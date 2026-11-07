import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth, type KeybindingsManager, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type TaskRecord } from "../src/tasks.ts";
import {
  createSessionTail,
  panelTaskInfos,
  refreshSessionTail,
  renderTranscriptLines,
  runningTaskInfos,
  TasksPanelComponent,
  toPanelTaskInfo,
  type PanelTaskInfo,
  type SessionEntryData,
  type TranscriptRenderOptions,
} from "../src/tasks-panel.ts";

// The chat components (assistant message, tool execution) style through the
// package-global theme; in the real TUI pi initializes it at startup.
initTheme("dark");

type RecordOptions = Partial<Omit<TaskRecord, "usage">> & Pick<TaskRecord, "id"> & { usage?: Partial<TaskRecord["usage"]> };

function record(options: RecordOptions): TaskRecord {
  const { usage, ...rest } = options;
  return {
    agent: "general-purpose",
    description: "task",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
      toolCalls: 0,
      toolCallsRequested: 0,
      toolCallsExecuted: 0,
      toolCallsBlocked: 0,
      ...usage,
    },
    ...rest,
  } as unknown as TaskRecord;
}

function panelTask(options: Partial<PanelTaskInfo> & Pick<PanelTaskInfo, "id">): PanelTaskInfo {
  return {
    name: options.id,
    agent: "Explore",
    description: "task",
    turns: 0,
    toolCalls: 0,
    status: "running",
    ...options,
  };
}

function identityTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

function identityMarkdownTheme(): MarkdownTheme {
  const id = (text: string) => text;
  return {
    heading: id,
    link: id,
    linkUrl: id,
    code: id,
    codeBlock: id,
    codeBlockBorder: id,
    quote: id,
    quoteBorder: id,
    hr: id,
    listBullet: id,
    bold: id,
    italic: id,
    strikethrough: id,
    underline: id,
    highlightCode: (code: string) => code.split("\n"),
  };
}

function keybindingsFor(overrides?: Record<string, string>): KeybindingsManager {
  const map: Record<string, string> = {
    "\x1b[A": "tui.select.up",
    "\x1b[B": "tui.select.down",
    "\x1b": "tui.select.cancel",
    "\u0003": "tui.select.cancel",
    ...overrides,
  };
  return {
    matches: (data: string, keybinding: string) => map[data] === keybinding,
  } as unknown as KeybindingsManager;
}

function fakeTui(rows = 40): TUI {
  return { requestRender: () => {}, terminal: { columns: 100, rows } } as unknown as TUI;
}

function transcriptOptions(tui: TUI = fakeTui()): TranscriptRenderOptions {
  return { tui, markdownTheme: identityMarkdownTheme(), cwd: os.tmpdir() };
}

function messageEntry(message: Record<string, unknown>, id = "e1"): SessionEntryData {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message };
}

test("runningTaskInfos keeps only running records and maps fields", () => {
  const running = record({ id: "a", name: "alpha", status: "running", usage: { turns: 3, toolCallsExecuted: 5 } });
  const done = record({ id: "b", status: "completed" });
  const infos = runningTaskInfos([done, running]);
  assert.equal(infos.length, 1);
  assert.deepEqual(infos[0], toPanelTaskInfo(running));
  assert.equal(infos[0]!.name, "alpha");
  assert.equal(infos[0]!.turns, 3);
  assert.equal(infos[0]!.toolCalls, 5);
  assert.equal(infos[0]!.agent, "general-purpose");
});

test("toPanelTaskInfo falls back to the agent name", () => {
  const info = toPanelTaskInfo(record({ id: "a", agent: "Plan" }));
  assert.equal(info.name, "Plan");
});

test("renderTranscriptLines renders user, assistant, and tool entries like the chat window", () => {
  const entries: SessionEntryData[] = [
    messageEntry({ role: "user", content: "find the token refresh" }, "u1"),
    messageEntry(
      { role: "assistant", content: [{ type: "text", text: "Looking at src/auth.ts." }], stopReason: "stop" },
      "a1",
    ),
    messageEntry(
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/auth.ts" } }], stopReason: "stop" },
      "a2",
    ),
    {
      type: "message",
      id: "r1",
      parentId: "a2",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "export const refresh = () => {}" }], isError: false },
    },
  ];
  const lines = renderTranscriptLines(entries, 80, transcriptOptions()).join("\n");
  assert.match(lines, /find the token refresh/);
  assert.match(lines, /Looking at src\/auth\.ts\./);
  assert.match(lines, /read/);
  assert.match(lines, /export const refresh/);
  for (const line of renderTranscriptLines(entries, 80, transcriptOptions())) assert.ok(visibleWidth(line) <= 80);
});

test("renderTranscriptLines skips non-message entries and orphan tool results", () => {
  const entries: SessionEntryData[] = [
    { type: "compaction", id: "c1", parentId: null, timestamp: "t" },
    {
      type: "message",
      id: "r0",
      parentId: null,
      timestamp: "t",
      message: { role: "toolResult", toolCallId: "missing", content: [{ type: "text", text: "orphan" }], isError: false },
    },
    messageEntry({ role: "assistant", content: [{ type: "text", text: "still here" }], stopReason: "stop" }, "a1"),
  ];
  const lines = renderTranscriptLines(entries, 80, transcriptOptions()).join("\n");
  assert.doesNotMatch(lines, /orphan/);
  assert.match(lines, /still here/);
});

test("renderTranscriptLines skips malformed entries instead of throwing", () => {
  const entries: SessionEntryData[] = [
    messageEntry({ role: "assistant", content: [{ type: "text", text: "before" }], stopReason: "stop" }, "a0"),
    messageEntry({ role: "assistant", stopReason: "stop" }, "a1"), // no content
    messageEntry({ role: "assistant", content: "not an array", stopReason: "stop" }, "a2"),
    messageEntry({ role: "assistant", content: 42, stopReason: "stop" }, "a3"),
    messageEntry({ role: "assistant", content: [{ type: "text", text: "after" }], stopReason: "stop" }, "a4"),
  ];
  const lines = renderTranscriptLines(entries, 80, transcriptOptions()).join("\n");
  assert.match(lines, /before/);
  assert.match(lines, /after/);
});

test("refreshSessionTail parses entries incrementally without duplicates", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "child.jsonl");
  const first = JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" }));
  fs.writeFileSync(file, `${first}\n`);

  const tail = createSessionTail();
  refreshSessionTail(tail, file);
  assert.equal(tail.entries.length, 1);
  assert.equal(tail.entries[0]!.message?.role, "assistant");

  // Second read with no new data must not duplicate.
  refreshSessionTail(tail, file);
  assert.equal(tail.entries.length, 1);

  const second = JSON.stringify(messageEntry({ role: "user", content: "more" }, "u2"));
  fs.appendFileSync(file, `${second}\n`);
  refreshSessionTail(tail, file);
  assert.equal(tail.entries.length, 2);
  assert.equal(tail.entries[1]!.message?.role, "user");
});

test("refreshSessionTail holds partial lines until newline and ignores noise", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "child.jsonl");
  const entry = JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "stop" }));
  fs.writeFileSync(file, `noise line\n${entry.slice(0, 40)}`);

  const tail = createSessionTail();
  refreshSessionTail(tail, file);
  assert.deepEqual(tail.entries, []);

  fs.appendFileSync(file, entry.slice(40)); // no newline yet
  refreshSessionTail(tail, file);
  assert.deepEqual(tail.entries, []);

  fs.appendFileSync(file, "\n");
  refreshSessionTail(tail, file);
  assert.equal(tail.entries.length, 1);

  // Non-object JSON lines are ignored.
  fs.appendFileSync(file, `42\n"just a string"\n`);
  refreshSessionTail(tail, file);
  assert.equal(tail.entries.length, 1);
});

test("refreshSessionTail ignores a missing file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tail = createSessionTail();
  refreshSessionTail(tail, path.join(dir, "absent.jsonl"));
  assert.deepEqual(tail, { offset: 0, buffer: "", entries: [] });
});

function makePanel(getTasks: () => PanelTaskInfo[], rows = 40, sendToTask?: (taskId: string, message: string) => Promise<string>) {
  let doneResult: { id: string } | undefined;
  let doneCalls = 0;
  const component = new TasksPanelComponent({
    getTasks,
    tui: fakeTui(rows),
    theme: identityTheme(),
    markdownTheme: identityMarkdownTheme(),
    keybindings: keybindingsFor(),
    cwd: os.tmpdir(),
    done: (result) => {
      doneCalls += 1;
      doneResult = result;
    },
    refreshMs: 60_000,
    sendToTask,
  });
  return {
    component,
    done: () => ({ calls: doneCalls, result: doneResult }),
  };
}

test("panel renders bordered list and a chat-style detail pane at the requested width", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, "child.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify(messageEntry({ role: "user", content: "trace the auth flow" }, "u1")),
      JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "Checking the token refresh path." }], stopReason: "stop" }, "a1")),
      JSON.stringify(
        messageEntry({ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/auth.ts" } }], stopReason: "stop" }, "a2"),
      ),
      JSON.stringify({
        type: "message",
        id: "r1",
        parentId: "a2",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "const refresh = async () => { /* token */ }" }], isError: false },
      }),
    ].join("\n") + "\n",
  );
  const { component, done } = makePanel(() => [
    panelTask({ id: "task-a", name: "trace-auth", agent: "Explore", turns: 12, toolCalls: 5, sessionFile }),
    panelTask({ id: "task-b", name: "fork-audit", turns: 3, toolCalls: 1 }),
  ]);
  t.after(() => component.dispose());

  const lines = component.render(100);
  assert.equal(lines.length, 40, "full-screen panel fills the terminal rows");
  for (const line of lines) assert.equal(visibleWidth(line), 100, "every line fits the width exactly");
  assert.match(lines[0]!, /subagents/);
  assert.match(lines[lines.length - 1]!, /esc close/);
  assert.ok(lines.some((line) => line.includes("▶") && line.includes("trace-auth")), "selected task is marked");
  assert.ok(lines.some((line) => line.includes("fork-audit")));
  const detail = lines.join("\n");
  assert.match(detail, /trace the auth flow/, "detail shows the user prompt like the primary window");
  assert.match(detail, /Checking the token refresh path\./);
  assert.match(detail, /read/);
  assert.match(detail, /const refresh = async/);
  assert.equal(done().calls, 0);
});

test("panel detail follows the selected task and appends new session data", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionA = path.join(dir, "a.jsonl");
  const sessionB = path.join(dir, "b.jsonl");
  fs.writeFileSync(sessionA, `${JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "work A" }], stopReason: "stop" }))}\n`);
  fs.writeFileSync(sessionB, `${JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "work B" }], stopReason: "stop" }))}\n`);
  const tasks = [
    panelTask({ id: "a", name: "task-a", sessionFile: sessionA }),
    panelTask({ id: "b", name: "task-b", sessionFile: sessionB }),
  ];
  const { component } = makePanel(() => tasks);
  t.after(() => component.dispose());

  let detail = component.render(100).join("\n");
  assert.match(detail, /work A/);
  assert.doesNotMatch(detail, /work B/);

  component.handleInput("\x1b[B"); // select the second task
  detail = component.render(100).join("\n");
  assert.match(detail, /work B/);
  assert.doesNotMatch(detail, /work A/);

  // New data appended to the selected session shows up after a tick.
  fs.appendFileSync(sessionB, `${JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "work B continued" }], stopReason: "stop" }, "a2"))}\n`);
  component["tick"]();
  detail = component.render(100).join("\n");
  assert.match(detail, /work B continued/);
});

test("panel stays box-exact at the minimum renderable width", (t) => {
  const { component } = makePanel(() => [panelTask({ id: "a" }), panelTask({ id: "b" })], 12);
  t.after(() => component.dispose());

  for (const width of [26, 27, 28]) {
    for (const line of component.render(width)) assert.equal(visibleWidth(line), width, `every line fits at width ${width}`);
  }
});

test("panel navigates selection with up/down and closes with escape", (t) => {
  const { component, done } = makePanel(() => [panelTask({ id: "a" }), panelTask({ id: "b" })]);
  t.after(() => component.dispose());

  const initial = component.render(100).join("\n");
  assert.match(initial, /▶ .*a/);

  component.handleInput("\x1b[B"); // down
  assert.match(component.render(100).join("\n"), /▶ .*b/);
  component.handleInput("\x1b[B"); // wraps to the top
  assert.match(component.render(100).join("\n"), /▶ .*a/);
  component.handleInput("\x1b[A"); // up wraps to the bottom
  assert.match(component.render(100).join("\n"), /▶ .*b/);

  component.handleInput("\x1b");
  assert.equal(done().calls, 1);
  assert.equal(done().result, undefined);
});

test("panel with no running tasks renders the empty state", (t) => {
  const { component, done } = makePanel(() => []);
  t.after(() => component.dispose());

  const text = component.render(100).join("\n");
  assert.match(text, /no running subagents/);
  assert.match(text, /esc close/);
  component.handleInput("\u0003"); // ctrl+c also closes
  assert.equal(done().calls, 1);
});

test("panel falls back to the task preview when the session has no rendered content", (t) => {
  const { component } = makePanel(() => [panelTask({ id: "a", name: "scout", preview: "scanning the repo…" })]);
  t.after(() => component.dispose());

  const text = component.render(100).join("\n");
  assert.match(text, /scanning the repo…/);
});

test("panel fills the terminal rows exactly regardless of task count", (t) => {
  const tasks = Array.from({ length: 30 }, (_, i) => panelTask({ id: `task-${i}`, name: `task-${i}` }));
  const { component } = makePanel(() => tasks, 40);
  t.after(() => component.dispose());

  const lines = component.render(100);
  assert.equal(lines.length, 40, `full-screen panel fills the terminal, got ${lines.length}`);
  assert.ok(lines.some((line) => /\+20 more/.test(line)), "list overflow is summarized");
  for (const line of lines) assert.equal(visibleWidth(line), 100);
});

test("transcript view follows the tail and scrolls with pageUp/pageDown/End", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, "child.jsonl");
  const entries = Array.from({ length: 100 }, (_, i) =>
    JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: `message ${i}` }], stopReason: "stop" }, `m${i}`)),
  );
  fs.writeFileSync(sessionFile, entries.join("\n") + "\n");
  const { component } = makePanel(() => [panelTask({ id: "a", sessionFile })], 40);
  t.after(() => component.dispose());

  component.render(100); // the TUI renders before input arrives
  let view = component.render(100).join("\n");
  assert.match(view, /message 99/, "tail shows the newest message");
  assert.doesNotMatch(view, /message 0\b/, "tail hides the oldest message");

  component.handleInput("\x1b[5~"); // pageUp
  view = component.render(100).join("\n");
  assert.doesNotMatch(view, /message 99/, "scrolling up hides the tail");

  component.handleInput("\x1b[H"); // home
  view = component.render(100).join("\n");
  assert.match(view, /message 0\b/, "home reaches the oldest message");
  assert.match(view, /↑\d+/, "header shows the scroll offset");

  component.handleInput("\x1b[F"); // end
  view = component.render(100).join("\n");
  assert.match(view, /message 99/, "end returns to the tail");
  assert.doesNotMatch(view, /↑\d+/, "offset indicator is gone at the tail");
});

test("wheel scrolls the detail pane and is ignored over the list", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, "child.jsonl");
  const entries = Array.from({ length: 40 }, (_, i) =>
    JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: `message ${i}` }], stopReason: "stop" }, `m${i}`)),
  );
  fs.writeFileSync(sessionFile, entries.join("\n") + "\n");
  const { component } = makePanel(() => [panelTask({ id: "a", sessionFile })], 40);
  t.after(() => component.dispose());

  const wheel = (y: number, delta: number) =>
    component.handleMouse({
      type: "wheel", button: "none", x: 10, y, screenX: 10, screenY: y, width: 100, height: 40,
      shift: false, alt: false, ctrl: false, wheelDelta: delta,
    });

  component.render(100); // the TUI renders before mouse events arrive
  assert.deepEqual(wheel(1, -5), { handled: true }, "wheel over the list is consumed, not forwarded to the main chat");
  assert.deepEqual(wheel(20, -5), { handled: true }, "wheel up over the detail pane is handled");
  let view = component.render(100).join("\n");
  assert.doesNotMatch(view, /message 39/, "wheel up hid the tail");

  component.handleInput("\x1b[F"); // back to the tail
  assert.match(component.render(100).join("\n"), /message 39/);
});

test("scroll position pauses tail-follow until the user returns to the bottom", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, "child.jsonl");
  const entries = Array.from({ length: 40 }, (_, i) =>
    JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: `message ${i}` }], stopReason: "stop" }, `m${i}`)),
  );
  fs.writeFileSync(sessionFile, entries.join("\n") + "\n");
  const { component } = makePanel(() => [panelTask({ id: "a", sessionFile })], 40);
  t.after(() => component.dispose());

  component.render(100); // the TUI renders before input arrives
  component.handleInput("\x1b[H"); // scroll to the top
  fs.appendFileSync(sessionFile, `${JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "brand new" }], stopReason: "stop" }, "mnew"))}\n`);
  component["tick"]();
  let view = component.render(100).join("\n");
  assert.doesNotMatch(view, /brand new/, "scrolled-up view does not jump to new content");

  component.handleInput("\x1b[F"); // end resumes follow
  view = component.render(100).join("\n");
  assert.match(view, /brand new/, "back at the bottom, new content is visible");
});

test("panelTaskInfos lists running first, then recently finished within the cap", () => {
  const mk = (id: string, status: "running" | "completed", startedAt: string, completedAt?: string) =>
    record({ id, status, startedAt, completedAt, updatedAt: completedAt ?? startedAt });
  const infos = panelTaskInfos(
    [
      mk("z-run", "running", "2026-01-01T01:00:00Z"),
      mk("a-run", "running", "2026-01-01T00:00:00Z"),
      mk("c-done", "completed", "2026-01-01T02:00:00Z", "2026-01-02T03:00:00Z"),
      mk("b-done", "completed", "2026-01-01T02:00:00Z", "2026-01-02T02:00:00Z"),
      mk("a-done", "completed", "2026-01-01T02:00:00Z", "2026-01-02T01:00:00Z"),
    ],
    2,
  );
  assert.deepEqual(infos.map((info) => info.id), ["a-run", "z-run", "c-done", "b-done"], "running first by start, then newest finished, capped");
  assert.equal(infos[2]!.status, "completed");
});

test("finished tasks are hidden by default and toggled with f", (t) => {
  const { component } = makePanel(() => [
    panelTask({ id: "a", name: "scout", status: "running" }),
    panelTask({ id: "b", name: "old-scene", status: "completed" }),
  ]);
  t.after(() => component.dispose());

  let text = component.render(100).join("\n");
  assert.match(text, /scout/);
  assert.doesNotMatch(text, /old-scene/, "finished tasks are hidden by default");
  assert.match(text, /f finished/, "footer offers the toggle");

  component.handleInput("f"); // show finished
  text = component.render(100).join("\n");
  assert.match(text, /old-scene/);
  assert.match(text, /f hide finished/);

  component.handleInput("\x1b[B"); // select the finished task
  text = component.render(100).join("\n");
  assert.match(text, /— completed, 0 tool calls/, "finished task header shows its status");

  component.handleInput("f"); // hide again
  text = component.render(100).join("\n");
  assert.doesNotMatch(text, /old-scene/);
  assert.match(text, /▶ scout/, "selection falls back to a running task");
});

test("session tail tracks the latest assistant model", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, "child.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "one" }], stopReason: "stop", model: "litellm/Qwen-A", provider: "litellm" }, "a1")),
      JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "two" }], stopReason: "stop" }, "a2")),
      JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "three" }], stopReason: "stop", model: "litellm/Qwen-B", provider: "litellm" }, "a3")),
    ].join("\n") + "\n",
  );
  const tail = createSessionTail();
  refreshSessionTail(tail, sessionFile);
  assert.equal(tail.lastModel, "litellm/Qwen-B", "latest assistant model wins; model-less messages don't reset it");
});

const editorBoxVisible = (lines: string[]) => lines.some((line) => /^│ ─+ │$/.test(line));

test("Enter opens the main-TUI editor box; Enter sends to the task and shows the returned note", async (t) => {
  const sent: Array<[string, string]> = [];
  const sendToTask = (id: string, message: string) => {
    sent.push([id, message]);
    return Promise.resolve("Message delivered to scout.");
  };
  const { component } = makePanel(() => [panelTask({ id: "a", name: "scout" })], 40, sendToTask);
  t.after(() => component.dispose());

  component.render(100);
  component.handleInput("\r"); // enter opens the editor box
  let lines = component.render(100);
  assert.ok(editorBoxVisible(lines), "editor box is visible");

  component.handleInput("h");
  component.handleInput("i");
  component.handleInput("\r"); // submit (Enter)
  assert.deepEqual(sent, [["a", "hi"]], "typed message is delivered to the selected task");

  await new Promise((resolve) => setImmediate(resolve)); // let the async note land
  lines = component.render(100);
  const text = lines.join("\n");
  assert.match(text, /Message delivered to scout\./);
  assert.ok(!editorBoxVisible(lines), "editor box is gone after send");
  assert.match(text, /Enter message/);
});

test("footer shows the model the selected subagent is using, like the main TUI", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, "child.jsonl");
  fs.writeFileSync(
    sessionFile,
    JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "stop", model: "litellm/Qwen3.8-27B-FP8", provider: "litellm" }, "a1")) + "\n",
  );
  const { component } = makePanel(() => [
    panelTask({ id: "a", name: "scout", model: "configured-model", sessionFile }),
    panelTask({ id: "b", name: "planner", model: "configured-model-2" }),
  ]);
  t.after(() => component.dispose());

  let lines = component.render(100);
  assert.ok(lines.at(-1)!.includes("litellm/Qwen3.8-27B-FP8"), "session's actual model wins over the configured one");
  for (const line of lines) assert.equal(visibleWidth(line), 100);

  component.handleInput("\x1b[B"); // select the task without a session
  lines = component.render(100);
  assert.ok(lines.at(-1)!.includes("configured-model-2"), "falls back to the configured model");
  assert.ok(!lines.at(-1)!.includes("litellm"), "no leak from the other task");
  for (const line of lines) assert.equal(visibleWidth(line), 100);
});

test("footer model truncates on narrow widths without breaking the box", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, "child.jsonl");
  fs.writeFileSync(
    sessionFile,
    JSON.stringify(messageEntry({ role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "stop", model: "litellm/very-long-model-name-that-never-fits", provider: "litellm" }, "a1")) + "\n",
  );
  const { component } = makePanel(() => [panelTask({ id: "a", name: "scout", sessionFile })], 40);
  t.after(() => component.dispose());

  const lines = component.render(26);
  assert.equal(lines.length, 40);
  for (const line of lines) assert.equal(visibleWidth(line), 26, "narrow width stays box-exact with the model in the footer");
});

test("the editor box keeps the panel exactly terminal-sized", (t) => {
  const { component } = makePanel(() => [panelTask({ id: "a", name: "scout" })], 40, () => Promise.resolve("ok"));
  t.after(() => component.dispose());

  component.render(100);
  component.handleInput("\r");
  const lines = component.render(100);
  assert.equal(lines.length, 40, `editor open still fills the terminal, got ${lines.length}`);
  for (const line of lines) assert.equal(visibleWidth(line), 100);
});

test("Esc returns from the editor without closing the panel", (t) => {
  const { component, done } = makePanel(() => [panelTask({ id: "a", name: "scout" })], 40, () => Promise.resolve("ok"));
  t.after(() => component.dispose());

  component.render(100);
  component.handleInput("\r");
  assert.ok(editorBoxVisible(component.render(100)));

  component.handleInput("\x1b"); // esc exits editing
  assert.equal(done().calls, 0, "panel is still open");
  assert.ok(!editorBoxVisible(component.render(100)));

  component.handleInput("\x1b"); // esc closes
  assert.equal(done().calls, 1);
});

test("an empty message does not send", (t) => {
  const sent: string[] = [];
  const { component } = makePanel(
    () => [panelTask({ id: "a", name: "scout" })],
    40,
    (_id, message) => {
      sent.push(message);
      return Promise.resolve("ok");
    },
  );
  t.after(() => component.dispose());

  component.render(100);
  component.handleInput("\r");
  component.handleInput("\r"); // empty submit
  assert.equal(sent.length, 0, "empty message is not sent");
  assert.ok(!editorBoxVisible(component.render(100)), "editor closed after empty submit");
});

test("a failed send shows the error in the footer", async (t) => {
  const { component } = makePanel(
    () => [panelTask({ id: "a", name: "scout" })],
    40,
    () => Promise.reject(new Error("task is no longer running")),
  );
  t.after(() => component.dispose());

  component.render(100);
  component.handleInput("\r");
  component.handleInput("h");
  component.handleInput("i");
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(component.render(100).join("\n"), /send failed: task is no longer running/);
});

test("short terminals still fill exactly: the list shrinks before the footer clips", (t) => {
  const tasks = Array.from({ length: 20 }, (_, i) => panelTask({ id: `task-${i}` }));
  const { component } = makePanel(() => tasks, 16);
  t.after(() => component.dispose());

  const lines = component.render(100);
  assert.equal(lines.length, 16, `short terminal renders 16 rows, got ${lines.length}`);
  for (const line of lines) assert.equal(visibleWidth(line), 100);
  assert.ok(lines.some((line) => /\+\d+ more/.test(line)), "overflow is still summarized");

  component.dispose();
  const tiny = new TasksPanelComponent({
    getTasks: () => Array.from({ length: 10 }, (_, i) => panelTask({ id: `task-${i}` })),
    tui: fakeTui(10),
    theme: identityTheme(),
    markdownTheme: identityMarkdownTheme(),
    keybindings: keybindingsFor(),
    cwd: os.tmpdir(),
    done: () => {},
    refreshMs: 60_000,
  });
  t.after(() => tiny.dispose());
  const tinyLines = tiny.render(100);
  assert.equal(tinyLines.length, 10, `10-row terminal renders 10 rows, got ${tinyLines.length}`);
  for (const line of tinyLines) assert.equal(visibleWidth(line), 100);
});
