/**
 * Codex hook trust (verified against Codex CLI 0.159.3, see docs/verification/02-codex-hooks.md):
 * `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"] trusted_hash = "sha256:<hex>"` in config.toml.
 * The hash is the sha256 of the compact, sorted-key JSON of one handler wrapped in a one-handler group.
 */
import { createHash } from "node:crypto";

export const CODEX_EVENT_LABEL: Record<string, string> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};

/** Codex's default when a handler has no `timeout` (the normalized value is the one hashed) */
const DEFAULT_TIMEOUT = 600;

export interface CodexHandler {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
  [k: string]: unknown;
}

/** JSON with sorted keys at every level and no whitespace (what serde_json prints for Codex's sorted value) */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function hookHash(event: string, matcher: string | undefined, h: CodexHandler): string {
  const label = CODEX_EVENT_LABEL[event];
  if (label === undefined) throw new Error(`unknown Codex hook event: ${event}`);
  const hook: Record<string, unknown> = {
    type: "command",
    command: h.command,
    timeout: h.timeout ?? DEFAULT_TIMEOUT,
    async: h.async ?? false,
  };
  if (h.statusMessage) hook["statusMessage"] = h.statusMessage;
  const ident: Record<string, unknown> = { event_name: label, hooks: [hook] };
  if (matcher !== undefined) ident["matcher"] = matcher;
  return "sha256:" + createHash("sha256").update(canonicalJson(ident)).digest("hex");
}

export function stateKey(hooksFile: string, event: string, group: number, handler: number): string {
  const label = CODEX_EVENT_LABEL[event];
  if (label === undefined) throw new Error(`unknown Codex hook event: ${event}`);
  return `${hooksFile}:${label}:${group}:${handler}`;
}

// ---- config.toml: line-based edits of [hooks.state."…"] tables only ----

const tomlEscape = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const tomlUnescape = (s: string): string => s.replace(/\\(["\\])/g, "$1");
const STATE_HEADER = /^\s*\[hooks\.state\."((?:[^"\\]|\\.)*)"\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;

export interface StateEdits {
  /** Tables to remove */
  drop?: Iterable<string>;
  /** Tables whose key changes (old → new), applied simultaneously */
  rename?: ReadonlyMap<string, string>;
  /** Tables to create or whose trusted_hash is replaced */
  set?: ReadonlyMap<string, string>;
}

/** Apply the edits touching only `[hooks.state."…"]` tables; every other line is kept byte for byte */
export function editState(toml: string, edits: StateEdits): string {
  const drop = new Set(edits.drop ?? []);
  const rename = edits.rename ?? new Map<string, string>();
  const set = new Map(edits.set ?? []);
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  const lines = toml === "" ? [] : toml.split(/\r?\n/);
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (endsWithNewline) lines.pop();

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = STATE_HEADER.exec(lines[i]!);
    if (!m) {
      out.push(lines[i]!);
      continue;
    }
    const key = tomlUnescape(m[1]!);
    let end = i + 1;
    while (end < lines.length && !ANY_HEADER.test(lines[end]!)) end++;
    // Blank lines before the next header belong to that header, not to this table
    while (end > i + 1 && lines[end - 1]!.trim() === "") end--;
    const block = lines.slice(i, end);
    if (drop.has(key)) {
      if (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
      i = end - 1;
      continue;
    }
    const newKey = rename.get(key) ?? key;
    if (newKey !== key) block[0] = `[hooks.state."${tomlEscape(newKey)}"]${m[2] ? " " + m[2] : ""}`;
    const hash = set.get(newKey);
    if (hash !== undefined) {
      const at = block.findIndex((l) => /^\s*trusted_hash\s*=/.test(l));
      if (at >= 0) block[at] = `trusted_hash = "${hash}"`;
      else block.splice(1, 0, `trusted_hash = "${hash}"`);
      set.delete(newKey);
    }
    out.push(...block);
    i = end - 1;
  }
  const appended = set.size > 0;
  for (const [key, hash] of set) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push(`[hooks.state."${tomlEscape(key)}"]`, `trusted_hash = "${hash}"`);
  }
  return out.length === 0 ? "" : out.join(eol) + (endsWithNewline || appended ? eol : "");
}

/** key → trusted_hash of every `[hooks.state."…"]` table */
export function readState(toml: string): Map<string, string | undefined> {
  const res = new Map<string, string | undefined>();
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = STATE_HEADER.exec(lines[i]!);
    if (!m) continue;
    let hash: string | undefined;
    for (let j = i + 1; j < lines.length && !ANY_HEADER.test(lines[j]!); j++) {
      const h = /^\s*trusted_hash\s*=\s*"([^"]*)"/.exec(lines[j]!);
      if (h) hash = h[1];
    }
    res.set(tomlUnescape(m[1]!), hash);
  }
  return res;
}
