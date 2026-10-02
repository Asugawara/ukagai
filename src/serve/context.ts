import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isAllowedTranscriptPath, type Decision, type DecisionSession } from "../contract.js";

type Context = Decision["context"];

const GIT_TIMEOUT_MS = 500;
const GIT_MAX_BYTES = 200 * 1024;
const TAIL_BYTES = 512 * 1024;
const RETRY_DELAY_MS = 500;
const SUMMARY_MAX = 80;
const ASSISTANT_TEXT_MAX = 10000;
const RECENT_TOOLS = 10;

export type CollectOptions = { home?: string };

function isDirectory(p: string): boolean {
  try {
    return isAbsolute(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A failure or timeout yields undefined. Output is truncated at GIT_MAX_BYTES */
function runGit(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let out = Buffer.alloc(0);
    const done = (v: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      // Avoid running commands that come from repository config (fsmonitor / external diff / textconv)
      child = spawn("git", ["-c", "core.fsmonitor=false", "-C", cwd, "--no-pager", ...args], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(undefined);
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      out = Buffer.concat([out, chunk]);
      if (out.length >= GIT_MAX_BYTES) {
        const truncated = out.subarray(0, GIT_MAX_BYTES).toString("utf8");
        child.kill("SIGKILL");
        done(truncated);
      }
    });
    child.on("error", () => done(undefined));
    child.on("close", (code) => done(code === 0 ? out.toString("utf8") : undefined));
  });
}

async function collectGit(cwd: string): Promise<Context> {
  if (!isDirectory(cwd)) return {};
  const [branch, status, stat, diff] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(cwd, ["status", "--porcelain"]),
    runGit(cwd, ["diff", "--stat", "--no-ext-diff", "--no-textconv"]),
    runGit(cwd, ["diff", "--no-ext-diff", "--no-textconv"]),
  ]);
  const ctx: Context = {};
  if (branch?.trim()) ctx.branch = branch.trim();
  if (status) ctx.git_status = status;
  if (stat) ctx.git_diff_stat = stat;
  if (diff) ctx.git_diff = diff;
  return ctx;
}

function readTail(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, size - len + read);
      if (n <= 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    if (size > len) {
      // The head is cut mid-line
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function summarize(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  const v = typeof o.file_path === "string" ? o.file_path : typeof o.command === "string" ? o.command : "";
  return v.slice(0, SUMMARY_MAX);
}

function parseTranscript(text: string): Context {
  const ctx: Context = {};
  const tools: { name: string; summary: string }[] = [];
  let lastText: string | undefined;
  let title: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      title = rec.aiTitle;
      continue;
    }
    const msg = rec.message as Record<string, unknown> | undefined;
    if (rec.type !== "assistant" || !msg || !Array.isArray(msg.content)) continue;
    const texts: string[] = [];
    for (const block of msg.content as unknown[]) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "tool_use" && typeof b.name === "string") {
        tools.push({ name: b.name, summary: summarize(b.input) });
      }
    }
    const joined = texts.join("\n").trim();
    if (joined) lastText = joined;
  }
  if (lastText) ctx.last_assistant_text = lastText.slice(-ASSISTANT_TEXT_MAX);
  if (tools.length > 0) ctx.recent_tools = tools.slice(-RECENT_TOOLS);
  if (title) ctx.ai_title = title;
  return ctx;
}

function transcriptCandidates(session: DecisionSession, home: string): string[] {
  const paths: string[] = [];
  if (session.agent_id) {
    paths.push(join(dirname(session.transcript_path), session.session_id, "subagents", `agent-${session.agent_id}.jsonl`));
  }
  paths.push(session.transcript_path);
  return paths.filter((p) => isAllowedTranscriptPath(p, home));
}

function readTranscriptOnce(session: DecisionSession, home: string): Context {
  for (const p of transcriptCandidates(session, home)) {
    const text = readTail(p);
    if (text === undefined) continue;
    const ctx = parseTranscript(text);
    if (Object.keys(ctx).length > 0) return ctx;
  }
  return {};
}

async function collectTranscript(session: DecisionSession, home: string): Promise<Context> {
  const first = readTranscriptOnce(session, home);
  if (Object.keys(first).length > 0) return first;
  // Transcript writes can lag, so re-read exactly once
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  return readTranscriptOnce(session, home);
}

export async function collectContext(session: DecisionSession, opts: CollectOptions = {}): Promise<Context> {
  const home = opts.home ?? homedir();
  const [git, transcript] = await Promise.all([
    collectGit(session.cwd).catch((): Context => ({})),
    collectTranscript(session, home).catch((): Context => ({})),
  ]);
  return { ...git, ...transcript };
}
