fn main() {
    // Windows: embed the app manifest (modern common controls, DPI awareness) into every binary this
    // crate links, test binaries included. Tauri only adds it to the app, and tests that use the
    // mock runtime won't start without it (STATUS_ENTRYPOINT_NOT_FOUND).
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    // Tauri requires the bundled tool server (binaries/rtutor-mcp-<triple>) to exist before it compiles anything,
    // tests included. `tauri build` makes the real one first (scripts/sidecar.mjs); anything else gets an empty
    // stand-in, which the app passes over for `rtutor --mcp`.
    let triple = std::env::var("TARGET").unwrap();
    let exe = if triple.contains("windows") { ".exe" } else { "" };
    let sidecar = std::path::Path::new("binaries").join(format!("rtutor-mcp-{triple}{exe}"));
    if !sidecar.exists() {
        let _ = std::fs::create_dir_all("binaries");
        let _ = std::fs::write(&sidecar, b"");
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("failed to run tauri-build");
}
