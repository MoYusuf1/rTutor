# rlearn

A personal tutor on your computer. Tell it what you want to learn, or give it your own material
(a textbook chapter, slides, a video transcript), and it teaches you one small step at a time.

## How it teaches

1. It asks a few quick questions to find out what you already know.
2. It shows you a plan for getting from there to your goal.
3. It explains one idea at a time and checks each one with a short quiz, keeping notes on what you've
   got and what you missed.

## Get started

You need [Node.js](https://nodejs.org) and [Rust](https://rustup.rs). Then, in this folder:

```bash
npm install
npm run tauri dev
```

Your tutor is a coding agent running in rlearn's terminal. Click the terminal button (bottom left), pick a
folder, and click **Claude Code** or **Codex**: it starts with the subscription you're already signed into and
takes over the lesson. Close the terminal and the tutor stops. rlearn can start your agent automatically next
time, and any other agent that speaks MCP works too. Prefer an API key (NVIDIA, Anthropic, OpenAI and others)?
Click the name at the bottom left.

## Credits

The teaching method comes from Amos Blomqvist: his video
[How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU) and his
[learn](https://github.com/amosblomqvist/learn) setup. Built with [Tauri](https://tauri.app).

## Desktop releases

Download desktop installers from [GitHub Releases](https://github.com/MoYusuf1/rlearn/releases).
The repository and releases are private; sign in with an account that has repository access.
Choose `aarch64.dmg` for Apple Silicon, `x64.dmg` for Intel Mac, an `.exe`/`.msi` for Windows x64, or the AppImage for Linux/Arch. A `.deb` is also built for Debian-based systems. API keys and lessons stay
on your computer. Claude Code and Codex must be installed and signed in separately.

For an API provider, click the name at the bottom left, then the gear, and click **Test connection**. The check makes a small real
request and verifies lesson tool calling without adding a lesson. For API providers, enter the exact
model ID and key first. A key entered for testing is saved in the OS keyring.

## Verification

```bash
npm ci
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npx playwright install chromium
npm run test:ui
```

The UI smoke test uses controlled IPC replies to check grading, free answers, provider errors and
reopening a quiz without duplicating content. Set `CHROME_PATH` to use an installed Chrome binary.
It also drives a lesson the way a terminal agent does. Build Linux installers with `npm run tauri build -- --bundles appimage,deb`.

## Cross-platform releases

Push a version tag matching `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (for example
`v0.1.2`). `.github/workflows/release.yml` runs Chromium and WebKit lesson/layout tests, native Rust
tests and installer builds on Apple Silicon, Intel Mac, Windows x64 and Linux x64. A separate check
runs the Linux AppImage tool server on current Arch Linux. Only when every job passes are all six
installers and their checksums published as a private preview release. Screenshots and installers
remain in Actions artifacts for seven days. A manual workflow run validates builds without publishing.

Mac builds are ad-hoc signed and not notarized; Windows builds are unsigned. See release notes for
installation limitations. Playwright tests the frontend with controlled IPC, while the built-binary
smoke test checks MCP startup; these do not replace native GUI and provider sign-in testing.

For local WebKit checks: `npx playwright install --with-deps chromium webkit`, then run
`UI_BROWSERS=chromium,webkit npm run test:ui`. Set `UI_SCREENSHOTS=test-results` to save screenshots.
Private-repository workflows use the account's GitHub Actions allowance; hosted Mac/Windows builds
cannot be produced locally on this Linux machine.
