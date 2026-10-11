rTutor's first preview: a personal tutor that probes what you know, plans, teaches one idea at a time and checks it landed, powered by Claude Code, Codex or an API key, and taught from your own textbooks and notes.

Downloads:
- Apple Silicon Macs: `aarch64.dmg`. Intel Macs: `x64.dmg`.
- Windows: `x64-setup.exe` (or the `.msi`).
- Linux, including Arch: `amd64.AppImage`. Make it executable (`chmod +x`) and open it. Without FUSE, run it with `APPIMAGE_EXTRACT_AND_RUN=1`.
- Debian and Ubuntu: `amd64.deb`.
- `SHA256SUMS` lets you check the downloads.

Opening it the first time: the Mac build isn't notarized, so right-click the app and choose Open (or allow it in System Settings → Privacy & Security). The Windows installer isn't signed, so choose More info → Run anyway.

To be tutored by Claude Code or Codex, install it and sign in once; rTutor then starts it with one click. Or use an API key.

Checked before release: the UI tests (Chromium and WebKit) and the Rust tests on both kinds of Mac, Windows and Linux; installers built on each; the AppImage's tool server started on current Arch Linux.
