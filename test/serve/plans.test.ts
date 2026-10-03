import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type ServeHandle } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ukagai-plans-"));
  roots.push(d);
  return d;
}

async function env(withDir = true) {
  const home = tmp();
  const dir = join(home, ".claude", "plans");
  if (withDir) mkdirSync(dir, { recursive: true });
  const h = await start({ port: 0, dataDir: tmp(), home });
  handles.push(h);
  const url = `http://127.0.0.1:${h.port}`;
  const get = (path: string, auth = true) =>
    fetch(url + path, { headers: auth ? { authorization: `Bearer ${h.token}` } : {} });
  return { home, dir, get };
}

function put(dir: string, name: string, body: string, at: string): void {
  const p = join(dir, name);
  writeFileSync(p, body);
  const t = new Date(at);
  utimesSync(p, t, t);
}

async function seeded() {
  const e = await env();
  put(e.dir, "titled.md", "# Real title\n\nintro\n\n## A\n\n```\n## not a section\n# not a title\n```\n\n## B\n", "2026-10-01T00:00:00Z");
  put(e.dir, "no-h1.md", "just text\n## Only\n", "2026-10-02T00:00:00Z");
  put(e.dir, "empty.md", "", "2026-10-03T00:00:00Z");
  put(e.dir, ".hidden.md", "# Hidden\n", "2026-10-04T00:00:00Z");
  put(e.dir, "notes.txt", "# not md\n", "2026-10-04T00:00:00Z");
  const outside = join(e.home, "outside.md");
  writeFileSync(outside, "# Outside\n");
  symlinkSync(outside, join(e.dir, "link.md"));
  return e;
}

test("list: order, count, title fallback, sections; hidden / non-md / symlink excluded", async () => {
  const { get } = await seeded();
  const r = await get("/api/plans");
  assert.equal(r.status, 200);
  const { plans } = (await r.json()) as { plans: { name: string; title: string; mtime: string; bytes: number; sections: number; lines: number }[] };
  assert.deepEqual(plans.map((p) => p.name), ["empty.md", "no-h1.md", "titled.md"]);
  assert.deepEqual(plans.map((p) => p.title), ["empty.md", "no-h1.md", "Real title"]);
  assert.deepEqual(plans.map((p) => p.sections), [0, 1, 2]);
  assert.deepEqual(plans.map((p) => p.lines), [0, 2, 12]);
  assert.equal(plans[0]!.bytes, 0);
  assert.equal(plans[2]!.mtime, "2026-10-01T00:00:00.000Z");
});

test("list is capped at 50, newest first", async () => {
  const e = await env();
  for (let i = 0; i < 55; i++) put(e.dir, `p${String(i).padStart(2, "0")}.md`, `# P${i}\n`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
  const { plans } = (await (await e.get("/api/plans")).json()) as { plans: { name: string }[] };
  assert.equal(plans.length, 50);
  assert.equal(plans[0]!.name, "p54.md");
  assert.equal(plans[49]!.name, "p05.md");
});

test("list: missing directory gives an empty list", async () => {
  const { get } = await env(false);
  const r = await get("/api/plans");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { plans: [] });
});

test("detail: body, title, mtime", async () => {
  const { get } = await seeded();
  const r = await get("/api/plans/titled.md");
  assert.equal(r.status, 200);
  const j = (await r.json()) as { name: string; title: string; mtime: string; markdown: string };
  assert.equal(j.name, "titled.md");
  assert.equal(j.title, "Real title");
  assert.equal(j.mtime, "2026-10-01T00:00:00.000Z");
  assert.ok(j.markdown.startsWith("# Real title\n"));
  const e = await (await get("/api/plans/empty.md")).json() as { markdown: string; title: string };
  assert.equal(e.markdown, "");
  assert.equal(e.title, "empty.md");
});

test("detail: invalid names are 400", async () => {
  const { get } = await seeded();
  for (const n of ["..%2Fsecret.md", "a%2Fb.md", "a%5Cb.md", ".hidden.md", "x..md"]) {
    assert.equal((await get("/api/plans/" + n)).status, 400, n);
  }
});

test("detail: unknown name 404; symlink leaving the directory 404", async () => {
  const { get } = await seeded();
  assert.equal((await get("/api/plans/missing.md")).status, 404);
  assert.equal((await get("/api/plans/link.md")).status, 404);
});

test("detail: {name, title, mtime, markdown, read}; no sections, and `since` no longer gives a 304", async () => {
  const { get } = await seeded();
  const r = await get(`/api/plans/titled.md?since=${encodeURIComponent("2026-10-01T00:00:00.000Z")}`);
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(j).sort(), ["markdown", "mtime", "name", "read", "title"]);
});

test("detail: over 1 MB is 413 (and stays listed)", async () => {
  const e = await env();
  put(e.dir, "big.md", "# Big\n" + "x".repeat(1024 * 1024), "2026-10-01T00:00:00Z");
  assert.equal((await e.get("/api/plans/big.md")).status, 413);
  const { plans } = (await (await e.get("/api/plans")).json()) as { plans: { name: string; title: string }[] };
  assert.deepEqual(plans.map((p) => p.name), ["big.md"]);
});

test("authorization is required; no write endpoints", async () => {
  const { get, dir } = await seeded();
  assert.equal((await get("/api/plans", false)).status, 401);
  assert.equal((await get("/api/plans/titled.md", false)).status, 401);
  assert.ok(dir);
});

import { readFileSync } from "node:fs";

// ---- read marks ----

async function readEnv() {
  const home = tmp();
  const dir = join(home, ".claude", "plans");
  mkdirSync(dir, { recursive: true });
  const dataDir = tmp();
  const h = await start({ port: 0, dataDir, home });
  handles.push(h);
  const url = `http://127.0.0.1:${h.port}`;
  const call = (method: string, path: string, body?: unknown, auth = true) =>
    fetch(url + path, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${h.token}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { home, dir, dataDir, call, h };
}

test("read: POST marks, list / detail show read, a rewrite makes it unread, DELETE unmarks", async () => {
  const e = await readEnv();
  put(e.dir, "a.md", "# A\n## S\n", "2026-10-01T00:00:00Z");
  const mtime = "2026-10-01T00:00:00.000Z";
  const list = async () => ((await (await e.call("GET", "/api/plans")).json()) as { plans: { read: boolean }[] }).plans[0]!.read;
  assert.equal(await list(), false);
  const r = await e.call("POST", "/api/plans/a.md/read", { mtime });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: "a.md", read: true });
  assert.equal(await list(), true);
  const d = (await (await e.call("GET", "/api/plans/a.md")).json()) as { read: boolean };
  assert.equal(d.read, true);
  put(e.dir, "a.md", "# A\n## S\nmore\n", "2026-10-02T00:00:00Z");
  assert.equal(await list(), false);
  await e.call("POST", "/api/plans/a.md/read", { mtime: "2026-10-02T00:00:00.000Z" });
  assert.equal(await list(), true);
  const del = await e.call("DELETE", "/api/plans/a.md/read");
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { name: "a.md", read: false });
  assert.equal(await list(), false);
});

test("read: 400 / 404 / 401", async () => {
  const e = await readEnv();
  put(e.dir, "a.md", "# A\n", "2026-10-01T00:00:00Z");
  assert.equal((await e.call("POST", "/api/plans/a.md/read", {})).status, 400);
  assert.equal((await e.call("POST", "/api/plans/a.md/read", { mtime: "" })).status, 400);
  assert.equal((await e.call("POST", "/api/plans/.hidden.md/read", { mtime: "x" })).status, 400);
  assert.equal((await e.call("POST", "/api/plans/a%2Fb.md/read", { mtime: "x" })).status, 400);
  assert.equal((await e.call("POST", "/api/plans/missing.md/read", { mtime: "x" })).status, 404);
  assert.equal((await e.call("DELETE", "/api/plans/missing.md/read")).status, 404);
  assert.equal((await e.call("POST", "/api/plans/a.md/read", { mtime: "x" }, false)).status, 401);
  assert.equal((await e.call("DELETE", "/api/plans/a.md/read", undefined, false)).status, 401);
});

test("read: persists across a store reload; a removed plan is pruned at load and by the watcher", async () => {
  const e = await readEnv();
  put(e.dir, "a.md", "# A\n", "2026-10-01T00:00:00Z");
  put(e.dir, "b.md", "# B\n", "2026-10-01T00:00:00Z");
  const t = "2026-10-01T00:00:00.000Z";
  await e.call("POST", "/api/plans/a.md/read", { mtime: t });
  await e.call("POST", "/api/plans/b.md/read", { mtime: t });
  const file = join(e.dataDir, "plans-read.json");
  // Writes are asynchronous: wait for the file to settle
  const settled = async (want: object) => {
    for (let i = 0; i < 60; i++) {
      try {
        if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) === JSON.stringify(want)) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), want);
  };
  await settled({ "a.md": t, "b.md": t });

  const { PlanReadStore } = await import("../../src/serve/plan-read.js");
  const again = new PlanReadStore(e.dataDir, e.dir);
  assert.equal(again.isRead("a.md", t), true);
  assert.equal(again.isRead("a.md", "2026-10-02T00:00:00.000Z"), false);

  rmSync(join(e.dir, "b.md"));
  assert.equal(new PlanReadStore(e.dataDir, e.dir).isRead("b.md", t), false); // pruned at load
  await settled({ "a.md": t }); // and by the watcher's onRemove
});

test("read: a corrupt plans-read.json is treated as empty", async () => {
  const dataDir = tmp();
  writeFileSync(join(dataDir, "plans-read.json"), "{not json");
  const { PlanReadStore } = await import("../../src/serve/plan-read.js");
  assert.equal(new PlanReadStore(dataDir, dataDir).isRead("a.md", "x"), false);
});

test("plan with explanation blocks: markdown, lines, section count ignore them", async () => {
  const { dir, get } = await env();
  const block = "<!-- ukagai-explain -->\n---\nukagai: 1\nquestion: Q?\n---\n## Why this decision is needed now\nx\n## Options\n<!-- /ukagai-explain -->\n";
  const plain = "# Plan\n\n## Steps\n\n1. a\n\n## Scope and reversibility\n\nReversibility: reversible\n";
  writeFileSync(join(dir, "with.md"), "# Plan\n\n## Steps\n\n1. a\n\n" + block + "## Scope and reversibility\n\nReversibility: reversible\n");
  writeFileSync(join(dir, "plain.md"), plain);
  const withB = await (await get("/api/plans/with.md")).json();
  const plainB = await (await get("/api/plans/plain.md")).json();
  assert.equal(withB.markdown, plain);
  assert.equal(plainB.markdown, plain);
  const { plans: list } = (await (await get("/api/plans")).json()) as { plans: { name: string; lines: number; sections: number }[] };
  const w = list.find((x) => x.name === "with.md")!;
  const p = list.find((x) => x.name === "plain.md")!;
  assert.equal(w.lines, p.lines);
  assert.equal(w.sections, p.sections);
});
