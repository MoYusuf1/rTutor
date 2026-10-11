Polished chat typography, softer message bubbles and a rounded teal composer, with the original warm light/dark palette.

Downloads:
- Apple Silicon Macs: `aarch64.dmg`.
- Intel Macs: `x64.dmg`.
- Windows x64: `x64-setup.exe` or `x64_en-US.msi`.
- Linux x86_64, including Arch: `amd64.AppImage`. Make it executable before launching. If FUSE is unavailable, use `APPIMAGE_EXTRACT_AND_RUN=1 ./rlearn_0.1.2_amd64.AppImage`.
- Debian-based Linux: `amd64.deb`.
- `SHA256SUMS` verifies all installers.

Release checks: Chromium and WebKit Playwright flows on both Mac architectures, Windows and Linux; light/dark layouts at 960px and 1440px; correct/incorrect/unknown quiz answers; free answers; provider connection success/error states; quiz/state reopening; native Rust tests and builds; built tool-server startup; AppImage tool-server smoke test on current Arch Linux.

Playwright uses controlled IPC replies. It does not validate native webview rendering, installation prompts or live provider sign-in on every OS. Local Claude Code and Codex integrations were previously live-tested on Linux. Use Model → Test connection after installing on your machine.

macOS uses ad-hoc signing, without Apple notarization. Windows installers are unsigned. Your OS may require approval in its security settings. No paid signing certificate is configured.

macOS and Windows now use native secure credential stores; the terminal chooses the platform shell. CLI discovery includes common user and Homebrew installation paths. Install and sign in to your chosen CLI separately. API providers require your own model ID and key.

This is a private desktop preview, downloadable by repository collaborators. It is not a hosted website.

Windows terminal lifecycle now services ConPTY teardown while draining output. The native PTY regression test answers cursor-position queries like the app’s xterm terminal and has bounded execution.
