// Prevents a second console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MCP_BASE_URL: &str = "http://127.0.0.1:37421/mcp";
const HOST_NAME: &str = "com.pinako.mcp";

// ── Local access token (ai-todo #67) ─────────────────────────────────────────
// The URL written into every client config carries a machine-local token; the
// bridge treats a tokenless connection as read-only. Rather than reimplement
// token generation here (a third implementation after host.js and
// setup/token.js — three chances to drift on path or format), ask the service
// binary we just installed to create-or-read it and print it.
//
// Resolved once per run so every client in one install gets the same value.
// On failure we fall back to the bare URL: those clients still work read-only,
// which beats failing the whole install.
fn mcp_url_get() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| {
        let service = pinako_dir().join(service_binary_name());
        match std::process::Command::new(&service).arg("--print-token").output() {
            Ok(out) if out.status.success() => {
                let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if token.len() >= 32 && token.chars().all(|c| c.is_ascii_hexdigit()) {
                    format!("{MCP_BASE_URL}?token={token}")
                } else {
                    MCP_BASE_URL.to_string()
                }
            }
            _ => MCP_BASE_URL.to_string(),
        }
    })
    .as_str()
}

// Read-only MCP tools — pre-populated into Cline / Roo Code `autoApprove`
// arrays so the AI client doesn't prompt the user before each call. Limited
// to tools that DO NOT modify user data (reads only). Mirrors the
// readOnlyHint=true set on each tool in pinako-mcp/host.js TOOL_ANNOTATIONS,
// and the READ_ONLY_TOOLS list in pinako-mcp/setup/configure.js. Keep these
// three lists in sync when adding/removing tools.
//
// 2026-05-25 (security review): removed 11 Phase 4.5-F auto-organize tool
// names (auto_organize_bookmarks, apply_heuristic_organize, propose_*,
// refine_folder_outliers, resolve_duplicate_landings, get_organize_state,
// get_observations, record_observation, summarize_organize_results,
// complete_organize_sort). Those MCP tools were deleted when auto-organize
// moved to the extension popup; pre-approving deleted-then-recycled names
// would be a latent privesc surface if any name is ever reused with write
// semantics. Also added search_pinako (was always read-only in host.js).
const READ_ONLY_TOOLS: &[&str] = &[
    "get_tree",
    "search_tabs",
    "search_pinako",
    "list_libraries",
    "get_library",
    "get_main_tree_notes",
    "get_bookmarks",
    "list_browsers",
    "find_duplicates",
    "get_tree_summary",
    "search_docs",
];

// Hardcode once the extension is published to the Chrome Web Store.
// Format: 32 lowercase letters, e.g. "abcdefghijklmnopqrstuvwxyzabcdef"
const PROD_EXT_ID: Option<&str> = Some("clakbccnkfpmpfooiiffomhknnfcodgd");

// The MCP service binary is embedded at compile time.
// build.js runs esbuild+pkg first, so the binary exists before cargo runs.
// `static` (not `const`): the payload is ~90 MB and a `const`'s value may be
// re-materialized during codegen — at opt-level 3 that exhausts LLVM memory.
#[cfg(target_os = "windows")]
static SERVICE_BINARY: &[u8] = include_bytes!("../../../dist/pinako-mcp-service.exe");

#[cfg(target_os = "linux")]
static SERVICE_BINARY: &[u8] = include_bytes!("../../../dist/pinako-mcp-service-linux-x64");

#[cfg(target_os = "macos")]
static SERVICE_BINARY: &[u8] = include_bytes!("../../../dist/pinako-mcp-service-mac-arm64");

// ── Platform paths ────────────────────────────────────────────────────────────

fn home() -> PathBuf {
    dirs::home_dir().expect("could not determine home directory")
}

fn appdata() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join("AppData").join("Roaming"))
    }
    #[cfg(target_os = "linux")]
    {
        home().join(".config")
    }
    #[cfg(target_os = "macos")]
    {
        home().join("Library").join("Application Support")
    }
}

fn pinako_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        appdata().join("Pinako")
    }
    #[cfg(target_os = "linux")]
    {
        home().join(".local").join("share").join("pinako")
    }
    #[cfg(target_os = "macos")]
    {
        home().join("Library").join("Application Support").join("Pinako")
    }
}

fn service_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    { "pinako-mcp-service.exe" }
    #[cfg(not(target_os = "windows"))]
    { "pinako-mcp-service" }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct ClientInfo {
    id:       String,
    label:    String,
    detected: bool,
    note:     Option<String>,
}

fn client(id: &str, label: &str, detect: PathBuf, note: Option<&str>) -> ClientInfo {
    ClientInfo {
        id:       id.into(),
        label:    label.into(),
        detected: detect.exists(),
        note:     note.map(Into::into),
    }
}

fn local_appdata() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home().join("AppData").join("Local"))
    }
    #[cfg(target_os = "linux")]
    { home().join(".local").join("share") }
    #[cfg(target_os = "macos")]
    { home().join("Library").join("Application Support") }
}

/// Locate Claude Desktop's data directory when installed via MSIX (Microsoft Store).
/// MSIX-packaged apps store data under %LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming\Claude.
/// std::path's exists() can fail for MSIX-virtualized paths even when the data is reachable,
/// so detection falls back to checking the package directory directly.
fn find_msix_claude_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let packages = local_appdata().join("Packages");
        if let Ok(entries) = std::fs::read_dir(&packages) {
            for entry in entries.flatten() {
                if let Ok(name) = entry.file_name().into_string() {
                    if name.starts_with("Claude_") {
                        return Some(packages.join(&name)
                            .join("LocalCache").join("Roaming").join("Claude"));
                    }
                }
            }
        }
    }
    None
}

fn detect_claude_desktop(appdata: &Path) -> ClientInfo {
    let traditional = appdata.join("Claude");
    let msix = find_msix_claude_dir();
    ClientInfo {
        id:       "claude-desktop".into(),
        label:    "Claude Desktop".into(),
        detected: traditional.exists() || msix.is_some(),
        note:     None,
    }
}

fn write_claude_desktop_config(path: &Path) -> Result<(), String> {
    let mcp_url = mcp_url_get();
    let mut cfg = read_json(path);
    ensure_obj(&mut cfg, "mcpServers");
    // Claude Desktop only supports stdio MCP servers (command + args).
    // Use the bundled pinako-mcp-service binary in --stdio-mcp mode as a
    // self-contained stdio↔HTTP bridge — no Node.js dependency on the
    // end user's machine.
    let service_path = pinako_dir().join(service_binary_name());
    cfg["mcpServers"]["pinako"] = serde_json::json!({
        "command": service_path.to_string_lossy(),
        "args": ["--stdio-mcp", mcp_url],
    });
    write_json(path, &cfg)
}

// ── Home-dir resolution for clients with env overrides ───────────────────────

fn env_or_home(var: &str, default_leaf: &str) -> PathBuf {
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(default_leaf))
}

fn grok_home() -> PathBuf { env_or_home("GROK_HOME", ".grok") }
fn kimi_code_home() -> PathBuf { env_or_home("KIMI_CODE_HOME", ".kimi-code") }
fn openclaw_home() -> PathBuf { env_or_home("OPENCLAW_STATE_DIR", ".openclaw") }

/// Hermes: HERMES_HOME wins; the native Windows installer uses
/// %LOCALAPPDATA%\hermes rather than the POSIX ~/.hermes, so probe both and
/// prefer whichever exists (LOCALAPPDATA first — it's the Windows default).
fn hermes_home() -> PathBuf {
    if let Some(p) = std::env::var_os("HERMES_HOME") {
        return PathBuf::from(p);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    candidates.push(local_appdata().join("hermes"));
    candidates.push(home().join(".hermes"));
    candidates.iter().find(|p| p.exists()).cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

/// Detect which AI clients are installed on this machine.
#[tauri::command]
fn detect_clients() -> Vec<ClientInfo> {
    let h = home();
    let a = appdata();
    vec![
        client("claude-code", "Claude Code",
            h.join(".claude"), None),
        detect_claude_desktop(&a),
        client("cursor", "Cursor",
            h.join(".cursor"), None),
        client("windsurf", "Windsurf",
            h.join(".codeium").join("windsurf"), None),
        client("antigravity", "Antigravity",
            h.join(".gemini").join("antigravity"), None),
        // Gemini CLI: detect on the settings FILE, not ~/.gemini — that dir
        // also exists on Antigravity-only machines.
        client("gemini-cli", "Gemini CLI",
            h.join(".gemini").join("settings.json"),
            Some("Consumer service retired June 2026; enterprise/API-key installs still work")),
        client("cline", "Cline (VS Code extension)",
            a.join("Code").join("User").join("globalStorage")
             .join("saoudrizwan.claude-dev"), None),
        client("roo-code", "Roo Code (VS Code extension)",
            a.join("Code").join("User").join("globalStorage")
             .join("rooveterinaryinc.roo-cline"),
            Some("Discontinued upstream (May 2026); Zoo Code is the successor")),
        client("zoo-code", "Zoo Code (VS Code extension)",
            a.join("Code").join("User").join("globalStorage")
             .join("zoocodeorganization.zoo-code"), None),
        client("vscode", "VS Code (Copilot agent mode)",
            a.join("Code").join("User"),
            Some("Requires VS Code 1.102+ with Copilot chat enabled")),
        client("continue", "Continue.dev",
            h.join(".continue"),
            Some("Discontinued upstream (acquired by Cursor); existing installs still work")),
        client("codex", "ChatGPT-Codex (app / CLI / IDE)",
            h.join(".codex"),
            Some("Shared by the ChatGPT-Codex desktop app, Codex CLI, and IDE extension. The Windows app may clear the entry on launch (OpenAI bug #24718) — re-run to restore.")),
        client("grok", "Grok Build",
            grok_home(), None),
        client("kimi-code", "Kimi Code",
            kimi_code_home(), None),
        client("openclaw", "OpenClaw",
            openclaw_home(),
            Some("Restart the OpenClaw gateway after install to pick up the new server")),
        client("hermes", "Hermes",
            hermes_home(), None),
    ]
}

// ── Process management ───────────────────────────────────────────────────────

fn kill_service(name: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", name, "/F"])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-f", name])
            .output();
    }
}

/// Run the full installation with the user-selected client IDs.
/// Returns a log of result lines for display in the wizard.
#[tauri::command]
fn install(selected_ids: Vec<String>) -> Result<Vec<String>, String> {
    let mut log = Vec::<String>::new();
    let h = home();
    let a = appdata();
    let pd = pinako_dir();

    // 1. Create Pinako data directory
    std::fs::create_dir_all(&pd)
        .map_err(|e| format!("Failed to create Pinako directory: {e}"))?;

    // 2. Kill any running service before overwriting the binary
    let svc_name = service_binary_name();
    let service_path = pd.join(svc_name);
    if service_path.exists() {
        kill_service(svc_name);
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    // 3. Write the embedded service binary
    std::fs::write(&service_path, SERVICE_BINARY)
        .map_err(|e| format!("Failed to install {svc_name}: {e}"))?;

    // On Linux/macOS, set executable permission
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(&service_path, perms)
            .map_err(|e| format!("Failed to set executable permission: {e}"))?;
    }
    log.push("✓  Installed Pinako MCP service".into());

    // 4. Register Chrome native messaging host
    match install_native_host(&pd, &service_path) {
        Ok(())  => log.push("✓  Registered Chrome native messaging host".into()),
        Err(e)  => log.push(format!("⚠  Native host skipped: {e}")),
    }

    // 5. Configure each selected AI client
    for id in &selected_ids {
        match configure_client(id, &h, &a) {
            Ok(())  => log.push(format!("✓  Configured {}", client_label(id))),
            Err(e)  => log.push(format!("⚠  {}: {e}", client_label(id))),
        }
    }

    Ok(log)
}

/// Open a URL in the system default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close the installer window.
#[tauri::command]
fn quit() {
    std::process::exit(0);
}

// ── Native host ───────────────────────────────────────────────────────────────

fn install_native_host(pinako_dir: &Path, service_path: &Path) -> Result<(), String> {
    let ext_id = PROD_EXT_ID
        .map(String::from)
        .or_else(|| std::env::var("PINAKO_EXT_ID").ok())
        .ok_or("Extension ID not set (pending Chrome Web Store publish)")?;

    if ext_id.len() != 32 || !ext_id.chars().all(|c| c.is_ascii_lowercase()) {
        return Err(format!("Invalid extension ID: {ext_id}"));
    }

    // Compute allowed_origins: primary ID + optional dev ID + any IDs already
    // allowed by a previous install. Merging means re-installs never silently
    // revoke access from extensions that worked before.
    let manifest_path = pinako_dir.join("pinako-native-host.json");
    let mut allowed: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    allowed.insert(format!("chrome-extension://{ext_id}/"));
    if let Ok(dev_id) = std::env::var("PINAKO_DEV_EXT_ID") {
        if dev_id.len() == 32 && dev_id.chars().all(|c| c.is_ascii_lowercase()) {
            allowed.insert(format!("chrome-extension://{dev_id}/"));
        }
    }
    if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
        if let Ok(prev) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(arr) = prev.get("allowed_origins").and_then(|v| v.as_array()) {
                for v in arr {
                    if let Some(s) = v.as_str() {
                        // Validate format before keeping: chrome-extension://<32 lowercase>/
                        let valid = s.starts_with("chrome-extension://")
                            && s.ends_with('/')
                            && s.len() == "chrome-extension://".len() + 32 + 1
                            && s["chrome-extension://".len()..s.len() - 1]
                                .chars()
                                .all(|c| c.is_ascii_lowercase());
                        if valid {
                            allowed.insert(s.to_string());
                        }
                    }
                }
            }
        }
    }
    let allowed_vec: Vec<String> = allowed.into_iter().collect();

    // Write host manifest JSON to Pinako data dir
    let manifest = serde_json::json!({
        "name":            HOST_NAME,
        "description":     "Pinako MCP bridge — connects Pinako extension to AI clients",
        "path":            service_path.to_string_lossy(),
        "type":            "stdio",
        "allowed_origins": allowed_vec
    });
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap() + "\n",
    ).map_err(|e| format!("Failed to write native host manifest: {e}"))?;

    // Platform-specific registration
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let reg_path = format!(
            "Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}"
        );
        let (key, _) = hkcu
            .create_subkey(&reg_path)
            .map_err(|e| format!("Registry create_subkey failed: {e}"))?;
        key.set_value("", &manifest_path.to_string_lossy().as_ref())
            .map_err(|e| format!("Registry set_value failed: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        let nm_dirs = [
            home().join(".config").join("google-chrome").join("NativeMessagingHosts"),
            home().join(".config").join("chromium").join("NativeMessagingHosts"),
        ];
        let link_name = format!("{HOST_NAME}.json");
        for nm_dir in &nm_dirs {
            let _ = std::fs::create_dir_all(nm_dir);
            let link_path = nm_dir.join(&link_name);
            let _ = std::fs::remove_file(&link_path);
            let _ = std::os::unix::fs::symlink(&manifest_path, &link_path);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let nm_dirs = [
            home().join("Library").join("Application Support")
                  .join("Google").join("Chrome").join("NativeMessagingHosts"),
            home().join("Library").join("Application Support")
                  .join("Chromium").join("NativeMessagingHosts"),
        ];
        let link_name = format!("{HOST_NAME}.json");
        for nm_dir in &nm_dirs {
            let _ = std::fs::create_dir_all(nm_dir);
            let link_path = nm_dir.join(&link_name);
            let _ = std::fs::remove_file(&link_path);
            let _ = std::os::unix::fs::symlink(&manifest_path, &link_path);
        }
    }

    Ok(())
}

// ── Client configuration ──────────────────────────────────────────────────────

fn client_label(id: &str) -> &str {
    match id {
        "claude-code"    => "Claude Code",
        "claude-desktop" => "Claude Desktop",
        "cursor"         => "Cursor",
        "windsurf"       => "Windsurf",
        "antigravity"    => "Antigravity",
        "gemini-cli"     => "Gemini CLI",
        "cline"          => "Cline",
        "roo-code"       => "Roo Code",
        "zoo-code"       => "Zoo Code",
        "vscode"         => "VS Code",
        "continue"       => "Continue.dev",
        "codex"          => "ChatGPT-Codex",
        "grok"           => "Grok Build",
        "kimi-code"      => "Kimi Code",
        "openclaw"       => "OpenClaw",
        "hermes"         => "Hermes",
        other            => other,
    }
}

fn read_json(path: &Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

// Atomic write: several clients (Cline notably) watch their config file and
// can observe — and act on — a half-written file. Temp file in the same
// directory + rename is atomic on every platform we ship.
fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("pinako-tmp");
    std::fs::write(&tmp, content + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn ensure_obj(v: &mut serde_json::Value, key: &str) {
    if !v[key].is_object() {
        v[key] = serde_json::json!({});
    }
}

/// read_json() above falls back to `{}` on a parse error — fine for the small
/// per-client MCP config files we own outright, fatal for a large stateful file
/// the client owns. Missing/empty → Ok(None) (create it); unparseable → Err
/// (leave it alone). Mirrors readJsonStrict() in setup/configure.js.
fn read_json_strict(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("{} exists but is not valid JSON ({e}) — refusing to overwrite it",
                             path.display()))
}

// ── Claude Code ──────────────────────────────────────────────────────────────
// Claude Code reads MCP servers from ~/.claude.json (local + user scope) or a
// project-root .mcp.json — never from ~/.claude/settings.json, which only holds
// approval flags for .mcp.json servers. Installers wrote settings.json up to
// 2026-07-23; those entries were silently ignored. Prefer the documented CLI,
// which owns the file's schema and locking; merge directly only as a fallback.
// Mirrors the writer in setup/configure.js.

fn run_claude_cli(args: &[&str]) -> bool {
    // Windows resolves the `claude.cmd` npm shim only through a shell.
    #[cfg(target_os = "windows")]
    let out = std::process::Command::new("cmd")
        .arg("/c")
        .arg("claude")
        .args(args)
        .output();
    #[cfg(not(target_os = "windows"))]
    let out = std::process::Command::new("claude").args(args).output();

    matches!(out, Ok(o) if o.status.success())
}

fn configure_claude_code(home: &Path) -> Result<(), String> {
    let mcp_url = mcp_url_get();
    // `claude mcp add` errors when the name is taken; a missing entry makes
    // remove fail harmlessly, so its status is deliberately ignored.
    run_claude_cli(&["mcp", "remove", "pinako", "--scope", "user"]);
    let added = run_claude_cli(&[
        "mcp", "add", "--scope", "user", "--transport", "http", "pinako", mcp_url,
    ]);

    if !added {
        let path = home.join(".claude.json");
        let mut cfg = read_json_strict(&path)?.unwrap_or_else(|| serde_json::json!({}));
        ensure_obj(&mut cfg, "mcpServers");
        cfg["mcpServers"]["pinako"] = serde_json::json!({ "type": "http", "url": mcp_url });
        write_json(&path, &cfg)?;
    }

    prune_stale_claude_settings_entry(home);
    Ok(())
}

/// Drop the entry earlier installers wrote to the file Claude Code ignores.
fn prune_stale_claude_settings_entry(home: &Path) {
    let path = home.join(".claude").join("settings.json");
    // An unparseable settings.json is the user's business, not ours.
    let Ok(Some(mut cfg)) = read_json_strict(&path) else { return };
    if !cfg["mcpServers"]["pinako"].is_object() {
        return;
    }
    if let Some(servers) = cfg["mcpServers"].as_object_mut() {
        servers.remove("pinako");
        if servers.is_empty() {
            if let Some(root) = cfg.as_object_mut() {
                root.remove("mcpServers");
            }
        }
    }
    let _ = write_json(&path, &cfg);
}

// ── Antigravity ──────────────────────────────────────────────────────────────
// Global MCP config is ~/.gemini/config/mcp_config.json; current builds migrate
// the old per-tool ~/.gemini/antigravity path forward. HTTP entries use
// `serverUrl` — `url` and `httpUrl` are explicitly unsupported.

fn write_antigravity_config(path: &Path) -> Result<(), String> {
    let mcp_url = mcp_url_get();
    let mut cfg = read_json(path);
    ensure_obj(&mut cfg, "mcpServers");
    cfg["mcpServers"]["pinako"] = serde_json::json!({ "serverUrl": mcp_url });
    write_json(path, &cfg)
}

fn configure_client(id: &str, home: &Path, appdata: &Path) -> Result<(), String> {
    let mcp_url = mcp_url_get();
    match id {
        "claude-code" => configure_claude_code(home),
        "claude-desktop" => {
            let mut errs: Vec<String> = Vec::new();
            let mut wrote = false;

            // Traditional installer location (used by Anthropic's standalone .exe install)
            let trad = appdata.join("Claude").join("claude_desktop_config.json");
            match write_claude_desktop_config(&trad) {
                Ok(()) => wrote = true,
                Err(e) => errs.push(format!("traditional: {e}")),
            }

            // MSIX (Microsoft Store) install also gets configured if present
            if let Some(msix_dir) = find_msix_claude_dir() {
                let msix = msix_dir.join("claude_desktop_config.json");
                match write_claude_desktop_config(&msix) {
                    Ok(()) => wrote = true,
                    Err(e) => errs.push(format!("msix: {e}")),
                }
            }

            if wrote { Ok(()) } else { Err(errs.join("; ")) }
        }
        "cursor" => {
            let path = home.join(".cursor").join("mcp.json");
            let mut cfg = read_json(&path);
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({ "url": mcp_url });
            write_json(&path, &cfg)
        }
        "windsurf" => {
            let path = home.join(".codeium").join("windsurf").join("mcp_config.json");
            let mut cfg = read_json(&path);
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({ "url": mcp_url });
            write_json(&path, &cfg)
        }
        "antigravity" => {
            write_antigravity_config(
                &home.join(".gemini").join("config").join("mcp_config.json"))?;
            // Refresh the pre-migration per-tool path too, but only when it
            // already exists — creating it on a current build would leave an
            // orphan file that nothing reads.
            let legacy = home.join(".gemini").join("antigravity").join("mcp_config.json");
            if legacy.exists() {
                write_antigravity_config(&legacy)?;
            }
            Ok(())
        }
        "cline" => {
            // `type` is load-bearing: omitting it selects Cline's legacy SSE
            // transport — wrong protocol for our streamable-HTTP endpoint.
            // Cline 4.1.x A/B-tests two bundles per window that read
            // DIFFERENT paths (legacy → globalStorage, next/SDK → the
            // ~/.cline file shared with the Cline CLI and JetBrains); the
            // flag is remote and can flip on any reload, so write both.
            let entry = serde_json::json!({
                "type": "streamableHttp",
                "url": mcp_url, "disabled": false, "autoApprove": READ_ONLY_TOOLS
            });
            let paths = [
                appdata
                    .join("Code").join("User").join("globalStorage")
                    .join("saoudrizwan.claude-dev").join("settings")
                    .join("cline_mcp_settings.json"),
                home.join(".cline").join("data").join("settings")
                    .join("cline_mcp_settings.json"),
            ];
            for path in &paths {
                let mut cfg = read_json(path);
                ensure_obj(&mut cfg, "mcpServers");
                cfg["mcpServers"]["pinako"] = entry.clone();
                write_json(path, &cfg)?;
            }
            Ok(())
        }
        // Roo Code (discontinued 2026-05-15; kept for existing installs) and
        // its successor fork Zoo Code share a schema: an explicit hyphenated
        // `type` is REQUIRED for url servers (Roo throws without it), and the
        // auto-approve field is `alwaysAllow`, NOT Cline's `autoApprove`.
        "roo-code" => {
            let path = appdata
                .join("Code").join("User").join("globalStorage")
                .join("rooveterinaryinc.roo-cline").join("settings")
                .join("mcp_settings.json");
            let mut cfg = read_json(&path);
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({
                "type": "streamable-http",
                "url": mcp_url, "disabled": false, "alwaysAllow": READ_ONLY_TOOLS
            });
            write_json(&path, &cfg)
        }
        "zoo-code" => {
            let path = appdata
                .join("Code").join("User").join("globalStorage")
                .join("zoocodeorganization.zoo-code").join("settings")
                .join("mcp_settings.json");
            let mut cfg = read_json(&path);
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({
                "type": "streamable-http",
                "url": mcp_url, "disabled": false, "alwaysAllow": READ_ONLY_TOOLS
            });
            write_json(&path, &cfg)
        }
        "vscode" => {
            // Prefer `code --add-mcp`: it writes to the ACTIVE profile (a
            // file written to User/mcp.json is invisible to users running a
            // named profile) and lets VS Code own its JSONC parsing. Fallback
            // merges the default profile's mcp.json — top-level key is
            // `servers`, NOT `mcpServers`.
            if !run_code_add_mcp() {
                let path = appdata.join("Code").join("User").join("mcp.json");
                let mut cfg = read_json_strict(&path)?
                    .unwrap_or_else(|| serde_json::json!({}));
                ensure_obj(&mut cfg, "servers");
                cfg["servers"]["pinako"] =
                    serde_json::json!({ "type": "http", "url": mcp_url });
                write_json(&path, &cfg)?;
            }
            Ok(())
        }
        "gemini-cli" => {
            // ~/.gemini/settings.json is Gemini CLI's main settings file
            // (auth, prefs) — strict read so a corrupt file is refused.
            // Streamable HTTP uses `httpUrl` (`url` means SSE here, and
            // Antigravity's `serverUrl` file does not serve this CLI).
            let path = home.join(".gemini").join("settings.json");
            let mut cfg = read_json_strict(&path)?
                .unwrap_or_else(|| serde_json::json!({}));
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({ "httpUrl": mcp_url });
            write_json(&path, &cfg)
        }
        "grok" => {
            // Same [mcp_servers.pinako] TOML shape as Codex; `enabled = true`
            // matches the bundled docs' convention for url-form servers.
            upsert_pinako_toml_table(
                &grok_home().join("config.toml"),
                &[&format!("url = \"{mcp_url}\""), "enabled = true"])
        }
        "kimi-code" => {
            // Dedicated mcp.json (Claude-Desktop-compatible shape); a bare
            // `url` with no `transport` key is treated as streamable HTTP.
            let path = kimi_code_home().join("mcp.json");
            let mut cfg = read_json(&path);
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({ "url": mcp_url });
            write_json(&path, &cfg)
        }
        "openclaw" => {
            // openclaw.json is the MAIN gateway config (channels, auth,
            // plugins, agents) — strict read so a corrupt file is refused,
            // never replaced. Transport is NOT inferred from `url` here;
            // "streamable-http" must be explicit.
            let path = openclaw_home().join("openclaw.json");
            let mut cfg = read_json_strict(&path)?
                .unwrap_or_else(|| serde_json::json!({}));
            ensure_obj(&mut cfg, "mcp");
            if !cfg["mcp"]["servers"].is_object() {
                cfg["mcp"]["servers"] = serde_json::json!({});
            }
            cfg["mcp"]["servers"]["pinako"] = serde_json::json!({
                "url": mcp_url, "transport": "streamable-http", "enabled": true
            });
            write_json(&path, &cfg)
        }
        "hermes" => upsert_hermes_yaml(&hermes_home().join("config.yaml")),
        "continue" => {
            // Standalone MCP block file the IDE extensions auto-discover. We
            // own this file outright, so a plain overwrite is idempotent and
            // can never clobber the user's config.yaml. (The previous writer
            // targeted config.json's experimental key, which Continue ignores
            // once config.yaml exists — a silent no-op in practice. Continue
            // itself is frozen upstream: acquired by Cursor, final 2.0.0.)
            let path = home.join(".continue").join("mcpServers").join("pinako.yaml");
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let yaml = format!(
                "name: Pinako\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: Pinako\n    type: streamable-http\n    url: {mcp_url}\n"
            );
            std::fs::write(&path, yaml).map_err(|e| e.to_string())
        }
        "codex" => {
            upsert_pinako_toml_table(
                &home.join(".codex").join("config.toml"),
                &[&format!("url = \"{mcp_url}\""), "startup_timeout_sec = 20"])
        }
        other => Err(format!("Unknown client id: {other}")),
    }
}

// ── Codex TOML config ──────────────────────────────────────────────────────────
// Codex stores MCP servers in ~/.codex/config.toml, shared by the CLI, the IDE
// extension, and the desktop app. The file is usually hand-maintained (model
// prefs, plugins, other MCP servers, comments), so we do a format-preserving
// targeted edit — rewrite ONLY the [mcp_servers.pinako] table (and any of its
// sub-tables) and leave every other byte untouched. Mirrors the JS writer in
// pinako-mcp/setup/configure.js. A `url` field makes Codex treat it as a
// streamable-HTTP server automatically; no experimental flag is written (an
// unrecognized key would break Codex's --strict-config).

const PINAKO_TABLE: &str = "mcp_servers.pinako";

fn strip_toml_table(toml: &str, table: &str) -> String {
    let nl = if toml.contains("\r\n") { "\r\n" } else { "\n" };
    let sub_prefix = format!("{table}.");
    let mut out: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in toml.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let name = trimmed.trim_matches(|c| c == '[' || c == ']').trim();
            skipping = name == table || name.starts_with(&sub_prefix);
            if skipping { continue; } // drop the table header itself
        }
        if skipping { continue; }     // drop lines belonging to the skipped table
        out.push(line);
    }
    out.join(nl)
}

/// Drop any prior pinako table (idempotent re-install), then append a fresh
/// canonical block with the given body lines. Shared by Codex and Grok Build.
fn upsert_pinako_toml_table(path: &Path, body_lines: &[&str]) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let nl = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let stripped = strip_toml_table(&existing, PINAKO_TABLE);
    let stripped = stripped.trim_end();
    let block = format!("[{PINAKO_TABLE}]{nl}{}", body_lines.join(nl));
    let next = if stripped.is_empty() {
        format!("{block}{nl}")
    } else {
        format!("{stripped}{nl}{nl}{block}{nl}")
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, next).map_err(|e| e.to_string())
}

/// `code --add-mcp '<json>'` upserts into the active VS Code profile's
/// mcp.json. Same .cmd-shim spawn rules as the claude CLI.
fn run_code_add_mcp() -> bool {
    let mcp_url = mcp_url_get();
    let entry = serde_json::json!({ "name": "pinako", "type": "http", "url": mcp_url })
        .to_string();
    #[cfg(target_os = "windows")]
    let out = std::process::Command::new("cmd")
        .args(["/c", "code", "--add-mcp", &entry])
        .output();
    #[cfg(not(target_os = "windows"))]
    let out = std::process::Command::new("code")
        .args(["--add-mcp", &entry])
        .output();
    matches!(out, Ok(o) if o.status.success())
}

// ── Hermes YAML (textual surgery) ────────────────────────────────────────────
// Hermes config is a large user-owned YAML we must not re-serialize (comments,
// anchors, _config_version). Three recognized cases, mirroring the JS writer:
// no `mcp_servers:` key → append block at EOF; a bare `mcp_servers:` (or
// `mcp_servers: {}`) line → replace any existing pinako child, insert ours
// matching the block's existing child indent; anything else → refuse with a
// manual hint. YAML forbids tabs in indentation, so space-math is safe.

fn upsert_hermes_yaml(path: &Path) -> Result<(), String> {
    let mcp_url = mcp_url_get();
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<String> = if text.is_empty() {
        Vec::new()
    } else {
        text.split(['\n']).map(|l| l.trim_end_matches('\r').to_string()).collect()
    };

    // Matches `mcp_servers:` / `mcp_servers: {}`, optionally comment-trailed —
    // the JS writer's /^mcp_servers:\s*(\{\s*\}\s*)?(#.*)?$/ equivalent.
    let is_open_header = |l: &str| -> bool {
        let Some(rest) = l.strip_prefix("mcp_servers:") else { return false };
        let no_comment = rest.split('#').next().unwrap_or("").trim();
        no_comment.is_empty() || no_comment.replace(' ', "") == "{}"
    };

    let idx = lines.iter().position(|l| is_open_header(l));
    let Some(idx) = idx else {
        if lines.iter().any(|l| l.starts_with("mcp_servers:")) {
            return Err(format!(
                "config.yaml declares mcp_servers in a format this installer does not edit — \
                 add this entry manually: mcp_servers: {{ pinako: {{ url: \"{mcp_url}\" }} }}"));
        }
        let block = format!(
            "mcp_servers:{nl}  pinako:{nl}    url: \"{mcp_url}\"{nl}    enabled: true{nl}");
        let base = text.trim_end();
        let next = if base.is_empty() {
            block
        } else {
            format!("{base}{nl}{nl}{block}")
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        return std::fs::write(path, next).map_err(|e| e.to_string());
    };

    let mut lines = lines;
    // Normalize `mcp_servers: {}` into an open block.
    if lines[idx].contains('{') {
        lines[idx] = "mcp_servers:".to_string();
    }

    // The block runs until the next non-blank line at column 0.
    let mut end = idx + 1;
    while end < lines.len() {
        let l = &lines[end];
        if !l.is_empty() && !l.starts_with(' ') { break; }
        end += 1;
    }

    // Siblings must share indentation — reuse the block's existing indent.
    let indent: String = lines[idx + 1..end].iter()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.chars().take_while(|c| *c == ' ').collect())
        .unwrap_or_else(|| "  ".to_string());

    // Drop any existing pinako child (its header + every deeper line).
    let mut kept: Vec<String> = Vec::new();
    let mut skipping = false;
    for l in &lines[idx + 1..end] {
        let header = format!("{indent}pinako:");
        let after = l.strip_prefix(header.as_str()).map(str::trim);
        if matches!(after, Some(rest) if rest.is_empty() || rest.starts_with('#')) {
            skipping = true;
            continue;
        }
        if skipping {
            let line_indent = l.chars().take_while(|c| *c == ' ').count();
            if l.trim().is_empty() || line_indent > indent.len() { continue; }
            skipping = false;
        }
        kept.push(l.clone());
    }

    let child_indent = format!("{indent}{indent}");
    let mut next_lines: Vec<String> = lines[..idx + 1].to_vec();
    next_lines.push(format!("{indent}pinako:"));
    next_lines.push(format!("{child_indent}url: \"{mcp_url}\""));
    next_lines.push(format!("{child_indent}enabled: true"));
    next_lines.extend(kept);
    next_lines.extend_from_slice(&lines[end..]);

    let next = format!("{}{nl}", next_lines.join(nl).trim_end());
    std::fs::write(path, next).map_err(|e| e.to_string())
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            detect_clients,
            install,
            open_url,
            quit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pinako installer");
}
