import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";

/** Each subject has its own agent, started in the subject's folder when one of its lessons opens. */
async function subjectFlow(browser, engine) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__opened = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args = {}) => command === "term_open" ? void window.__opened.push(args) : ({
        get_settings: { active: "agent", providers: {}, main: { kind: "codex", name: "codex-mcp-client" } },
        mcp_command: { bin: "/opt/rtutor", home: "/home/me" },
        tree: { folders: [{ id: 1, parent: null, name: "Somali", dir: "/home/me/rtutor/Somali" }], lessons: [{ id: 1, folder: 1, title: "Greetings" }], sources: [] },
        get_lesson: { title: "Greetings", folder: 1, state: "", toolResults: {}, messages: [],
          sections: Array.from({ length: 30 }, (_, i) => `## Part ${i + 1}\n${"Somali greetings change with the time of day. ".repeat(12)}`) },
      })[command],
    };
  });
  await page.goto("http://localhost:1421");
  await page.locator("#tree .row.folder .chev").click();
  await page.locator("#tree .row.lesson").click();
  await page.waitForFunction(() => window.__opened.length === 1);
  const [opened] = await page.evaluate(() => window.__opened);
  assert.equal(opened.cwd, "/home/me/rtutor/Somali", "the agent starts in the subject's folder");
  // a long lesson opens on its newest part, not the top
  await page.waitForFunction(() => document.querySelector("#canvas").scrollTop > 1000);
  assert.ok(await page.locator("#canvas-body").getByText("Part 30").isVisible(), "the latest section is in view");
  assert.match(opened.run, /^codex .*mcp_servers\.rtutor/, "with the agent picked to start automatically");
  await page.locator("#tree .row.lesson").click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__opened.length), 1, "reopening the subject doesn't start a second one");
  // the focus timer: start, pause, reset
  await page.locator("#pomo").click();
  await page.locator("#pomo.running").getByText(/^2[45]:\d\d$/).waitFor();
  await page.locator("#pomo").click();
  await page.locator("#pomo.paused").waitFor();
  await page.locator("#pomo").click({ button: "right" });
  await page.locator("#pomo-time").getByText("Focus", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
  console.log(`${engine} UI passed: an agent per subject, started in its folder`);
}

/** A terminal agent powers the lesson: messages go to the bridge, and its tool calls run in the page. */
async function agentFlow(browser, engine) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const state = { lessons: [], folders: [], sent: [], results: {} };
    window.__state = state;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args = {}) => {
        const lesson = state.lessons.find((l) => l.id === (args.lesson ?? args.id));
        switch (command) {
          case "get_settings": return { active: "agent", providers: {} };
          case "agent_listen": window.__agent = args.onEvent; return;
          case "mcp_command": return { bin: "/opt/rtutor", home: "/home/learner" };
          case "tree": return { lessons: state.lessons, folders: state.folders, sources: [] };
          case "create_folder": state.folders.push({ id: 1, parent: null, name: args.name }); return 1;
          case "create_lesson": state.lessons.push({ id: 1, title: args.title, folder: args.folder, state: "", sections: [], messages: [], toolResults: {} }); return 1;
          case "get_lesson": return structuredClone(lesson);
          case "add_section": lesson.sections.push(args.markdown); return;
          case "rename_lesson": lesson.title = args.title; return;
          case "agent_send": state.sent.push(args.text); return;
          case "agent_stop": state.stopped = true; return;
          case "installed_agents": return ["codex"];
          case "agent_models": return { models: [{ id: "gpt-test", name: "GPT-Test", levels: ["low", "high"], default: "high" }], current: "gpt-test", effort: "low" };
          case "save_settings": return;
          case "log_listen": return ["/tmp/rtutor.log", ["12:00:00.000Z agent connected"]];
          case "material_search": return "material 1, part 2: voltage is push per charge";
          case "agent_result": state.results[args.id] = args.result; return;
          case "save_settings": case "agent_use": return;
          default: throw `Unhandled command ${command}`;
        }
      },
    };
  });
  await page.goto("http://localhost:1421");
  const emit = (e) => page.evaluate((e) => { window.__agent.onmessage(e); }, e); // a quiz call settles only once answered
  await page.locator("#who").getByText("No agent", { exact: true }).waitFor();
  // starting an agent: it says where it will run, with the agent's own models and effort levels
  await page.locator("#model").click();
  await page.locator("#pop").getByText("Start Codex").click();
  await page.locator("#where").getByText("Where should Codex run?").waitFor();
  await page.locator('#where-model option[value="gpt-test"]').waitFor({ state: "attached" });
  assert.equal(await page.locator("#where-model option").first().innerText(), "Default (GPT-Test)");
  assert.deepEqual(await page.locator("#where-effort option").allInnerTexts(), ["Default (low)", "low", "high"], "effort levels come from the model");
  // any model the agent accepts can be typed in, so new models need no update
  await page.locator("#where-model").selectOption("__other");
  await page.locator("#where .model-name").fill("gpt-new-9");
  await page.locator("#where .model-name").press("Enter");
  await page.waitForFunction(() => document.querySelector("#where-model")?.value === "gpt-new-9");
  await page.locator("#drawer-close").click();
  await emit({ type: "agents", agents: [{ id: 7, name: "claude-code", cwd: "/home/learner/rtutor", cmd: "", busy: false }], active: 7 });
  await page.locator("#who").getByText("Claude Code").waitFor();
  assert.ok(await page.locator("#who-logo svg[fill='#D97757']").count(), "the Claude logo marks the agent");
  const long = "Teach me circuits, from Ohm's law up to how a real power supply keeps its voltage steady";
  await page.locator("#start-input").fill(long);
  await page.locator('.gear:has-text("Test me")').click();
  await page.locator("#start-btn").click();
  await page.locator(".work:not(.done)").waitFor();
  assert.equal(await page.locator("#title").innerText(), long, "the lesson title isn't cut short");
  assert.equal(await page.locator('#tree .row.folder .label').innerText(), long, "a new lesson starts its own subject");
  assert.equal(await page.locator("#suggest .now").innerText(), "Reviewing", "the chosen gear shows as the phase");
  assert.equal(await page.locator("#composer .send").getAttribute("aria-label"), "Stop", "send turns into stop while the tutor works");
  const [first] = await page.evaluate(() => window.__state.sent);
  assert.ok(first.startsWith(long) && /test me/i.test(first), "the starting gear goes to the tutor");
  await emit({ type: "agents", agents: [{ id: 7, name: "claude-code", cwd: "/home/learner/rtutor", cmd: "", busy: true }], active: 7 });
  await emit({ type: "call", id: 1, agent: 7, lesson: 1, name: "phase", input: { phase: "probe" } });
  await page.locator("#suggest").getByText("Start teaching").waitFor();
  assert.equal(await page.locator("#suggest .now").innerText(), "Probing");
  await emit({ type: "call", id: 2, agent: 7, lesson: 1, name: "quiz", input: { question: "What carries current?", options: ["Charge", "Voltage"], correct_index: 0, explanation: "Current is moving charge." } });
  await page.locator(".card.quiz").waitFor();
  assert.equal(await page.locator(".work:not(.done)").count(), 0, "no thinking indicator while waiting on the learner");
  await page.locator("#input").fill("What is voltage?");
  await page.locator("#input").press("Enter");
  await page.waitForFunction(() => window.__state.results[2]);
  const typed = await page.evaluate(() => window.__state.results[2]);
  assert.ok(typed.content.includes("What is voltage?") && /skipped/.test(typed.content) && !typed.is_error, "a chat message sets the open question aside");
  await page.locator(".msg.user").getByText("What is voltage?").waitFor();
  await page.locator(".card.answered .given").getByText("Skipped").waitFor();
  await page.locator(".work:not(.done)").waitFor();
  await emit({ type: "call", id: 3, agent: 7, lesson: 1, name: "say", input: { text: "Good question, see the canvas." } });
  await page.locator(".msg.bot").getByText("Good question, see the canvas.").waitFor();
  await emit({ type: "call", id: 4, agent: 7, lesson: 1, name: "write_lesson", input: { markdown: "# Voltage\nPush per charge." } });
  await page.locator("#canvas-body").getByText("Push per charge.").waitFor();
  assert.equal(await page.locator("#canvas-body > .appear").count() > 0, true, "new content animates in");
  await emit({ type: "call", id: 5, agent: 7, lesson: 1, name: "search_material", input: { query: "voltage" } });
  await page.locator(".work .step").getByText("Searched the material for “voltage”").waitFor();
  await page.locator("#suggest").getByText("Start teaching").click();
  await page.waitForFunction(() => window.__state.sent.length === 2);
  assert.match((await page.evaluate(() => window.__state.sent))[1], /start teaching/i);
  await page.locator("#composer .send").click(); // stop
  await page.locator(".meta").getByText("Stopped.").waitFor();
  assert.ok(await page.evaluate(() => window.__state.stopped), "stop reaches the agent");
  await page.locator(".work.done").first().waitFor();
  // true/false is graded in the app; a short answer goes back to the tutor to judge
  await emit({ type: "call", id: 20, agent: 7, lesson: 1, name: "true_false", input: { statement: "Voltage is a kind of current.", answer: false, explanation: "Voltage pushes; current flows." } });
  await page.locator(".card.quiz .opt", { hasText: "False" }).click();
  await page.waitForFunction(() => window.__state.results[20]);
  assert.match((await page.evaluate(() => window.__state.results[20])).content, /said "False" \(correct/);
  await page.locator("#canvas-body").getByText("Voltage pushes; current flows.").waitFor();
  await emit({ type: "call", id: 21, agent: 7, lesson: 1, name: "short_answer", input: { question: "What carries current?", answer: "Moving charge", explanation: "" } });
  await page.locator(".card.short input").fill("moving charges");
  await page.locator(".card.short").getByText("Check").click();
  await page.waitForFunction(() => window.__state.results[21]);
  const judged = (await page.evaluate(() => window.__state.results[21])).content;
  assert.ok(judged.includes('"moving charges"') && judged.includes("Judge it yourself"), judged);
  await page.locator("#canvas-body").getByText("A good answer:").waitFor();
  // an answered question settles: no box or Check button left, the answer stays as text
  assert.equal(await page.locator(".card.short input, .card.short button").count(), 0, "nothing left to check");
  await page.locator(".card.short.answered .given").getByText("moving charges").waitFor();
  assert.equal(await page.locator(".card.answered input").count(), 0, "no answered card keeps an input");
  // deleting asks first, in a dialog
  await page.locator("#tree .row.lesson").click({ button: "right" });
  await page.locator("#menu").getByText("Delete lesson").click();
  await page.locator("#confirm[open]").getByText("Delete lesson").waitFor();
  await page.locator("#confirm").getByText("Cancel").click();
  assert.equal(await page.locator("#confirm[open]").count(), 0);
  assert.equal(await page.locator("#tree .row.lesson").count(), 1, "cancel keeps the lesson");
  // the Log tab shows what happened
  await page.locator("#term-btn").click();
  await page.locator("#logtab").click();
  await page.locator("#log-lines").getByText("agent connected").waitFor();
  await emit({ type: "agents", agents: [], active: null });
  await page.locator("#who").getByText("No agent", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
  console.log(`${engine} UI passed: terminal agent drives the lesson, phase shortcuts, typed quiz answer, thinking state`);
}

// Exercise the real UI with deterministic IPC replies. Live Rust tests cover provider transport.
const server = await createServer({ server: { port: 1421, strictPort: true } });
await server.listen();
try {
for (const engine of (process.env.UI_BROWSERS || "chromium").split(",")) {
  assert.ok(["chromium", "webkit"].includes(engine), `Unknown browser: ${engine}`);
  const browser = await ({ chromium, webkit }[engine]).launch(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
  for (const answer of [1, 0, 2]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const state = JSON.parse(localStorage.getItem("smoke.db") || "null") || { lessons: [], folders: [], turns: 0 };
      const save = () => localStorage.setItem("smoke.db", JSON.stringify(state));
      let nextCallback = 0;
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => ++nextCallback,
        unregisterCallback: () => {},
        invoke: async (command, args = {}) => {
          const lesson = state.lessons.find((l) => l.id === (args.lesson ?? args.id));
          switch (command) {
            case "get_settings": return { active: "api", api: "nvidia", providers: { nvidia: { model: "test-model" } } };
            case "save_settings": return;
            case "has_api_key": return true;
            case "agent_listen": window.__agent = args.onEvent; return;
            case "mcp_command": return { bin: "/opt/rtutor", home: "/home/learner" };
            case "test_provider":
              if (args.provider.id === "openai") throw "Invalid API key";
              return "Connected. Lesson tool calling works.";
            case "tree": return { lessons: state.lessons, folders: state.folders, sources: [] };
            case "stats": return {};
            case "create_folder": state.folders.push({ id: state.folders.length + 1, parent: null, name: args.name }); save(); return state.folders.length;
            case "create_lesson": {
              const id = state.lessons.length + 1;
              state.lessons.push({ id, title: args.title, folder: args.folder, state: "", sections: [], messages: [], toolResults: {} });
              save(); return id;
            }
            case "get_lesson": return structuredClone(lesson);
            case "add_section": lesson.sections.push(args.markdown); save(); return;
            case "rename_lesson": lesson.title = args.title; save(); return;
            case "set_state": lesson.state = args.markdown; save(); return;
            case "save_tool_result": lesson.toolResults[args.result.tool_use_id] = args.result; save(); return;
            case "send": {
              lesson.messages.push({ role: "user", content: args.content });
              const tool = (id, name, input) => ({ type: "tool_use", id, name, input });
              const replies = [
                [tool("write-1", "write_lesson", { markdown: "# Addition\nOne plus one makes two." }),
                 tool("quiz-1", "quiz", { question: "What is 1+1?", options: ["1", "2"], correct_index: 1, explanation: "Combine the two single objects." })],
                [tool("state-1", "update_state", { markdown: "Addition checked. Next: practice." }),
                 tool("ask-1", "ask", { question: "Continue?", options: ["Practice", "Stop"] })],
                [{ type: "text", text: "Your answer was received." }],
              ];
              const content = replies[state.turns++];
              if (!content) throw "Unexpected extra provider turn";
              content.forEach((block, index) => {
                args.onEvent.onmessage({ type: "start", index, block: { ...block, input: {}, text: "" } });
                args.onEvent.onmessage({ type: "delta", index, text: block.type === "text" ? block.text : JSON.stringify(block.input) });
                args.onEvent.onmessage({ type: "stop", index });
              });
              lesson.messages.push({ role: "assistant", content }); save();
              return { content, invalid: {}, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
            }
            default: throw `Unhandled command ${command}`;
          }
        },
      };
    });
    await page.goto("http://localhost:1421");
    await page.locator("#model").click();
    await page.locator("#pop .api-row .icon").click();
    await page.locator("#p-test").click();
    await page.locator("#p-status").getByText("Connected. Lesson tool calling works.").waitFor();
    await page.locator('[data-id="openai"]').click();
    await page.locator("#p-test").click();
    await page.locator("#p-status").getByText("Connection failed: Invalid API key").waitFor();
    await page.locator('#settings button[value="close"]').click();
    await page.locator("#start-input").fill("Teach me addition");
    await page.locator("#start-btn").click();
    await page.locator(".card.quiz").waitFor();
    assert.equal(await page.locator("#canvas-body h1").count(), 1);
    assert.equal(await page.locator("#input").isEnabled(), true, "the composer stays usable while a quiz waits");
    // Simulate closing the app while waiting for an answer.
    await page.reload();
    await page.locator('#tree [data-kind="lesson"]').click();
    await page.locator(".card.quiz").waitFor();
    assert.equal(await page.locator("#canvas-body h1").count(), 1, "resume duplicated a lesson section");
    await page.locator(".card.quiz .opt").nth(answer).click();
    await page.locator(".card.ask").waitFor();
    const result = await page.locator("#canvas-body").innerText();
    assert.ok(result.includes("Combine the two single objects."));
    assert.ok(result.includes(answer === 1 ? "Answer: 2" : "Correct answer: 2"));
    if (answer === 2) assert.ok(result.includes("I don't know"));
    await page.locator('.card.ask input').fill("More examples please");
    await page.locator('.card.ask input').press("Enter");
    await page.getByText("Your answer was received.", { exact: true }).waitFor();
    assert.equal(await page.locator("#input").isEnabled(), true);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("smoke.db")));
    assert.equal(saved.lessons[0].sections.length, 2);
    assert.equal(saved.lessons[0].state, "Addition checked. Next: practice.");
    assert.equal(Object.keys(saved.lessons[0].toolResults).length, 4);
    assert.ok(saved.lessons[0].messages[2].content.some((b) => b.tool_use_id === "quiz-1"));
    await page.reload();
    await page.locator('#tree [data-kind="lesson"]').click();
    await page.locator("#notes-body").getByText("Addition checked. Next: practice.").waitFor({ state: "attached" });
    assert.equal(await page.locator("#canvas-body h1").count(), 1);
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      for (const width of [960, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => document.fonts.ready);
        const layout = await page.locator("#chat").evaluate((chat) => {
          const input = document.querySelector("#composer");
          const bounds = input.getBoundingClientRect();
          const font = getComputedStyle(chat);
          return { overflow: chat.scrollWidth > chat.clientWidth + 1, fontSize: font.fontSize,
            visible: bounds.top >= 0 && bounds.bottom <= innerHeight, background: getComputedStyle(document.body).backgroundColor };
        });
        assert.equal(layout.overflow, false, `${engine}: chat overflows at ${width}`);
        assert.equal(layout.visible, true, `${engine}: composer is clipped at ${width}`);
        assert.equal(layout.fontSize, "16px");
        if (process.env.UI_SCREENSHOTS && answer === 1) {
          await mkdir(process.env.UI_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: `${process.env.UI_SCREENSHOTS}/${engine}-${colorScheme}-${width}.png`, animations: "disabled" });
        }
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${engine} UI passed: answer ${answer}, connection success/error, quiz resume, grading, free answer, state reload`);
  }
  await agentFlow(browser, engine);
  await subjectFlow(browser, engine);
  } finally {
    await browser.close();
  }
}
} finally {
  await server.close();
}
