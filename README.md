# rTutor

A personal tutor on your computer. Tell it what you want to learn, add your own books or notes if you
have them, and it teaches you one small step at a time, checking as it goes that each step really
stuck.

## How it tutors you

Like a good private teacher, in four steps. The tag above the chat box always shows which one it's on,
and you can switch any time.

1. **Probing:** a few quick questions to find where your knowledge runs out. That's where you learn fastest.
2. **Planning:** a short map from what you know to what you want, in the order the ideas build. You approve it.
3. **Teaching:** one idea at a time: why it matters, how it follows from what you know, then a quick
   question. After each answer it explains and shows the idea another way before the next question.
4. **Reviewing:** questions across everything so far, to catch what needs another pass.

Questions are multiple choice, true or false, or a short answer you type. The lesson builds up on the
left like a book; you talk to the tutor on the right. New to a subject? Start **from scratch**. Know it
already? Start with **a test**.

## Your own material

Each subject (Somali, electrical engineering, an exam you're studying for) has its lessons and its
material. Drop in a textbook, slides, notes or a video transcript once, and every lesson in that
subject teaches from it. The tutor doesn't reread whole books: it looks up the pages it needs, and it
keeps its own notes about the subject so a new lesson picks up where the last one left off.

Everything is also kept as plain files you can open:

```
~/rtutor/
  Somali/
    sources/          your books and notes, as text
    notes.md          the tutor's notes on the whole subject
    Greetings/        one folder per lesson
      lesson.md       the lesson so far
      notes.md        what the tutor knows about you in this lesson
```

## Who teaches

An AI you already use. Pick **Claude Code** or **Codex** from the button at the bottom left: it runs with
the subscription you're signed into, so there's nothing to pay or paste. Each subject gets its own tutor,
so it only ever has that subject on its mind. Prefer an API key (NVIDIA, Anthropic, OpenAI…)? It's in
the same menu.

## Get it

Download the installer for your computer from [Releases](https://github.com/MoYusuf1/rTutor/releases):
`aarch64.dmg` for Apple Silicon Macs, `x64.dmg` for Intel Macs, the `.exe` for Windows, and the
`.AppImage` for Linux (including Arch). Everything stays on your computer.

## Credits

The teaching method comes from Amos Blomqvist: his video
[How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU) and his
[learn](https://github.com/amosblomqvist/learn) setup. Built with [Tauri](https://tauri.app).

---

## For developers

How it fits together: a Rust core (Tauri) with a web UI. One SQLite database is the source of truth
(subjects, lessons, chat, canvas, notes, and material split into searchable parts); `~/rtutor` mirrors it
as files. AI agents run in terminal tabs, one per subject in its folder, and reach the app through
`rtutor --mcp`, a tool server that talks to the running app over a local connection. Each message goes to
the agent in its subject's folder, and the agent teaches through the tools (`next`, `write_lesson`,
`quiz`, `search_material`, ...). API providers use the same tools directly.

You need [Node.js](https://nodejs.org) and [Rust](https://rustup.rs). Run it with `npm install` and
`npm run tauri dev`.

```bash
npm ci
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npx playwright install chromium
npm run test:ui
```

The UI tests drive a whole lesson with controlled replies: grading, typed answers, the terminal agent
flow, stopping, the delete dialog and the log. Set `CHROME_PATH` to use an installed Chrome, and
`UI_BROWSERS=chromium,webkit` to add WebKit. Something stuck? The **Log** tab in the bottom panel (also
`rtutor.log` in the app's data folder) records each step: agents connecting, messages delivered, tool
calls and errors.

**Releases.** Push a version tag matching `src-tauri/tauri.conf.json` (for example `v0.2.0`).
`.github/workflows/release.yml` runs the Chromium and WebKit UI tests, the Rust tests and the installer
builds on Apple Silicon, Intel Mac, Windows and Linux, then checks the AppImage on current Arch Linux.
Only when all of that passes are the installers and their checksums published. A manual run checks
everything without publishing. Mac builds are ad-hoc signed and not notarized, and Windows builds are
unsigned; see the release notes for how to open them.
