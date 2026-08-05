//! Native commands the web UI calls via `invoke`. Text-file IO is resolved
//! relative to the app's data directory and written atomically (temp + rename).
//! Zip reading is used by the import flow.

use std::fs;
use std::io::Read;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Resolve a caller-relative path against the app data directory.
fn resolve(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join(rel))
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

/// Read a text file at an absolute path (from the file picker, e.g. a bank CSV).
#[tauri::command]
pub fn read_text_abs(path: String) -> Result<String, String> {
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
