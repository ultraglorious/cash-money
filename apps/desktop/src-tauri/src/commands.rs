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
