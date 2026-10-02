import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  const home = mkdtempSync(join(tmpdir(), "ukagai-ctx-"));
  try {
    const ctx = await collectContext(session(process.cwd(), home), { home });
    assert.ok(typeof ctx.branch === "string" && ctx.branch.length > 0);
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
