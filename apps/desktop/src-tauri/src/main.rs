use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

struct RuntimeProcess(Mutex<Option<Child>>);

const WEB_RUNTIME_PORT: u16 = 4331;
const DESKTOP_DEV_RUNTIME_PORT: u16 = 4321;
const DESKTOP_PROD_RUNTIME_PORT: u16 = 4322;

fn find_node_candidate(dir: &Path) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }

    let exact = dir.join("node");
    if exact.is_file() {
        return Some(exact);
    }

    let mut candidates = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| {
            if !path.is_file() {
                return false;
            }
            match path.file_name().and_then(|name| name.to_str()) {
                Some(name) => name.starts_with("node-"),
                None => false,
            }
        })
        .collect::<Vec<_>>();

    candidates.sort();
    candidates.into_iter().next()
}

fn resolve_node_binary(resource_dir: &Path) -> Option<PathBuf> {
    let mut search_dirs = vec![resource_dir.join("binaries"), resource_dir.to_path_buf()];

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            search_dirs.push(exe_dir.to_path_buf());
            search_dirs.push(exe_dir.join("binaries"));
        }
    }

    for dir in search_dirs {
        if let Some(node_bin) = find_node_candidate(&dir) {
            return Some(node_bin);
        }
    }

    None
}

fn desktop_runtime_init_script(port: u16) -> String {
    format!(
        "window.__CS_RUNTIME_PORT = {port}; window.__CS_RUNTIME_API_BASE = 'http://127.0.0.1:{port}/api';"
    )
}

fn spawn_runtime_dev(port: u16) -> Option<Child> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let workspace_root = std::path::Path::new(manifest_dir)
        .parent()? // src-tauri -> desktop
        .parent()? // desktop -> apps
        .parent()?; // apps -> workspace root

    let mut cmd = Command::new("pnpm");
    cmd.args(["--filter", "@codesymphony/runtime", "dev"])
        .env("RUNTIME_HOST", "127.0.0.1")
        .env("RUNTIME_PORT", port.to_string())
        .current_dir(workspace_root);

    #[cfg(unix)]
    cmd.process_group(0);

    cmd.spawn().ok()
}

fn resolve_claude_binary() -> Option<PathBuf> {
    let candidates = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
    for candidate in candidates {
        let path = Path::new(candidate);
        if path.is_file() {
            return Some(path.to_path_buf());
        }
    }
    None
}

fn spawn_runtime_prod(app_handle: &tauri::AppHandle, port: u16) -> Option<Child> {
    let resource_dir = match app_handle.path().resource_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Failed to resolve resource directory: {error}");
            return None;
        }
    };
    let app_data_dir = match app_handle.path().app_data_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Failed to resolve app data directory: {error}");
            return None;
        }
    };

    // Ensure app data directory exists for the database
    if let Err(error) = std::fs::create_dir_all(&app_data_dir) {
        eprintln!(
            "Failed to create app data directory ({}): {error}",
            app_data_dir.display()
        );
        return None;
    }

    let node_bin = match resolve_node_binary(&resource_dir) {
        Some(path) => path,
        None => {
            eprintln!(
                "Failed to locate bundled node binary. Checked resource dir: {}",
                resource_dir.display()
            );
            return None;
        }
    };
    let runtime_entry = resource_dir
        .join("runtime-bundle")
        .join("dist")
        .join("index.js");
    let runtime_bundle_dir = resource_dir.join("runtime-bundle");
    let prisma_dir = resource_dir.join("runtime-bundle").join("prisma");
    let db_path = app_data_dir.join("codesymphony.db");
    let debug_log_path = app_data_dir.join("debug.log");

    if !runtime_entry.is_file() {
        eprintln!(
            "Runtime entry not found at expected path: {}",
            runtime_entry.display()
        );
        return None;
    }

    let mut cmd = Command::new(&node_bin);
    cmd.arg(&runtime_entry)
        .current_dir(&runtime_bundle_dir)
        .env("NODE_ENV", "production")
        .env("DATABASE_URL", format!("file:{}", db_path.display()))
        .env("PRISMA_SCHEMA_PATH", prisma_dir.join("schema.prisma"))
        .env("PRISMA_MIGRATIONS_DIR", prisma_dir.join("migrations"))
        .env("RUNTIME_HOST", "127.0.0.1")
        .env("RUNTIME_PORT", port.to_string())
        .env("CODESYMPHONY_DEBUG_LOG_PATH", &debug_log_path)
        .env(
            "WEB_DIST_PATH",
            resource_dir.join("runtime-bundle").join("web-dist"),
        );

    if let Some(claude_bin) = resolve_claude_binary() {
        cmd.env("CLAUDE_CODE_EXECUTABLE", &claude_bin);
    }

    #[cfg(unix)]
    cmd.process_group(0);

    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(error) => {
            eprintln!(
                "Failed to spawn runtime process using node {}: {error}",
                node_bin.display()
            );
            None
        }
    }
}

fn wait_for_runtime(timeout: Duration, port: u16) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn kill_runtime(child: &mut Child) {
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }

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

fn stop_managed_runtime(app_handle: &tauri::AppHandle) {
    if let Some(state) = app_handle.try_state::<RuntimeProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                kill_runtime(&mut child);
            }
        }
    }
}

fn main() {
    let runtime_port = if cfg!(debug_assertions) {
        DESKTOP_DEV_RUNTIME_PORT
    } else {
        DESKTOP_PROD_RUNTIME_PORT
    };

    tauri::Builder::default()
        .append_invoke_initialization_script(desktop_runtime_init_script(runtime_port))
        .setup(move |app| {
            let child = if cfg!(debug_assertions) {
                spawn_runtime_dev(runtime_port)
            } else {
                spawn_runtime_prod(app.handle(), runtime_port)
            };

            app.manage(RuntimeProcess(Mutex::new(child)));

            // Wait for the runtime to be ready, then show the window
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                let ready = wait_for_runtime(Duration::from_secs(30), runtime_port);
                if let Some(window) = app_handle.get_webview_window("main") {
                    if ready {
                        let _ = window.show();
                    } else {
                        eprintln!(
                            "Runtime failed to start within 30s on port {} (web runtime dev port remains {})",
                            runtime_port,
                            WEB_RUNTIME_PORT
                        );
                        let _ = window.show();
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                stop_managed_runtime(&window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                stop_managed_runtime(app_handle);
            }
        });
}
