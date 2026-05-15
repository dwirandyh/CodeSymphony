use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
#[cfg(target_os = "macos")]
use std::fs::OpenOptions;
#[cfg(target_os = "macos")]
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, Sender};
use std::sync::LazyLock;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
#[cfg(target_os = "macos")]
use std::time::{SystemTime, UNIX_EPOCH};
use serde::Serialize;
use tauri::Manager;

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindow, NSWindowButton};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

struct RuntimeProcess(Mutex<Option<Child>>);
struct AppShutdown(AtomicBool);

#[derive(Clone)]
struct DesktopProcessInfo {
    pid: u32,
    ppid: u32,
    cpu: f64,
    memory: u64,
    command: String,
}

struct DesktopProcessSnapshot {
    by_pid: HashMap<u32, DesktopProcessInfo>,
    children_of: HashMap<u32, Vec<u32>>,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopResourceUsage {
    cpu: f64,
    memory: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopResourceMonitorSnapshot {
    shell: DesktopResourceUsage,
    webview: DesktopResourceUsage,
    runtime: DesktopResourceUsage,
    other: DesktopResourceUsage,
}

const DESKTOP_DEV_RUNTIME_PORT: u16 = 4321;
const DESKTOP_PROD_RUNTIME_PORT: u16 = 4322;
const LOCALHOST_RUNTIME_HOST: &str = "127.0.0.1";
const LAN_RUNTIME_HOST: &str = "0.0.0.0";
const COMMON_RUNTIME_EXECUTABLE_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];
const USER_RUNTIME_EXECUTABLE_DIR_SUFFIXES: [&str; 2] = [".opencode/bin", ".local/bin"];
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_VERTICAL_OFFSET: f64 = 4.0;
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_EPSILON: f64 = 0.5;
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_SYNC_CHECKPOINTS_MS: [u64; 4] = [120, 280, 600, 1200];
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_SETTLE_CHECKPOINTS_MS: [u64; 3] = [450, 900, 1500];
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_LIVE_RESIZE_THROTTLE_MS: u128 = 75;
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_LOG_PATH: &str = "/tmp/codesymphony-traffic-light.log";

#[cfg(target_os = "macos")]
static MACOS_TRAFFIC_LIGHT_BASELINE_HEIGHTS: LazyLock<Mutex<HashMap<String, f64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(target_os = "macos")]
static MACOS_TRAFFIC_LIGHT_SYNC_GENERATIONS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(target_os = "macos")]
static MACOS_TRAFFIC_LIGHT_LAST_LIVE_RESIZE_ADJUSTMENTS_MS: LazyLock<Mutex<HashMap<String, u128>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(target_os = "macos")]
static MACOS_TRAFFIC_LIGHT_LOG_SENDER: LazyLock<Sender<String>> = LazyLock::new(|| {
    let (sender, receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        while let Ok(line) = receiver.recv() {
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(MACOS_TRAFFIC_LIGHT_LOG_PATH)
            {
                let _ = writeln!(file, "{line}");
            }
        }
    });

    sender
});

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

fn should_copy_prisma_engine(src: &Path, dst: &Path) -> std::io::Result<bool> {
    let src_metadata = std::fs::metadata(src)?;
    let dst_metadata = match std::fs::metadata(dst) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };

    if src_metadata.len() != dst_metadata.len() {
        return Ok(true);
    }

    match (src_metadata.modified(), dst_metadata.modified()) {
        (Ok(src_modified), Ok(dst_modified)) => Ok(dst_modified < src_modified),
        _ => Ok(false),
    }
}

fn sync_prisma_engine(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !should_copy_prisma_engine(src, dst)? {
        return Ok(());
    }

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

        if let Err(error) = sync_prisma_engine(src, dst) {
            eprintln!(
                "Failed to sync Prisma engine from {} to {}: {error}",
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
    let prisma_migration_marker_path = app_data_dir.join("prisma-migrations.sha1");

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
        .env("PRISMA_MIGRATION_MARKER_PATH", &prisma_migration_marker_path)
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

fn shutdown_requested(app_handle: &tauri::AppHandle) -> bool {
    app_handle
        .try_state::<AppShutdown>()
        .map(|state| state.0.load(Ordering::Relaxed))
        .unwrap_or(true)
}

fn show_main_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();

        #[cfg(target_os = "macos")]
        schedule_macos_traffic_light_adjustment(app_handle, "main", "window.reopen");
    }
}

fn monitor_managed_runtime(app_handle: tauri::AppHandle, port: u16, is_dev: bool) {
    loop {
        thread::sleep(Duration::from_secs(2));

        if shutdown_requested(&app_handle) {
            break;
        }

        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            continue;
        }

        let _ = ensure_managed_runtime(&app_handle, port, is_dev);
    }
}

fn normalize_f64(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

fn normalize_u64(value: u64) -> u64 {
    value
}

fn list_desktop_processes() -> Vec<DesktopProcessInfo> {
    #[cfg(unix)]
    {
        let output = Command::new("ps")
            .args(["-eo", "pid=,ppid=,pcpu=,rss=,comm="])
            .output();

        let Ok(output) = output else {
            return Vec::new();
        };

        if !output.status.success() {
            return Vec::new();
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut processes = Vec::new();

        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let mut parts = trimmed.split_whitespace();
            let Some(pid_raw) = parts.next() else {
                continue;
            };
            let Some(ppid_raw) = parts.next() else {
                continue;
            };
            let Some(cpu_raw) = parts.next() else {
                continue;
            };
            let Some(rss_raw) = parts.next() else {
                continue;
            };

            let pid = pid_raw.parse::<u32>().ok();
            let ppid = ppid_raw.parse::<u32>().ok();
            let cpu = cpu_raw.parse::<f64>().ok();
            let rss_kb = rss_raw.parse::<u64>().ok();

            let (Some(pid), Some(ppid), Some(cpu), Some(rss_kb)) = (pid, ppid, cpu, rss_kb) else {
                continue;
            };

            processes.push(DesktopProcessInfo {
                pid,
                ppid,
                cpu: normalize_f64(cpu),
                memory: normalize_u64(rss_kb.saturating_mul(1024)),
                command: parts.collect::<Vec<_>>().join(" "),
            });
        }

        return processes;
    }

    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

fn capture_desktop_process_snapshot() -> DesktopProcessSnapshot {
    let mut by_pid = HashMap::new();
    let mut children_of = HashMap::new();

    for process in list_desktop_processes() {
        children_of
            .entry(process.ppid)
            .or_insert_with(Vec::new)
            .push(process.pid);
        by_pid.insert(process.pid, process);
    }

    DesktopProcessSnapshot { by_pid, children_of }
}

fn get_subtree_pids(snapshot: &DesktopProcessSnapshot, root_pid: u32) -> HashSet<u32> {
    let mut result = HashSet::new();
    let mut stack = vec![root_pid];

    while let Some(pid) = stack.pop() {
        if !result.insert(pid) {
            continue;
        }

        if let Some(children) = snapshot.children_of.get(&pid) {
            for child in children {
                stack.push(*child);
            }
        }
    }

    result.retain(|pid| snapshot.by_pid.contains_key(pid));
    result
}

fn sum_desktop_resources(snapshot: &DesktopProcessSnapshot, pids: &HashSet<u32>) -> DesktopResourceUsage {
    let mut cpu = 0.0;
    let mut memory = 0_u64;

    for pid in pids {
        if let Some(process) = snapshot.by_pid.get(pid) {
            cpu += process.cpu;
            memory = memory.saturating_add(process.memory);
        }
    }

    DesktopResourceUsage {
        cpu: normalize_f64(cpu),
        memory,
    }
}

fn is_webview_process(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    normalized.contains("webkit")
        || normalized.contains("webcontent")
        || normalized.contains("networkprocess")
        || normalized.contains("gpuprocess")
}

#[tauri::command]
fn collect_resource_monitor_desktop_metrics(
    runtime_pid: Option<u32>,
) -> Result<DesktopResourceMonitorSnapshot, String> {
    let snapshot = capture_desktop_process_snapshot();
    let app_pid = std::process::id();
    let app_subtree = get_subtree_pids(&snapshot, app_pid);
    let runtime_subtree = runtime_pid
        .map(|pid| get_subtree_pids(&snapshot, pid))
        .unwrap_or_default();

    let mut shell_pids = HashSet::new();
    if snapshot.by_pid.contains_key(&app_pid) {
        shell_pids.insert(app_pid);
    }

    let mut webview_pids = HashSet::new();
    let mut other_pids = HashSet::new();
    let mut union_pids = app_subtree.clone();
    union_pids.extend(runtime_subtree.iter().copied());

    for pid in union_pids {
        if pid == app_pid || runtime_subtree.contains(&pid) {
            continue;
        }

        let Some(process) = snapshot.by_pid.get(&pid) else {
            continue;
        };

        if is_webview_process(&process.command) {
            webview_pids.insert(pid);
        } else {
            other_pids.insert(pid);
        }
    }

    Ok(DesktopResourceMonitorSnapshot {
        shell: sum_desktop_resources(&snapshot, &shell_pids),
        webview: sum_desktop_resources(&snapshot, &webview_pids),
        runtime: sum_desktop_resources(&snapshot, &runtime_subtree),
        other: sum_desktop_resources(&snapshot, &other_pids),
    })
}

#[cfg(target_os = "macos")]
fn macos_traffic_light_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn log_macos_traffic_light_trace(window_label: &str, event: &str, details: &str) {
    let timestamp_ms = macos_traffic_light_timestamp_ms();
    let _ = MACOS_TRAFFIC_LIGHT_LOG_SENDER.send(format!(
        "ts_ms={timestamp_ms} window={window_label} event={event} {details}"
    ));
}

#[cfg(target_os = "macos")]
fn macos_traffic_light_follow_up_checkpoints(reason: &str) -> &'static [u64] {
    match reason {
        "window.resized" | "window.moved" => &MACOS_TRAFFIC_LIGHT_SETTLE_CHECKPOINTS_MS,
        _ => &MACOS_TRAFFIC_LIGHT_SYNC_CHECKPOINTS_MS,
    }
}

#[cfg(target_os = "macos")]
fn macos_traffic_light_should_adjust_immediately(reason: &str) -> bool {
    let _ = reason;
    true
}

#[cfg(target_os = "macos")]
fn macos_traffic_light_should_throttle_live_resize_adjustment(
    window_label: &str,
    reason: &str,
    phase: &str,
    in_live_resize: bool,
) -> Option<u128> {
    if reason != "window.resized" || phase != "immediate" || !in_live_resize {
        return None;
    }

    let Ok(mut state) = MACOS_TRAFFIC_LIGHT_LAST_LIVE_RESIZE_ADJUSTMENTS_MS.lock() else {
        return None;
    };

    let now_ms = macos_traffic_light_timestamp_ms();
    let previous_adjustment_ms = state.get(window_label).copied().unwrap_or(0);
    let elapsed_ms = now_ms.saturating_sub(previous_adjustment_ms);

    if previous_adjustment_ms != 0 && elapsed_ms < MACOS_TRAFFIC_LIGHT_LIVE_RESIZE_THROTTLE_MS {
        return Some(elapsed_ms);
    }

    state.insert(window_label.to_string(), now_ms);
    None
}

#[cfg(target_os = "macos")]
fn adjust_macos_traffic_lights(window: &tauri::WebviewWindow, reason: &str, phase: &str) {
    let window_label = window.label().to_string();
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    if fullscreen {
        log_macos_traffic_light_trace(
            &window_label,
            "adjust.skip_fullscreen",
            &format!("reason={reason} phase={phase}"),
        );
        return;
    }

    let Ok(ns_window_ptr) = window.ns_window() else {
        log_macos_traffic_light_trace(
            &window_label,
            "adjust.skip_missing_ns_window",
            &format!("reason={reason} phase={phase}"),
        );
        return;
    };

    let ns_window = unsafe { &*ns_window_ptr.cast::<NSWindow>() };
    let in_live_resize = ns_window.inLiveResize();
    if let Some(elapsed_ms) = macos_traffic_light_should_throttle_live_resize_adjustment(
        &window_label,
        reason,
        phase,
        in_live_resize,
    ) {
        log_macos_traffic_light_trace(
            &window_label,
            "adjust.skip_live_resize_throttled",
            &format!(
                "reason={reason} phase={phase} in_live_resize={in_live_resize} elapsed_ms={elapsed_ms} throttle_ms={MACOS_TRAFFIC_LIGHT_LIVE_RESIZE_THROTTLE_MS}"
            ),
        );
        return;
    }

    let Some(close_button) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
        log_macos_traffic_light_trace(
            &window_label,
            "adjust.skip_missing_close_button",
            &format!("reason={reason} phase={phase}"),
        );
        return;
    };
    let Some(title_bar_container) =
        (unsafe { close_button.superview() }).and_then(|view| unsafe { view.superview() })
    else {
        log_macos_traffic_light_trace(
            &window_label,
            "adjust.skip_missing_title_bar_container",
            &format!("reason={reason} phase={phase}"),
        );
        return;
    };

    let outer_size = window.outer_size().ok();
    let mut title_bar_rect = title_bar_container.frame();
    let title_bar_top = title_bar_rect.origin.y + title_bar_rect.size.height;

    let (baseline_height, current_matches_expected, current_looks_native, baseline_updated) = {
        let Ok(mut state) = MACOS_TRAFFIC_LIGHT_BASELINE_HEIGHTS.lock() else {
            log_macos_traffic_light_trace(
                &window_label,
                "adjust.skip_baseline_lock_failed",
                &format!("reason={reason} phase={phase}"),
            );
            return;
        };

        let baseline = state
            .entry(window_label.clone())
            .or_insert(title_bar_rect.size.height);
        let expected_height = *baseline + MACOS_TRAFFIC_LIGHT_VERTICAL_OFFSET;
        let current_matches_expected =
            (title_bar_rect.size.height - expected_height).abs() <= MACOS_TRAFFIC_LIGHT_EPSILON;

        let current_looks_native =
            (title_bar_rect.size.height - *baseline).abs() <= MACOS_TRAFFIC_LIGHT_EPSILON;
        let mut baseline_updated = false;

        if !current_matches_expected && !current_looks_native {
            *baseline = title_bar_rect.size.height;
            baseline_updated = true;
        }

        (
            *baseline,
            current_matches_expected,
            current_looks_native,
            baseline_updated,
        )
    };

    let target_height = baseline_height + MACOS_TRAFFIC_LIGHT_VERTICAL_OFFSET;
    let target_origin_y = title_bar_top - target_height;
    let needs_update = !current_matches_expected
        || (title_bar_rect.size.height - target_height).abs() > MACOS_TRAFFIC_LIGHT_EPSILON
        || (title_bar_rect.origin.y - target_origin_y).abs() > MACOS_TRAFFIC_LIGHT_EPSILON;

    if needs_update {
        title_bar_rect.size.height = target_height;
        title_bar_rect.origin.y = target_origin_y;
        title_bar_container.setFrame(title_bar_rect);
    }

    let (outer_width, outer_height) = outer_size
        .map(|size| (size.width, size.height))
        .unwrap_or((0, 0));
    log_macos_traffic_light_trace(
        &window_label,
        if needs_update {
            "adjust.applied"
        } else {
            "adjust.noop"
        },
        &format!(
            "reason={reason} phase={phase} in_live_resize={in_live_resize} outer_width={outer_width} outer_height={outer_height} current_y={:.2} current_height={:.2} title_bar_top={:.2} baseline_height={:.2} current_matches_expected={} current_looks_native={} baseline_updated={} target_y={:.2} target_height={:.2}",
            title_bar_rect.origin.y,
            title_bar_rect.size.height,
            title_bar_top,
            baseline_height,
            current_matches_expected,
            current_looks_native,
            baseline_updated,
            target_origin_y,
            target_height,
        ),
    );
}

#[cfg(target_os = "macos")]
fn next_macos_traffic_light_sync_generation(window_label: &str) -> u64 {
    let Ok(mut state) = MACOS_TRAFFIC_LIGHT_SYNC_GENERATIONS.lock() else {
        return 0;
    };

    let next_generation = state
        .get(window_label)
        .copied()
        .unwrap_or(0)
        .saturating_add(1);
    state.insert(window_label.to_string(), next_generation);
    next_generation
}

#[cfg(target_os = "macos")]
fn is_macos_traffic_light_sync_generation_current(window_label: &str, generation: u64) -> bool {
    MACOS_TRAFFIC_LIGHT_SYNC_GENERATIONS
        .lock()
        .ok()
        .and_then(|state| state.get(window_label).copied())
        .map(|current_generation| current_generation == generation)
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn queue_macos_traffic_light_adjustment(
    app_handle: &tauri::AppHandle,
    window_label: &str,
    generation: u64,
    reason: &'static str,
    phase: &'static str,
) {
    let app_handle = app_handle.clone();
    let app_handle_for_closure = app_handle.clone();
    let window_label = window_label.to_string();

    let _ = app_handle.run_on_main_thread(move || {
        if !is_macos_traffic_light_sync_generation_current(&window_label, generation) {
            log_macos_traffic_light_trace(
                &window_label,
                "queue.skip_stale_generation",
                &format!("reason={reason} phase={phase} generation={generation}"),
            );
            return;
        }

        if let Some(window) = app_handle_for_closure.get_webview_window(&window_label) {
            adjust_macos_traffic_lights(&window, reason, phase);
        }
    });
}

#[cfg(target_os = "macos")]
fn schedule_macos_traffic_light_adjustment(
    app_handle: &tauri::AppHandle,
    window_label: &str,
    reason: &'static str,
) {
    let generation = next_macos_traffic_light_sync_generation(window_label);
    let checkpoints = macos_traffic_light_follow_up_checkpoints(reason);
    let adjusts_immediately = macos_traffic_light_should_adjust_immediately(reason);
    let checkpoint_summary = checkpoints
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    log_macos_traffic_light_trace(
        window_label,
        "schedule",
        &format!(
            "reason={reason} generation={generation} adjusts_immediately={adjusts_immediately} log_path={} follow_up_checkpoints_ms={checkpoint_summary}",
            MACOS_TRAFFIC_LIGHT_LOG_PATH,
        ),
    );
    if adjusts_immediately {
        queue_macos_traffic_light_adjustment(
            app_handle,
            window_label,
            generation,
            reason,
            "immediate",
        );
    } else {
        log_macos_traffic_light_trace(
            window_label,
            "schedule.immediate_deferred",
            &format!("reason={reason} generation={generation}"),
        );
    }

    let app_handle = app_handle.clone();
    let window_label = window_label.to_string();
    thread::spawn(move || {
        let mut previous_checkpoint_ms = 0_u64;

        for checkpoint_ms in checkpoints {
            if *checkpoint_ms > previous_checkpoint_ms {
                thread::sleep(Duration::from_millis(
                    *checkpoint_ms - previous_checkpoint_ms,
                ));
            }
            previous_checkpoint_ms = *checkpoint_ms;

            if !is_macos_traffic_light_sync_generation_current(&window_label, generation) {
                log_macos_traffic_light_trace(
                    &window_label,
                    "schedule.follow_up_cancelled",
                    &format!(
                        "reason={reason} generation={generation} checkpoint_ms={checkpoint_ms}"
                    ),
                );
                return;
            }

            let phase = match *checkpoint_ms {
                120 => "follow_up_120ms",
                280 => "follow_up_280ms",
                450 => "follow_up_450ms",
                600 => "follow_up_600ms",
                900 => "follow_up_900ms",
                1200 => "follow_up_1200ms",
                1500 => "follow_up_1500ms",
                _ => "follow_up",
            };
            queue_macos_traffic_light_adjustment(
                &app_handle,
                &window_label,
                generation,
                reason,
                phase,
            );
        }
    });
}

#[cfg(target_os = "macos")]
fn macos_traffic_light_window_event_reason(event: &tauri::WindowEvent) -> Option<&'static str> {
    match event {
        tauri::WindowEvent::Resized(_) => Some("window.resized"),
        tauri::WindowEvent::ScaleFactorChanged { .. } => Some("window.scale_changed"),
        tauri::WindowEvent::Focused(true) => Some("window.focused"),
        _ => None,
    }
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
        .invoke_handler(tauri::generate_handler![collect_resource_monitor_desktop_metrics])
        .setup(move |app| {
            app.manage(RuntimeProcess(Mutex::new(None)));
            app.manage(AppShutdown(AtomicBool::new(false)));
            let _ = ensure_managed_runtime(app.handle(), runtime_port, is_dev);

            #[cfg(target_os = "macos")]
            schedule_macos_traffic_light_adjustment(app.handle(), "main", "app.setup");

            if let Some(window) = app.handle().get_webview_window("main") {
                let _ = window.show();
            }

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
            if window.label() == "main" {
                if let Some(reason) = macos_traffic_light_window_event_reason(event) {
                    schedule_macos_traffic_light_adjustment(
                        &window.app_handle(),
                        window.label(),
                        reason,
                    );
                }
            }

            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !shutdown_requested(&window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
            }

            if let tauri::WindowEvent::CloseRequested { .. } = event {
                request_runtime_shutdown(&window.app_handle());
                stop_managed_runtime(&window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                show_main_window(app_handle);
            }
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                request_runtime_shutdown(app_handle);
                stop_managed_runtime(app_handle);
            }
            _ => {}
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
