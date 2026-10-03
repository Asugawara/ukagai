import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { PlanContent, PlanSummary } from "../contract.js";

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

/** Title (first H1 outside code fences) and H2 count */
function scan(markdown: string): { title: string | undefined; sections: number; lines: number } {
  let title: string | undefined;
  let sections = 0;
  let fence: string | undefined;
  const all = markdown === "" ? [] : markdown.replace(/\r?\n$/, "").split(/\r?\n/);
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

export async function listPlans(home: string): Promise<PlanSummary[]> {
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
  return Promise.all(
    found.map(async ({ n, r }): Promise<PlanSummary> => {
      let md = "";
      if (r.size <= MAX_PLAN_BYTES) {
        try { md = await readFile(r.path, "utf8"); } catch {}
      }
      const s = scan(md);
      return {
        name: n,
        title: s.title ?? n,
        mtime: new Date(r.mtimeMs).toISOString(),
        bytes: r.size,
        sections: s.sections,
        lines: s.lines,
      };
    }),
  );
}

/** Returns null when `since` equals the file's mtime (not modified). Throws PlanError otherwise on failure */
export async function readPlan(home: string, name: string, since?: string): Promise<PlanContent | null> {
  if (!isPlanName(name)) throw new PlanError(400, "invalid plan name");
  const r = await resolvePlan(plansDir(home), name);
  if (!r) throw new PlanError(404, "plan not found");
  const mtime = new Date(r.mtimeMs).toISOString();
  if (since !== undefined && since === mtime) return null;
  if (r.size > MAX_PLAN_BYTES) throw new PlanError(413, "plan too large");
  const markdown = await readFile(r.path, "utf8");
  return { name, title: scan(markdown).title ?? name, mtime, markdown };
}
