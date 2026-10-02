import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectContext } from "../../src/serve/context.js";

const session = (cwd: string, home: string) => ({
  session_id: "s",
  cwd,
  transcript_path: join(home, ".claude", "projects", "p", "s.jsonl"),
});

test("nonexistent cwd / transcript gives empty context", async () => {
  const home = mkdtempSync(join(tmpdir(), "ukagai-ctx-"));
  try {
    assert.deepEqual(await collectContext(session("/nonexistent-ukagai", home), { home }), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a cwd that is not a git repo gives empty without crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-ctx-"));
  try {
    assert.deepEqual(await collectContext(session(dir, dir), { home: dir }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in a repo cwd the branch is read and the diff is within 200 KB", async () => {
  // the dev repo (process.cwd()) is large and git times out under parallel test load, so use a small temp repo
  const home = mkdtempSync(join(tmpdir(), "ukagai-ctx-"));
  const repo = join(home, "repo");
  try {
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q", "-b", "ctx-branch");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    writeFileSync(join(repo, "a.txt"), "x".repeat(300 * 1024));
    git("add", "a.txt");
    writeFileSync(join(repo, "a.txt"), "y".repeat(300 * 1024));
    // even a small repo can exceed git's 500ms timeout under parallel load, so retry up to 3 times
    let ctx = await collectContext(session(repo, home), { home });
    for (let i = 0; i < 2 && ctx.branch === undefined; i++) {
      ctx = await collectContext(session(repo, home), { home });
    }
    assert.equal(ctx.branch, "ctx-branch");
    assert.ok((ctx.git_diff ?? "").length <= 200 * 1024);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a transcript_path outside the allowed area is not read", async () => {
  const home = mkdtempSync(join(tmpdir(), "ukagai-ctx-"));
  try {
    const s = { ...session("/nonexistent-ukagai", home), transcript_path: "/etc/passwd" };
    assert.deepEqual(await collectContext(s, { home }), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
