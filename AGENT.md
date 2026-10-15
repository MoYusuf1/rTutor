# How the tutor works

Everything the tutor does is here or in a file this page points to. Nothing is hidden in the app.

## What the model is told

| What | Where |
|------|-------|
| The teaching method (probe → plan → teach → review), sent as the system prompt | `src-tauri/prompts/teach.md` |
| The learner's material and the tutor's subject notes, appended to that prompt | `material()` in `src-tauri/src/lib.rs` |
| The 11 tools the tutor can call | `tools()` in `src-tauri/src/llm.rs` |
| The extra `next` and `say` tools for terminal agents | `src-tauri/src/mcp.rs` |

The tutor has **no** shell, file or network access of its own. It can only call those tools, and the app
runs them. (Anthropic models with web search also get that one server-side tool.)

## The tools

| Tool | What the app does |
|------|-------------------|
| `write_lesson` | Appends a section to the canvas, saved in the database and `lesson.md` |
| `quiz`, `true_false`, `short_answer` | Asks in the chat; multiple choice and true/false are graded by the app, short answers by the model |
| `ask` | An ungraded question |
| `update_state` | Replaces the lesson state (`notes.md`), the tutor's memory of this learner |
| `subject_notes` | Replaces the notes shared by every lesson in the subject |
| `search_material` | Full-text search (SQLite FTS5) over the subject's material |
| `read_material` | Returns one ~1,200-word part of one source |
| `phase` | Sets probe / plan / teach / review, which only changes the shortcuts shown |

## One turn

1. The learner types, or answers a question. The app appends it to the lesson history (SQLite, `messages`).
2. **API providers:** `send` in `lib.rs` posts the history to the model and streams the reply to the page.
   **Terminal agents** (Claude Code, Codex): the agent calls `next`; the app hands over the message through the
   localhost bridge (`bridge.rs`), and the agent answers by calling tools.
3. The page runs each tool call, writing to the canvas or waiting for the learner's answer.
4. The tool result goes back to the model. The turn ends when it stops calling tools.

What the app adds around a terminal agent (`bridge.rs`):

- **One agent per subject.** It runs in the subject's folder and teaches all of that subject's lessons. When the
  learner moves to another lesson, `next` says so first, so the agent doesn't ask which lesson to continue.
- **No dead air.** If the agent shows the learner something after its last question and then waits, `next` sends it
  back once to finish the step with a question. Once only, so it can't loop.
- **Same tutor on every machine.** Claude Code starts with `--restricted --strict-mcp-config --disable-slash-commands`:
  none of the learner's own hooks, plugins, skills or other MCP servers, and no shell. Only rTutor's tools.
- **What the learner answered is kept** with each question (`tool_results`), so a reopened lesson shows the chat as it was.

Every request, and every tool call a terminal agent makes, is written to `rtutor.log` (the Log tab shows it live).

## Where the data lives

- `~/rtutor/<subject>/sources/`: the material, as Markdown
- `~/rtutor/<subject>/<lesson>/lesson.md` and `notes.md`: the canvas and the lesson state
- `~/rtutor/<subject>/notes.md`: the subject notes
- The app's data folder: `rtutor.db` (history, usage, search index) and `rtutor.log`
- The OS keyring: API keys. They are never in the database, the files or the log.

Nothing is sent anywhere except to the provider you choose.

## Cost and memory limits

| Concern | How it's bounded |
|---------|------------------|
| Reading a long book | Split into ~1,200-word parts once when added. The prompt holds only a contents list; the tutor reads a few parts per step. Material under 12,000 words goes in whole. |
| Finding a topic | FTS5 index: cost grows with the number of matches, not the size of the book |
| Long lessons | Anthropic: the API compacts older turns itself. Other providers: the app cuts old turns in steps (at ~60k tokens, back to ~16k) and substitutes the tutor's own `update_state`. The prompt prefix stays identical between cuts, so provider caching keeps working. |
| History in memory | The open lesson is held once, behind an `Arc`, and each turn only appends: O(1) per message instead of re-reading the database |
| Streaming | Each byte of the reply is scanned once; text goes to the page as it arrives |
| Saving the canvas | Appended to `lesson.md`; the file is not rewritten on each section |
| Usage | Each turn's tokens and estimated cost are recorded (`turns`) and shown under the chat |
| Opening a long lesson | Only the newest 20 sections and 40 messages render; older ones load as they're scrolled to. A 240-section, 600-message lesson: 3.2 s → 0.2 s to open, 26k → 3.5k DOM nodes, 103 → 54 MB heap |
| Claude Code's fixed context | Restricted start: 23k → 11k tokens per call, re-read on every call |

## Changing how it teaches

Edit `src-tauri/prompts/teach.md`. It is plain Markdown, compiled into the app, with no code behind it.

## Measured: where a terminal-agent session's tokens go

`python3 scripts/usage.py` reads Claude Code's own transcripts (the only place agent-mode usage is recorded).
On 9 Somali sessions, 63 API calls (2026-10-13):

| Finding | Number |
|---------|--------|
| Average context per call | ~56k tokens, of which Claude Code's own prompt and tools are most |
| Context at a session's first call | median 38k |
| Cache writes: first call / new content / after >5 min idle | 132k / 169k / 2k |
| Cost split at list price | cache writes ~54%, cache reads ~46% of input cost; output ~10% of the total |
| rTutor's own part of the first `next` result (`teach.md` + lesson brief) | ~9.4–10.3k tokens, once per session |
| Every later `next` result | ~88 tokens |
| Learner message, `write_lesson` call, quiz result | 50–250 tokens each |

What this rules out:

- **A longer cache lifetime** wouldn't help: only 2k tokens were re-written because a cache went cold.
- **Terse output** (caveman-style) targets the ~10% output share and would make explanations worse.
- **Trimming `teach.md`** by 30% would save ~3% of cache writes, under the 10% bar set for changing anything.

rTutor's own overhead is already small. What's left is Claude Code's baseline, which rTutor doesn't control.
Re-run the script after any change to `teach.md`, the tool list, or the lesson brief.
