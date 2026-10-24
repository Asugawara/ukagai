import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  ASIDE_MAX_ENTRIES,
  type AgentName,
  type AsideEntry,
  type AsideQuote,
  type AsideRequest,
  type AsideThread,
  type AsideTrace,
  type AsideUpdated,
  type AsideUsage,
} from "../contract.js";
import type { SseHub } from "./sse.js";
import { HttpError, type Store } from "./store.js";

const MAX_SESSIONS = 20;
const ANSWER_CAP = 64 * 1024;
const STDERR_TAIL = 4 * 1024;
const PROGRESS_MS = 150;
const DEFAULT_TIMEOUT_MS = 180000;
const KILL_GRACE_MS = 3000;
const HISTORY_ENTRIES = 6;
const HISTORY_CHARS = 8000;
const TRANSCRIPT_TAIL = 1024 * 1024;
const CODEX_NOISE = "Custom tool call output is missing for call id";

/** What the store knows of a session, as far as a fork needs it */
export type AsideSession = { cwd: string; transcript_path?: string; agent: AgentName; title?: string };

/** What is on screen while the human asks: the pending decision's kind and title */
export type AsidePending = { kind: "question" | "plan"; title?: string };

export type AsideOptions = {
  /** The session behind an id, or undefined for an unknown one */
  lookup: (sessionId: string) => AsideSession | undefined;
  /** The decision on screen (for the prompt and the thread's separator) */
  pending: (decisionId: string) => AsidePending | undefined;
  broadcast: (event: "aside.updated", data: AsideUpdated) => void;
  /** Binary names (tests point them at fakes). Default: `claude` / `codex` on PATH */
  bins?: { claude?: string; codex?: string };
  /** Whole run (default 180 s) */
  timeoutMs?: number;
  /** SIGTERM to SIGKILL (default 3 s) */
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
};

// ---- Prompt ----

export type AsidePromptInput = {
  pending?: AsidePending;
  question: string;
  quote?: AsideQuote;
  /** Entries of this thread, oldest first (only finished ones count) */
  history: AsideEntry[];
};

/** The latest entry of each regenerate chain, finished ones only */
function latestOfChains(entries: AsideEntry[]): AsideEntry[] {
  const replaced = new Set(entries.map((e) => e.regenerate_of).filter((x): x is string => x !== undefined));
  return entries.filter((e) => e.status === "done" && !replaced.has(e.id));
}

export function buildPrompt(input: AsidePromptInput): string {
  const what = input.pending?.kind ?? "question";
  const title = input.pending?.title ? ` "${input.pending.title}"` : "";
  const lines = [
    `[ukagai] Side question from the human, asked while your ${what}${title} waits in ukagai.`,
    "Answer from this conversation. You may read files; change nothing and ask nothing back.",
    `This exchange is not part of your main conversation; the human answers the pending ${what} separately.`,
  ];
  const past = latestOfChains(input.history).slice(-HISTORY_ENTRIES);
  const blocks = past.map((e) => `Q: ${e.question}\nA: ${e.answer}`);
  while (blocks.length > 0 && blocks.join("\n\n").length > HISTORY_CHARS) blocks.shift();
  if (blocks.length > 0) lines.push(`Earlier side questions in this thread:\n${blocks.join("\n\n")}`);
  if (input.quote) lines.push(`Quoted from the ${input.quote.source}: ${JSON.stringify(input.quote.text)}`);
  lines.push(`Question: ${input.question}`);
  return lines.join("\n") + "\n";
}

// ---- Parsers (one output line at a time) ----

export type ParseState = {
  answer: string;
  trace: AsideTrace[];
  usage?: AsideUsage;
  /** The run said it failed */
  error?: string;
  /** Codex `error` events: only an error when no answer came */
  softError?: string;
  /** Codex: ids of command items already traced (started, then completed) */
  seen: Set<string>;
};

export function newParseState(): ParseState {
  return { answer: "", trace: [], seen: new Set() };
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function capAnswer(s: string): string {
  if (Buffer.byteLength(s) <= ANSWER_CAP) return s;
  return Buffer.from(s).subarray(0, ANSWER_CAP).toString().replace(/�$/, "") + "…";
}

function pushTrace(st: ParseState, kind: AsideTrace["kind"], label: string): void {
  st.trace.push({ kind, label: label.slice(0, 200) });
}

function toolTrace(st: ParseState, name: string, input: Record<string, unknown> | undefined): void {
  if (name === "Read") pushTrace(st, "read", String(input?.["file_path"] ?? ""));
  else if (name === "Grep" || name === "Glob") pushTrace(st, "search", String(input?.["pattern"] ?? ""));
  else pushTrace(st, "tool", name);
}

/** Claude `--output-format stream-json --include-partial-messages`. The final `result` line is authoritative */
export function parseClaudeLine(st: ParseState, line: string): void {
  let ev: Record<string, unknown> | undefined;
  try {
    ev = obj(JSON.parse(line));
  } catch {
    return;
  }
  if (!ev) return;
  if (ev["type"] === "stream_event") {
    if (ev["parent_tool_use_id"]) return;
    const e = obj(ev["event"]);
    if (e?.["type"] === "message_start") st.answer = "";
    else if (e?.["type"] === "content_block_delta") {
      const d = obj(e["delta"]);
      if (d?.["type"] === "text_delta" && typeof d["text"] === "string") st.answer = capAnswer(st.answer + d["text"]);
    }
  } else if (ev["type"] === "assistant") {
    const content = obj(ev["message"])?.["content"];
    if (Array.isArray(content)) {
      for (const b of content) {
        const blk = obj(b);
        if (blk?.["type"] === "tool_use" && typeof blk["name"] === "string") toolTrace(st, blk["name"], obj(blk["input"]));
      }
    }
  } else if (ev["type"] === "result") {
    const text = typeof ev["result"] === "string" ? ev["result"] : "";
    if (ev["is_error"] === true) st.error = text || String(ev["subtype"] ?? "error");
    else if (text) st.answer = capAnswer(text);
    const u = obj(ev["usage"]);
    if (u) {
      const cache = num(u["cache_read_input_tokens"]);
      st.usage = {
        input_tokens: num(u["input_tokens"]),
        output_tokens: num(u["output_tokens"]),
        ...(cache > 0 ? { cache_read_tokens: cache } : {}),
        ...(typeof ev["total_cost_usd"] === "number" ? { cost_usd: ev["total_cost_usd"] } : {}),
      };
    }
  }
}

/** Codex `exec --json` */
export function parseCodexLine(st: ParseState, line: string): void {
  let ev: Record<string, unknown> | undefined;
  try {
    ev = obj(JSON.parse(line));
  } catch {
    return;
  }
  if (!ev) return;
  const type = ev["type"];
  if (type === "item.started" || type === "item.completed") {
    const item = obj(ev["item"]);
    if (item?.["type"] === "command_execution") {
      const id = String(item["id"] ?? "");
      if (!st.seen.has(id)) {
        st.seen.add(id);
        pushTrace(st, "command", String(item["command"] ?? ""));
      }
    } else if (item?.["type"] === "agent_message" && type === "item.completed" && typeof item["text"] === "string") {
      st.answer = capAnswer(item["text"]);
    }
  } else if (type === "turn.completed") {
    const u = obj(ev["usage"]);
    if (u) {
      const cache = num(u["cached_input_tokens"]);
      st.usage = { input_tokens: num(u["input_tokens"]), output_tokens: num(u["output_tokens"]), ...(cache > 0 ? { cache_read_tokens: cache } : {}) };
    }
  } else if (type === "turn.failed") {
    st.error = String(obj(ev["error"])?.["message"] ?? "turn failed");
  } else if (type === "error") {
    st.softError = String(ev["message"] ?? "error");
  }
}

// ---- Command lines ----

export function claudeArgs(sessionId: string, model: string | undefined): string[] {
  return [
    "-p",
    "--resume",
    sessionId,
    "--fork-session",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--allowedTools",
    "Read,Grep,Glob",
    "--permission-mode",
    "dontAsk",
    "--settings",
    '{"disableAllHooks":true}',
    ...(model ? ["--model", model] : []),
  ];
}

export function codexArgs(sessionId: string): string[] {
  return ["exec", "fork", sessionId, "--ephemeral", "--json", "--skip-git-repo-check", "--disable", "hooks", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "-"];
}

/** `message.model` of the last assistant line of the transcript, or undefined */
export function lastModel(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"type":"assistant"')) continue;
      try {
        const model = obj(obj(JSON.parse(lines[i]!))?.["message"])?.["model"];
        if (typeof model === "string" && /^[A-Za-z0-9][\w.:\-[\]]*$/.test(model) && model !== "synthetic") return model;
      } catch {
        // a line cut by the tail window
      }
    }
  } catch {
    // unreadable transcript: no --model
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/** The child's env: the server's, without the markers of a running Claude Code / ukagai */
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("UKAGAI_")) continue;
    env[k] = v;
  }
  return env;
}

// ---- Threads ----

type Thread = { agent: AgentName; entries: AsideEntry[] };
type Running = { entry: AsideEntry; finish: (status: "cancelled") => void };

export class AsideStore {
  /** session_id -> thread; Map order is the LRU order (oldest first) */
  private threads = new Map<string, Thread>();
  private running = new Map<string, Running>();

  constructor(private opts: AsideOptions) {}

  private unavailable(sessionId: string): { session?: AsideSession; reason?: string } {
    const session = this.opts.lookup(sessionId);
    if (!session) return {};
    if (!/^[A-Za-z0-9][\w.-]*$/.test(sessionId)) return { session, reason: "invalid session id" };
    if (!session.cwd) return { session, reason: "the session has no working directory" };
    return { session };
  }

  /** undefined: unknown session */
  thread(sessionId: string): AsideThread | undefined {
    const { session, reason } = this.unavailable(sessionId);
    const t = this.threads.get(sessionId);
    if (!session) return t ? { session_id: sessionId, agent: t.agent, available: false, unavailable_reason: "unknown session", entries: t.entries } : undefined;
    return {
      session_id: sessionId,
      agent: session.agent,
      available: reason === undefined,
      ...(reason ? { unavailable_reason: reason } : {}),
      entries: t?.entries ?? [],
    };
  }

  private touch(sessionId: string, agent: AgentName): Thread {
    let t = this.threads.get(sessionId);
    if (t) this.threads.delete(sessionId);
    else t = { agent, entries: [] };
    this.threads.set(sessionId, t);
    for (const id of this.threads.keys()) {
      if (this.threads.size <= MAX_SESSIONS) break;
      if (!this.running.has(id) && id !== sessionId) this.threads.delete(id);
    }
    return t;
  }

  /** Starts a run. Throws HttpError: 404 unknown session, 400 unavailable, 409 already running */
  start(sessionId: string, req: AsideRequest): AsideEntry {
    const { session, reason } = this.unavailable(sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (reason) throw new HttpError(400, "unavailable", { reason });
    if (this.running.has(sessionId)) throw new HttpError(409, "running");
    const thread = this.touch(sessionId, session.agent);
    let { question, quote } = req;
    if (req.regenerate_of !== undefined) {
      const src = thread.entries.find((e) => e.id === req.regenerate_of);
      if (!src) throw new HttpError(400, "regenerate_of not found");
      ({ question, quote } = src);
    }
    const pending = this.opts.pending(req.decision_id);
    const entry: AsideEntry = {
      id: randomUUID(),
      decision_id: req.decision_id,
      ...(pending?.title ? { decision_title: pending.title } : {}),
      question,
      ...(quote ? { quote } : {}),
      ...(req.regenerate_of !== undefined ? { regenerate_of: req.regenerate_of } : {}),
      answer: "",
      trace: [],
      status: "running",
      created_at: new Date().toISOString(),
    };
    const prompt = buildPrompt({ ...(pending ? { pending } : {}), question, ...(quote ? { quote } : {}), history: thread.entries });
    thread.entries.push(entry);
    while (thread.entries.length > ASIDE_MAX_ENTRIES) {
      const i = thread.entries.findIndex((e) => e.status !== "running");
      if (i < 0) break;
      thread.entries.splice(i, 1);
    }
    this.run(sessionId, session, entry, prompt);
    return entry;
  }

  /** Stops the running entry; undefined when nothing runs */
  cancel(sessionId: string): AsideEntry | undefined {
    const r = this.running.get(sessionId);
    if (!r) return undefined;
    r.finish("cancelled");
    return r.entry;
  }

  /** Stops every run (server shutdown) */
  close(): void {
    for (const id of [...this.running.keys()]) this.cancel(id);
  }

  private emit(sessionId: string, entry: AsideEntry): void {
    this.opts.broadcast("aside.updated", { session_id: sessionId, entry: structuredClone(entry) });
  }

  private run(sessionId: string, session: AsideSession, entry: AsideEntry, prompt: string): void {
    const { opts } = this;
    const codex = session.agent === "codex";
    const bin = (codex ? opts.bins?.codex : opts.bins?.claude) ?? (codex ? "codex" : "claude");
    const args = codex ? codexArgs(sessionId) : claudeArgs(sessionId, lastModel(session.transcript_path));
    const st = newParseState();
    const parse = codex ? parseCodexLine : parseClaudeLine;
    let stderr = "";
    let buf = "";
    let finished = false;
    let timedOut = false;
    let last = 0;
    let timer: NodeJS.Timeout | undefined;

    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd: session.cwd, env: childEnv(opts.env ?? process.env), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (err) {
      entry.status = "error";
      entry.error = err instanceof Error ? err.message : String(err);
      entry.finished_at = new Date().toISOString();
      this.emit(sessionId, entry);
      return;
    }

    const sync = () => {
      entry.answer = st.answer;
      entry.trace = st.trace.slice();
    };
    const progress = () => {
      if (finished || timer) return;
      const wait = Math.max(0, last + PROGRESS_MS - Date.now());
      timer = setTimeout(() => {
        timer = undefined;
        if (finished) return;
        last = Date.now();
        sync();
        this.emit(sessionId, entry);
      }, wait);
    };
    // The CLIs start MCP servers and the like as children: signal the whole process group (it leads its own, `detached`)
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (child.pid === undefined) child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const kill = () => {
      signal("SIGTERM");
      const t = setTimeout(() => signal("SIGKILL"), opts.killGraceMs ?? KILL_GRACE_MS);
      t.unref();
    };
    const finish = (status: "done" | "error" | "cancelled", error?: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      clearTimeout(deadline);
      this.running.delete(sessionId);
      sync();
      entry.status = status;
      if (error) entry.error = error;
      if (st.usage) entry.usage = st.usage;
      entry.finished_at = new Date().toISOString();
      if (status === "cancelled") kill();
      this.emit(sessionId, entry);
    };
    const tail = () => {
      const lines = stderr.split("\n").filter((l) => l.trim() !== "" && !l.includes(CODEX_NOISE));
      return lines.join("\n").slice(-STDERR_TAIL).trim();
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      kill();
      // A grandchild may keep the pipes open past the kill: do not wait for `close` forever
      setTimeout(() => finish("error", `timed out after ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s`), (opts.killGraceMs ?? KILL_GRACE_MS) + 1000).unref();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    deadline.unref();

    this.running.set(sessionId, { entry, finish });

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() !== "") parse(st, line);
      }
      progress();
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL * 4);
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(prompt);
    child.on("error", (err) => finish("error", err.message));
    child.on("close", (code) => {
      if (buf.trim() !== "") parse(st, buf);
      if (timedOut) return finish("error", `timed out after ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s`);
      if (st.error) return finish("error", st.error.slice(0, 2000));
      if (st.answer) return finish("done");
      const why = st.softError ?? tail();
      finish("error", (why || `exited with code ${code ?? "?"} without an answer`).slice(-STDERR_TAIL));
    });
    this.emit(sessionId, entry);
  }
}

/** The store of threads wired to the decision store (session lookup, titles) and the SSE hub */
export function createAside(store: Store, hub: SseHub, extra: Pick<AsideOptions, "bins" | "timeoutMs" | "killGraceMs" | "env"> = {}): AsideStore {
  return new AsideStore({
    ...extra,
    lookup: (id) => {
      const sum = store.listSessions().find((s) => s.session_id === id);
      const d = store.list().reverse().find((x) => x.session.session_id === id);
      if (!sum && !d) return undefined;
      const transcript_path = sum?.transcript_path ?? d?.session.transcript_path;
      return {
        cwd: sum?.cwd ?? d?.session.cwd ?? "",
        ...(transcript_path ? { transcript_path } : {}),
        agent: d?.session.agent ?? "claude",
        ...(sum?.title ?? d?.session.title ? { title: (sum?.title ?? d?.session.title)! } : {}),
      };
    },
    pending: (decisionId) => {
      const d = store.get(decisionId);
      if (!d) return undefined;
      const title = d.explanation?.title;
      return { kind: d.kind === "approve_plan" ? "plan" : "question", ...(title ? { title } : {}) };
    },
    broadcast: (event, data) => hub.broadcast(event, data),
  });
}
