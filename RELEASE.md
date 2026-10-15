rTutor's first preview: a personal tutor that probes what you know, plans, teaches one idea at a time and checks it landed, powered by Claude Code, Codex or an API key, and taught from your own textbooks and notes.

## What's better in this build

**Your subscription goes further**
- An idle tutor checks in every 8 hours instead of every 20 minutes: about 3 turns a day while you're away instead of 72.
- A long book's contents cost about 570 tokens per lesson instead of about 3,700 (a 250-part textbook: 40 lines instead of 250).
- A message the tutor missed is re-sent on its own, without the 4,245-word teaching guide again (about 5,600 tokens saved each time).
- With an API key, the prompt stays cached for an hour instead of 5 minutes, so a long think or a quiz doesn't make the next reply cost full price.
- A tutor that loops on tools stops after 25 steps instead of running forever.

**Lighter on your computer**
- Each Claude Code or Codex tutor starts a 445 KB helper using 2.5 MB of memory, instead of a copy of the 10 MB app using 34.5 MB.
- A long lesson opens with its newest 120 messages and 40 canvas sections, and older ones load as you scroll up, instead of all of it at once.
- A book you import stays in the app's core: its text no longer crosses to the window and back (two full copies per import before).

**Steadier**
- Searching and reading your material, saving notes and switching phases now work even while the window reloads.
- If the tutor stops waiting on a question, your answer still reaches it as your next message.
- Tutors remember the core teaching rules (plain English, one idea at a time) after their memory is summarized, and get them again every 15 messages.
- Two subjects with the same name get their own folders, so they never share files or a tutor.
- PDFs that are damaged or huge (over 200 MB) give a clear message instead of freezing an import.

## Downloads
- Apple Silicon Macs: `aarch64.dmg`. Intel Macs: `x64.dmg`.
- Windows: `x64-setup.exe` (or the `.msi`).
- Linux, including Arch: `amd64.AppImage`. Make it executable (`chmod +x`) and open it. Without FUSE, run it with `APPIMAGE_EXTRACT_AND_RUN=1`.
- Debian and Ubuntu: `amd64.deb`.
- `SHA256SUMS` lets you check the downloads.

Opening it the first time: the Mac build isn't notarized, so right-click the app and choose Open (or allow it in System Settings → Privacy & Security). The Windows installer isn't signed, so choose More info → Run anyway.

To be tutored by Claude Code or Codex, install it and sign in once; rTutor then starts it with one click. Or use an API key.

Checked before release: the UI tests (Chromium and WebKit) and 37 Rust tests on both kinds of Mac, Windows and Linux; installers built on each; both tool servers started from the built app; the AppImage's tool server started on current Arch Linux.
