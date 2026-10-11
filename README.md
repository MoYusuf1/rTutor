# rTutor

A personal tutor on your computer. Tell it what you want to learn, add your own books or notes if you
have them, and it teaches you one small step at a time, checking as it goes that each step really
stuck.

## How it tutors you

Think of a good private teacher. They don't start by lecturing. They find out what you already know,
make a plan, explain one thing at a time, and check you understood before moving on. rTutor works the
same way, in four gears. You can always see which gear it's in (the little tag above the chat box)
and switch whenever you like:

1. **Probing.** A few quick questions to find where your knowledge stops. If you get everything right,
   the questions get harder until it finds the edge. That edge is where learning happens fastest.
2. **Planning.** A short map of the ideas between what you know and what you want, in the order they
   build on each other. You say "looks good" before it starts.
3. **Teaching.** One idea at a time: why you need it, how it follows from what you already know, then
   a quick question to make sure it landed. After each answer it explains, shows the idea from a new
   angle, and only then asks the next question. Never a wall of questions.
4. **Reviewing.** Questions across everything you've covered, to find what needs another pass.

Questions come as multiple choice, true or false, or a short answer you type yourself. Lessons are
written on the left like pages of a book, and the chat is on the right.

New to a subject? Start **from scratch**. Already know some? Let it **find what you know**. Know it
well? Start with **a test**.

## Your own material

Each subject (Somali, electrical engineering, an exam you're studying for) has its lessons and its
material. Drop in a textbook, slides, notes or a video transcript once, and every lesson in that
subject teaches from it. The tutor doesn't reread whole books: it looks up the pages it needs, and it
keeps its own notes about the subject so a new lesson picks up where the last one left off. Your
files are kept as plain text in `~/rtutor/<subject>/sources/`.

## Who teaches

rTutor is powered by an AI you already use. Click **Claude Code** or **Codex** when it asks you to
choose a tutor: it starts in rTutor's terminal with the subscription you're signed into, so there's
nothing to pay for or paste. Prefer an API key (NVIDIA, Anthropic, OpenAI and others)? Choose
**API key** instead. You can also pick how hard it thinks: light, balanced or deep.

## Get it

Download the installer for your computer from [Releases](https://github.com/MoYusuf1/rtutor/releases):
`aarch64.dmg` for Apple Silicon Macs, `x64.dmg` for Intel Macs, the `.exe` for Windows, and the
`.AppImage` for Linux (including Arch). Everything stays on your computer.

## Credits

The teaching method comes from Amos Blomqvist: his video
[How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU) and his
[learn](https://github.com/amosblomqvist/learn) setup. Built with [Tauri](https://tauri.app).

---

## For developers

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
