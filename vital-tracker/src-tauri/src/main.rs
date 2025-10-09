#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, GlobalShortcutManager};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle();
            // Register global shortcut Ctrl+Shift+V to open the main window
            let mut gsm = handle.global_shortcut_manager();
            let _ = gsm.register("Ctrl+Shift+V", move || {
                if let Some(w) = handle.get_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
