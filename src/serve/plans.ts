import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { PlanContent, PlanSection, PlanSummary } from "../contract.js";

/** Whether a plan (name, mtime ISO) is marked read. Defaults to "never" */
export type IsRead = (name: string, mtime: string) => boolean;

export const MAX_PLANS = 50;
export const MAX_PLAN_BYTES = 1024 * 1024;

export class PlanError extends Error {
  constructor(readonly status: 400 | 404 | 413, message: string) {
    super(message);
  }
}

export function plansDir(home: string): string {
  return join(home, ".claude", "plans");
}

/** A basename only: no separators, no "..", no leading dot, no NUL */
export function isPlanName(name: string): boolean {
  return name !== "" && !/[/\\\0]/.test(name) && !name.includes("..") && !name.startsWith(".");
}

function splitLines(markdown: string): string[] {
  return markdown === "" ? [] : markdown.replace(/\r?\n$/, "").split(/\r?\n/);
}

/**
 * H2 / H3 sections. A section runs from its heading line to the line before the next heading
 * (outside code fences) of level <= its own, so an H2 section contains its H3 sections.
 * hash = first 12 hex of sha256 of those lines joined with "\n". The GUI copies this rule.
 */
export function sectionsOf(markdown: string): PlanSection[] {
  const lines = splitLines(markdown);
  const heads: { index: number; level: number; heading: string }[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === undefined) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (line.startsWith("### ")) heads.push({ index: i, level: 3, heading: line.slice(4).trim() });
    else if (line.startsWith("## ")) heads.push({ index: i, level: 2, heading: line.slice(3).trim() });
    else if (line.startsWith("# ")) heads.push({ index: i, level: 1, heading: "" });
  }
  const out: PlanSection[] = [];
  heads.forEach((h, k) => {
    if (h.level === 1) return;
    let end = lines.length;
    for (let j = k + 1; j < heads.length; j++) {
      if (heads[j]!.level <= h.level) {
        end = heads[j]!.index;
        break;
      }
    }
    const text = lines.slice(h.index, end).join("\n");
    out.push({
      heading: h.heading,
      level: h.level as 2 | 3,
      hash: createHash("sha256").update(text).digest("hex").slice(0, 12),
    });
  });
  return out;
}

/** Title (first H1 outside code fences) and H2 count */
function scan(markdown: string): { title: string | undefined; sections: number; lines: number } {
  let title: string | undefined;
  let sections = 0;
  let fence: string | undefined;
  const all = splitLines(markdown);
  for (const line of all) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === undefined) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const h1 = /^# +(.+?)\s*#*\s*$/.exec(line);
    if (h1 && title === undefined) title = h1[1]!.trim();
    else if (/^## /.test(line)) sections++;
  }
  return { title, sections, lines: all.length };
}

/** Resolve a plan file; null if it is absent, not a regular file, or its realpath leaves the plans directory */
async function resolvePlan(dir: string, name: string): Promise<{ path: string; size: number; mtimeMs: number } | null> {
  try {
    const root = await realpath(dir);
    const real = await realpath(join(dir, name));
    if (!real.startsWith(root + sep)) return null;
    const st = await stat(real);
    return st.isFile() ? { path: real, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function summarize(name: string, r: { path: string; size: number; mtimeMs: number }, isRead: IsRead): Promise<PlanSummary> {
  let md = "";
  if (r.size <= MAX_PLAN_BYTES) {
    try { md = await readFile(r.path, "utf8"); } catch {}
  }
  const s = scan(md);
  const mtime = new Date(r.mtimeMs).toISOString();
  return {
    name,
    title: s.title ?? name,
    mtime,
    bytes: r.size,
    sections: s.sections,
    lines: s.lines,
    read: isRead(name, mtime),
  };
}

/** One plan's summary through the same filters as the list (`*.md`, no dotfile, realpath inside the dir). Null if it does not pass. Oversize files are summarized without reading, as in the list */
export async function planSummary(dir: string, name: string, isRead: IsRead = () => false): Promise<PlanSummary | null> {
  if (!name.endsWith(".md") || !isPlanName(name)) return null;
  const r = await resolvePlan(dir, name);
  return r ? summarize(name, r, isRead) : null;
}

export async function listPlans(home: string, isRead: IsRead = () => false): Promise<PlanSummary[]> {
  const dir = plansDir(home);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md") && isPlanName(n));
  } catch {
    return [];
  }
  const found = (await Promise.all(names.map(async (n) => ({ n, r: await resolvePlan(dir, n) }))))
    .filter((x): x is { n: string; r: NonNullable<typeof x.r> } => x.r !== null)
    .sort((a, b) => b.r.mtimeMs - a.r.mtimeMs || (a.n < b.n ? -1 : 1))
    .slice(0, MAX_PLANS);
  return Promise.all(found.map(({ n, r }) => summarize(n, r, isRead)));
}

/** Returns null when `since` equals the file's mtime (not modified). Throws PlanError otherwise on failure */
export async function readPlan(home: string, name: string, since?: string, isRead: IsRead = () => false): Promise<PlanContent | null> {
  if (!isPlanName(name)) throw new PlanError(400, "invalid plan name");
  const r = await resolvePlan(plansDir(home), name);
  if (!r) throw new PlanError(404, "plan not found");
  const mtime = new Date(r.mtimeMs).toISOString();
  if (since !== undefined && since === mtime) return null;
  if (r.size > MAX_PLAN_BYTES) throw new PlanError(413, "plan too large");
  const markdown = await readFile(r.path, "utf8");
  return { name, title: scan(markdown).title ?? name, mtime, markdown, read: isRead(name, mtime), sections: sectionsOf(markdown) };
}

/** name -> "mtimeMs:size" of every listable plan file (same filters as the list, no cap), for change detection */
export async function plansFingerprint(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md") && isPlanName(n));
  } catch {
    return out;
  }
  await Promise.all(
    names.map(async (n) => {
      const r = await resolvePlan(dir, n);
      if (r) out.set(n, `${r.mtimeMs}:${r.size}`);
    }),
  );
  return out;
}

/** The fingerprint of one file, or null if it is not a listable plan */
export async function planFingerprint(dir: string, name: string): Promise<string | null> {
  if (!name.endsWith(".md") || !isPlanName(name)) return null;
  const r = await resolvePlan(dir, name);
  return r ? `${r.mtimeMs}:${r.size}` : null;
}
