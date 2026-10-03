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

test("detail: since equal to mtime is 304, otherwise 200", async () => {
  const { get } = await seeded();
  const mtime = "2026-10-01T00:00:00.000Z";
  assert.equal((await get(`/api/plans/titled.md?since=${encodeURIComponent(mtime)}`)).status, 304);
  assert.equal((await get(`/api/plans/titled.md?since=${encodeURIComponent("2026-09-30T00:00:00.000Z")}`)).status, 200);
  assert.equal((await get("/api/plans/titled.md?since=garbage")).status, 200);
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

// ---- sectionsOf ----

import { readFileSync } from "node:fs";
import { sectionsOf } from "../../src/serve/plans.js";

test("sectionsOf: long-plan fixture has 9 H2 + 6 H3 with stable hashes", () => {
  const md = readFileSync(new URL("../gui/fixtures/long-plan.md", import.meta.url), "utf8");
  const a = sectionsOf(md);
  assert.equal(a.filter((s) => s.level === 2).length, 9);
  assert.equal(a.filter((s) => s.level === 3).length, 6);
  assert.equal(a.length, 15);
  assert.deepEqual(sectionsOf(md), a);
  for (const s of a) assert.match(s.hash, /^[0-9a-f]{12}$/);
});

test("sectionsOf: changing one line changes only that section (and its H2 parent)", () => {
  const md = "# T\n\n## A\nalpha\n\n### A1\none\n\n### A2\ntwo\n\n## B\nbeta\n";
  const before = sectionsOf(md);
  assert.deepEqual(before.map((s) => [s.level, s.heading]), [[2, "A"], [3, "A1"], [3, "A2"], [2, "B"]]);
  const after = sectionsOf(md.replace("two", "TWO"));
  assert.equal(after[0]!.hash === before[0]!.hash, false); // A contains A2
  assert.equal(after[1]!.hash, before[1]!.hash);
  assert.equal(after[2]!.hash === before[2]!.hash, false);
  assert.equal(after[3]!.hash, before[3]!.hash);
  const b = sectionsOf(md.replace("beta", "BETA"));
  assert.deepEqual(b.slice(0, 3), before.slice(0, 3));
  assert.notEqual(b[3]!.hash, before[3]!.hash);
});

test("sectionsOf: a ## inside a code fence is not a section; H1 and H4 are not sections but H1 ends one", () => {
  const md = "## A\n```\n## nope\n### nope\n```\ntext\n#### deep\n# Next\nafter\n## B\n";
  const s = sectionsOf(md);
  assert.deepEqual(s.map((x) => x.heading), ["A", "B"]);
  const a2 = sectionsOf(md.replace("after", "AFTER"));
  assert.equal(a2[0]!.hash, s[0]!.hash); // "after" is under the H1, outside A
  assert.deepEqual(sectionsOf(""), []);
});

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
  const d = (await (await e.call("GET", "/api/plans/a.md")).json()) as { read: boolean; sections: unknown[] };
  assert.equal(d.read, true);
  assert.equal(d.sections.length, 1);
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

test("read: persists across a store reload; entries of deleted files are pruned on save", async () => {
  const e = await readEnv();
  put(e.dir, "a.md", "# A\n", "2026-10-01T00:00:00Z");
  put(e.dir, "b.md", "# B\n", "2026-10-01T00:00:00Z");
  const t = "2026-10-01T00:00:00.000Z";
  await e.call("POST", "/api/plans/a.md/read", { mtime: t });
  await e.call("POST", "/api/plans/b.md/read", { mtime: t });
  const file = join(e.dataDir, "plans-read.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "a.md": t, "b.md": t });

  const { PlanReadStore } = await import("../../src/serve/plan-read.js");
  const again = new PlanReadStore(e.dataDir, e.dir);
  assert.equal(again.isRead("a.md", t), true);
  assert.equal(again.isRead("a.md", "2026-10-02T00:00:00.000Z"), false);

  rmSync(join(e.dir, "b.md"));
  await e.call("DELETE", "/api/plans/a.md/read"); // any save prunes
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});

test("read: a corrupt plans-read.json is treated as empty", async () => {
  const dataDir = tmp();
  writeFileSync(join(dataDir, "plans-read.json"), "{not json");
  const { PlanReadStore } = await import("../../src/serve/plan-read.js");
  assert.equal(new PlanReadStore(dataDir, dataDir).isRead("a.md", "x"), false);
});

test("plan with explanation blocks: markdown, lines, sections ignore them", async () => {
  const { dir, get } = await env();
  const block = "<!-- ukagai-explain -->\n---\nukagai: 1\nquestion: Q?\n---\n## Why this decision is needed now\nx\n## Options\n<!-- /ukagai-explain -->\n";
  const plain = "# Plan\n\n## Steps\n\n1. a\n\n## Scope and reversibility\n\nReversibility: reversible\n";
  writeFileSync(join(dir, "with.md"), "# Plan\n\n## Steps\n\n1. a\n\n" + block + "## Scope and reversibility\n\nReversibility: reversible\n");
  writeFileSync(join(dir, "plain.md"), plain);
  const withB = await (await get("/api/plans/with.md")).json();
  const plainB = await (await get("/api/plans/plain.md")).json();
  assert.equal(withB.markdown, plain);
  assert.deepEqual(withB.sections, plainB.sections);
  assert.deepEqual(withB.sections.map((s: { heading: string }) => s.heading), ["Steps", "Scope and reversibility"]);
  const { plans: list } = (await (await get("/api/plans")).json()) as { plans: { name: string; lines: number; sections: number }[] };
  const w = list.find((x) => x.name === "with.md")!;
  const p = list.find((x) => x.name === "plain.md")!;
  assert.equal(w.lines, p.lines);
  assert.equal(w.sections, p.sections);
});
