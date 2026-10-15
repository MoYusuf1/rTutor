# rTutor

A personal tutor on your computer. Tell it what you want to learn, add your books or notes if you have
them, and it teaches you one small step at a time.

## How it teaches

Like a good private teacher, in four steps. The tag above the chat box shows which step it's on, and
you can switch whenever you like.

1. **Probing:** a few quick questions to find where your knowledge runs out. That's where you learn fastest.
2. **Planning:** a short map from what you know to what you want to know. You approve it.
3. **Teaching:** one idea at a time, then a quick question. After each answer it explains, shows the idea
   another way, and only then asks the next question.
4. **Reviewing:** questions across everything so far, to catch what needs another pass.

Questions are multiple choice, true or false, or a short answer you type. The lesson builds up on the
left like a book; you talk to the tutor on the right.

## Your books and notes

Each subject (Somali, electrical engineering, an exam) has its own lessons and material. Drop in a
textbook, slides, notes or a video transcript once, and every lesson in that subject teaches from it.
The tutor looks up only the pages it needs, and keeps notes so the next lesson picks up where you left
off. Everything is also saved as plain files in `~/rtutor`.

## Focus timer

The timer at the top of a lesson works like a Pomodoro: 25 minutes of focus, then a short break, with a
longer break after a few rounds. Click it to start or pause. Click the minutes to change them, and use
− and + to set how many rounds come before the long break. rTutor remembers your settings.

## Who teaches

An AI you already use. Start **Claude Code** or **Codex** from the button at the bottom left: it uses
the subscription you're signed into, so there's nothing to pay or paste. You can switch its model there
too. Prefer an API key (NVIDIA, Anthropic, OpenAI…)? It's in the same menu.

## Get it

Download the installer from [Releases](https://github.com/MoYusuf1/rTutor/releases): `aarch64.dmg`
for Apple Silicon Macs, `x64.dmg` for Intel Macs, the `.exe` for Windows, the `.AppImage` for Linux
(including Arch). Everything stays on your computer.

## Credits

The teaching method comes from Amos Blomqvist: his video
[How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU) and his
[learn](https://github.com/amosblomqvist/learn) setup. Built with [Tauri](https://tauri.app).

---

## For developers

A Rust core (Tauri) with a web UI. One SQLite database holds everything; `~/rtutor` mirrors it as
files. Agents run in terminal tabs, one per subject, and reach the app through `rtutor-mcp`, a small
tool server (shipped next to the app; `rtutor --mcp` also works) that talks to the running app over a
local connection.

```bash
npm ci && npm run build
cargo test --workspace --manifest-path src-tauri/Cargo.toml
npx playwright install chromium webkit
UI_BROWSERS=chromium,webkit npm run test:ui
npm run tauri dev
```

The UI tests drive whole lessons with controlled replies. Something stuck? The **Log** tab in the
bottom panel records every step. To release, push a version tag (e.g. `v0.2.0`): the workflow tests
and builds on both Macs, Windows and Linux, checks the AppImage on Arch, and publishes only if all pass.
