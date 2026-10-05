// The session of a plan file: Claude Code assigns the transcript slug lazily (when the session first enters plan mode), so it is looked up from
// the transcript's tail first, then its head; a session found after the plan was announced is announced again with `session_id`.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanSessions, SLUG_SCAN_BYTES } from "../../src/serve/plan-session.js";
import type { PlanSummary, SessionSummary } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-plsess-"));
  roots.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!cond()) {
    assert.ok(Date.now() < end, "condition not met in time");
    await sleep(25);
  }
}

/** A transcript line without a slug, ~1 KB */
const plain = (i: number) => JSON.stringify({ type: "user", n: i, text: "x".repeat(1000) }) + "\n";
const withSlug = (slug: string) => JSON.stringify({ type: "assistant", slug }) + "\n";
const filler = (bytes: number) => Array.from({ length: Math.ceil(bytes / 1000) }, (_, i) => plain(i)).join("");

function setup() {
  const home = tmp();
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  const path = join(home, ".claude", "projects", "p", "s1.jsonl");
  const sessions = [{ session_id: "s1", state: "idle", transcript_path: path, cwd: "/w", last_event_at: new Date().toISOString() }] as SessionSummary[];
  const found: [string, string][] = [];
  const ps = new PlanSessions(() => sessions, home, Date.now, (name, id) => found.push([name, id]));
  return { home, path, ps, found };
}

test("a slug that first appears after 300 KB of slug-less lines (only the tail has it) is found", async () => {
  const { path, ps } = setup();
  writeFileSync(path, filler(300 * 1024) + withSlug("late-fox") + plain(1) + withSlug("late-fox"));
  assert.equal(await ps.find("late-fox.md"), "s1");
});

test("a slug in the first 256 KB still works when the tail has none (head fallback)", async () => {
  const { path, ps } = setup();
  writeFileSync(path, withSlug("early-fox") + filler(SLUG_SCAN_BYTES * 2));
  assert.equal(await ps.find("early-fox.md"), "s1");
});

test("an unknown slug is looked up again once the file grew; a found slug is kept without re-reading", async () => {
  const { path, ps, found } = setup();
  writeFileSync(path, filler(2000));
  assert.equal(await ps.find("new-owl.md"), undefined);
  assert.equal(await ps.find("new-owl.md"), undefined);
  appendFileSync(path, withSlug("new-owl")); // the file grew: the next poll sees the slug
  assert.equal(await ps.find("new-owl.md"), "s1");
  assert.deepEqual(found, [["new-owl.md", "s1"]], "announced once, when it changed from unknown to found");
  // Not read again: removing the slug (the file is rewritten without it) changes nothing
  writeFileSync(path, filler(5000));
  assert.equal(await ps.find("new-owl.md"), "s1");
  assert.equal(await ps.find("new-owl.md"), "s1");
  assert.equal(found.length, 1);
});

test("a plan first looked up with its session already known is not announced (the answer carried it)", async () => {
  const { path, ps, found } = setup();
  writeFileSync(path, withSlug("known-cat"));
  assert.equal(await ps.find("known-cat.md"), "s1");
  assert.deepEqual(found, []);
});

// ---- Through the server: the timer finds it and plan.updated carries session_id ----

test("SSE: a plan announced without a session gets one plan.updated with session_id when the transcript gets its slug", async () => {
  const home = tmp();
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  const h = await start({ port: 0, dataDir: tmp(), home, planDebounceMs: 50, planPollMs: 100, recapPollMs: 60000 });
  handles.push(h);
  const base = `http://127.0.0.1:${h.port}`;
  const headers = { authorization: `Bearer ${h.token}` };
  const tpath = join(home, ".claude", "projects", "p", "s-late.jsonl");
  writeFileSync(tpath, filler(4000));
  await fetch(`${base}/api/events`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ session_id: "s-late", transcript_path: tpath, cwd: "/w", hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() }),
  });

  const ac = new AbortController();
  const updates: PlanSummary[] = [];
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
          if (/^event: plan\.updated$/m.test(block)) updates.push(JSON.parse(/^data: (.+)$/m.exec(block)![1]!));
        }
      }
    } catch {}
  })();
  after(() => ac.abort());
  await sleep(150);

  writeFileSync(join(home, ".claude", "plans", "late-owl.md"), "# Late owl\n\n## S\n");
  await until(() => updates.some((u) => u.name === "late-owl.md"));
  assert.equal(updates.find((u) => u.name === "late-owl.md")!.session_id, undefined, "no slug yet: no session");
  appendFileSync(tpath, withSlug("late-owl")); // Claude Code names the plan after the slug it assigns on entering plan mode
  await until(() => updates.some((u) => u.session_id === "s-late"));
  await sleep(400); // later polls find the same session: nothing more is announced
  assert.equal(updates.filter((u) => u.session_id === "s-late").length, 1);
  const list = (await (await fetch(`${base}/api/plans`, { headers })).json()) as { plans: PlanSummary[] };
  assert.equal(list.plans.find((p) => p.name === "late-owl.md")!.session_id, "s-late");
});
