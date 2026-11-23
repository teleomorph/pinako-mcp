//! Put a new service binary where an old one may be running.
//!
//! The old way (ask the service to stop, wait half a second, overwrite) failed
//! whenever the service had not let go of its file yet, or something started it
//! again in that gap (2026-11-23: "used by another process", os error 32).
//! Windows refuses to overwrite a running exe but lets it be RENAMED, so: write
//! the new one beside it, rename the old one out of the way, move the new one
//! in. Anything that starts from the path after that gets the new one, and only
//! then are the old processes stopped.
//!
//! The text installer does the same in setup/replace-binary.js. Std only, so
//! `rustc --test src/replace.rs` runs the tests without building Tauri.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RENAME_TRIES: u32 = 15;
const DELETE_TRIES: u32 = 10;
const PAUSE: Duration = Duration::from_millis(200);

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.file_name().unwrap_or_default());
    name.push(suffix);
    path.with_file_name(name)
}

// A virus scanner can hold a fresh 90 MB file for a moment.
fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if tries + 1 >= RENAME_TRIES || e.kind() == std::io::ErrorKind::NotFound => return Err(e),
            Err(_) => {
                tries += 1;
                std::thread::sleep(PAUSE);
            }
        }
    }
}

/// Files an earlier run renamed out of the way: `<name>.old-<digits>`, nothing else.
fn old_copies(path: &Path) -> Vec<PathBuf> { numbered(path, ".old-") }

fn numbered(path: &Path, suffix: &str) -> Vec<PathBuf> {
    let prefix = sibling(path, suffix).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let Some(Ok(dir)) = path.parent().map(std::fs::read_dir) else { return Vec::new() };
    dir.flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            name.strip_prefix(&prefix).is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
        })
        .collect()
}

/// Best effort: one still running stays, and the next install takes it.
pub fn delete_old_copies(path: &Path) {
    for old in old_copies(path) {
        for i in 0..DELETE_TRIES {
            if std::fs::remove_file(&old).is_ok() { break; }
            if i + 1 < DELETE_TRIES { std::thread::sleep(PAUSE); }
        }
    }
}

/// An installer closed between the two renames leaves no file at `path` and
/// the working one under its old name: put the newest of those back.
fn recover(path: &Path) {
    if path.exists() { return; }
    let stamp = |p: &PathBuf| -> u128 {
        p.to_string_lossy().rsplit('-').next().and_then(|d| d.parse().ok()).unwrap_or(0)
    };
    if let Some(old) = old_copies(path).into_iter().max_by_key(stamp) { let _ = rename_retry(&old, path); }
}

/// New files an interrupted run never moved in. Only stale ones: a second
/// installer open right now may still be writing its own.
fn delete_stale_new(path: &Path) {
    for p in numbered(path, ".new-") {
        let stale = std::fs::metadata(&p).and_then(|m| m.modified()).ok()
            .and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(3600));
        if stale { let _ = std::fs::remove_file(&p); }
    }
}

/// Write `bytes` at `path`. On any error the file that was there is still there.
pub fn replace_binary(path: &Path, bytes: &[u8]) -> Result<(), String> {
    recover(path);
    delete_stale_new(path);
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    // Its own name each time, and never one that exists: two installers open at
    // once must not write into the same file.
    let fresh = sibling(path, &format!(".new-{}{stamp}", std::process::id()));
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&fresh)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fresh, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&fresh);
        return Err(format!("could not write the new file: {e}"));
    }

    let aside = sibling(path, &format!(".old-{stamp}"));
    let had_old = path.exists();
    if had_old {
        if let Err(e) = rename_retry(path, &aside) {
            let _ = std::fs::remove_file(&fresh);
            return Err(format!("could not move the old file out of the way: {e}"));
        }
    }
    if let Err(e) = rename_retry(&fresh, path) {
        let mut msg = format!("could not move the new file into place: {e}");
        if had_old {
            if let Err(e2) = rename_retry(&aside, path) {
                msg.push_str(&format!("; could not put the old file back: {e2}"));
            }
        }
        let _ = std::fs::remove_file(&fresh);
        return Err(msg);
    }
    Ok(())
}

/// True for `path` itself and for a copy of it renamed out of the way.
fn is_ours(candidate: &str, path: &Path) -> bool {
    let norm = |s: &str| {
        let s = s.strip_prefix(r"\\?\").unwrap_or(s);
        let s = s.strip_suffix(" (deleted)").unwrap_or(s);
        if cfg!(windows) { s.replace('/', "\\").to_lowercase() } else { s.to_string() }
    };
    // The system reports the real path; ours may go through a link (a moved
    // profile, a linked home folder).
    let real = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let c = norm(candidate);
    [path, real.as_path()].iter().any(|p| same_file_name(&c, &norm(&p.to_string_lossy())))
}

fn same_file_name(candidate: &str, ours: &str) -> bool {
    match candidate.strip_prefix(ours) {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix(".old-")
            .is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit())),
        None => false,
    }
}

/// Stop every process running from `path` (or from a renamed-aside copy of it)
/// and wait for each to end. Never by name alone: another copy of the service
/// running from another folder is not ours to stop. Returns false when one of
/// them is still running.
pub fn stop_processes(path: &Path) -> bool {
    imp::stop(path)
}

#[cfg(windows)]
mod imp {
    use super::is_ours;
    use std::ffi::c_void;
    use std::path::Path;

    type Handle = *mut c_void;
    const SNAPPROCESS: u32 = 0x2;
    const TERMINATE: u32 = 0x1;
    const QUERY_LIMITED: u32 = 0x1000;
    const SYNCHRONIZE: u32 = 0x10_0000;
    const WAIT_MS: u32 = 5000;

    #[repr(C)]
    struct ProcessEntry32W {
        size: u32, usage: u32, pid: u32, heap: usize, module: u32,
        threads: u32, parent: u32, pri: i32, flags: u32, exe: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Process32FirstW(snap: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snap: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn QueryFullProcessImageNameW(p: Handle, flags: u32, buf: *mut u16, len: *mut u32) -> i32;
        fn TerminateProcess(p: Handle, code: u32) -> i32;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn CloseHandle(h: Handle) -> i32;
    }

    fn image_path(p: Handle) -> Option<String> {
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        // SAFETY: buf holds len wide characters; len is updated to what was written.
        let ok = unsafe { QueryFullProcessImageNameW(p, 0, buf.as_mut_ptr(), &mut len) };
        (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }

    fn pids() -> Option<Vec<u32>> {
        let mut out = Vec::new();
        // SAFETY: the entry's size field is set before the first call, and the
        // snapshot handle is closed on the way out.
        unsafe {
            let snap = CreateToolhelp32Snapshot(SNAPPROCESS, 0);
            if snap.is_null() || snap as isize == -1 { return None; }
            let mut e: ProcessEntry32W = std::mem::zeroed();
            e.size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut more = Process32FirstW(snap, &mut e);
            while more != 0 {
                if e.pid != 0 && e.pid != std::process::id() { out.push(e.pid); }
                more = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
        }
        Some(out)
    }

    pub fn stop(path: &Path) -> bool {
        let mut all_gone = true;
        let mut stopping = Vec::new();
        let Some(pids) = pids() else { return false };
        for pid in pids {
            // SAFETY: handles are checked, and closed on every path. The query
            // handle stays open past the second OpenProcess, which keeps the
            // pid from being reused in between.
            unsafe {
                let q = OpenProcess(QUERY_LIMITED, 0, pid);
                if q.is_null() { continue; }
                if image_path(q).is_some_and(|p| is_ours(&p, path)) {
                    // Refused when it runs with more rights (an elevated browser).
                    let h = OpenProcess(SYNCHRONIZE | TERMINATE, 0, pid);
                    if h.is_null() {
                        all_gone = false;
                    } else {
                        TerminateProcess(h, 1);
                        stopping.push(h);
                    }
                }
                CloseHandle(q);
            }
        }
        for h in stopping {
            // SAFETY: h was opened above with SYNCHRONIZE and is closed here.
            unsafe {
                if WaitForSingleObject(h, WAIT_MS) != 0 { all_gone = false; }
                CloseHandle(h);
            }
        }
        all_gone
    }
}

#[cfg(not(windows))]
mod imp {
    use super::is_ours;
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    fn ours(path: &Path) -> Option<Vec<String>> {
        #[cfg(target_os = "linux")]
        {
            let dir = std::fs::read_dir("/proc").ok()?;
            Some(dir.flatten()
                .filter(|e| e.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit()))
                .filter(|e| std::fs::read_link(e.path().join("exe")).is_ok_and(|p| is_ours(&p.to_string_lossy(), path)))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect())
        }
        #[cfg(not(target_os = "linux"))]
        {
            let o = Command::new("ps").args(["-axo", "pid=,comm="]).output().ok()?;
            Some(String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().split_once(' ').map(|(p, c)| (p.to_string(), c.trim().to_string())))
                .filter(|(_, c)| is_ours(c, path))
                .map(|(p, _)| p)
                .collect())
        }
    }

    pub fn stop(path: &Path) -> bool {
        for signal in ["-TERM", "-KILL"] {
            let Some(pids) = ours(path) else { return false };
            for pid in pids { let _ = Command::new("kill").args([signal, &pid]).output(); }
            for _ in 0..25 {
                if ours(path).is_some_and(|p| p.is_empty()) { return true; }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        ours(path).is_some_and(|p| p.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};

    fn folder(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pinako-replace-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // A real program that stays up: this test binary itself, told to sleep.
    fn run_copy(at: &Path) -> Child {
        std::fs::copy(std::env::current_exe().unwrap(), at).unwrap();
        let c = Command::new(at)
            .args(["tests::sleeper", "--exact", "--nocapture"])
            .env("PINAKO_REPLACE_SLEEPER", "1")
            .stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        c
    }

    #[test]
    fn sleeper() {
        if std::env::var_os("PINAKO_REPLACE_SLEEPER").is_some() { std::thread::sleep(Duration::from_secs(60)); }
    }

    #[test]
    fn fresh_install_and_over_an_idle_file() {
        let p = folder("plain").join("svc.exe");
        replace_binary(&p, b"one").unwrap();
        replace_binary(&p, b"two").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        delete_old_copies(&p);
        assert!(old_copies(&p).is_empty());
        assert!(numbered(&p, ".new-").is_empty());
    }

    #[test]
    fn an_interrupted_swap_is_put_right() {
        let p = folder("interrupted").join("svc.exe");
        std::fs::write(sibling(&p, ".old-5"), b"older").unwrap();
        std::fs::write(sibling(&p, ".old-40"), b"newest").unwrap();
        recover(&p);
        assert_eq!(std::fs::read(&p).unwrap(), b"newest");
        std::fs::write(sibling(&p, ".new-7"), b"another installer, still writing").unwrap();
        replace_binary(&p, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
        assert!(sibling(&p, ".new-7").exists());
    }

    #[test]
    fn over_a_running_program_then_stops_it_and_only_it() {
        let d = folder("running");
        let p = d.join("svc.exe");
        let other = d.join("svc.exe.mine");
        let mut ours = run_copy(&p);
        let mut theirs = run_copy(&other);
        replace_binary(&p, b"new one").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new one");
        assert!(ours.try_wait().unwrap().is_none(), "the rename itself stopped it");
        // Reaped from another thread, as a real parent would (a zombie on unix
        // would otherwise count as still there).
        let t = std::thread::spawn(move || ours.wait().unwrap());
        assert!(stop_processes(&p));
        t.join().unwrap();
        assert!(theirs.try_wait().unwrap().is_none(), "stopped a program that is not ours");
        let _ = theirs.kill();
        let _ = theirs.wait();
        delete_old_copies(&p);
        assert!(old_copies(&p).is_empty());
    }

    #[test]
    fn a_failed_write_is_reported() {
        // No folder to write into.
        let p = folder("fails").join("gone").join("svc.exe");
        assert!(replace_binary(&p, b"new").is_err());
        assert!(!p.exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_file_locked_by_someone_else_is_reported_and_kept() {
        use std::os::windows::fs::OpenOptionsExt;
        let p = folder("locked").join("svc.exe");
        std::fs::write(&p, b"old").unwrap();
        let lock = std::fs::OpenOptions::new().read(true).share_mode(1).open(&p).unwrap();
        assert!(replace_binary(&p, b"new").is_err());
        drop(lock);
        assert_eq!(std::fs::read(&p).unwrap(), b"old");
        assert!(numbered(&p, ".new-").is_empty());
        replace_binary(&p, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
    }

    #[test]
    fn only_our_own_leftovers_are_swept() {
        let p = folder("sweep").join("svc.exe");
        std::fs::write(&p, b"x").unwrap();
        for n in [".old-123", ".old-", ".old-12x", ".bak", "2.old-9"] { std::fs::write(sibling(&p, n), b"x").unwrap(); }
        delete_old_copies(&p);
        assert!(!sibling(&p, ".old-123").exists());
        for n in [".old-", ".old-12x", ".bak", "2.old-9"] { assert!(sibling(&p, n).exists(), "{n} was deleted"); }
        assert!(p.exists());
    }

    #[test]
    fn whose_process_it_is() {
        let p = if cfg!(windows) { Path::new(r"C:\A\Pinako\svc.exe") } else { Path::new("/a/Pinako/svc.exe") };
        let s = p.to_string_lossy().into_owned();
        assert!(is_ours(&s, p));
        assert!(is_ours(&format!("{s}.old-17"), p));
        assert!(is_ours(&format!("{s}.old-17 (deleted)"), p));
        assert!(!is_ours(&format!("{s}.bak"), p));
        assert!(!is_ours(&format!("{s}.old-x"), p));
        assert!(!is_ours(&s.replace("Pinako", "Other"), p));
        if cfg!(windows) { assert!(is_ours(&s.to_uppercase(), p)); }
    }
}
