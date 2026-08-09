mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::read_text_file,
      commands::write_text_file,
      commands::list_dir,
      commands::remove_file,
      commands::read_zip_csvs,
      commands::read_text_abs,
      commands::read_budget_file,
      commands::write_budget_file,
      commands::stat_budget_file,
      commands::backup_budget_file,
      commands::snapshot_budget_file,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
