use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

struct RuntimeProcess(Mutex<Option<Child>>);

fn spawn_runtime_dev() -> Option<Child> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let workspace_root = std::path::Path::new(manifest_dir)
        .parent()? // src-tauri -> desktop
        .parent()? // desktop -> apps
        .parent()?; // apps -> workspace root

    let mut cmd = Command::new("pnpm");
    cmd.args(["--filter", "@codesymphony/runtime", "dev"])
        .current_dir(workspace_root);

    #[cfg(unix)]
    cmd.process_group(0);

    cmd.spawn().ok()
}

fn spawn_runtime_prod(app_handle: &tauri::AppHandle) -> Option<Child> {
    let resource_dir = app_handle.path().resource_dir().ok()?;
    let app_data_dir = app_handle.path().app_data_dir().ok()?;

    // Ensure app data directory exists for the database
    std::fs::create_dir_all(&app_data_dir).ok()?;

    let node_bin = app_handle
        .path()
        .resolve("binaries/node", tauri::path::BaseDirectory::Resource)
        .ok()?;
    let runtime_entry = resource_dir.join("runtime-bundle").join("dist").join("index.js");
    let prisma_dir = resource_dir.join("runtime-bundle").join("prisma");
    let db_path = app_data_dir.join("codesymphony.db");

    let mut cmd = Command::new(&node_bin);
    cmd.arg(&runtime_entry)
        .env("NODE_ENV", "production")
        .env("DATABASE_URL", format!("file:{}", db_path.display()))
        .env("PRISMA_SCHEMA_PATH", prisma_dir.join("schema.prisma"))
        .env("PRISMA_MIGRATIONS_DIR", prisma_dir.join("migrations"))
        .env("RUNTIME_HOST", "127.0.0.1")
        .env("RUNTIME_PORT", "4321");

    #[cfg(unix)]
    cmd.process_group(0);

    cmd.spawn().ok()
}

fn wait_for_runtime(timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect("127.0.0.1:4321").is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn kill_runtime(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        unsafe {
            libc::killpg(pid, libc::SIGTERM);
        }
        // Give processes time to exit gracefully, then force kill
        thread::sleep(Duration::from_millis(500));
        let _ = child.kill();
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }

    let _ = child.wait();
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let child = if cfg!(debug_assertions) {
                spawn_runtime_dev()
            } else {
                spawn_runtime_prod(app.handle())
            };

            app.manage(RuntimeProcess(Mutex::new(child)));

            // Wait for the runtime to be ready, then show the window
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                let ready = wait_for_runtime(Duration::from_secs(30));
                if let Some(window) = app_handle.get_webview_window("main") {
                    if ready {
                        let _ = window.show();
                    } else {
                        eprintln!("Runtime failed to start within 30s");
                        let _ = window.show();
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<RuntimeProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.as_mut() {
                            kill_runtime(child);
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
