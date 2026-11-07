import * as fs from "node:fs";
import {
  Container,
  Editor,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type KeybindingsManager,
  type MarkdownTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type TaskRecord, type TaskStatus } from "./tasks.ts";

/** Snapshot of one running task, everything the panel needs to display it. */
export interface PanelTaskInfo {
  id: string;
  name: string;
  agent: string;
  description: string;
  turns: number;
  toolCalls: number;
  status: TaskStatus;
  /** Model configured for the task (may be undefined = inherit parent). */
  model?: string;
  preview?: string;
  sessionFile?: string;
}

export function toPanelTaskInfo(record: TaskRecord): PanelTaskInfo {
  return {
    id: record.id,
    name: record.name ?? record.agent,
    agent: record.agent,
    description: record.description,
    turns: record.usage.turns,
    toolCalls: record.usage.toolCallsExecuted,
    status: record.status,
    model: record.model,
    preview: record.preview,
    sessionFile: record.sessionFile,
  };
}

/** Map task records to panel infos, keeping only the running ones. */
export function runningTaskInfos(records: TaskRecord[]): PanelTaskInfo[] {
  return records.filter((record) => record.status === "running").map(toPanelTaskInfo);
}

/**
 * Map task records to panel infos: running tasks first (oldest start first),
 * then recently finished tasks (newest completion first, capped).
 */
export function panelTaskInfos(records: TaskRecord[], finishedLimit = 12): PanelTaskInfo[] {
  const byDate = (a: TaskRecord, b: TaskRecord, field: "startedAt" | ("completedAt" | "updatedAt")) =>
    (b[field] ?? "").localeCompare(a[field] ?? "");
  const running = records
    .filter((record) => record.status === "running")
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
    .map(toPanelTaskInfo);
  const finished = records
    .filter((record) => record.status !== "running")
    .sort((a, b) => byDate(a, b, "completedAt") || byDate(a, b, "updatedAt"))
    .slice(0, Math.max(0, finishedLimit))
    .map(toPanelTaskInfo);
  return [...running, ...finished];
}

/**
 * One parsed child-session entry (a JSONL line). Kept untyped on purpose:
 * the transcript renderer only inspects the fields it renders.
 */
export type SessionEntryData = {
  type?: unknown;
  id?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
    isError?: unknown;
    details?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** Incremental state for tailing one child session JSONL file. */
export interface SessionTail {
  offset: number;
  buffer: string;
  entries: SessionEntryData[];
  /** Model of the latest assistant message in the session (what it is actually using). */
  lastModel?: string;
}

export function createSessionTail(): SessionTail {
  return { offset: 0, buffer: "", entries: [] };
}

const MAX_ENTRIES = 150;
/** Seed cap for the initial read of a child session file; larger files start at the tail. */
const MAX_SEED_BYTES = 512 * 1024;

/**
 * Read newly-appended JSONL bytes from a child session file and append the
 * parsed entries to the tail. The first read seeds from the end of the file
 * when it is larger than {@link MAX_SEED_BYTES}. A missing or reset file
 * leaves the existing entries intact.
 */
export function refreshSessionTail(tail: SessionTail, sessionFile: string): void {
  let size: number;
  try {
    size = fs.statSync(sessionFile).size;
  } catch {
    return;
  }
  if (size < tail.offset) {
    tail.offset = 0;
    tail.buffer = "";
    tail.entries = [];
    tail.lastModel = undefined;
  }
  let start = tail.offset;
  if (start === 0 && size > MAX_SEED_BYTES) start = size - MAX_SEED_BYTES;
  const length = size - start;
  if (length <= 0) {
    tail.offset = size;
    return;
  }
  let data: Buffer;
  try {
    const fd = fs.openSync(sessionFile, "r");
    try {
      data = Buffer.alloc(length);
      fs.readSync(fd, data, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  tail.offset = start + data.length;
  const full = tail.buffer + data.toString("utf8");
  const lastNewline = full.lastIndexOf("\n");
  if (lastNewline === -1) {
    tail.buffer = full;
    return;
  }
  tail.buffer = full.slice(lastNewline + 1);
  const added: SessionEntryData[] = [];
  for (const line of full.slice(0, lastNewline).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const data = entry as SessionEntryData;
    if (data.message?.role === "assistant" && typeof data.message.model === "string" && data.message.model) {
      tail.lastModel = data.message.model;
    }
    added.push(data);
  }
  if (added.length > 0) {
    tail.entries.push(...added);
    if (tail.entries.length > MAX_ENTRIES) tail.entries.splice(0, tail.entries.length - MAX_ENTRIES);
  }
}

function userMessageText(message: NonNullable<SessionEntryData["message"]>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => {
      const p = part as { type?: unknown; text?: unknown };
      return p?.type === "text" && typeof p.text === "string";
    })
    .map((part) => part.text)
    .join("");
}

export interface TranscriptRenderOptions {
  tui: TUI;
  markdownTheme: MarkdownTheme;
  cwd: string;
}

/**
 * Render child-session entries with the same components the primary chat
 * window uses (assistant messages, tool executions with results, user
 * messages), so the panel's detail pane looks like a miniature session view.
 * Non-message entries (compaction, usage, custom) are skipped.
 */
export function renderTranscriptLines(entries: readonly SessionEntryData[], width: number, options: TranscriptRenderOptions): string[] {
  if (width <= 0) return [];
  const container = new Container();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!message) continue;
    // One malformed entry must not take down the whole transcript: pi's chat
    // components throw on unexpected shapes (e.g. missing or non-array content).
    try {
      if (message.role === "assistant") {
        container.addChild(new AssistantMessageComponent(message as never, false, options.markdownTheme));
        const content = message.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            const p = part as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown };
            if (p?.type !== "toolCall" || typeof p.id !== "string") continue;
            const tool = new ToolExecutionComponent(String(p.name ?? "tool"), p.id, p.arguments, undefined, undefined, options.tui, options.cwd);
            if (message.stopReason === "aborted" || message.stopReason === "error") {
              tool.updateResult({ content: [{ type: "text", text: typeof message.errorMessage === "string" ? message.errorMessage : "Error" }], isError: true });
            } else {
              pendingTools.set(p.id, tool);
            }
            container.addChild(tool);
          }
        }
      } else if (message.role === "toolResult") {
        if (typeof message.toolCallId === "string" && pendingTools.has(message.toolCallId)) {
          const tool = pendingTools.get(message.toolCallId)!;
          tool.updateResult({
            content: Array.isArray(message.content) ? (message.content as never[]) : [{ type: "text", text: String(message.content ?? "") }],
            details: message.details,
            isError: message.isError === true,
          });
          pendingTools.delete(message.toolCallId);
        }
      } else if (message.role === "user") {
        const text = userMessageText(message);
        if (text) container.addChild(new UserMessageComponent(text, options.markdownTheme));
      }
    } catch {
      // Skip the entry; the rest of the transcript still renders.
    }
  }
  return container.render(width);
}

/**
 * Build the editor theme the main TUI uses for its input box, from the
 * session theme (same mapping as pi's getEditorTheme).
 */
function editorThemeFrom(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("muted", text),
    },
  };
}

export interface TasksPanelOptions {
  /** Returns fresh snapshots of the running and recently finished tasks. */
  getTasks: () => PanelTaskInfo[];
  tui: TUI;
  theme: Theme;
  markdownTheme: MarkdownTheme;
  keybindings: KeybindingsManager;
  cwd: string;
  done: (result: { id: string } | undefined) => void;
  /** Refresh tick in ms (default 1000). */
  refreshMs?: number;
  /**
   * Deliver a message to a task: running tasks queue it, finished tasks are
   * resumed with it. Resolves with a short user-facing note; rejects on failure.
   */
  sendToTask?: (taskId: string, message: string) => Promise<string>;
}

/** The task list never grows past this many rows; the rest go to the transcript view. */
const LIST_MAX_ROWS = 10;

/**
 * Full-screen component listing the session's subagent tasks — running tasks
 * by default, recently finished/stopped ones on demand (toggle: f) — with a
 * live, scrollable transcript view (primary-window rendering) of the
 * selected task's session. State is polled each tick from the known task
 * records and the child session files (the single source of truth, which
 * also covers resumed tasks). Enter opens a message editor (the main TUI's
 * input box) for the selected task; sending to a finished task resumes it.
 * The transcript follows the tail while at the bottom and pauses when the
 * user scrolls up (keys: PgUp/PgDn/Home/End, or the mouse wheel where the
 * TUI forwards it).
 */
export class TasksPanelComponent implements Component {
  private readonly opts: TasksPanelOptions;
  private readonly tails = new Map<string, SessionTail>();
  /** Cached transcript render; invalidated when the selected task's entries or width change. */
  private renderedTaskId: string | undefined;
  private renderedSignature: string | undefined;
  private renderedLines: string[] = [];
  private tasks: PanelTaskInfo[] = [];
  private selected = 0;
  /** Show finished/stopped tasks in the list (default: running only). */
  private showFinished = false;
  /** Lines above the bottom of the transcript; 0 = following the tail. */
  private scrollOffset = 0;
  /** Local row where the transcript viewport starts (wheel hit-testing). */
  private detailTopRow = 0;
  private detailViewportRows = 0;
  private editing = false;
  /** Message editor; rendered as a box above the footer while editing. */
  private editor: Editor | null = null;
  /** Local row where the editor box starts (mouse hit-testing). */
  private editorTopRow = 0;
  private editorBoxRows = 0;
  private footerNote: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private finished = false;

  constructor(opts: TasksPanelOptions) {
    this.opts = opts;
    this.tick();
    this.timer = setInterval(() => this.tick(), opts.refreshMs ?? 1000);
    this.timer.unref?.();
  }

  private close(): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.opts.done(undefined);
    } catch {
      // A stale session (replacement/reload while the panel is open) must not break input handling.
    }
  }

  private tick(): void {
    if (this.disposed) return;
    try {
      this.tasks = this.opts.getTasks();
      this.resyncSelection();
      for (const task of this.tasks) {
        if (!task.sessionFile) continue;
        let tail = this.tails.get(task.id);
        if (!tail) {
          tail = createSessionTail();
          this.tails.set(task.id, tail);
        }
        refreshSessionTail(tail, task.sessionFile);
      }
      for (const id of [...this.tails.keys()]) {
        if (!this.tasks.some((task) => task.id === id)) this.tails.delete(id);
      }
      const selectedTask = this.tasks[this.selected];
      if (selectedTask?.id !== this.renderedTaskId) {
        this.renderedTaskId = undefined;
        this.renderedSignature = undefined;
        this.scrollOffset = 0;
      }
      this.opts.tui.requestRender();
    } catch {
      // A transient read error must never take the panel down; the next tick retries.
    }
  }

  private maxScrollOffset(): number {
    return Math.max(0, this.renderedLines.length - this.detailViewportRows);
  }

  /** Indices (into this.tasks) visible under the current showFinished filter. */
  private visibleIndices(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.tasks.length; i++) {
      if (this.showFinished || this.tasks[i]!.status === "running") out.push(i);
    }
    return out;
  }

  private selectIndex(index: number): void {
    if (index === this.selected) return;
    this.selected = index;
    this.scrollOffset = 0;
    this.footerNote = null;
  }

  /** Move the selection by delta, wrapping within the visible tasks. */
  private moveSelection(delta: number): void {
    const visible = this.visibleIndices();
    if (visible.length === 0) return;
    let pos = visible.indexOf(this.selected);
    if (pos === -1) pos = 0;
    this.selectIndex(visible[(pos + delta + visible.length) % visible.length]!);
  }

  /** Keep the selection on a visible task after list updates or filter changes. */
  private resyncSelection(): void {
    if (this.tasks.length === 0) {
      this.selected = 0;
      return;
    }
    if (this.selected >= this.tasks.length) {
      this.selected = Math.max(0, this.tasks.length - 1);
      this.scrollOffset = 0;
      return;
    }
    const visible = this.visibleIndices();
    if (visible.length === 0 || visible.includes(this.selected)) return;
    const before = visible.filter((i) => i < this.selected).pop();
    this.selectIndex(before ?? visible[0]!);
  }

  /** delta > 0 scrolls up (away from the tail); delta < 0 scrolls down. */
  private scrollBy(delta: number): void {
    this.scrollOffset = Math.min(this.maxScrollOffset(), Math.max(0, this.scrollOffset + delta));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.editing && this.editor) {
      // The editor box owns its rows; forward mouse events to it.
      if (event.y >= this.editorTopRow && event.y < this.editorTopRow + this.editorBoxRows) {
        return this.editor.handleMouse({
          ...event,
          x: Math.max(0, event.x - 2),
          y: event.y - this.editorTopRow,
          width: Math.max(1, event.width - 4),
          height: Math.max(1, event.height - 1),
        });
      }
      if (event.type === "click") return { handled: true };
    }
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    // Consume wheels outside the transcript viewport (list/header/footer) so
    // they never reach the main chat behind the full-screen overlay.
    if (event.y < this.detailTopRow || event.y >= this.detailTopRow + this.detailViewportRows) return { handled: true };
    // Positive wheelDelta scrolls toward the tail (bottom).
    this.scrollBy(-event.wheelDelta);
    this.opts.tui.requestRender();
    return { handled: true };
  }

  handleInput(data: string): void {
    if (this.editing) {
      // Escape/Ctrl-C returns to the panel; everything else goes to the editor.
      if (this.opts.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
        this.closeEditing();
        return;
      }
      this.editor?.handleInput(data);
      return;
    }
    if (this.opts.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (this.tasks.length > 0 && this.opts.sendToTask && matchesKey(data, "enter")) {
      this.startEditing();
      return;
    }
    if (matchesKey(data, "f")) {
      // Toggle finished/stopped tasks in the list.
      this.showFinished = !this.showFinished;
      this.resyncSelection();
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollBy(Math.max(1, this.detailViewportRows - 1));
    } else if (matchesKey(data, "pageDown")) {
      this.scrollBy(-(Math.max(1, this.detailViewportRows - 1)));
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = this.maxScrollOffset();
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = 0;
    } else if (this.tasks.length > 0 && this.opts.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (this.tasks.length > 0 && this.opts.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else {
      return;
    }
    this.opts.tui.requestRender();
  }

  /** Open the message editor (Enter) — the main TUI's input box. */
  private startEditing(): void {
    const task = this.tasks[this.selected];
    if (!task || !this.opts.sendToTask || this.editing) return;
    // The editor box grows with the message (up to ~30% of terminal height);
    // it cannot fit on degenerate terminals, so ignore Enter there.
    if (this.opts.tui.terminal.rows < 9) return;
    this.editing = true;
    this.footerNote = null;
    const editor = new Editor(this.opts.tui, editorThemeFrom(this.opts.theme), { paddingX: 1 });
    editor.focused = true;
    editor.onSubmit = (value) => {
      const text = value.trim();
      const target = task;
      this.closeEditing();
      if (text) this.sendToTask(target.id, text);
    };
    this.editor = editor;
    this.opts.tui.requestRender();
  }

  private closeEditing(): void {
    if (!this.editing) return;
    this.editing = false;
    this.editor = null;
    this.opts.tui.requestRender();
  }

  /** Deliver a message; the returned note (or error) is shown in the footer. */
  private sendToTask(taskId: string, text: string): void {
    const send = this.opts.sendToTask;
    if (!send) return;
    this.footerNote = "sending…";
    this.opts.tui.requestRender();
    // Call send eagerly (the delivery must start synchronously); only the
    // note/error handling waits for the result, which may be sync or async.
    let result: Promise<string>;
    try {
      result = Promise.resolve(send(taskId, text));
    } catch (error) {
      result = Promise.reject(error);
    }
    result
      .then((note) => {
        this.footerNote = note;
      })
      .catch((error) => {
        this.footerNote = `send failed: ${error instanceof Error ? error.message : String(error)}`;
      })
      .finally(() => {
        if (!this.disposed) this.opts.tui.requestRender();
      });
  }

  /** Full transcript for the selected task, rendered once per change of its entries or width. */
  private selectedTranscriptLines(width: number): string[] {
    const task = this.tasks[this.selected];
    if (!task) return [];
    const tail = this.tails.get(task.id);
    const signature = `${width}:${tail?.entries.length ?? 0}:${String(tail?.entries.at(-1)?.id ?? "")}`;
    if (this.renderedTaskId !== task.id || this.renderedSignature !== signature) {
      try {
        this.renderedLines = renderTranscriptLines(tail?.entries ?? [], width, {
          tui: this.opts.tui,
          markdownTheme: this.opts.markdownTheme,
          cwd: this.opts.cwd,
        });
      } catch {
        // A bad transcript must not crash the render loop; fall back to the preview line.
        this.renderedLines = [];
      }
      this.renderedTaskId = task.id;
      this.renderedSignature = signature;
    }
    return this.renderedLines;
  }

  render(width: number): string[] {
    const theme = this.opts.theme;
    const inner = width - 2;
    if (inner < 24) return [];
    const rows = Math.max(6, this.opts.tui.terminal.rows);
    const border = (line: string) => theme.fg("border", line);
    const row = (content: string) =>
      border("│") + truncateToWidth(content, inner, "…", true) + border("│");
    const fill = (prefix: string, corners: [string, string]) => {
      const safePrefix = visibleWidth(prefix) > inner - 2 ? truncateToWidth(prefix, inner - 2, "…") : prefix;
      return border(`${corners[0]} ${safePrefix} ${"─".repeat(Math.max(0, inner - 2 - visibleWidth(safePrefix)))}${corners[1]}`);
    };

    const lines: string[] = [fill(" subagents ", ["╭", "╮"])];
    const visible = this.visibleIndices().map((i) => this.tasks[i]!);

    if (visible.length === 0) {
      lines.push(row(` ${theme.fg("muted", this.showFinished ? "no subagents" : "no running subagents")}`));
      for (let i = lines.length; i < rows - 1; i++) lines.push(row(" "));
      return [...lines, fill(" esc close ", ["╰", "╯"])];
    }

    // The message editor box (while editing) is rendered first so its height
    // can be charged against the list/viewport budget.
    let box = this.editing && this.editor ? this.editor.render(Math.max(2, inner - 2)) : [];
    // Budget: title + list (+overflow row) + divider + header + viewport (≥1
    // unless editing) + editor box + footer.
    const maxList = Math.max(1, rows - box.length - 4 - (this.editing ? 0 : 1));
    const listRows = Math.max(1, Math.min(visible.length, LIST_MAX_ROWS, maxList));
    for (let i = 0; i < listRows; i++) {
      const task = visible[i]!;
      const isSelected = task.id === this.tasks[this.selected]?.id;
      const label = `${task.name} (${task.agent})`;
      const meta = task.status === "running" ? `t${task.turns} · ${task.toolCalls} calls` : `${task.status} · t${task.turns} · ${task.toolCalls} calls`;
      const content = isSelected
        ? `${theme.fg("accent", `▶ ${label}`)}  ${theme.fg("dim", meta)}`
        : task.status === "running"
          ? `  ${label}  ${theme.fg("dim", meta)}`
          : `  ${theme.fg("muted", label)}  ${theme.fg("dim", meta)}`;
      lines.push(row(content));
    }
    const showOverflow = visible.length > listRows && listRows + 1 <= maxList;
    if (showOverflow) {
      lines.push(row(` ${theme.fg("dim", `+${visible.length - listRows} more — ↑↓ to reach`)}`));
    }

    lines.push(border(`├${"─".repeat(inner)}┤`));

    // The box must fit between the divider and the footer; crop the oldest
    // visible lines (the cursor sits at the newest) when it cannot.
    const budgetBox = rows - lines.length - 2;
    if (box.length > budgetBox && budgetBox >= 3) {
      box = [box[0]!, ...box.slice(-(budgetBox - 2)), box[box.length - 1]!];
    }
    const editorBoxRows = box.length;
    this.editorBoxRows = editorBoxRows;
    this.editorTopRow = rows - 1 - editorBoxRows;

    const task = this.tasks[this.selected]!;
    // Settle geometry and clamp the offset before the header is built so the
    // header never shows a stale offset in the frame the view snaps back.
    this.detailTopRow = lines.length + 1;
    // Header (1) and footer (1) are not pushed yet.
    this.detailViewportRows = Math.max(0, budgetBox - editorBoxRows);
    const transcript = this.selectedTranscriptLines(inner - 2);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset());
    const scrolled = this.scrollOffset > 0 ? theme.fg("warning", ` ↑${this.scrollOffset}`) : theme.fg("dim", " · tail");
    const status = task.status === "running" ? `turn ${task.turns}` : task.status;
    lines.push(row(` ${theme.fg("accent", task.name)} ${theme.fg("dim", `(${task.agent}) — ${status}, ${task.toolCalls} tool calls`)}${scrolled}`));

    const viewportStart = Math.max(0, transcript.length - this.detailViewportRows - this.scrollOffset);
    const shown = transcript.slice(viewportStart, viewportStart + this.detailViewportRows);
    if (shown.length === 0 && this.detailViewportRows > 0) shown.push(task.preview ?? theme.fg("muted", "no output yet"));
    for (const line of shown) lines.push(row(line));
    while (lines.length < rows - 1 - editorBoxRows) lines.push(row(" "));
    for (const boxLine of box) {
      lines.push(row(` ${truncateToWidth(boxLine, inner - 2, " ", true)} `));
    }

    {
      const hints: string[] = ["↑↓ task", "PgUp/PgDn scroll"];
      if (this.opts.sendToTask) hints.push("Enter message");
      if (this.tasks.some((t) => t.status !== "running")) hints.push(this.showFinished ? "f hide finished" : "f finished");
      hints.push("esc close");
      const note = this.footerNote ? theme.fg("dim", ` ${this.footerNote}`) : "";
      // Model the selected subagent is using, like the main TUI footer:
      // the session's actual model wins over the configured one.
      const model = this.tails.get(task.id)?.lastModel ?? task.model;
      if (model) {
        const contentMax = inner;
        const modelText = visibleWidth(model) > contentMax - 2 ? truncateToWidth(model, contentMax - 2, "…") : model;
        const right = ` ${theme.fg("muted", modelText)} `;
        const leftMax = Math.max(0, contentMax - visibleWidth(right));
        const left = ` ${hints.join(" · ")}${note}`;
        const safeLeft = visibleWidth(left) > leftMax ? truncateToWidth(left, leftMax, "…") : left;
        const gap = Math.max(0, contentMax - visibleWidth(safeLeft) - visibleWidth(right));
        lines.push(border(`╰${safeLeft}${"─".repeat(gap)}${right}╯`));
      } else {
        lines.push(fill(` ${hints.join(" · ")}${note}`, ["╰", "╯"]));
      }
    }
    return lines;
  }

  invalidate(): void {
    // Component children are rebuilt from cached lines; nothing else to drop.
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }
}
