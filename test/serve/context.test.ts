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

test("存在しない cwd・transcript は空の context", async () => {
  const home = mkdtempSync(join(tmpdir(), "ukagai-ctx-"));
  try {
    assert.deepEqual(await collectContext(session("/nonexistent-ukagai", home), { home }), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("git リポジトリでない cwd でも落ちずに空", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-ctx-"));
  try {
    assert.deepEqual(await collectContext(session(dir, dir), { home: dir }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("リポジトリの cwd では branch が取れ、diff は 200 KB 以内", async () => {
  // 開発リポジトリ(process.cwd())は大きく、並列テストの負荷で git が timeout して揺れるので、小さな一時リポジトリで見る
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
    // 小さなリポジトリでも、並列テストの負荷で git が 500ms の timeout を超えることがあるので 3 回まで試す
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

test("許可外の transcript_path は読まない", async () => {
  const home = mkdtempSync(join(tmpdir(), "ukagai-ctx-"));
  try {
    const s = { ...session("/nonexistent-ukagai", home), transcript_path: "/etc/passwd" };
    assert.deepEqual(await collectContext(s, { home }), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
