/**
 * setup/connections.js
 *
 * Is an AI app already connected to this computer's Bridge, and what would its
 * settings look like with the current access key? Pure: text in, text out.
 *
 * An update refreshes the connections that exist and makes no new ones, so this
 * must never take a file it could not understand for "not connected", and must
 * change nothing in an entry but what makes it connect: the user's own switches
 * (disabled, approved tools, timeouts) and the name they know it by stay.
 *
 * Mirrors installer/src-tauri/src/connections.rs. Both run the same cases:
 * tests/connections-cases.json.
 */

export const SERVER_KEY = 'Pinako';
export const LEGACY_SERVER_KEYS = ['pinako'];
const OUR_KEYS = [SERVER_KEY, ...LEGACY_SERVER_KEYS];

const URL_KEYS = ['url', 'httpUrl', 'serverUrl'];
const ADDRESS = String.raw`http://(?:127\.0\.0\.1|localhost|\[::1\]):37421(?:[/?][^\s"'\x60\\<>]*)?`;
const SERVICE_NAME = 'pinako-mcp-service';

// ── The Bridge's own address ─────────────────────────────────────────────────
// This computer only. An entry of our name that points anywhere else (the hosted
// connector, another machine) is the user's, and must never be handed the key.

// And only as a WHOLE value: an address inside another one, a comment or a note
// is not where an entry connects to.

const WHOLE = new RegExp(`^${ADDRESS}$`);
const ANYWHERE = new RegExp(ADDRESS);
const QUOTED = new RegExp(`(["'])(${ADDRESS})\\1`, 'g');
const isAddress = (s) => typeof s === 'string' && WHOLE.test(s);

/**
 * One Bridge address with the current key. Only the key changes: the path may
 * pick a tool profile, and the host spelling is the person's. A key they take
 * from their own ${NAME} is left as written.
 */
export function withKey(was, target) {
  const cut = was.indexOf('?');
  let base = cut === -1 ? was : was.slice(0, cut);
  const parts = cut === -1 ? [] : was.slice(cut + 1).split('&').filter(Boolean);
  if (parts.some(p => p.startsWith('token=${'))) return was;
  if (/:37421$/.test(base)) base += '/mcp';
  else if (/:37421\/$/.test(base)) base += 'mcp';
  return `${base}?${[`token=${target.token}`, ...parts.filter(p => !p.startsWith('token='))].join('&')}`;
}

/** The quoted addresses in one line of settings made current: [found, line]. */
function keyQuoted(line, target) {
  let found = false;
  const next = line.replace(QUOTED, (all, q, address) => {
    found = true;
    return target ? q + withKey(address, target) + q : all;
  });
  return [found, next];
}

const isService = (s) => typeof s === 'string' && /pinako-mcp-service(\.exe)?$/i.test(s);
const mentions = (s) => ANYWHERE.test(s) || s.toLowerCase().includes(SERVICE_NAME);

// ── JSON settings ────────────────────────────────────────────────────────────

const MAPS = { vscode: ['servers'], openclaw: ['mcp', 'servers'] };

/** What makes an entry connect, per app. Everything else in it is the user's. */
function shape(kind, target) {
  const { url } = target;
  switch (kind) {
    case 'claude-desktop': return { command: target.service, args: ['--stdio-mcp', url] };
    case 'claude-code': case 'vscode': return { type: 'http', url };
    case 'antigravity': return { serverUrl: url };
    case 'cline': return { type: 'streamableHttp', url };
    case 'roo-code': case 'zoo-code': return { type: 'streamable-http', url };
    case 'gemini-cli': return { httpUrl: url };
    case 'openclaw': return { url, transport: 'streamable-http' };
    default: return { url };
  }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function isOurEntry(e) {
  if (!isObj(e)) return false;
  // An entry that also names another server is not ours to change.
  if (URL_KEYS.some(k => typeof e[k] === 'string' && e[k] && !isAddress(e[k]))) return false;
  return URL_KEYS.some(k => isAddress(e[k])) || isService(e.command)
    || (Array.isArray(e.args) && e.args.some(isAddress));
}

function refreshEntry(kind, e, target) {
  const key = URL_KEYS.find(k => isAddress(e[k]));
  if (!key) {
    const out = { ...e };
    if (isService(e.command)) out.command = target.service;
    if (Array.isArray(e.args)) out.args = e.args.map(a => (isAddress(a) ? withKey(a, target) : a));
    return out;
  }
  const url = withKey(e[key], target);
  // Windsurf reads either spelling: keep the person's.
  const want = kind === 'windsurf' ? { [key]: url } : shape(kind, { ...target, url });
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    if (k in want) out[k] = want[k];
    else if (!URL_KEYS.includes(k)) out[k] = v;
  }
  return { ...out, ...want };
}

/** JSON.parse, with every number written back exactly as it was. */
export function parseJson(raw) {
  return JSON.parse(raw, (key, value, context) =>
    (typeof value === 'number' && context && JSON.rawJSON && String(value) !== context.source
      ? JSON.rawJSON(context.source) : value));
}

function inspectJson(kind, text, target) {
  const raw = text.replace(/^﻿/, '');
  if (!raw.trim()) return { status: 'no', next: null };
  let root;
  try { root = parseJson(raw); } catch {
    return { status: mentions(raw) ? 'unreadable' : 'no', next: null };
  }
  let found = false, changed = false;
  const put = (holder, key, now) => {
    if (JSON.stringify(now) === JSON.stringify(holder[key])) return;
    holder[key] = now;
    changed = true;
  };
  if (kind === 'continue-json') {
    const list = root?.experimental?.modelContextProtocolServers;
    for (const s of Array.isArray(list) ? list : []) {
      if (!isAddress(s?.transport?.url)) continue;
      found = true;
      if (target) put(s.transport, 'url', withKey(s.transport.url, target));
    }
  } else {
    let map = root;
    for (const k of MAPS[kind] || ['mcpServers']) map = isObj(map) ? map[k] : undefined;
    for (const k of isObj(map) ? OUR_KEYS : []) {
      if (!Object.hasOwn(map, k) || !isOurEntry(map[k])) continue;
      found = true;
      if (target) put(map, k, refreshEntry(kind, map[k], target));
    }
  }
  return { status: found ? 'yes' : 'no', next: changed ? JSON.stringify(root, null, 2) + '\n' : null };
}

// ── TOML settings (Codex, Grok Build) ────────────────────────────────────────

/** The name parts of a `[table]` line, or null. Quotes, spaces and a trailing comment allowed. */
export function tomlHeader(line) {
  const m = /^\s*\[\[?\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'.,=#[\]]+)(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'.,=#[\]]+))*)\s*\]\]?\s*(?:#.*)?$/.exec(line.trimEnd());
  return m ? m[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'.,=#[\]]+/g).map(p => p.replace(/^["']|["']$/g, '')) : null;
}

const isOurTable = (h) => h.length === 2 && h[0] === 'mcp_servers' && OUR_KEYS.includes(h[1]);

/** For each line: does it start inside a multi-line string, where nothing is a table or a key? */
export function tomlStringLines(text) {
  const out = [];
  let open = null; // the quote a string was opened with
  for (const line of text.split('\n')) {
    out.push(open !== null);
    for (let i = 0; i < line.length; i++) {
      const three = line.slice(i, i + 3);
      if (open === null) {
        if (line[i] === '#') break;
        if (three === '"""' || three === "'''") { open = three; i += 2; }
        else if (line[i] === '"' || line[i] === "'") open = line[i];
      } else if (open[0] === '"' && line[i] === '\\') i++;
      else if (open.length === 3 ? three === open : line[i] === open) { i += open.length - 1; open = null; }
    }
    if (open !== null && open.length === 1) open = null; // a plain string ends with its line
  }
  return out;
}

function tomlLines(text) {
  const masked = tomlStringLines(text);
  return text.split('\n').filter((_, i) => !masked[i]);
}

/** Our entry written as an inline value or a dotted key, which we do not edit. */
export function tomlInlineEntry(text) {
  return tomlLines(text).some(l =>
    /^\s*(?:["']?mcp_servers["']?\s*\.\s*)?["']?pinako["']?\s*[=.]/i.test(l)
    || /^\s*["']?mcp_servers["']?\s*=.*pinako/i.test(l));
}

/** A servers map written on one line: a table of ours cannot be added to it. */
export function tomlInlineMap(text) {
  return tomlLines(text).some(l => /^\s*["']?mcp_servers["']?\s*=/.test(l));
}

function inspectToml(text, target) {
  const masked = tomlStringLines(text);
  let inside = false, found = false, hidden = false;
  const lines = text.split('\n').map((line, i) => {
    if (masked[i]) return line;
    const header = tomlHeader(line);
    if (header) { inside = isOurTable(header); return line; }
    if (!inside || line.trim().startsWith('#') || !mentions(line)) return line;
    const key = /^\s*(url|args|command)\s*=/.exec(line)?.[1];
    const [code, note] = splitNote(line);
    // `url` is one address and nothing else; `args` may hold it among others.
    const [hit, next] = key === 'args' || (key === 'url' && ONE_QUOTED.test(code.replace(/^[^=]*=/, '').trim()))
      ? keyQuoted(code, target) : [false, code];
    if (hit || (key === 'command' && mentions(code))) found = true;
    else hidden = true;
    return next + note;
  });
  if (!found) {
    return { status: hidden || (tomlInlineEntry(text) && mentions(text)) ? 'unreadable' : 'no', next: null };
  }
  const next = lines.join('\n');
  return { status: 'yes', next: next === text ? null : next };
}

const ONE_QUOTED = new RegExp(`^(["'])${ADDRESS}\\1$`);

/** A line's own text and the comment after it. */
function splitNote(line) {
  const m = /\s#.*$/s.exec(line);
  return m ? [line.slice(0, m.index), line.slice(m.index)] : [line, ''];
}

// ── YAML settings (Hermes, Continue.dev) ─────────────────────────────────────

function inspectHermes(text, target) {
  let inBlock = false, childIndent = -1, inside = false, found = false, hidden = false, flow = false;
  const lines = text.split('\n').map(line => {
    const bare = line.trim();
    if (!bare || bare.startsWith('#')) return line;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const m = /^["']?mcp_servers["']?\s*:(.*)$/.exec(bare);
      inBlock = !!m;
      if (m && /pinako/i.test(m[1])) flow = true;
      childIndent = -1;
      inside = false;
      return line;
    }
    if (!inBlock) return line;
    if (childIndent === -1) childIndent = indent;
    if (indent <= childIndent) inside = /^["']?[Pp]inako["']?\s*:/.test(bare);
    if (!inside || !mentions(line)) return line;
    const [hit, next] = keyYaml(line, target);
    if (hit) found = true;
    else hidden = true;
    return next;
  });
  if (!found) return { status: hidden || (flow && mentions(text)) ? 'unreadable' : 'no', next: null };
  const next = lines.join('\n');
  return { status: 'yes', next: next === text ? null : next };
}

/**
 * A YAML line that gives the address: `url: …`, `- …` in a list, or
 * `Pinako: { url: "…" }` on one line. [found, line].
 */
function keyYaml(line, target) {
  const [code, note] = splitNote(line);
  const m = YAML_VALUE.exec(code);
  if (m) return [true, target ? m[1] + m[2] + withKey(m[3], target) + m[2] + m[4] + note : line];
  if (!/^\s*["']?[Pp]inako["']?\s*:\s*\{\s*["']?url["']?\s*:/.test(code)) return [false, line];
  const [hit, next] = keyQuoted(code, target);
  return [hit, next + note];
}

const YAML_VALUE = new RegExp(`^(\\s*(?:-\\s*)?(?:["']?url["']?\\s*:\\s*)?)(["']?)(${ADDRESS})\\2(\\s*)$`);

/** Continue's file is ours alone: any line of it that gives the address counts. */
function inspectOwnYaml(text, target) {
  let found = false;
  const next = text.split('\n').map(line => {
    if (line.trim().startsWith('#')) return line;
    const [hit, now] = keyYaml(line, target);
    found ||= hit;
    return now;
  }).join('\n');
  return { status: found ? 'yes' : 'no', next: found && next !== text ? next : null };
}

// ── The one entry point ──────────────────────────────────────────────────────

/**
 * kind: a client id, or 'continue-json' for Continue's old config.json.
 * target: { url, token, service }, or null to only ask for the status.
 * Returns { status: 'yes' | 'no' | 'unreadable', next: text to write, or null }.
 */
export function inspect(kind, text, target = null) {
  switch (kind) {
    case 'codex': case 'grok': return inspectToml(text, target);
    case 'hermes': return inspectHermes(text, target);
    case 'continue': return inspectOwnYaml(text, target);
    default: return inspectJson(kind, text, target);
  }
}
