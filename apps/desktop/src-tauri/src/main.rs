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

fn resolve_claude_binary() -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ];
    for candidate in candidates {
        let path = Path::new(candidate);
        if path.is_file() {
            return Some(path.to_path_buf());
        }
    }
    None
}

fn spawn_runtime_prod(app_handle: &tauri::AppHandle) -> Option<Child> {
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
    let runtime_entry = resource_dir.join("runtime-bundle").join("dist").join("index.js");
    let prisma_dir = resource_dir.join("runtime-bundle").join("prisma");
    let db_path = app_data_dir.join("codesymphony.db");

    if !runtime_entry.is_file() {
        eprintln!(
            "Runtime entry not found at expected path: {}",
            runtime_entry.display()
        );
        return None;
    }

    let mut cmd = Command::new(&node_bin);
    cmd.arg(&runtime_entry)
        .env("NODE_ENV", "production")
        .env("DATABASE_URL", format!("file:{}", db_path.display()))
        .env("PRISMA_SCHEMA_PATH", prisma_dir.join("schema.prisma"))
        .env("PRISMA_MIGRATIONS_DIR", prisma_dir.join("migrations"))
        .env("RUNTIME_HOST", "127.0.0.1")
        .env("RUNTIME_PORT", "4321")
        .env("WEB_DIST_PATH", resource_dir.join("runtime-bundle").join("web-dist"));

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
