/**
 * tests/auth-67.smoke.js — local HTTP auth surface (ai-todo #67)
 *
 * Standalone: `node tests/auth-67.smoke.js`. Unlike the vitest suites in this
 * folder it needs NO browser and NO extension — it spawns its own host.js on
 * a scratch port with an isolated data dir (APPDATA/HOME redirected), so it
 * never touches the developer's real token or collides with a live bridge.
 *
 * Covers the three things the design promises:
 *   Tier A — loopback-only: bad Host and any browser Origin are refused.
 *   Tier C — a connection without the token gets the catalog and no data.
 *   Squat  — /health answers an HMAC challenge only a token-holder can forge.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOST_JS  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host.js');
const PORT     = 37799;                       // scratch port, not the real 37421
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-auth67-'));

let passed = 0, failed = 0, skipped = 0;   // `skipped` counts cases this checkout cannot
                                          // run at all; they are neither pass nor fail.
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else    { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}\n      expected: ${expected}\n      actual:   ${actual}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function status(url, opts) {
  try { return (await fetch(url, opts)).status; }
  catch (e) { return `ERR ${e.message}`; }
}

// `Host` is a forbidden header name for fetch(), which silently drops an
// override — so the rebinding case has to go out over raw http.
function rawStatus(pathname, headers) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (e) => resolve(`ERR ${e.message}`));
    req.end();
  });
}
async function main() {
  const child = spawn(process.execPath, [HOST_JS], {
    env: {
      ...process.env,
      PINAKO_MCP_PORT: String(PORT),
      APPDATA: DATA_DIR,        // win32 data dir
      HOME: DATA_DIR,           // posix data dir
      USERPROFILE: DATA_DIR,
    },
    stdio: ['pipe', 'pipe', 'pipe'],   // stdin stays OPEN: closing it shuts the host down
  });
  child.stderr.on('data', () => {});   // keep the pipe drained

  try {
    // Wait for the port
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(100);
      try { up = (await fetch(`${BASE}/health`)).ok; } catch (_) {}
    }
    if (!up) throw new Error(`host.js never came up on ${PORT}`);

    const tokenFile = path.join(DATA_DIR, 'Pinako', 'mcp-auth-token');
    const TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
    check('token file is 64 hex chars', /^[0-9a-f]{64}$/.test(TOKEN), true);
    if (process.platform !== 'win32') {
      check('token file is 0600', (fs.statSync(tokenFile).mode & 0o777), 0o600);
    }

    console.log('\n  Tier A — loopback only');
    // The DNS-rebinding shape: an attacker page resolves its own hostname to
    // 127.0.0.1, so the request arrives on loopback carrying THEIR Host.
    check('non-loopback Host refused',   await rawStatus('/health', { Host: 'evil.example.com' }), 403);
    check('localhost Host still allowed', await rawStatus('/health', { Host: `localhost:${PORT}` }), 200);
    // Legal Host forms real clients emit that a strict equality check refused.
    check('portless Host allowed',        await rawStatus('/health', { Host: '127.0.0.1' }), 200);
    check('trailing-dot Host allowed',    await rawStatus('/health', { Host: 'localhost.' }), 200);
    check('IPv6 loopback allowed',        await rawStatus('/health', { Host: `[::1]:${PORT}` }), 200);
    // A rebinding page naming a different port must still be refused.
    check('loopback name, wrong port refused', await rawStatus('/health', { Host: '127.0.0.1:1234' }), 403);

    // Origin: web pages refused, local app schemes allowed. Blanket refusal
    // would break Electron clients (VS Code, Cursor, Claude Desktop) entirely.
    check('http Origin refused',   await status(`${BASE}/health`, { headers: { Origin: 'http://evil.example.com' } }), 403);
    check('app-scheme Origin OK',  await status(`${BASE}/health`, { headers: { Origin: 'vscode-file://vscode-app' } }), 200);
    check('browser Origin refused',      await status(`${BASE}/health`, { headers: { Origin: 'https://evil.example.com' } }), 403);
    check('/debug is gone',              await status(`${BASE}/debug`), 404);

    console.log('\n  /health disclosure');
    const anon = await (await fetch(`${BASE}/health`)).json();
    const auth = await (await fetch(`${BASE}/health?token=${TOKEN}`)).json();
    check('tokenless hides browser ids', Array.isArray(anon.browsers), false);
    check('tokenless still reports up',  anon.ok, true);
    check('tokened exposes browsers',    Array.isArray(auth.browsers), true);

    console.log('\n  Port-squat challenge');
    const nonce = crypto.randomBytes(8).toString('hex');
    const chal  = await (await fetch(`${BASE}/health?challenge=${nonce}`)).json();
    const want  = crypto.createHmac('sha256', TOKEN).update(nonce).digest('hex');
    check('proof matches HMAC(token, nonce)', chal.proof, want);
    const chal2 = await (await fetch(`${BASE}/health?challenge=${nonce}x`)).json();
    check('proof is nonce-bound',             chal2.proof === want, false);

    console.log('\n  POST /edit');
    const editBody = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: { type: 'set_title' } }) };
    check('tokenless refused', await status(`${BASE}/edit`, editBody), 401);
    check('bad token refused', await status(`${BASE}/edit?token=deadbeef`, editBody), 401);
    check('bearer header accepted', await status(`${BASE}/edit`, {
      ...editBody, headers: { ...editBody.headers, Authorization: `Bearer ${TOKEN}` },
    }) !== 401, true);

    console.log('\n  Tier C — /mcp');
    const initBody = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'auth67', version: '0' } },
      }),
    };
    // A 401 makes clients start OAuth and hides the reason, so neither a
    // missing nor a wrong token is refused at the handshake; the refusal comes
    // in-band on the first data request.
    check('wrong-token handshake answers (no 401)', await status(`${BASE}/mcp?token=deadbeef`, initBody), 200);
    check('tokened URL still routes', await status(`${BASE}/mcp?token=${TOKEN}`, initBody), 200);

    const openSession = async (query = '') => (await fetch(`${BASE}/mcp${query}`, initBody)).headers.get('mcp-session-id');
    const rpc = async (sid, method, params, query = '') => {
      const r = await fetch(`${BASE}/mcp${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method, params }),
      });
      return r.json();
    };
    const innerCode = (j) => { try { return JSON.parse(j?.result?.content?.[0]?.text)?.error?.code ?? null; } catch (_) { return null; } };

    // A TOKENLESS session: catalog yes, data no.
    const sid = await openSession();
    const call = async (tool, query = '') => {
      const j = await rpc(sid, 'tools/call', { name: tool, arguments: {} }, query);
      return { json: j, code: innerCode(j) };
    };
    const catalog = await rpc(sid, 'tools/list', {});
    check('tokenless catalog (tools/list) answers', (catalog?.result?.tools || []).length > 0, true);
    const readAnon = await call('list_browsers');
    check('tokenless READ refused', readAnon.code, 'AUTH_REQUIRED');
    check('refusal is in-band (not a protocol error)', readAnon.json?.result?.isError, true);
    check('refusal names the fix', /re-run the Pinako AI Bridge installer/i.test(JSON.stringify(readAnon.json)), true);
    check('tokenless WRITE refused', (await call('set_title')).code, 'AUTH_REQUIRED');
    const resRead = await rpc(sid, 'resources/read', { uri: 'pinako://tree' });
    check('tokenless resources/read refused', resRead?.error?.code, -32011);
    check('…and it carries no tree', /"tree"/.test(JSON.stringify(resRead)), false);
    const resList = await rpc(sid, 'resources/list', {});
    check('tokenless resources/list answered empty', JSON.stringify(resList?.result), JSON.stringify({ resources: [] }));

    // The push stream: none for an unauthorized connection (405, which the
    // spec requires clients to accept), but an authorized one still gets it.
    const getStatus = async (sidForGet, query = '') => {
      const ac = new AbortController();
      try {
        const r = await fetch(`${BASE}/mcp${query}`, { headers: { Accept: 'text/event-stream', 'mcp-session-id': sidForGet }, signal: ac.signal });
        return r.status;
      } catch (e) { return `ERR ${e.message}`; }
      finally { ac.abort(); }
    };
    check('tokenless GET stream refused with 405', await getStatus(sid), 405);
    const tokSid = await openSession(`?token=${TOKEN}`);
    check('tokened GET stream still opens', await getStatus(tokSid, `?token=${TOKEN}`), 200);

    // Same tokenless session, now presenting the token: the gate lets it
    // through to real argument validation (which then rejects the empty args).
    const writeAuthed = await call('set_title', `?token=${TOKEN}`);
    check('tokened WRITE passes the gate', writeAuthed.code === 'AUTH_REQUIRED', false);

    // A WRONG token: another OS user's app reaching this user's bridge, or a
    // stale config. Refused in-band, with a message that names that cause.
    const wrongSid = await openSession('?token=deadbeef');
    const wrong = await rpc(wrongSid, 'tools/call', { name: 'list_browsers', arguments: {} }, '?token=deadbeef');
    check('wrong-token READ refused', innerCode(wrong), 'WRONG_ACCESS_TOKEN');
    check('…naming another user account on this computer', /another user account/.test(JSON.stringify(wrong)), true);
    // A wrong token is never rescued by a session that was authorized.
    const rescued = await rpc(tokSid, 'tools/call', { name: 'list_browsers', arguments: {} }, '?token=deadbeef');
    check('wrong token on an authorized session still refused', innerCode(rescued), 'WRONG_ACCESS_TOKEN');

    console.log('\n  POST /update (the relay between bridges)');
    const updBody = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    check('tokenless /update refused', await status(`${BASE}/update`, updBody), 401);
    check('tokened /update accepted', await status(`${BASE}/update`, {
      ...updBody, headers: { ...updBody.headers, Authorization: `Bearer ${TOKEN}` },
    }), 200);
    // Bridges prove the token instead of sending it (a relay can land on
    // whoever grabbed the port), and the proof is bound to its body.
    const proofFor = (body, ts = Date.now()) =>
      `${ts}.${crypto.createHmac('sha256', TOKEN).update(`pinako-relay|/update|${ts}|`).update(body).digest('hex')}`;
    check('/update with a relay proof accepted', await status(`${BASE}/update`, {
      ...updBody, headers: { ...updBody.headers, 'x-pinako-relay-proof': proofFor('{}') },
    }), 200);
    check('a proof made for another body refused', await status(`${BASE}/update`, {
      ...updBody, headers: { ...updBody.headers, 'x-pinako-relay-proof': proofFor('{"x":1}') },
    }), 401);

    // JSON-RPC batching: the gate originally inspected only parsed.method, so
    // an ARRAY body had no top-level method and skipped it entirely.
    console.log('\n  Batch smuggling');
    const batch = async (tools) => {
      const r = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
        body: JSON.stringify(tools.map((name, i) => ({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name, arguments: {} } }))),
      });
      return JSON.stringify(await r.json());
    };
    check('batched write blocked',            /AUTH_REQUIRED/.test(await batch(['set_title'])), true);
    check('batched destructive write blocked', /AUTH_REQUIRED/.test(await batch(['delete_node'])), true);
    const mixed = await batch(['list_browsers', 'delete_live_node']);
    check('mixed batch refused',              /AUTH_REQUIRED/.test(mixed), true);
    check('mixed batch did not execute anything', /BROWSER_NOT_FOUND/.test(mixed), false);
    // Every id must be answered: a JSON-RPC client resolves per-id, so an
    // unanswered id is a hang rather than a visible refusal.
    const mixedIds = (JSON.parse(mixed) || []).map(m => m.id).sort();
    check('every batch id gets a reply', JSON.stringify(mixedIds), JSON.stringify([100, 101]));

    // The token travels in the query string, so every log sink has to redact
    // it. pinako-mcp.log persists, rotates to .old, and is what users paste
    // into bug reports — a live credential in there would undo the point of
    // deleting /debug. Exercised above by the tokened calls.
    // Rotation must revoke, not just re-key. A running bridge memoizes the
    // token, so without an on-disk change check it would keep honouring the
    // OLD secret (and every session already marked authed) until restart.
    console.log('\n  Rotation revokes a live session');
    const authedSess = await fetch(`${BASE}/mcp?token=${TOKEN}`, initBody);
    const authedSid  = authedSess.headers.get('mcp-session-id');
    const callOn = async (sid, query = '') => {
      const r = await fetch(`${BASE}/mcp${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'set_title', arguments: {} } }),
      });
      return (await r.text());
    };
    check('authorized session can write before rotation',
      /AUTH_REQUIRED/.test(await callOn(authedSid)), false);

    const rotated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile, rotated + '\n', 'utf8');
    await sleep(2200);   // clear the stat-throttle window

    check('old token is rejected after rotation',
      (await status(`${BASE}/edit?token=${TOKEN}`, editBody)), 401);
    check('new token is accepted after rotation',
      (await status(`${BASE}/edit?token=${rotated}`, editBody)) !== 401, true);
    check('previously authorized session is revoked',
      /AUTH_REQUIRED/.test(await callOn(authedSid)), true);
    // Restore so the redaction checks below still use a known value.
    fs.writeFileSync(tokenFile, TOKEN + '\n', 'utf8');
    await sleep(2200);

    console.log('\n  Credential redaction');
    await fetch(`${BASE}/mcp?token=${TOKEN}`, initBody);          // force a logged tokened request
    await fetch(`${BASE}/mcp`, { ...initBody, headers: { ...initBody.headers, Authorization: `Bearer ${TOKEN}` } });
    await sleep(300);
    const logText = fs.readFileSync(path.join(DATA_DIR, 'Pinako', 'pinako-mcp.log'), 'utf8');
    check('log never contains the token', logText.includes(TOKEN), false);
    check('log shows the redaction marker', logText.includes('token=<redacted>'), true);
    check('bearer header redacted in log', /"authorization":"<redacted>"/.test(logText), true);

    // ── Catalog-wide invariants ──
    // Checked against the LIVE catalog rather than a hardcoded list, so a tool
    // added later is covered with no one remembering to update the auth code.
    //   Tier C: EVERY tool is refused on a tokenless connection.
    //   Escape hatch (PINAKO_MCP_ALLOW_TOKENLESS_READS=1, Tier B): exactly the
    //   read-only tools answer; a write mislabelled readOnlyHint:true would
    //   show up here instead of shipping as a hole.
    console.log('\n  Catalog-wide: every tool refused tokenless');
    const toolNames = (catalog?.result?.tools || []).map(t => t.name);
    check('catalog is non-empty', toolNames.length > 0, true);
    const leaked = [];
    for (const name of toolNames) {
      if ((await call(name)).code !== 'AUTH_REQUIRED') leaked.push(name);
    }
    check(`every tool refused tokenless (${toolNames.length} checked)`, leaked.join(',') || 'none', 'none');

    console.log('\n  Escape hatch: tokenless reads (Tier B) on request');
    {
      const HATCH_PORT = PORT + 1;
      const HATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-auth67-hatch-'));
      const hatch = spawn(process.execPath, [HOST_JS], {
        env: { ...process.env, PINAKO_MCP_PORT: String(HATCH_PORT), APPDATA: HATCH_DIR, HOME: HATCH_DIR, USERPROFILE: HATCH_DIR, PINAKO_MCP_ALLOW_TOKENLESS_READS: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      hatch.stderr.on('data', () => {});
      try {
        const HB = `http://127.0.0.1:${HATCH_PORT}`;
        let hup = false;
        for (let i = 0; i < 50 && !hup; i++) { await sleep(100); try { hup = (await fetch(`${HB}/health`)).ok; } catch (_) {} }
        const hsid = (await fetch(`${HB}/mcp`, initBody)).headers.get('mcp-session-id');
        const hcall = async (tool, query = '') => {
          const r = await fetch(`${HB}/mcp${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': hsid },
            body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: tool, arguments: {} } }),
          });
          return innerCode(await r.json());
        };
        const READ_ONLY_EXPECTED = new Set([
          'get_tree', 'search_tabs', 'search_pinako', 'list_libraries', 'get_library',
          'get_main_tree_notes', 'get_bookmarks', 'list_browsers', 'find_duplicates',
          'get_tree_summary', 'search_docs',
        ]);
        const leakedWrites = [], overGatedReads = [];
        for (const name of toolNames) {
          const blocked = (await hcall(name)) === 'AUTH_REQUIRED';
          if (READ_ONLY_EXPECTED.has(name)) { if (blocked) overGatedReads.push(name); }
          else if (!blocked) leakedWrites.push(name);
        }
        check(`hatch: every write tool still blocked (${toolNames.length - READ_ONLY_EXPECTED.size} checked)`, leakedWrites.join(',') || 'none', 'none');
        check('hatch: no read tool over-gated', overGatedReads.join(',') || 'none', 'none');
        check('hatch: a WRONG token is still refused', await hcall('list_browsers', '?token=deadbeef'), 'WRONG_ACCESS_TOKEN');
      } finally {
        hatch.stdin.end();
        hatch.kill();
        await sleep(200);
        try { fs.rmSync(HATCH_DIR, { recursive: true, force: true }); } catch (_) {}
      }
    }

    // ── C(ii): THE NM HEARTBEAT ONLY FIRES WHEN THERE IS WORK (2026-09-18) ──
    // Found live: the MV3 service worker idles out after ~5 minutes of no port
    // traffic, Chrome then closes the native port, and host.js exits one grace
    // period later — while a background queue in this process still had work
    // waiting. The heartbeat is now one connection-lifetime interval that
    // WRITES only when an applyEdit is in flight or a host extension reports a
    // queue as RUNNING OR SCHEDULED. Three halves have to hold: firing when
    // something is scheduled, staying silent when nothing is, and never firing
    // on a leftover count alone — a heartbeat that never stops is a machine
    // that never sleeps.
    //
    // Each run spawns its own host (own scratch port, own data dir) so the
    // suite's long-lived `child` is untouched, and shortens the interval
    // through PINAKO_NM_HEARTBEAT_MS. The first passes NO knob at all and lets
    // the real predicate answer over the extension's own start-up state. The
    // second sets PINAKO_PENDING_WORK_QUIESCE, which asks the extension not to
    // ARM the one wake-up it would schedule for itself at start-up: it parks
    // the schedule, never the predicate, so the answer is still the
    // extension's own. Only the third stubs the answer, through
    // PINAKO_PENDING_WORK_FORCE, to prove host.js reaches a registered probe
    // at all.
    console.log('\n  NM heartbeat fires for scheduled work and for nothing else');
    const EXT_PRESENT = fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bridge-ext', 'host-ext.js'));
    if (!EXT_PRESENT) {
      // No host extension in this checkout, so nothing can register a probe
      // and there is no queue to schedule. Skip cleanly: these cases are
      // neither passed nor failed here.
      skipped += 4;
      console.log('  \x1b[33m—\x1b[0m SKIP: heartbeat-with-pending-work cases need the host extension (not present in this checkout)');
    } else {
      const HB_MS = 250;
      // NOTHING RUNNING AND NOTHING SCHEDULED. One neutral knob, honoured by
      // the extension at exactly one place: it declines to arm the wake-up it
      // would otherwise schedule for itself at start-up. Whatever counts it is
      // carrying, the predicate has to answer false.
      const QUIET = { PINAKO_PENDING_WORK_QUIESCE: '1' };
      // A CASE SAYS ITS OWN ENV, WHOLE. Every knob this host reads is a
      // PINAKO_* variable, and any of them may already be set in the shell a
      // developer runs the suite from — which would decide these cases instead
      // of the code under test: an inherited knob can silence the armed run
      // (false FAIL) or, worse, make the quiet run pass for a reason that has
      // nothing to do with the predicate (false PASS). So strip the whole
      // prefix out of the inherited environment first, then layer on exactly
      // what the case means to say. The run with no knobs of its own gets a
      // genuinely bare one.
      const baseEnv = () => Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('PINAKO_')));
      const runHost = async (label, port, extraEnv) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-hb-'));
        const c = spawn(process.execPath, [HOST_JS], {
          env: { ...baseEnv(), PINAKO_MCP_PORT: String(port), PINAKO_NM_HEARTBEAT_MS: String(HB_MS),
                 APPDATA: dir, HOME: dir, USERPROFILE: dir, ...extraEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        c.stderr.on('data', () => {});
        // stdout is the native-messaging channel: 4-byte LE length + JSON body.
        let buf = Buffer.alloc(0), beats = 0;
        c.stdout.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 4) {
            const n = buf.readUInt32LE(0);
            if (buf.length < 4 + n) break;
            const body = buf.slice(4, 4 + n); buf = buf.slice(4 + n);
            try { if (JSON.parse(body.toString('utf8')).type === 'heartbeat') beats++; } catch (_) {}
          }
        });
        await sleep(4000);                    // ~16 intervals, minus the extension's load time
        const whileConnected = beats;
        c.stdin.end();                        // exactly what Chrome does to tear the port down
        await sleep(1500);                    // ~6 more intervals, well inside the 30s grace
        const afterStdinEnd = beats - whileConnected;
        try { c.kill(); } catch (_) {}
        await sleep(100);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        return { label, whileConnected, afterStdinEnd };
      };

      // SCHEDULED, WITH NOTHING BEHIND IT. No knob at all, so the extension
      // arms its own start-up wake-up exactly as it does on a real machine.
      // That wake-up is a long way outside this window, so nothing runs, no
      // cycle ever completes, and no count exists anywhere: the armed timer is
      // the ONLY thing that can hold the heartbeat open. This is the case the
      // first cut got backwards — it asked each queue for a count, and a
      // wake-up armed with a count of zero let the bridge die under it.
      const armed  = await runHost('armed',  PORT - 1, {});
      const quiet  = await runHost('quiet',  PORT - 2, QUIET);
      const forced = await runHost('forced', PORT - 3, { ...QUIET, PINAKO_PENDING_WORK_FORCE: '1' });
      check('a scheduled resume gets heartbeats with no cycle and no count behind it',
        armed.whileConnected > 0, true);
      check('…and NOT one per tick more than the interval allows (16 ticks in 4s)',
        armed.whileConnected <= 20, true);
      check('nothing running and nothing scheduled gets none at all — this is not a keep-alive',
        `${quiet.whileConnected}/${forced.whileConnected > 0}`, '0/true');
      check('nothing is written after stdin ended, work pending or not',
        `${armed.afterStdinEnd}/${quiet.afterStdinEnd}/${forced.afterStdinEnd}`, '0/0/0');
    }

    // ── A BRIDGE EXIT LEAVES A LINE IN THE LOG (2026-09-17) ──────────────
    // Chrome owns this process's stderr and puts it somewhere no user can
    // read, so when a Bridge vanished mid-session `pinako-mcp.log` just
    // stopped: indistinguishable from a bridge still running and idle. Closing
    // stdin is exactly what Chrome does when it tears the native port down, so
    // it is what this asserts. The EXIT line one grace period later is the same
    // `log()` call on the same handler's timer; pinning it would cost the
    // suite 30 s of waiting for a second line by construction.
    // MUST BE LAST: the host is on its way out after this.
    console.log('\n  Bridge exit is visible in the log');
    child.stdin.end();
    await sleep(500);
    const exitLog = fs.readFileSync(path.join(DATA_DIR, 'Pinako', 'pinako-mcp.log'), 'utf8');
    const exitLines = exitLog.split('\n').filter(l => l.includes('native port closed by the browser'));
    check('stdin end writes ONE line to the shared log, not stderr alone', exitLines.length, 1);
    check('…and it names the pid, so one log can be read across bridges',
      exitLines.length === 1 && exitLines[0].includes(`[${child.pid}]`), true);

  } finally {
    child.stdin.end();
    child.kill();
    await sleep(200);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n  ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
