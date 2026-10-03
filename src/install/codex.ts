/** `install --codex` / `uninstall --codex` / doctor: Codex CLI's hooks.json plus the trust hashes in config.toml */
import { copyFile, mkdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  /** Delete the file instead of writing `*After` (a file install created and uninstall leaves empty) */
  hooksDelete: boolean;
  configDelete: boolean;
  /** The first install over files without ukagai: backups made now are the originals */
  fresh: boolean;
  /** The record to keep (null: remove it); `backups` is filled in by apply */
  record: CodexRecord | null;
  recordBefore: string | null;
  /** uninstall: remove the (now empty) CODEX_HOME install had to create */
  removeHome: boolean;
}

/** What install did to the files, kept in `<CODEX_HOME>/.ukagai-codex.json` so uninstall can undo it exactly */
export interface CodexRecord {
  /** Files install created (they did not exist) */
  created: { hooks: boolean; config: boolean };
  /** config.toml had no final newline, so install added one */
  configNoFinalNewline: boolean;
  /** The `.bak-*` made by the first install (basenames) */
  backups: { hooks?: string; config?: string };
  createdHome: boolean;
}

const RECORD = ".ukagai-codex.json";

/** Indent and final newline of an existing hooks.json, so ukagai's groups are added in the same style */
function hooksFormat(text: string): { indent: string | number; finalNewline: boolean; crlf: boolean } {
  const m = /^[ \t]+(?=")/m.exec(text);
  const compact = !text.includes("\n");
  return { indent: text.trim() === "" ? 2 : compact ? 0 : (m ? m[0] : 2), finalNewline: text.trim() === "" ? true : /\n$/.test(text), crlf: text.includes("\r\n") };
}

function serializeHooks(doc: Json, text: string): string {
  const f = hooksFormat(text);
  let out = JSON.stringify(doc, null, f.indent) + (f.finalNewline ? "\n" : "");
  if (f.crlf) out = out.replace(/\n/g, "\r\n");
  return out;
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function readRecord(home: string): Promise<{ raw: string | null; rec: CodexRecord | null }> {
  const raw = await read(join(home, RECORD)).then((t) => (t === "" ? null : t));
  if (raw === null) return { raw, rec: null };
  try {
    const v = JSON.parse(raw) as Partial<CodexRecord>;
    return { raw, rec: { created: { hooks: !!v.created?.hooks, config: !!v.created?.config }, configNoFinalNewline: !!v.configNoFinalNewline, backups: v.backups ?? {}, createdHome: !!v.createdHome } };
  } catch {
    return { raw, rec: null };
  }
}

const trimEnd = (s: string): string => s.replace(/(\r?\n)+$/, "");

/** The backup made by the first install, when it still exists */
async function original(home: string, name: string | undefined): Promise<string | null> {
  if (!name) return null;
  const f = join(home, basename(name));
  return (await exists(f)) ? readFile(f, "utf8") : null;
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
  const hooksExisted = await exists(join(o.home, "hooks.json"));
  const configExisted = await exists(configFile);
  const homeExisted = await exists(o.home);
  const hooksBefore = await read(join(o.home, "hooks.json"));
  const configBefore = await read(configFile);
  const { raw: recordBefore, rec } = await readRecord(o.home);
  const doc = await parseHooks(hooksFile, hooksBefore);
  const before = slots(doc);
  const wasManaged = new Map<object, string>();
  for (const [h, s] of before) if (isManagedCommand(s.command)) wasManaged.set(h, stateKey(hooksFile, s.event, s.group, s.handler));

  const at = stripManaged(doc);
  const stripped = structuredClone(doc);
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
  let hooksAfter = untouched ? hooksBefore : serializeHooks(doc, hooksBefore);
  let configAfter = editState(configBefore, { drop, rename, set: managed });
  const fresh = mode === "install" && wasManaged.size === 0;
  let record: CodexRecord | null = rec;
  let hooksDelete = false;
  let configDelete = false;

  if (mode === "install") {
    if (fresh || !rec)
      record = { created: { hooks: !hooksExisted, config: !configExisted }, configNoFinalNewline: configBefore !== "" && !/\n$/.test(configBefore), backups: {}, createdHome: !homeExisted };
  } else if (!untouched && rec) {
    // Undo exactly: files install created go away; the others come back to the original bytes when they are semantically the original
    const hooksOrig = await original(o.home, rec.backups.hooks);
    const configOrig = await original(o.home, rec.backups.config);
    const emptyDoc = Object.keys(stripped).every((k) => k === "hooks") && Object.keys(eventsOf(stripped)).length === 0;
    if (rec.created.hooks && emptyDoc) hooksDelete = true;
    else if (hooksOrig !== null) {
      try {
        if (isDeepStrictEqual(JSON.parse(hooksOrig), stripped)) hooksAfter = hooksOrig;
      } catch {
        // the backup is not JSON: keep the line-for-line result
      }
    }
    if (rec.created.config && configAfter.trim() === "") configDelete = true;
    else if (configOrig !== null && trimEnd(configOrig) === trimEnd(configAfter)) configAfter = configOrig;
    else if (rec.configNoFinalNewline && /\n$/.test(configAfter)) configAfter = configAfter.replace(/\r?\n$/, "");
    record = null;
  } else if (!untouched) record = null;
  if (hooksDelete) hooksAfter = "";
  if (configDelete) configAfter = "";
  return { hooksFile, configFile, hooksBefore, hooksAfter, configBefore, configAfter, managed, hooksDelete, configDelete, fresh, record, recordBefore, removeHome: mode === "uninstall" && record === null && !!rec?.createdHome && !untouched };
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
  const made: { hooks?: string; config?: string } = {};
  await mkdir(home, { recursive: true });
  for (const [key, file, before, after, del] of [
    ["hooks", join(home, "hooks.json"), p.hooksBefore, p.hooksAfter, p.hooksDelete],
    ["config", p.configFile, p.configBefore, p.configAfter, p.configDelete],
  ] as const) {
    if (del) {
      await rm(file, { force: true });
      continue;
    }
    if (before === after) continue;
    const bak = await backup(file);
    if (bak) {
      baks.push(bak);
      made[key] = basename(bak);
    }
    await writeFile(file, after);
  }
  const recFile = join(home, RECORD);
  if (p.record === null) {
    if (p.recordBefore !== null) {
      await rm(recFile, { force: true });
      if (p.removeHome) await rmdir(home).catch(() => undefined);
    }
  } else {
    const rec: CodexRecord = { ...p.record, backups: { ...p.record.backups } };
    if (p.fresh) rec.backups = made;
    const text = JSON.stringify(rec, null, 2) + "\n";
    if (text !== p.recordBefore) await writeFile(recFile, text);
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
