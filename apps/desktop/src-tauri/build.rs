use std::fs;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const PLACEHOLDER_SCRIPT: &str = "#!/usr/bin/env bash\n\
echo \"Bundled Bun sidecar placeholder. Run the desktop build script to download the real Bun binary.\" >&2\n\
exit 1\n";

fn ensure_bun_placeholder(root: &PathBuf, file_name: &str) {
    let binaries_dir = root.join("binaries");
    let binary_path = binaries_dir.join(file_name);

    if binary_path.exists() {
        return;
    }

    fs::create_dir_all(&binaries_dir).expect("failed to create binaries directory");
    fs::write(&binary_path, PLACEHOLDER_SCRIPT).expect("failed to write Bun placeholder binary");

    #[cfg(unix)]
    {
        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(&binary_path, permissions)
            .expect("failed to mark Bun placeholder as executable");
    }
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("missing manifest dir"));

    ensure_bun_placeholder(&manifest_dir, "bun-aarch64-apple-darwin");
    ensure_bun_placeholder(&manifest_dir, "bun-x86_64-apple-darwin");

    tauri_build::build()
}
