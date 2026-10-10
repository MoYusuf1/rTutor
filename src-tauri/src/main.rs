// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `rlearn --mcp`: the tool server Claude Code starts during a lesson; no window
    if std::env::args().any(|a| a == "--mcp") {
        return rlearn_lib::mcp::serve();
    }
    // WebKitGTK's DMA-BUF renderer crashes on some Wayland setups ("Error 71 (Protocol error)").
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    rlearn_lib::run()
}
