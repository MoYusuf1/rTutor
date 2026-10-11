import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";

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
      const state = JSON.parse(localStorage.getItem("smoke.db") || "null") || { lessons: [], turns: 0 };
      const save = () => localStorage.setItem("smoke.db", JSON.stringify(state));
      let nextCallback = 0;
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => ++nextCallback,
        unregisterCallback: () => {},
        invoke: async (command, args = {}) => {
          const lesson = state.lessons.find((l) => l.id === (args.lesson ?? args.id));
          switch (command) {
            case "get_settings": return { active: "codex", providers: {} };
            case "save_settings": return;
            case "has_api_key": return false;
            case "test_provider":
              if (args.provider.kind === "openai") throw "Invalid API key";
              return "Connected. Lesson tool calling works.";
            case "tree": return { lessons: state.lessons, folders: [], sources: [] };
            case "stats": return {};
            case "create_lesson": {
              const id = state.lessons.length + 1;
              state.lessons.push({ id, title: args.title, folder: null, state: "", sections: [], messages: [], toolResults: {} });
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
    assert.equal(await page.locator("#input").isDisabled(), true);
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
    await page.waitForFunction(() => !document.body.classList.contains("busy"));
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
  } finally {
    await browser.close();
  }
}
} finally {
  await server.close();
}
