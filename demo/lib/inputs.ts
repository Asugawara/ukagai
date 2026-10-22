// Hash of what a render depends on (public/, src/, demo/ without demo/out) and the git state.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["public", "src", "demo"];
const SKIP = new Set(["out", "node_modules"]);
// Publishing and docs do not change a render, so they stay out of the hash.
const EXCLUDE = new Set([
  "demo/published.json",
  "demo/publish.ts",
  "demo/lib/attachments.ts",
  "demo/README.md",
]);

export interface RenderInputs {
  hash: string;
  files: number;
  head: string;
  dirty: boolean;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function renderInputs(repoRoot: string): RenderInputs {
  const files: string[] = [];
  for (const r of ROOTS) walk(join(repoRoot, r), files);
  files.sort();
  const kept = files.filter((f) => !EXCLUDE.has(relative(repoRoot, f)));
  files.length = 0;
  files.push(...kept);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(relative(repoRoot, f));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return {
    hash: h.digest("hex"),
    files: files.length,
    head: git(repoRoot, ["rev-parse", "--short=7", "HEAD"]),
    dirty: git(repoRoot, ["status", "--porcelain"]) !== "",
  };
}
