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
const HOSTS = ['http://127.0.0.1:37421', 'http://localhost:37421', 'http://[::1]:37421'];
const SERVICE_NAME = 'pinako-mcp-service';

// ── The Bridge's own address ─────────────────────────────────────────────────
// This computer only. An entry of our name that points anywhere else (the hosted
// connector, another machine) is the user's, and must never be handed the key.

function isUrlEnd(c) {
  return /\s/.test(c) || '"\'`#,}]\\<>'.includes(c);
}

/** [start, end] of the first Bridge address at or after `from`, or null. */
function findUrl(s, from = 0) {
  let best = null;
  for (const host of HOSTS) {
    for (let at = s.indexOf(host, from); at !== -1; at = s.indexOf(host, at + 1)) {
      if (best && at >= best[0]) break;
      let end = at + host.length;
      // Another port (374210) or a name that only starts like ours.
      if (end < s.length && !'/?'.includes(s[end]) && !isUrlEnd(s[end])) continue;
      while (end < s.length && !isUrlEnd(s[end])) end++;
      best = [at, end];
      break;
    }
  }
  return best;
}

const hasUrl = (s) => typeof s === 'string' && findUrl(s) !== null;

/** Every Bridge address in `s` made current. One that already carries the key is left as written. */
function swapUrls(s, target) {
  let out = '', pos = 0;
  for (let hit = findUrl(s); hit; hit = findUrl(s, hit[1])) {
    const was = s.slice(hit[0], hit[1]);
    out += s.slice(pos, hit[0]) + (was.includes(`token=${target.token}`) ? was : target.url);
    pos = hit[1];
  }
  return out + s.slice(pos);
}

const isService = (s) => typeof s === 'string' && /pinako-mcp-service(\.exe)?$/i.test(s);
const mentions = (s) => hasUrl(s) || s.toLowerCase().includes(SERVICE_NAME);

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
  return isObj(e) && (URL_KEYS.some(k => hasUrl(e[k])) || isService(e.command)
    || (Array.isArray(e.args) && e.args.some(hasUrl)));
}

function refreshEntry(kind, e, target) {
  const key = URL_KEYS.find(k => hasUrl(e[k]));
  if (!key) {
    const out = { ...e };
    if (isService(e.command)) out.command = target.service;
    if (Array.isArray(e.args)) out.args = e.args.map(a => (hasUrl(a) ? swapUrls(a, target) : a));
    return out;
  }
  const want = shape(kind, { ...target, url: swapUrls(e[key], target) });
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    if (k in want) out[k] = want[k];
    else if (!URL_KEYS.includes(k)) out[k] = v;
  }
  return { ...out, ...want };
}

function inspectJson(kind, text, target) {
  const raw = text.replace(/^﻿/, '');
  if (!raw.trim()) return { status: 'no', next: null };
  let root;
  try { root = JSON.parse(raw); } catch {
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
      if (!hasUrl(s?.transport?.url)) continue;
      found = true;
      if (target) put(s.transport, 'url', swapUrls(s.transport.url, target));
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
  const m = /^\s*\[\[?\s*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*\]\]?\s*(?:#.*)?$/.exec(line.trimEnd());
  return m ? m[1].match(/"[^"]*"|'[^']*'|[A-Za-z0-9_-]+/g).map(p => p.replace(/^["']|["']$/g, '')) : null;
}

const isOurTable = (h) => h.length === 2 && h[0] === 'mcp_servers' && OUR_KEYS.includes(h[1]);

/** Our entry written as an inline value or a dotted key, which we do not edit. */
export function tomlInlineEntry(text) {
  return text.split(/\r?\n/).some(l =>
    /^\s*(?:["']?mcp_servers["']?\s*\.\s*)?["']?pinako["']?\s*[=.]/i.test(l)
    || /^\s*["']?mcp_servers["']?\s*=.*pinako/i.test(l));
}

function inspectToml(text, target) {
  let inside = false, found = false;
  const lines = text.split('\n').map(line => {
    const header = tomlHeader(line);
    if (header) { inside = isOurTable(header); return line; }
    if (!inside || line.trim().startsWith('#') || !mentions(line)) return line;
    found = true;
    return target ? swapUrls(line, target) : line;
  });
  if (!found) return { status: tomlInlineEntry(text) && mentions(text) ? 'unreadable' : 'no', next: null };
  const next = lines.join('\n');
  return { status: 'yes', next: next === text ? null : next };
}

// ── YAML settings (Hermes, Continue.dev) ─────────────────────────────────────

function inspectHermes(text, target) {
  let inBlock = false, childIndent = -1, inside = false, found = false, flow = false;
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
    found = true;
    return target ? swapUrls(line, target) : line;
  });
  if (!found) return { status: flow && mentions(text) ? 'unreadable' : 'no', next: null };
  const next = lines.join('\n');
  return { status: 'yes', next: next === text ? null : next };
}

/** Continue's file is ours alone: any Bridge address in it counts. */
function inspectOwnYaml(text, target) {
  const live = text.split('\n').some(l => !l.trim().startsWith('#') && mentions(l));
  if (!live) return { status: 'no', next: null };
  const next = target ? swapUrls(text, target) : text;
  return { status: 'yes', next: next === text ? null : next };
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
