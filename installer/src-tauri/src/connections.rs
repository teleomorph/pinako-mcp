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
const SERVICE_NAME: &str = "pinako-mcp-service";

/// What a refreshed entry should carry.
pub struct Target {
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

macro_rules! address {
    () => { r#"http://(?:127\.0\.0\.1|localhost|\[::1\]):37421(?:[/?][^\s"'`\\<>]*)?"# };
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

// And only as a WHOLE value: an address inside another one, a comment or a note
// is not where an entry connects to.

fn is_address(s: &str) -> bool {
    re!(concat!("^", address!(), "$")).is_match(s)
}

/// One Bridge address with the current key. Only the key changes: the path may
/// pick a tool profile, and the host spelling is the person's. A key they take
/// from their own ${NAME} is left as written.
pub fn with_key(was: &str, t: &Target) -> String {
    let (base, query) = was.split_once('?').unwrap_or((was, ""));
    let parts: Vec<&str> = query.split('&').filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| p.starts_with("token=${")) {
        return was.to_string();
    }
    let path = if base.ends_with(":37421") { "/mcp" } else if base.ends_with(":37421/") { "mcp" } else { "" };
    let mut out = format!("{base}{path}?token={}", t.token);
    for p in parts.iter().filter(|p| !p.starts_with("token=")) {
        out.push('&');
        out.push_str(p);
    }
    out
}

/// The quoted addresses in one line of settings made current: whether there were any, and the line.
fn key_quoted(line: &str, target: Option<&Target>) -> (bool, String) {
    let quoted = re!(concat!("\"(", address!(), ")\"|'(", address!(), ")'"));
    let found = quoted.is_match(line);
    let Some(t) = target else { return (found, line.to_string()) };
    let next = quoted.replace_all(line, |c: &regex::Captures| {
        let q = &c[0][..1];
        let was = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
        format!("{q}{}{q}", with_key(was, t))
    });
    (found, next.into_owned())
}

fn is_service(s: &str) -> bool {
    let s = s.to_lowercase();
    s.ends_with(SERVICE_NAME) || s.ends_with("pinako-mcp-service.exe")
}

fn mentions(s: &str) -> bool {
    re!(address!()).is_match(s) || s.to_lowercase().contains(SERVICE_NAME)
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
    URL_KEYS.iter().copied().find(|k| is_address(str_of(e, k)))
}

pub fn is_our_entry(v: &Value) -> bool {
    let Some(e) = v.as_object() else { return false };
    // An entry that also names another server is not ours to change.
    if URL_KEYS.iter().any(|k| !str_of(e, k).is_empty() && !is_address(str_of(e, k))) {
        return false;
    }
    our_url_key(e).is_some()
        || is_service(str_of(e, "command"))
        || e.get("args").and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|x| x.as_str().is_some_and(is_address)))
}

fn refresh_entry(kind: &str, e: &Map<String, Value>, t: &Target) -> Map<String, Value> {
    let Some(key) = our_url_key(e) else {
        let mut out = e.clone();
        if is_service(str_of(e, "command")) {
            out.insert("command".into(), json!(t.service));
        }
        if let Some(args) = out.get_mut("args").and_then(Value::as_array_mut) {
            for a in args {
                let now = a.as_str().filter(|s| is_address(s)).map(|s| with_key(s, t));
                if let Some(now) = now {
                    *a = json!(now);
                }
            }
        }
        return out;
    };
    let now = with_key(str_of(e, key), t);
    // Windsurf reads either spelling: keep the person's.
    let want = if kind == "windsurf" {
        Map::from_iter([(key.to_string(), json!(now))])
    } else {
        shape(kind, &now, t)
    };
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
            let Some(was) = url.as_str().filter(|u| is_address(u)).map(String::from) else { continue };
            found = true;
            if let Some(t) = target {
                let now = with_key(&was, t);
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
    let whole = re!(r#"^\s*\[\[?\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'.,=#\[\]]+)(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'.,=#\[\]]+))*)\s*\]\]?\s*(?:#.*)?$"#);
    let part = re!(r#""(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'.,=#\[\]]+"#);
    let name = whole.captures(line.trim_start_matches('\u{feff}'))?.get(1)?.as_str().to_string();
    Some(part.find_iter(&name)
        .map(|p| p.as_str().trim_matches(|c| c == '"' || c == '\'').to_string())
        .collect())
}

fn is_our_table(h: &[String]) -> bool {
    h.len() == 2 && h[0] == "mcp_servers" && OUR_KEYS.contains(&h[1].as_str())
}

/// For each line: does it start inside a multi-line string, where nothing is a table or a key?
pub fn toml_string_lines(text: &str) -> Vec<bool> {
    let mut out = Vec::new();
    let mut open: Option<&str> = None; // the quote a string was opened with
    for line in text.split('\n') {
        out.push(open.is_some());
        let mut rest = line;
        while let Some(c) = rest.chars().next() {
            let mut step = c.len_utf8();
            match open {
                None if c == '#' => break,
                None => {
                    if let Some(q) = ["\"\"\"", "'''", "\"", "'"].into_iter().find(|q| rest.starts_with(q)) {
                        open = Some(q);
                        step = q.len();
                    }
                }
                Some(q) if q.starts_with('"') && c == '\\' => {
                    step += rest[step..].chars().next().map_or(0, char::len_utf8);
                }
                Some(q) if rest.starts_with(q) => {
                    open = None;
                    step = q.len();
                    // Up to two more quotes right here are the string's own last characters.
                    if q.len() == 3 {
                        step += rest[step..].bytes().take(2).take_while(|b| *b == q.as_bytes()[0]).count();
                    }
                }
                Some(_) => {}
            }
            rest = &rest[step..];
        }
        if open.is_some_and(|q| q.len() == 1) {
            open = None; // a plain string ends with its line
        }
    }
    out
}

fn toml_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n').zip(toml_string_lines(text)).filter(|(_, masked)| !masked).map(|(l, _)| l)
}

/// Our entry written as an inline value or a dotted key, which we do not edit.
pub fn toml_inline_entry(text: &str) -> bool {
    let dotted = re!(r#"(?i)^\s*(?:["']?mcp_servers["']?\s*\.\s*)?["']?pinako["']?\s*[=.]"#);
    let inline = re!(r#"(?i)^\s*["']?mcp_servers["']?\s*=.*pinako"#);
    toml_lines(text).any(|l| dotted.is_match(l) || inline.is_match(l))
}

/// A servers map written on one line: a table of ours cannot be added to it.
pub fn toml_inline_map(text: &str) -> bool {
    toml_lines(text).any(|l| re!(r#"^\s*["']?mcp_servers["']?\s*="#).is_match(l))
}

/// A line's own text and the comment after it.
fn split_note(line: &str) -> (&str, &str) {
    line.split_at(re!(r"\s#").find(line).map_or(line.len(), |m| m.start()))
}

fn inspect_toml(text: &str, target: Option<&Target>) -> Inspected {
    let field = re!(r"^\s*(url|args|command)\s*=(.*)$");
    let one = re!(concat!("^(?:\"", address!(), "\"|'", address!(), "')$"));
    let (mut inside, mut found, mut hidden) = (false, false, false);
    let lines: Vec<String> = text.split('\n').zip(toml_string_lines(text)).map(|(line, masked)| {
        if masked {
            return line.to_string();
        }
        if let Some(h) = toml_header(line) {
            inside = is_our_table(&h);
            return line.to_string();
        }
        if !inside || line.trim().starts_with('#') || !mentions(line) {
            return line.to_string();
        }
        let (code, note) = split_note(line);
        let caps = field.captures(code);
        let key = caps.as_ref().and_then(|c| c.get(1)).map_or("", |m| m.as_str());
        let value = caps.as_ref().and_then(|c| c.get(2)).map_or("", |m| m.as_str()).trim();
        // `url` is one address and nothing else; `args` may hold it among others.
        let (hit, next) = if key == "args" || (key == "url" && one.is_match(value)) {
            key_quoted(code, target)
        } else {
            (false, code.to_string())
        };
        if hit || (key == "command" && mentions(code)) { found = true } else { hidden = true }
        next + note
    }).collect();
    if !found {
        let unseen = hidden || (toml_inline_entry(text) && mentions(text));
        return answer(if unseen { Status::Unreadable } else { Status::No }, None);
    }
    let next = lines.join("\n");
    answer(Status::Yes, Some(next).filter(|n| n != text))
}

// ── YAML settings (Hermes, Continue.dev) ─────────────────────────────────────

fn inspect_hermes(text: &str, target: Option<&Target>) -> Inspected {
    let top = re!(r#"^["']?mcp_servers["']?\s*:(.*)$"#);
    let child = re!(r#"^["']?[Pp]inako["']?\s*:"#);
    let (mut in_block, mut inside, mut found, mut hidden, mut flow) = (false, false, false, false, false);
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
        let (hit, next) = key_yaml(line, target);
        if hit { found = true } else { hidden = true }
        next
    }).collect();
    if !found {
        return answer(if hidden || (flow && mentions(text)) { Status::Unreadable } else { Status::No }, None);
    }
    let next = lines.join("\n");
    answer(Status::Yes, Some(next).filter(|n| n != text))
}

/// A YAML line that gives the address: `url: …`, `- …` in a list, or
/// `Pinako: { url: "…" }` on one line. Whether it does, and the line.
fn key_yaml(line: &str, target: Option<&Target>) -> (bool, String) {
    let value = re!(concat!(r#"^(\s*(?:-\s*)?(?:["']?url["']?\s*:\s*)?)(["']?)("#, address!(), r#")(["']?)(\s*)$"#));
    let (code, note) = split_note(line);
    if let Some(c) = value.captures(code).filter(|c| c[2] == c[4]) {
        let now = target.map_or_else(|| c[3].to_string(), |t| with_key(&c[3], t));
        return (true, format!("{}{}{now}{}{}{note}", &c[1], &c[2], &c[4], &c[5]));
    }
    // Only as far as the address: what follows it is not where the entry connects to.
    let one = re!(concat!(r#"^(\s*["']?[Pp]inako["']?\s*:\s*\{\s*["']?url["']?\s*:\s*(?:""#, address!(), r#""|'"#, address!(), r#"'))\s*[,}]"#));
    let Some(head) = one.captures(code).and_then(|c| c.get(1)).map(|m| m.end()) else {
        return (false, line.to_string());
    };
    let (hit, next) = key_quoted(&code[..head], target);
    (hit, next + &code[head..] + note)
}

/// Continue's file is ours alone: any line of it that gives the address counts.
fn inspect_own_yaml(text: &str, target: Option<&Target>) -> Inspected {
    let mut found = false;
    let lines: Vec<String> = text.split('\n').map(|line| {
        if line.trim().starts_with('#') {
            return line.to_string();
        }
        let (hit, next) = key_yaml(line, target);
        found |= hit;
        next
    }).collect();
    if !found {
        return answer(Status::No, None);
    }
    let next = lines.join("\n");
    answer(Status::Yes, Some(next).filter(|n| n != text))
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
