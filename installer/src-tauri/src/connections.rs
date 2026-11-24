//! Is an AI app already connected to this computer's Bridge, and what would its
//! settings look like with the current access key? Pure: text in, text out.
//!
//! An update refreshes the connections that exist and makes no new ones, so this
//! must never take a file it could not understand for "not connected", and must
//! change nothing in an entry but what makes it connect: the user's own switches
//! (disabled, approved tools, timeouts) and the name they know it by stay.
//!
//! Mirrors setup/connections.js. Both run the same cases:
//! tests/connections-cases.json. Needs serde_json and regex only, so
//! tests/connections-rs runs it without building Tauri.

use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

pub const SERVER_KEY: &str = "Pinako";
pub const LEGACY_SERVER_KEYS: &[&str] = &["pinako"];
const OUR_KEYS: &[&str] = &["Pinako", "pinako"];

const URL_KEYS: &[&str] = &["url", "httpUrl", "serverUrl"];
const HOSTS: &[&str] = &["http://127.0.0.1:37421", "http://localhost:37421", "http://[::1]:37421"];
const SERVICE_NAME: &str = "pinako-mcp-service";

/// What a refreshed entry should carry.
pub struct Target {
    pub url: String,
    pub token: String,
    pub service: String,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Status {
    Yes,
    No,
    /// Our entry may be in there, in a form we cannot read.
    Unreadable,
}

pub struct Inspected {
    pub status: Status,
    /// The text to write, when it differs from what is there.
    pub next: Option<String>,
}

fn answer(status: Status, next: Option<String>) -> Inspected {
    Inspected { status, next }
}

macro_rules! re {
    ($text:expr) => {{
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| Regex::new($text).expect("a fixed pattern"))
    }};
}

// ── The Bridge's own address ─────────────────────────────────────────────────
// This computer only. An entry of our name that points anywhere else (the hosted
// connector, another machine) is the user's, and must never be handed the key.

fn is_url_end(c: char) -> bool {
    c.is_whitespace() || "\"'`#,}]\\<>".contains(c)
}

/// Start and end of the first Bridge address at or after `from`.
fn find_url(s: &str, from: usize) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for host in HOSTS {
        let mut pos = from;
        while let Some(i) = s[pos..].find(host) {
            let at = pos + i;
            if best.is_some_and(|b| at >= b.0) {
                break;
            }
            let end = at + host.len();
            // Another port (374210) or a name that only starts like ours.
            if s[end..].chars().next().is_some_and(|c| c != '/' && c != '?' && !is_url_end(c)) {
                pos = end;
                continue;
            }
            let stop = s[end..].find(is_url_end).map_or(s.len(), |n| end + n);
            best = Some((at, stop));
            break;
        }
    }
    best
}

fn has_url(s: &str) -> bool {
    find_url(s, 0).is_some()
}

/// Every Bridge address in `s` made current. One that already carries the key is left as written.
fn swap_urls(s: &str, t: &Target) -> String {
    let mut out = String::new();
    let mut pos = 0;
    let key = format!("token={}", t.token);
    while let Some((at, end)) = find_url(s, pos) {
        out.push_str(&s[pos..at]);
        let was = &s[at..end];
        out.push_str(if was.contains(&key) { was } else { &t.url });
        pos = end;
    }
    out.push_str(&s[pos..]);
    out
}

fn is_service(s: &str) -> bool {
    let s = s.to_lowercase();
    s.ends_with(SERVICE_NAME) || s.ends_with("pinako-mcp-service.exe")
}

fn mentions(s: &str) -> bool {
    has_url(s) || s.to_lowercase().contains(SERVICE_NAME)
}

// ── JSON settings ────────────────────────────────────────────────────────────

fn map_path(kind: &str) -> &'static [&'static str] {
    match kind {
        "vscode" => &["servers"],
        "openclaw" => &["mcp", "servers"],
        _ => &["mcpServers"],
    }
}

/// What makes an entry connect, per app. Everything else in it is the user's.
fn shape(kind: &str, url: &str, t: &Target) -> Map<String, Value> {
    let v = match kind {
        "claude-desktop" => json!({ "command": t.service, "args": ["--stdio-mcp", url] }),
        "claude-code" | "vscode" => json!({ "type": "http", "url": url }),
        "antigravity" => json!({ "serverUrl": url }),
        "cline" => json!({ "type": "streamableHttp", "url": url }),
        "roo-code" | "zoo-code" => json!({ "type": "streamable-http", "url": url }),
        "gemini-cli" => json!({ "httpUrl": url }),
        "openclaw" => json!({ "url": url, "transport": "streamable-http" }),
        _ => json!({ "url": url }),
    };
    v.as_object().cloned().unwrap_or_default()
}

fn str_of<'a>(e: &'a Map<String, Value>, key: &str) -> &'a str {
    e.get(key).and_then(Value::as_str).unwrap_or("")
}

fn our_url_key(e: &Map<String, Value>) -> Option<&'static str> {
    URL_KEYS.iter().copied().find(|k| has_url(str_of(e, k)))
}

pub fn is_our_entry(v: &Value) -> bool {
    let Some(e) = v.as_object() else { return false };
    our_url_key(e).is_some()
        || is_service(str_of(e, "command"))
        || e.get("args").and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|x| x.as_str().is_some_and(has_url)))
}

fn refresh_entry(kind: &str, e: &Map<String, Value>, t: &Target) -> Map<String, Value> {
    let Some(key) = our_url_key(e) else {
        let mut out = e.clone();
        if is_service(str_of(e, "command")) {
            out.insert("command".into(), json!(t.service));
        }
        if let Some(args) = out.get_mut("args").and_then(Value::as_array_mut) {
            for a in args {
                let now = a.as_str().filter(|s| has_url(s)).map(|s| swap_urls(s, t));
                if let Some(now) = now {
                    *a = json!(now);
                }
            }
        }
        return out;
    };
    let want = shape(kind, &swap_urls(str_of(e, key), t), t);
    let mut out = Map::new();
    for (k, v) in e {
        if let Some(w) = want.get(k) {
            out.insert(k.clone(), w.clone());
        } else if !URL_KEYS.contains(&k.as_str()) {
            out.insert(k.clone(), v.clone());
        }
    }
    for (k, v) in want {
        out.insert(k, v);
    }
    out
}

fn inspect_json(kind: &str, text: &str, target: Option<&Target>) -> Inspected {
    let raw = text.strip_prefix('\u{feff}').unwrap_or(text);
    if raw.trim().is_empty() {
        return answer(Status::No, None);
    }
    let Ok(mut root) = serde_json::from_str::<Value>(raw) else {
        return answer(if mentions(raw) { Status::Unreadable } else { Status::No }, None);
    };
    let mut found = false;
    let mut changed = false;
    if kind == "continue-json" {
        let list = root.pointer_mut("/experimental/modelContextProtocolServers").and_then(Value::as_array_mut);
        for s in list.into_iter().flatten() {
            let Some(url) = s.pointer_mut("/transport/url") else { continue };
            let Some(was) = url.as_str().filter(|u| has_url(u)).map(String::from) else { continue };
            found = true;
            if let Some(t) = target {
                let now = swap_urls(&was, t);
                changed |= now != was;
                *url = json!(now);
            }
        }
    } else {
        let mut map = Some(&mut root);
        for k in map_path(kind) {
            map = map.and_then(|m| m.get_mut(*k));
        }
        if let Some(map) = map.and_then(Value::as_object_mut) {
            for k in OUR_KEYS {
                let Some(entry) = map.get_mut(*k).filter(|e| is_our_entry(e)) else { continue };
                found = true;
                let (Some(t), Some(e)) = (target, entry.as_object()) else { continue };
                let now = Value::Object(refresh_entry(kind, e, t));
                changed |= now != *entry;
                *entry = now;
            }
        }
    }
    let next = if changed { serde_json::to_string_pretty(&root).ok().map(|s| s + "\n") } else { None };
    answer(if found { Status::Yes } else { Status::No }, next)
}

// ── TOML settings (Codex, Grok Build) ────────────────────────────────────────

/// The name parts of a `[table]` line. Quotes, spaces and a trailing comment allowed.
pub fn toml_header(line: &str) -> Option<Vec<String>> {
    let whole = re!(r#"^\s*\[\[?\s*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*\]\]?\s*(?:#.*)?$"#);
    let part = re!(r#""[^"]*"|'[^']*'|[A-Za-z0-9_-]+"#);
    let name = whole.captures(line)?.get(1)?.as_str().to_string();
    Some(part.find_iter(&name)
        .map(|p| p.as_str().trim_matches(|c| c == '"' || c == '\'').to_string())
        .collect())
}

fn is_our_table(h: &[String]) -> bool {
    h.len() == 2 && h[0] == "mcp_servers" && OUR_KEYS.contains(&h[1].as_str())
}

/// Our entry written as an inline value or a dotted key, which we do not edit.
pub fn toml_inline_entry(text: &str) -> bool {
    let dotted = re!(r#"(?i)^\s*(?:["']?mcp_servers["']?\s*\.\s*)?["']?pinako["']?\s*[=.]"#);
    let inline = re!(r#"(?i)^\s*["']?mcp_servers["']?\s*=.*pinako"#);
    text.lines().any(|l| dotted.is_match(l) || inline.is_match(l))
}

fn inspect_toml(text: &str, target: Option<&Target>) -> Inspected {
    let mut inside = false;
    let mut found = false;
    let lines: Vec<String> = text.split('\n').map(|line| {
        if let Some(h) = toml_header(line) {
            inside = is_our_table(&h);
            return line.to_string();
        }
        if !inside || line.trim().starts_with('#') || !mentions(line) {
            return line.to_string();
        }
        found = true;
        target.map_or_else(|| line.to_string(), |t| swap_urls(line, t))
    }).collect();
    if !found {
        let hidden = toml_inline_entry(text) && mentions(text);
        return answer(if hidden { Status::Unreadable } else { Status::No }, None);
    }
    let next = lines.join("\n");
    answer(Status::Yes, Some(next).filter(|n| n != text))
}

// ── YAML settings (Hermes, Continue.dev) ─────────────────────────────────────

fn inspect_hermes(text: &str, target: Option<&Target>) -> Inspected {
    let top = re!(r#"^["']?mcp_servers["']?\s*:(.*)$"#);
    let child = re!(r#"^["']?[Pp]inako["']?\s*:"#);
    let (mut in_block, mut inside, mut found, mut flow) = (false, false, false, false);
    let mut child_indent: Option<usize> = None;
    let lines: Vec<String> = text.split('\n').map(|line| {
        let bare = line.trim();
        if bare.is_empty() || bare.starts_with('#') {
            return line.to_string();
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            let m = top.captures(bare);
            in_block = m.is_some();
            flow |= m.and_then(|c| c.get(1)).is_some_and(|r| r.as_str().to_lowercase().contains("pinako"));
            child_indent = None;
            inside = false;
            return line.to_string();
        }
        if !in_block {
            return line.to_string();
        }
        if indent <= *child_indent.get_or_insert(indent) {
            inside = child.is_match(bare);
        }
        if !inside || !mentions(line) {
            return line.to_string();
        }
        found = true;
        target.map_or_else(|| line.to_string(), |t| swap_urls(line, t))
    }).collect();
    if !found {
        return answer(if flow && mentions(text) { Status::Unreadable } else { Status::No }, None);
    }
    let next = lines.join("\n");
    answer(Status::Yes, Some(next).filter(|n| n != text))
}

/// Continue's file is ours alone: any Bridge address in it counts.
fn inspect_own_yaml(text: &str, target: Option<&Target>) -> Inspected {
    if !text.split('\n').any(|l| !l.trim().starts_with('#') && mentions(l)) {
        return answer(Status::No, None);
    }
    let next = target.map(|t| swap_urls(text, t)).filter(|n| n != text);
    answer(Status::Yes, next)
}

// ── The one entry point ──────────────────────────────────────────────────────

/// `kind`: a client id, or "continue-json" for Continue's old config.json.
/// Without a target only the status is worked out.
pub fn inspect(kind: &str, text: &str, target: Option<&Target>) -> Inspected {
    match kind {
        "codex" | "grok" => inspect_toml(text, target),
        "hermes" => inspect_hermes(text, target),
        "continue" => inspect_own_yaml(text, target),
        _ => inspect_json(kind, text, target),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_cases() {
        let cases: Value = serde_json::from_str(include_str!("../../../tests/connections-cases.json")).unwrap();
        let t = &cases["target"];
        let target = Target {
            url: t["url"].as_str().unwrap().into(),
            token: t["token"].as_str().unwrap().into(),
            service: t["service"].as_str().unwrap().into(),
        };
        for c in cases["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let kind = c["kind"].as_str().unwrap();
            let text = match &c["text"] {
                Value::String(s) => s.clone(),
                v => v.to_string(),
            };
            let got = inspect(kind, &text, Some(&target));
            let want = match c["status"].as_str().unwrap() {
                "yes" => Status::Yes,
                "no" => Status::No,
                _ => Status::Unreadable,
            };
            assert_eq!(got.status, want, "{name}");
            assert_eq!(inspect(kind, &text, None).status, want, "{name}: status alone");
            match &c["next"] {
                Value::Null => assert_eq!(got.next, None, "{name}"),
                Value::String(s) => assert_eq!(got.next.as_deref(), Some(s.as_str()), "{name}"),
                v => {
                    let next: Value = serde_json::from_str(&got.next.expect(name)).unwrap();
                    assert_eq!(&next, v, "{name}");
                }
            }
        }
    }
}
