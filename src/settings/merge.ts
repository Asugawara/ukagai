import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isManagedHook, type MatcherGroup } from "./hooks-spec.js";

export type Settings = Record<string, unknown>;

export async function readSettings(file: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object at the top level`);
  }
  return parsed as Settings;
}

export function serialize(s: Settings): string {
  return JSON.stringify(s, null, 2) + "\n";
}

/** Copy to <file>.bak-<ISO time> before writing. No bak is made if the file does not exist */
export async function writeSettings(file: string, s: Settings): Promise<string | null> {
  let bak: string | null = null;
  try {
    bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(file, bak);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    bak = null;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serialize(s));
  return bak;
}

function hooksOf(s: Settings): Record<string, unknown> {
  const h = s["hooks"];
  if (h === undefined) return {};
  if (typeof h !== "object" || h === null || Array.isArray(h)) {
    throw new Error("hooks in settings is not an object");
  }
  return h as Record<string, unknown>;
}

function stripManaged(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const g of groups) {
    const inner = (g as { hooks?: unknown } | null)?.hooks;
    if (typeof g !== "object" || g === null || !Array.isArray(inner)) {
      out.push(g);
      continue;
    }
    const kept = inner.filter((h) => !isManagedHook(h));
    if (kept.length === inner.length) out.push(g);
    else if (kept.length > 0) out.push({ ...(g as object), hooks: kept });
  }
  return out;
}

/** Replace the marked entries and keep the rest. The input is not modified */
export function mergeHooks(existing: Settings, entries: Record<string, MatcherGroup[]>): Settings {
  const removed = removeHooks(existing);
  const hooks: Record<string, unknown> = { ...hooksOf(removed) };
  for (const [event, groups] of Object.entries(entries)) {
    const cur = hooks[event];
    hooks[event] = [...(Array.isArray(cur) ? cur : []), ...groups];
  }
  return { ...removed, hooks };
}

/** Remove only the marked entries. Events and hooks that become empty are dropped */
export function removeHooks(existing: Settings): Settings {
  if (existing["hooks"] === undefined) return { ...existing };
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooksOf(existing))) {
    const kept = Array.isArray(groups) ? stripManaged(groups) : groups;
    if (Array.isArray(kept) && kept.length === 0 && Array.isArray(groups) && groups.length > 0) continue;
    hooks[event] = kept;
  }
  const { hooks: _drop, ...rest } = existing;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

export function hasManaged(existing: Settings, event: string): boolean {
  const groups = hooksOf(existing)[event];
  return (
    Array.isArray(groups) &&
    groups.some((g) => Array.isArray((g as { hooks?: unknown })?.hooks) && (g as { hooks: unknown[] }).hooks.some(isManagedHook))
  );
}

export function findManaged(
  existing: Settings,
  event: string,
  where: (h: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> | undefined {
  const groups = hooksOf(existing)[event];
  if (!Array.isArray(groups)) return undefined;
  for (const g of groups) {
    const inner = (g as { hooks?: unknown })?.hooks;
    if (!Array.isArray(inner)) continue;
    const h = inner.find((x) => isManagedHook(x) && where(x as Record<string, unknown>));
    if (h) return h as Record<string, unknown>;
  }
  return undefined;
}
