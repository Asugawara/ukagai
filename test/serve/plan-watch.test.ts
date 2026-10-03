import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanSummary } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { startPlanWatcher } from "../../src/serve/plan-watch.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
const stops: (() => void)[] = [];
after(async () => {
  for (const s of stops) s();
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ukagai-pwatch-"));
  roots.push(d);
  return d;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function watcher(dir: string, pollMs = 10000, isRead?: (name: string, mtime: string) => boolean) {
  const changes: PlanSummary[] = [];
  const removes: string[] = [];
  const w = startPlanWatcher({ plansDir: dir, pollMs, debounceMs: 100, isRead, onChange: (s) => changes.push(s), onRemove: (n) => removes.push(n) });
  stops.push(() => w.stop());
  return { changes, removes, w };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), "condition not met in time");
}

test("watcher: create emits one change; existing files are not reported", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "old.md"), "# Old\n");
  const { changes } = watcher(dir);
  await sleep(150);
  writeFileSync(join(dir, "new.md"), "# New\n## S\n");
  await until(() => changes.length >= 1);
  await sleep(400);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.name, "new.md");
  assert.equal(changes[0]!.title, "New");
  assert.equal(changes[0]!.sections, 1);
});

test("watcher: onChange gets the final summary, with `read` from isRead", async () => {
  const dir = tmp();
  const { changes } = watcher(dir, 10000, (name) => name === "marked.md");
  await sleep(150);
  writeFileSync(join(dir, "marked.md"), "# M\n");
  writeFileSync(join(dir, "plain.md"), "# P\n");
  await until(() => changes.length >= 2);
  assert.equal(changes.find((c) => c.name === "marked.md")!.read, true);
  assert.equal(changes.find((c) => c.name === "plain.md")!.read, false);
});

test("watcher: 5 rapid appends emit once with the final state", async () => {
  const dir = tmp();
  const { changes } = watcher(dir);
  await sleep(150);
  const p = join(dir, "burst.md");
  writeFileSync(p, "# B\n");
  await until(() => changes.length === 1);
  for (let i = 0; i < 5; i++) {
    appendFileSync(p, `line ${i}\n`);
    await sleep(10);
  }
  await sleep(700);
  assert.equal(changes.length, 2);
  assert.equal(changes[1]!.lines, 6);
});

test("watcher: delete emits remove", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "gone.md"), "# G\n");
  const { removes } = watcher(dir);
  await sleep(150);
  rmSync(join(dir, "gone.md"));
  await until(() => removes.length === 1);
  assert.deepEqual(removes, ["gone.md"]);
});

test("watcher: a directory created after start is picked up (poll)", async () => {
  const root = tmp();
  const dir = join(root, "plans");
  const { changes } = watcher(dir, 200);
  await sleep(100);
  mkdirSync(dir);
  writeFileSync(join(dir, "first.md"), "# First\n");
  await until(() => changes.length >= 1, 3000);
  assert.equal(changes[0]!.name, "first.md");
});

test("watcher: dotfiles, non-md files and escaping symlinks emit nothing", async () => {
  const dir = tmp();
  const outside = join(tmp(), "outside.md");
  writeFileSync(outside, "# Out\n");
  const { changes } = watcher(dir, 200);
  await sleep(150);
  writeFileSync(join(dir, ".hidden.md"), "# H\n");
  writeFileSync(join(dir, "notes.txt"), "# T\n");
  symlinkSync(outside, join(dir, "link.md"));
  await sleep(900);
  assert.equal(changes.length, 0);
});

test("watcher: stop() ends events", async () => {
  const dir = tmp();
  const { changes, w } = watcher(dir, 200);
  await sleep(150);
  w.stop();
  writeFileSync(join(dir, "late.md"), "# Late\n");
  await sleep(800);
  assert.equal(changes.length, 0);
});

// ---- SSE through HTTP ----

test("SSE: plan.updated with read false, then true after POST read; rewrite is unread again", async () => {
  const home = tmp();
  const dir = join(home, ".claude", "plans");
  mkdirSync(dir, { recursive: true });
  const h = await start({ port: 0, dataDir: tmp(), home, planDebounceMs: 100, planPollMs: 200 });
  handles.push(h);
  const base = `http://127.0.0.1:${h.port}`;
  const headers = { authorization: `Bearer ${h.token}` };

  const ac = new AbortController();
  const events: { event: string; data: PlanSummary & { name: string } }[] = [];
  const res = await fetch(`${base}/api/stream`, { headers, signal: ac.signal });
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch {}
  })();
  after(() => ac.abort());
  await sleep(150);

  writeFileSync(join(dir, "live.md"), "# Live\n## S\n");
  await until(() => events.some((e) => e.event === "plan.updated"));
  const first = events.find((e) => e.event === "plan.updated")!.data;
  assert.equal(first.name, "live.md");
  assert.equal(first.read, false);

  const n = events.length;
  const r = await fetch(`${base}/api/plans/live.md/read`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ mtime: first.mtime }),
  });
  assert.equal(r.status, 200);
  await until(() => events.length > n);
  const marked = events.at(-1)!;
  assert.equal(marked.event, "plan.updated");
  assert.equal(marked.data.read, true);

  await sleep(50);
  appendFileSync(join(dir, "live.md"), "more\n");
  await until(() => events.some((e, i) => i >= n && e.event === "plan.updated" && e.data.read === false));
  const list = (await (await fetch(`${base}/api/plans`, { headers })).json()) as { plans: { read: boolean }[] };
  assert.equal(list.plans[0]!.read, false);

  rmSync(join(dir, "live.md"));
  await until(() => events.some((e) => e.event === "plan.removed"));
  assert.deepEqual(events.find((e) => e.event === "plan.removed")!.data, { name: "live.md" });
});
