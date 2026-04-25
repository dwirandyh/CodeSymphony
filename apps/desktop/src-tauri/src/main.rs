use std::collections::HashMap;
use std::ffi::OsString;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, Url};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindow, NSWindowButton};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

struct RuntimeProcess(Mutex<Option<Child>>);
struct AppShutdown(AtomicBool);

const WEB_RUNTIME_PORT: u16 = 4331;
const DESKTOP_DEV_RUNTIME_PORT: u16 = 4321;
const DESKTOP_PROD_RUNTIME_PORT: u16 = 4322;
const LOCALHOST_RUNTIME_HOST: &str = "127.0.0.1";
const LAN_RUNTIME_HOST: &str = "0.0.0.0";
const COMMON_RUNTIME_EXECUTABLE_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];
const USER_RUNTIME_EXECUTABLE_DIR_SUFFIXES: [&str; 2] = [".opencode/bin", ".local/bin"];
#[cfg(target_os = "macos")]
// Coarse vertical lift for the whole native traffic-light container.
const MACOS_TRAFFIC_LIGHT_VERTICAL_INSET: f64 = 4.0;
#[cfg(target_os = "macos")]
// Fine adjustment for the buttons themselves. In this titlebar coordinate space,
// increasing the value moves the traffic lights upward.
const MACOS_TRAFFIC_LIGHT_BUTTON_DROP: f64 = 0.9;
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_EPSILON: f64 = 0.5;
#[cfg(target_os = "macos")]
const MACOS_FULLSCREEN_EVENT: &str = "codesymphony://fullscreen-changed";
#[cfg(target_os = "macos")]
const MACOS_WINDOW_CHROME_SYNC_CHECKPOINTS_MS: [u64; 5] = [0, 160, 420, 900, 1400];

#[cfg(target_os = "macos")]
static MACOS_TRAFFIC_LIGHT_LAST_Y: std::sync::LazyLock<Mutex<HashMap<String, f64>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn desktop_runtime_host(is_dev: bool) -> &'static str {
    if is_dev {
        LOCALHOST_RUNTIME_HOST
    } else {
        LAN_RUNTIME_HOST
    }
}

fn prisma_engine_suffix() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "darwin-arm64",
        "x86_64" => "darwin",
        _ => "darwin-arm64",
    }
}

fn prisma_query_engine_library_name() -> String {
    format!("libquery_engine-{}.dylib.node", prisma_engine_suffix())
}

fn prisma_schema_engine_name() -> String {
    format!("schema-engine-{}", prisma_engine_suffix())
}

fn copy_prisma_engine(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::copy(src, dst)?;

    #[cfg(unix)]
    {
        let mode = std::fs::metadata(src)?.permissions().mode();
        std::fs::set_permissions(dst, std::fs::Permissions::from_mode(mode))?;
    }

    Ok(())
}

fn prepare_prisma_engines(
    resource_dir: &Path,
    app_data_dir: &Path,
) -> Option<(PathBuf, PathBuf, PathBuf)> {
    let bundled_engines_dir = resource_dir
        .join("runtime-bundle")
        .join("node_modules")
        .join("@prisma")
        .join("engines");
    let writable_engines_dir = app_data_dir.join("prisma-engines");
    let query_engine_name = prisma_query_engine_library_name();
    let schema_engine_name = prisma_schema_engine_name();
    let bundled_query_engine = bundled_engines_dir.join(&query_engine_name);
    let bundled_schema_engine = bundled_engines_dir.join(&schema_engine_name);
    let writable_query_engine = writable_engines_dir.join(&query_engine_name);
    let writable_schema_engine = writable_engines_dir.join(&schema_engine_name);

    if let Err(error) = std::fs::create_dir_all(&writable_engines_dir) {
        eprintln!(
            "Failed to create writable Prisma engines directory ({}): {error}",
            writable_engines_dir.display()
        );
        return None;
    }

    for (src, dst) in [
        (&bundled_query_engine, &writable_query_engine),
        (&bundled_schema_engine, &writable_schema_engine),
    ] {
        if !src.is_file() {
            eprintln!(
                "Bundled Prisma engine not found at expected path: {}",
                src.display()
            );
            return None;
        }

        if let Err(error) = copy_prisma_engine(src, dst) {
            eprintln!(
                "Failed to copy Prisma engine from {} to {}: {error}",
                src.display(),
                dst.display()
            );
            return None;
        }
    }

    Some((
        writable_engines_dir,
        writable_query_engine,
        writable_schema_engine,
    ))
}

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
        "window.__CS_RUNTIME_PORT = {port}; window.__CS_RUNTIME_API_BASE = 'http://{LOCALHOST_RUNTIME_HOST}:{port}/api';"
    )
}

fn runtime_executable_dirs(home_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    for candidate in COMMON_RUNTIME_EXECUTABLE_DIRS {
        let candidate_path = PathBuf::from(candidate);
        if candidate_path.is_dir() && !dirs.iter().any(|existing| existing == &candidate_path) {
            dirs.push(candidate_path);
        }
    }

    if let Some(home_dir) = home_dir {
        for suffix in USER_RUNTIME_EXECUTABLE_DIR_SUFFIXES {
            let candidate_path = home_dir.join(suffix);
            if candidate_path.is_dir() && !dirs.iter().any(|existing| existing == &candidate_path) {
                dirs.push(candidate_path);
            }
        }
    }

    dirs
}

fn build_runtime_path_env() -> Option<OsString> {
    let mut paths = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let home_dir = std::env::var_os("HOME").map(PathBuf::from);

    for candidate_path in runtime_executable_dirs(home_dir.as_deref()) {
        if paths.iter().any(|existing| existing == &candidate_path) {
            continue;
        }

        paths.push(candidate_path);
    }

    std::env::join_paths(paths).ok()
}

fn desktop_dev_runtime_db_path(workspace_root: &Path) -> PathBuf {
    workspace_root
        .join("apps")
        .join("runtime")
        .join("prisma")
        .join("desktop.dev.db")
}

fn ensure_runtime_dev_database(runtime_dir: &Path, db_path: &Path) -> bool {
    if let Some(parent) = db_path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            eprintln!(
                "Failed to create desktop dev database directory ({}): {error}",
                parent.display()
            );
            return false;
        }
    }

    let database_url = format!("file:{}", db_path.display());
    let status = Command::new("pnpm")
        .args(["exec", "prisma", "migrate", "deploy"])
        .env("DATABASE_URL", &database_url)
        .current_dir(runtime_dir)
        .status();

    match status {
        Ok(result) if result.success() => true,
        Ok(result) => {
            eprintln!(
                "Failed to apply desktop dev runtime migrations for {} (exit status: {})",
                db_path.display(),
                result
            );
            false
        }
        Err(error) => {
            eprintln!(
                "Failed to launch Prisma migrations for desktop dev runtime database {}: {error}",
                db_path.display()
            );
            false
        }
    }
}

fn spawn_runtime_dev(port: u16) -> Option<Child> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let workspace_root = std::path::Path::new(manifest_dir)
        .parent()? // src-tauri -> desktop
        .parent()? // desktop -> apps
        .parent()?; // apps -> workspace root
    let runtime_dir = workspace_root.join("apps").join("runtime");
    let runtime_db_path = desktop_dev_runtime_db_path(workspace_root);

    if !ensure_runtime_dev_database(&runtime_dir, &runtime_db_path) {
        return None;
    }

    let mut cmd = Command::new("pnpm");
    cmd.args(["--filter", "@codesymphony/runtime", "dev"])
        .env(
            "DATABASE_URL",
            format!("file:{}", runtime_db_path.display()),
        )
        .env("RUNTIME_HOST", desktop_runtime_host(true))
        .env("RUNTIME_PORT", port.to_string())
        .env("CODESYMPHONY_DEBUG_LOG_PATH", runtime_dir.join("debug.log"))
        .current_dir(workspace_root);

    if let Some(runtime_path) = build_runtime_path_env() {
        cmd.env("PATH", runtime_path);
    }
    if let Some(codex_bin) = resolve_codex_binary() {
        cmd.env("CODEX_BINARY_PATH", &codex_bin);
    }
    if let Some(opencode_bin) = resolve_opencode_binary() {
        cmd.env("OPENCODE_BINARY_PATH", &opencode_bin);
    }

    #[cfg(unix)]
    cmd.process_group(0);

    cmd.spawn().ok()
}

fn resolve_common_binary(binary_name: &str) -> Option<PathBuf> {
    let home_dir = std::env::var_os("HOME").map(PathBuf::from);

    for candidate_dir in runtime_executable_dirs(home_dir.as_deref()) {
        let path = candidate_dir.join(binary_name);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn resolve_claude_binary() -> Option<PathBuf> {
    resolve_common_binary("claude")
}

fn resolve_codex_binary() -> Option<PathBuf> {
    resolve_common_binary("codex")
}

fn resolve_opencode_binary() -> Option<PathBuf> {
    resolve_common_binary("opencode")
}

fn runtime_stdout_log_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("runtime.stdout.log")
}

fn runtime_stderr_log_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("runtime.stderr.log")
}

fn configure_runtime_stdio(cmd: &mut Command, app_data_dir: &Path) -> std::io::Result<()> {
    let stdout = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime_stdout_log_path(app_data_dir))?;
    let stderr = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime_stderr_log_path(app_data_dir))?;

    cmd.stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));

    Ok(())
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

    let (prisma_engines_dir, prisma_query_engine_library, prisma_schema_engine_binary) =
        match prepare_prisma_engines(&resource_dir, &app_data_dir) {
            Some(paths) => paths,
            None => return None,
        };

    let mut cmd = Command::new(&node_bin);
    cmd.arg(&runtime_entry)
        .current_dir(&runtime_bundle_dir)
        .env("NODE_ENV", "production")
        .env("DATABASE_URL", format!("file:{}", db_path.display()))
        .env("PRISMA_SCHEMA_PATH", prisma_dir.join("schema.prisma"))
        .env("PRISMA_MIGRATIONS_DIR", prisma_dir.join("migrations"))
        .env("PRISMA_ENGINES_DIR", &prisma_engines_dir)
        .env("PRISMA_QUERY_ENGINE_LIBRARY", &prisma_query_engine_library)
        .env("PRISMA_SCHEMA_ENGINE_BINARY", &prisma_schema_engine_binary)
        .env("RUNTIME_HOST", desktop_runtime_host(false))
        .env("RUNTIME_PORT", port.to_string())
        .env("CODESYMPHONY_DEBUG_LOG_PATH", &debug_log_path)
        .env(
            "WEB_DIST_PATH",
            resource_dir.join("runtime-bundle").join("web-dist"),
        );

    if let Some(runtime_path) = build_runtime_path_env() {
        cmd.env("PATH", runtime_path);
    }
    if let Some(claude_bin) = resolve_claude_binary() {
        cmd.env("CLAUDE_CODE_EXECUTABLE", &claude_bin);
    }
    if let Some(codex_bin) = resolve_codex_binary() {
        cmd.env("CODEX_BINARY_PATH", &codex_bin);
    }
    if let Some(opencode_bin) = resolve_opencode_binary() {
        cmd.env("OPENCODE_BINARY_PATH", &opencode_bin);
    }

    if let Err(error) = configure_runtime_stdio(&mut cmd, &app_data_dir) {
        eprintln!(
            "Failed to configure runtime stdio logs in {}: {error}",
            app_data_dir.display()
        );
        return None;
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

fn spawn_managed_runtime(app_handle: &tauri::AppHandle, port: u16, is_dev: bool) -> Option<Child> {
    if is_dev {
        spawn_runtime_dev(port)
    } else {
        spawn_runtime_prod(app_handle, port)
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

fn ensure_managed_runtime(app_handle: &tauri::AppHandle, port: u16, is_dev: bool) -> bool {
    let Some(state) = app_handle.try_state::<RuntimeProcess>() else {
        eprintln!("Managed runtime state is unavailable.");
        return false;
    };

    let mut guard = match state.0.lock() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("Failed to lock managed runtime state: {error}");
            return false;
        }
    };

    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return true,
            Ok(Some(status)) => {
                eprintln!("Managed runtime exited unexpectedly with status: {status}");
                *guard = None;
            }
            Err(error) => {
                eprintln!("Failed to inspect managed runtime status: {error}");
                *guard = None;
            }
        }
    }

    let child = spawn_managed_runtime(app_handle, port, is_dev);
    if child.is_none() {
        eprintln!("Managed runtime spawn attempt failed on port {port}");
    }
    *guard = child;

    guard.is_some()
}

fn wait_for_managed_runtime(
    app_handle: &tauri::AppHandle,
    port: u16,
    is_dev: bool,
    timeout: Duration,
) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if wait_for_runtime(Duration::from_millis(200), port) {
            return true;
        }

        let _ = ensure_managed_runtime(app_handle, port, is_dev);
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

fn request_runtime_shutdown(app_handle: &tauri::AppHandle) {
    if let Some(state) = app_handle.try_state::<AppShutdown>() {
        state.0.store(true, Ordering::Relaxed);
    }
}

fn monitor_managed_runtime(app_handle: tauri::AppHandle, port: u16, is_dev: bool) {
    loop {
        thread::sleep(Duration::from_secs(2));

        let shutdown_requested = app_handle
            .try_state::<AppShutdown>()
            .map(|state| state.0.load(Ordering::Relaxed))
            .unwrap_or(true);
        if shutdown_requested {
            break;
        }

        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            continue;
        }

        let _ = ensure_managed_runtime(&app_handle, port, is_dev);
    }
}

#[cfg(target_os = "macos")]
fn adjust_macos_traffic_lights(window: &tauri::WebviewWindow) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };

    let ns_window = unsafe { &*ns_window_ptr.cast::<NSWindow>() };
    let Some(close_button) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(minimize_button) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
    else {
        return;
    };
    let Some(zoom_button) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) else {
        return;
    };

    let window_label = window.label().to_string();
    let close_y = close_button.frame().origin.y;
    let already_adjusted = MACOS_TRAFFIC_LIGHT_LAST_Y
        .lock()
        .ok()
        .and_then(|state| state.get(&window_label).copied())
        .map(|last_y| (close_y - last_y).abs() <= MACOS_TRAFFIC_LIGHT_EPSILON)
        .unwrap_or(false);
    if already_adjusted {
        return;
    }

    let Some(title_bar_container) =
        (unsafe { close_button.superview() }).and_then(|view| unsafe { view.superview() })
    else {
        return;
    };

    let mut title_bar_rect = title_bar_container.frame();
    title_bar_rect.origin.y -= MACOS_TRAFFIC_LIGHT_VERTICAL_INSET;
    title_bar_rect.size.height += MACOS_TRAFFIC_LIGHT_VERTICAL_INSET;
    title_bar_container.setFrame(title_bar_rect);

    for button in [close_button, minimize_button, zoom_button] {
        let mut rect = button.frame();
        rect.origin.y -= MACOS_TRAFFIC_LIGHT_BUTTON_DROP;
        button.setFrameOrigin(rect.origin);
    }

    if let Ok(mut state) = MACOS_TRAFFIC_LIGHT_LAST_Y.lock() {
        state.insert(window_label, close_y - MACOS_TRAFFIC_LIGHT_BUTTON_DROP);
    }
}

#[cfg(target_os = "macos")]
fn sync_macos_window_chrome(window: &tauri::WebviewWindow) {
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    let _ = window.emit(MACOS_FULLSCREEN_EVENT, is_fullscreen);

    if !is_fullscreen {
        adjust_macos_traffic_lights(window);
    }
}

#[cfg(target_os = "macos")]
fn schedule_macos_window_chrome_sync(app_handle: tauri::AppHandle, window_label: String) {
    thread::spawn(move || {
        let mut previous_checkpoint_ms = 0_u64;

        for checkpoint_ms in MACOS_WINDOW_CHROME_SYNC_CHECKPOINTS_MS {
            if checkpoint_ms > previous_checkpoint_ms {
                thread::sleep(Duration::from_millis(
                    checkpoint_ms - previous_checkpoint_ms,
                ));
            }
            previous_checkpoint_ms = checkpoint_ms;

            if let Some(window) = app_handle.get_webview_window(&window_label) {
                sync_macos_window_chrome(&window);
            }
        }
    });
}

fn main() {
    let is_dev = cfg!(debug_assertions);
    let runtime_port = if cfg!(debug_assertions) {
        DESKTOP_DEV_RUNTIME_PORT
    } else {
        DESKTOP_PROD_RUNTIME_PORT
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(true).build())
        .append_invoke_initialization_script(desktop_runtime_init_script(runtime_port))
        .setup(move |app| {
            app.manage(RuntimeProcess(Mutex::new(None)));
            app.manage(AppShutdown(AtomicBool::new(false)));
            let _ = ensure_managed_runtime(app.handle(), runtime_port, is_dev);

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                sync_macos_window_chrome(&window);
            }

            // Wait for the runtime to be ready, then show the window
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                let ready = wait_for_managed_runtime(
                    &app_handle,
                    runtime_port,
                    is_dev,
                    Duration::from_secs(30),
                );
                if let Some(window) = app_handle.get_webview_window("main") {
                    if ready {
                        if !is_dev {
                            let runtime_url = format!("http://127.0.0.1:{runtime_port}");
                            match Url::parse(&runtime_url) {
                                Ok(url) => {
                                    if let Err(error) = window.navigate(url) {
                                        eprintln!(
                                            "Failed to navigate desktop webview to runtime origin {}: {error}",
                                            runtime_url
                                        );
                                    }
                                }
                                Err(error) => {
                                    eprintln!(
                                        "Failed to parse desktop runtime origin {}: {error}",
                                        runtime_url
                                    );
                                }
                            }
                        }
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

            if !is_dev {
                let app_handle = app.handle().clone();
                thread::spawn(move || {
                    monitor_managed_runtime(app_handle, runtime_port, is_dev);
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::ScaleFactorChanged { .. }
                        | tauri::WindowEvent::Focused(true)
                )
            {
                schedule_macos_window_chrome_sync(
                    window.app_handle().clone(),
                    window.label().to_string(),
                );
            }

            if let tauri::WindowEvent::CloseRequested { .. } = event {
                request_runtime_shutdown(&window.app_handle());
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
                request_runtime_shutdown(app_handle);
                stop_managed_runtime(app_handle);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        build_runtime_path_env, desktop_runtime_host, resolve_codex_binary,
        runtime_executable_dirs, runtime_stderr_log_path, runtime_stdout_log_path,
    };
    use std::fs;
    use std::path::Path;

    #[test]
    fn desktop_dev_runtime_stays_localhost() {
        assert_eq!(desktop_runtime_host(true), "127.0.0.1");
    }

    #[test]
    fn desktop_prod_runtime_binds_to_lan() {
        assert_eq!(desktop_runtime_host(false), "0.0.0.0");
    }

    #[test]
    fn runtime_log_paths_live_in_app_data_dir() {
        let app_data_dir = Path::new("/tmp/codesymphony");
        assert_eq!(
            runtime_stdout_log_path(app_data_dir),
            Path::new("/tmp/codesymphony/runtime.stdout.log")
        );
        assert_eq!(
            runtime_stderr_log_path(app_data_dir),
            Path::new("/tmp/codesymphony/runtime.stderr.log")
        );
    }

    #[test]
    fn runtime_path_includes_homebrew_locations_when_available() {
        let path = build_runtime_path_env().expect("runtime PATH should be buildable");
        let path_text = path.to_string_lossy();
        assert!(path_text.contains("/opt/homebrew/bin") || path_text.contains("/usr/local/bin"));
    }

    #[test]
    fn runtime_executable_dirs_include_user_opencode_bin_when_present() {
        let temp_root = std::env::temp_dir().join(format!(
            "codesymphony-tauri-runtime-dirs-{}",
            std::process::id()
        ));
        let opencode_bin_dir = temp_root.join(".opencode").join("bin");

        if temp_root.exists() {
            let _ = fs::remove_dir_all(&temp_root);
        }

        fs::create_dir_all(&opencode_bin_dir).expect("temp opencode bin dir should be created");

        let dirs = runtime_executable_dirs(Some(temp_root.as_path()));

        assert!(dirs.contains(&opencode_bin_dir));

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn codex_binary_resolution_uses_common_install_locations() {
        if let Some(path) = resolve_codex_binary() {
            assert!(path.ends_with("codex"));
        }
    }
}
