use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct RuntimeProcess(Mutex<Option<Child>>);

fn spawn_runtime() -> Option<Child> {
    let current_dir = std::env::current_dir().ok()?;
    let workspace_root = current_dir
        .parent()?
        .parent()?
        .parent()?;

    Command::new("pnpm")
        .arg("--filter")
        .arg("@codesymphony/runtime")
        .arg("dev")
        .current_dir(workspace_root)
        .spawn()
        .ok()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let child = spawn_runtime();
            app.manage(RuntimeProcess(Mutex::new(child)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<RuntimeProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
