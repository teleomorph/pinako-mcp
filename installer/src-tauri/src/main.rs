// Prevents a second console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};

const MCP_URL:   &str = "http://127.0.0.1:37421/mcp";
const HOST_NAME: &str = "com.pinako.mcp";

// Hardcode once the extension is published to the Chrome Web Store.
// Format: 32 lowercase letters, e.g. "abcdefghijklmnopqrstuvwxyzabcdef"
const PROD_EXT_ID: Option<&str> = Some("clakbccnkfpmpfooiiffomhknnfcodgd");

// The MCP service binary is embedded at compile time.
// build.js runs esbuild+pkg first, so the binary exists before cargo runs.
#[cfg(target_os = "windows")]
const SERVICE_BINARY: &[u8] = include_bytes!("../../../dist/pinako-mcp-service.exe");

#[cfg(target_os = "linux")]
const SERVICE_BINARY: &[u8] = include_bytes!("../../../dist/pinako-mcp-service-linux-x64");

#[cfg(target_os = "macos")]
const SERVICE_BINARY: &[u8] = include_bytes!("../../../dist/pinako-mcp-service-mac-arm64");

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
    let mut cfg = read_json(path);
    ensure_obj(&mut cfg, "mcpServers");
    // Claude Desktop only supports stdio MCP servers (command + args).
    // Use the bundled pinako-mcp-service binary in --stdio-mcp mode as a
    // self-contained stdio↔HTTP bridge — no Node.js dependency on the
    // end user's machine.
    let service_path = pinako_dir().join(service_binary_name());
    cfg["mcpServers"]["pinako"] = serde_json::json!({
        "command": service_path.to_string_lossy(),
        "args": ["--stdio-mcp", MCP_URL],
    });
    write_json(path, &cfg)
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
        client("cline", "Cline (VS Code extension)",
            a.join("Code").join("User").join("globalStorage")
             .join("saoudrizwan.claude-dev"), None),
        client("roo-code", "Roo Code (VS Code extension)",
            a.join("Code").join("User").join("globalStorage")
             .join("rooveterinaryinc.roo-cline"), None),
        client("continue", "Continue.dev",
            h.join(".continue"),
            Some("HTTP transport requires Continue.dev v0.9.210+")),
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
        "cline"          => "Cline",
        "roo-code"       => "Roo Code",
        "continue"       => "Continue.dev",
        other            => other,
    }
}

fn read_json(path: &Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, content + "\n").map_err(|e| e.to_string())
}

fn ensure_obj(v: &mut serde_json::Value, key: &str) {
    if !v[key].is_object() {
        v[key] = serde_json::json!({});
    }
}

fn configure_client(id: &str, home: &Path, appdata: &Path) -> Result<(), String> {
    match id {
        "claude-code" => {
            let path = home.join(".claude").join("settings.json");
            let mut cfg = read_json(&path);
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({ "type": "http", "url": MCP_URL });
            write_json(&path, &cfg)
        }
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
            cfg["mcpServers"]["pinako"] = serde_json::json!({ "url": MCP_URL });
            write_json(&path, &cfg)
        }
        "windsurf" => {
            let path = home.join(".codeium").join("windsurf").join("mcp_config.json");
            let mut cfg = read_json(&path);
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({ "url": MCP_URL });
            write_json(&path, &cfg)
        }
        "cline" => {
            let path = appdata
                .join("Code").join("User").join("globalStorage")
                .join("saoudrizwan.claude-dev").join("settings")
                .join("cline_mcp_settings.json");
            let mut cfg = read_json(&path);
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({
                "url": MCP_URL, "disabled": false, "autoApprove": []
            });
            write_json(&path, &cfg)
        }
        "roo-code" => {
            let path = appdata
                .join("Code").join("User").join("globalStorage")
                .join("rooveterinaryinc.roo-cline").join("settings")
                .join("mcp_settings.json");
            let mut cfg = read_json(&path);
            ensure_obj(&mut cfg, "mcpServers");
            cfg["mcpServers"]["pinako"] = serde_json::json!({
                "url": MCP_URL, "disabled": false, "autoApprove": []
            });
            write_json(&path, &cfg)
        }
        "continue" => {
            let path = home.join(".continue").join("config.json");
            let mut cfg = read_json(&path);
            if !cfg["experimental"].is_object() {
                cfg["experimental"] = serde_json::json!({});
            }
            let existing = cfg["experimental"]["modelContextProtocolServers"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            // Remove stale pinako entry, then append fresh one
            let mut servers: Vec<_> = existing.into_iter()
                .filter(|s| {
                    s.get("transport")
                        .and_then(|t| t.get("url"))
                        .and_then(|u| u.as_str())
                        != Some(MCP_URL)
                })
                .collect();
            servers.push(serde_json::json!({
                "transport": { "type": "streamableHttp", "url": MCP_URL }
            }));
            cfg["experimental"]["modelContextProtocolServers"] =
                serde_json::Value::Array(servers);
            write_json(&path, &cfg)
        }
        other => Err(format!("Unknown client id: {other}")),
    }
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
