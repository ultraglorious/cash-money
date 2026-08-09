//! Native commands the web UI calls via `invoke`. Text-file IO is resolved
//! relative to the app's data directory and written atomically (temp + rename).
//! Zip reading is used by the import flow.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Resolve a caller-relative path against the app data directory.
///
/// The webview must never escape the app data dir: `PathBuf::join` with an
/// absolute path REPLACES the base entirely, and `..` components climb out of
/// it. Reject both so a compromised frontend can't read/write/delete arbitrary
/// files through these commands.
fn resolve(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    if !rel_is_safe(rel) {
        return Err(format!("path escapes the app data directory: {rel}"));
    }
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join(rel))
}

/// True when `rel` is a plain relative path: no root, no drive prefix, no `..`.
fn rel_is_safe(rel: &str) -> bool {
    let p = Path::new(rel);
    !p.is_absolute()
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

#[tauri::command]
pub fn read_text_file(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let full = resolve(&app, &path)?;
    match fs::read_to_string(&full) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn write_text_file(app: AppHandle, path: String, contents: String) -> Result<(), String> {
    let full = resolve(&app, &path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Atomic write: temp file in the same dir, then rename over the target.
    let tmp = full.with_extension("tmp-write");
    fs::write(&tmp, contents.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &full).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_dir(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let full = resolve(&app, &path)?;
    let entries = match fs::read_dir(&full) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

#[tauri::command]
pub fn remove_file(app: AppHandle, path: String) -> Result<(), String> {
    let full = resolve(&app, &path)?;
    match fs::remove_file(&full) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Largest file the absolute-path readers will touch (a full budget export is
/// well under 1 MB; bank statements are tiny).
const MAX_PICKED_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Guard for the absolute-path readers: these exist for files the user chose
/// in the native picker, but nothing binds a call to a picker result — so at
/// minimum require the expected extension and a sane size, narrowing what a
/// compromised webview could pull off the disk.
fn check_picked_file(path: &str, ext: &str) -> Result<(), String> {
    let p = Path::new(path);
    let ok_ext = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext));
    if !ok_ext {
        return Err(format!("expected a .{ext} file: {path}"));
    }
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_PICKED_FILE_BYTES {
        return Err(format!("not a regular file of reasonable size: {path}"));
    }
    Ok(())
}

/// Read a text file at an absolute path (from the file picker, e.g. a bank CSV).
#[tauri::command]
pub fn read_text_abs(path: String) -> Result<String, String> {
    check_picked_file(&path, "csv")?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvMember {
    pub name: String,
    pub content: String,
}

/// Read every `*.csv` member from a zip at an absolute path (from the file
/// picker) and return their names + contents.
#[tauri::command]
pub fn read_zip_csvs(zip_path: String) -> Result<Vec<CsvMember>, String> {
    check_picked_file(&zip_path, "zip")?;
    let file = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name.to_lowercase().ends_with(".csv") {
            let mut content = String::new();
            entry.read_to_string(&mut content).map_err(|e| e.to_string())?;
            out.push(CsvMember { name, content });
        }
    }
    Ok(out)
}

// ---- Single-file budget (.cashmoney) ---------------------------------------
//
// The budget lives as ONE file wherever the user put it (e.g. iCloud Drive),
// chosen through the native save/open dialogs. These commands are the only
// absolute-path writers, gated to the .cashmoney extension. Writes are atomic
// (temp + rename in the same directory) and optionally guarded by the mtime
// the app last saw — if another device's sync changed the file since, the
// write is refused so the app can ask the user instead of clobbering.

const BUDGET_EXT: &str = "cashmoney";

fn check_budget_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    let ok_ext = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(BUDGET_EXT));
    if !p.is_absolute() || !ok_ext {
        return Err(format!("expected an absolute .{BUDGET_EXT} path: {path}"));
    }
    Ok(p.to_path_buf())
}

fn mtime_ms(meta: &fs::Metadata) -> Result<f64, String> {
    let t = meta.modified().map_err(|e| e.to_string())?;
    let d = t
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(d.as_millis() as f64)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetFileRead {
    pub contents: String,
    pub mtime_ms: f64,
}

/// Read the budget file and report the mtime the contents correspond to.
#[tauri::command]
pub fn read_budget_file(path: String) -> Result<BudgetFileRead, String> {
    let p = check_budget_path(&path)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_PICKED_FILE_BYTES {
        return Err(format!("not a regular file of reasonable size: {path}"));
    }
    let contents = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let meta_after = fs::metadata(&p).map_err(|e| e.to_string())?;
    Ok(BudgetFileRead {
        contents,
        mtime_ms: mtime_ms(&meta_after)?,
    })
}

/// Atomically write the budget file. When `expected_mtime_ms` is given and the
/// file on disk has a different mtime, refuse with a "conflict:" error — the
/// file changed since the app last read or wrote it (another device?).
#[tauri::command]
pub fn write_budget_file(
    path: String,
    contents: String,
    expected_mtime_ms: Option<f64>,
) -> Result<f64, String> {
    let p = check_budget_path(&path)?;
    if let Some(expected) = expected_mtime_ms {
        let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
        let current = mtime_ms(&meta)?;
        // Filesystems differ in mtime granularity; allow sub-2ms wobble.
        if (current - expected).abs() > 2.0 {
            return Err(format!(
                "conflict: file changed on disk (mtime {current} vs expected {expected})"
            ));
        }
    }
    let tmp = p.with_extension("cashmoney.tmp-write");
    fs::write(&tmp, contents.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    mtime_ms(&meta)
}

/// Current mtime of the budget file, or null when it doesn't exist.
#[tauri::command]
pub fn stat_budget_file(path: String) -> Result<Option<f64>, String> {
    let p = check_budget_path(&path)?;
    match fs::metadata(&p) {
        Ok(meta) => Ok(Some(mtime_ms(&meta)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Keep a `.bak` sibling of the budget file (called once per session, before
/// the first save, so yesterday's state survives a bad day).
#[tauri::command]
pub fn backup_budget_file(path: String) -> Result<(), String> {
    let p = check_budget_path(&path)?;
    let bak = p.with_extension("cashmoney.bak");
    fs::copy(&p, &bak).map_err(|e| e.to_string())?;
    Ok(())
}

/// Keep a dated copy of the budget before an edit that touches many rows at
/// once, so a bulk mistake is always recoverable.
///
/// The rolling `.bak` sibling is written once per session, which makes it a
/// snapshot of whenever the app happened to open — no use at all if the bulk
/// edit came later in the same session. These are per-operation, labelled, and
/// live in the app data dir rather than beside the budget so a synced folder
/// stays tidy. The newest `SNAPSHOT_KEEP` survive; older ones are pruned.
const SNAPSHOT_KEEP: usize = 12;

#[tauri::command]
pub fn snapshot_budget_file(app: AppHandle, path: String, label: String) -> Result<String, String> {
    let p = check_budget_path(&path)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("snapshots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("budget");
    let slug: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let dest = dir.join(format!("{stem}-{stamp}-{slug}.{BUDGET_EXT}"));
    fs::copy(&p, &dest).map_err(|e| e.to_string())?;

    // Prune oldest first. A failure here must not fail the snapshot itself.
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some(BUDGET_EXT))
            .collect();
        files.sort();
        while files.len() > SNAPSHOT_KEEP {
            let _ = fs::remove_file(files.remove(0));
        }
    }
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::rel_is_safe;

    #[test]
    fn accepts_plain_relative_paths() {
        assert!(rel_is_safe("app.json"));
        assert!(rel_is_safe("budgets/01ABC/transactions/2026-01.ndjson"));
        assert!(rel_is_safe("./budgets/x.json"));
    }

    #[test]
    fn rejects_escapes() {
        assert!(!rel_is_safe("/etc/hosts"));
        assert!(!rel_is_safe("../outside.txt"));
        assert!(!rel_is_safe("budgets/../../outside.txt"));
        #[cfg(windows)]
        assert!(!rel_is_safe("C:\\Windows\\system32"));
    }
}
