/** `install --codex` / `uninstall --codex` / doctor: Codex CLI's hooks.json plus the trust hashes in config.toml */
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MANAGED_FLAG, MANAGED_VALUE } from "../settings/hooks-spec.js";
import { CODEX_EVENT_LABEL, editState, hookHash, readState, stateKey, type CodexHandler } from "./codex-trust.js";

type Json = Record<string, unknown>;

export interface CodexSpec {
  event: string;
  matcher?: string;
  /** Seconds; undefined means the install timeout */
  timeout?: number;
}

/** Events ukagai handles for Codex (docs/spec/api.md "Codex") */
export const CODEX_SPECS: CodexSpec[] = [
  { event: "PreToolUse", matcher: "request_user_input" },
  { event: "PermissionRequest" },
  { event: "Stop" },
  { event: "SessionStart", timeout: 30 },
];

export interface CodexInstallOptions {
  home: string;
  node: string;
  cli: string;
  /** Timeout of the waiting events (seconds) */
  timeout: number;
  /** --data-dir / --server for the hook */
  hookArgs: string[];
  noAutostart: boolean;
}

const shq = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function isManagedCommand(command: unknown): boolean {
  return typeof command === "string" && new RegExp(`(^|\\s)${MANAGED_FLAG} ${MANAGED_VALUE}(\\s|$)`).test(command);
}

export function hookCommand(o: CodexInstallOptions, spec: CodexSpec): string {
  const parts = [o.node, o.cli, "hook", "--agent", "codex"];
  if (spec.event === "SessionStart") {
    if (o.noAutostart) parts.push("--no-autostart");
  } else parts.push("--budget", String(o.timeout - 10));
  parts.push(...o.hookArgs, MANAGED_FLAG, MANAGED_VALUE);
  return parts.map(shq).join(" ");
}

interface Slot {
  event: string;
  group: number;
  handler: number;
  matcher: string | undefined;
  command: unknown;
  h: CodexHandler;
}

const eventsOf = (hooks: Json): Record<string, unknown> => {
  const e = hooks["hooks"];
  return typeof e === "object" && e !== null && !Array.isArray(e) ? (e as Record<string, unknown>) : {};
};

/** Every handler of the file with its position (handlers are tracked by object identity) */
function slots(hooks: Json): Map<object, Slot> {
  const res = new Map<object, Slot>();
  for (const [event, groups] of Object.entries(eventsOf(hooks))) {
    if (!Array.isArray(groups) || CODEX_EVENT_LABEL[event] === undefined) continue;
    groups.forEach((g, gi) => {
      const inner = (g as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) return;
      const matcher = typeof (g as { matcher?: unknown }).matcher === "string" ? (g as { matcher: string }).matcher : undefined;
      inner.forEach((h, hi) => {
        if (typeof h === "object" && h !== null) res.set(h, { event, group: gi, handler: hi, matcher, command: (h as CodexHandler).command, h: h as CodexHandler });
      });
    });
  }
  return res;
}

/** Remove every ukagai handler; returns, per event, where the first removed group sat (so a re-install keeps the position and other hooks' keys) */
function stripManaged(hooks: Json): Map<string, number> {
  const at = new Map<string, number>();
  const events = eventsOf(hooks);
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const g of groups) {
      const inner = (g as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) {
        kept.push(g);
        continue;
      }
      const rest = inner.filter((h) => !isManagedCommand((h as CodexHandler)?.command));
      if (rest.length === inner.length) {
        kept.push(g);
        continue;
      }
      if (!at.has(event)) at.set(event, kept.length);
      if (rest.length > 0) kept.push({ ...(g as Json), hooks: rest });
    }
    if (kept.length > 0) events[event] = kept;
    else delete events[event];
  }
  return at;
}

function addManaged(hooks: Json, at: Map<string, number>, o: CodexInstallOptions): void {
  if (typeof hooks["hooks"] !== "object" || hooks["hooks"] === null || Array.isArray(hooks["hooks"])) hooks["hooks"] = {};
  const events = hooks["hooks"] as Record<string, unknown[]>;
  for (const spec of CODEX_SPECS) {
    const h: CodexHandler = { type: "command", command: hookCommand(o, spec), timeout: spec.timeout ?? o.timeout };
    const group = spec.matcher === undefined ? { hooks: [h] } : { matcher: spec.matcher, hooks: [h] };
    const list = (events[spec.event] ??= []);
    list.splice(at.get(spec.event) ?? list.length, 0, group);
  }
}

export interface CodexPlan {
  hooksFile: string;
  configFile: string;
  hooksBefore: string;
  hooksAfter: string;
  configBefore: string;
  configAfter: string;
  /** state key → hash of the ukagai handlers after the change */
  managed: Map<string, string>;
}

const read = (f: string): Promise<string> =>
  readFile(f, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });

async function parseHooks(file: string, text: string): Promise<Json> {
  if (text.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${file} does not contain a JSON object at the top level`);
  return v as Json;
}

/** The hooks.json path as Codex spells it (symlinks resolved, e.g. /private/tmp on macOS) */
async function codexPath(home: string, name: string): Promise<string> {
  let dir = home;
  try {
    dir = await realpath(home);
  } catch {
    // does not exist yet: the spelling given is all there is
  }
  return join(dir, name);
}

export async function plan(o: CodexInstallOptions, mode: "install" | "uninstall"): Promise<CodexPlan> {
  const hooksFile = await codexPath(o.home, "hooks.json");
  const configFile = join(o.home, "config.toml");
  const hooksBefore = await read(join(o.home, "hooks.json"));
  const configBefore = await read(configFile);
  const doc = await parseHooks(hooksFile, hooksBefore);
  const before = slots(doc);
  const wasManaged = new Map<object, string>();
  for (const [h, s] of before) if (isManagedCommand(s.command)) wasManaged.set(h, stateKey(hooksFile, s.event, s.group, s.handler));

  const at = stripManaged(doc);
  if (mode === "install") addManaged(doc, at, o);
  const after = slots(doc);

  const managed = new Map<string, string>();
  const rename = new Map<string, string>();
  for (const [h, s] of after) {
    const key = stateKey(hooksFile, s.event, s.group, s.handler);
    if (isManagedCommand(s.command)) managed.set(key, hookHash(s.event, s.matcher, s.h));
    else {
      const old = before.get(h);
      if (old) {
        const oldKey = stateKey(hooksFile, old.event, old.group, old.handler);
        if (oldKey !== key) rename.set(oldKey, key);
      }
    }
  }
  const drop = [...wasManaged.values()].filter((k) => !managed.has(k));
  const untouched = mode === "uninstall" && wasManaged.size === 0;
  const hooksAfter = untouched ? hooksBefore : JSON.stringify(doc, null, 2) + "\n";
  const configAfter = editState(configBefore, { drop, rename, set: managed });
  return { hooksFile, configFile, hooksBefore, hooksAfter, configBefore, configAfter, managed };
}

async function backup(file: string): Promise<string | null> {
  const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await copyFile(file, bak);
    return bak;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write what changed (with a .bak next to each changed file that existed). Returns the backups made */
export async function apply(home: string, p: CodexPlan): Promise<string[]> {
  const baks: string[] = [];
  await mkdir(home, { recursive: true });
  for (const [file, before, after] of [
    [join(home, "hooks.json"), p.hooksBefore, p.hooksAfter],
    [p.configFile, p.configBefore, p.configAfter],
  ] as const) {
    if (before === after) continue;
    const bak = await backup(file);
    if (bak) baks.push(bak);
    await writeFile(file, after);
  }
  return baks;
}

export interface CodexStatusRow {
  event: string;
  installed: boolean;
  /** undefined when not installed */
  trusted?: "trusted" | "modified" | "untrusted";
  command?: string;
}

/** For doctor: is each ukagai handler in hooks.json, and does config.toml hold the hash Codex would compute */
export async function status(home: string): Promise<{ hooksFile: string; rows: CodexStatusRow[] }> {
  const hooksFile = await codexPath(home, "hooks.json");
  const doc = await parseHooks(hooksFile, await read(join(home, "hooks.json")));
  const state = readState(await read(join(home, "config.toml")));
  const all = [...slots(doc).values()].filter((s) => isManagedCommand(s.command));
  const rows = CODEX_SPECS.map((spec): CodexStatusRow => {
    const s = all.find((x) => x.event === spec.event);
    if (!s) return { event: spec.event, installed: false };
    const have = state.get(stateKey(hooksFile, s.event, s.group, s.handler));
    const trusted = have === undefined ? "untrusted" : have === hookHash(s.event, s.matcher, s.h) ? "trusted" : "modified";
    return { event: spec.event, installed: true, trusted, command: String(s.command) };
  });
  return { hooksFile, rows };
}
