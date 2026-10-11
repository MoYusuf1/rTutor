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

Click **Model** (bottom left) to choose who teaches you: **Claude Code** or **Codex** use the subscription
you're already signed into, or paste an API key (NVIDIA, Anthropic, OpenAI and others).

## Credits

The teaching method comes from Amos Blomqvist: his video
[How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU) and his
[learn](https://github.com/amosblomqvist/learn) setup. Built with [Tauri](https://tauri.app).

## Desktop releases

Download Linux installers from [GitHub Releases](https://github.com/MoYusuf1/rlearn/releases).
The repository and releases are private; sign in with an account that has repository access.
Choose the AppImage for Linux or the `.deb` for Debian-based distributions. API keys and lessons stay
on your computer. Claude Code and Codex must be installed and signed in separately.

Open **Model**, choose your provider, and click **Test connection**. The check makes a small real
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
The ignored live tests use the signed-in provider and a small amount of subscription usage:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
CLI=codex RLEARN_MCP_BIN="$PWD/src-tauri/target/debug/rlearn" cargo test --manifest-path src-tauri/Cargo.toml --lib cli::live -- --ignored --nocapture
# Replace CLI=codex with CLI=claude-code to test Claude Code.
```

The two-turn live test verifies lesson and quiz tools, answer feedback, tutor follow-up, saved state,
and SQLite reload. Build Linux installers with `npm run tauri build -- --bundles appimage,deb`.
