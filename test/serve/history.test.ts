import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHistory } from "../../src/serve/history.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ukagai-hist-"));
  roots.push(d);
  return d;
}

let seq = 0;
function transcript(home: string, lines: (object | string)[]): { path: string; session: { session_id: string; cwd: string; transcript_path: string } } {
  const dir = join(home, ".claude", "projects", "p");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `s${++seq}.jsonl`);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return { path, session: { session_id: `s${seq}`, cwd: "/nonexistent", transcript_path: path } };
}

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  isSidechain: false,
  message: { role: "user", content },
  timestamp: "2026-10-02T03:04:36.144Z",
  ...extra,
});

test("string content, text blocks, and ai-title", async () => {
  const home = tmp();
  const { session } = transcript(home, [
    { type: "ai-title", aiTitle: "Old" },
    user("first instruction", { timestamp: "2026-10-02T01:00:00.000Z" }),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    user([{ type: "text", text: "second" }, { type: "text", text: "part" }], { timestamp: "2026-10-02T02:00:00.000Z" }),
    { type: "ai-title", aiTitle: "New title" },
  ]);
  const h = await collectHistory(session, { home });
  assert.equal(h.ai_title, "New title");
  assert.equal(h.total, 2);
  assert.deepEqual(h.first, { at: "2026-10-02T01:00:00.000Z", text: "first instruction" });
  assert.deepEqual(h.recent.map((r) => r.text), ["first instruction", "second\npart"]);
});

test("excludes tool_result only, sidechain, meta, slash commands and interrupts", async () => {
  const home = tmp();
  const { session } = transcript(home, [
    user([{ type: "tool_result", content: "x", tool_use_id: "t" }]),
    user("sub agent prompt", { isSidechain: true }),
    user("caveat", { isMeta: true }),
    user("<command-name>/clear</command-name>\n<command-message>clear</command-message>"),
    user("<local-command-stdout>done</local-command-stdout>"),
    user("[Request interrupted by user]"),
    user("<system-reminder>only a reminder</system-reminder>"),
    user("real one"),
  ]);
  const h = await collectHistory(session, { home });
  assert.equal(h.total, 1);
  assert.equal(h.first?.text, "real one");
});

test("strips pasted_content tags and system-reminder blocks, keeps whitespace", async () => {
  const home = tmp();
  const { session } = transcript(home, [
    user('fix this:\n<pasted_content id="1">  line1\n  line2</pasted_content>\n<system-reminder>\nhidden\n</system-reminder>'),
  ]);
  const h = await collectHistory(session, { home });
  assert.equal(h.first?.text, "fix this:\n  line1\n  line2");
});

test("truncates first at 4000 and recent at 500 with an ellipsis", async () => {
  const home = tmp();
  const { session } = transcript(home, [user("a".repeat(5000)), user("b".repeat(500))]);
  const h = await collectHistory(session, { home });
  assert.equal(h.first?.text, "a".repeat(4000) + "…");
  assert.equal(h.recent[0]!.text, "a".repeat(500) + "…");
  assert.equal(h.recent[1]!.text, "b".repeat(500));
});

test("recent is the last 20 in chronological order and total counts all", async () => {
  const home = tmp();
  const { session } = transcript(home, Array.from({ length: 77 }, (_, i) => user(`msg ${i}`)));
  const h = await collectHistory(session, { home });
  assert.equal(h.total, 77);
  assert.equal(h.recent.length, 20);
  assert.equal(h.recent[0]!.text, "msg 57");
  assert.equal(h.recent[19]!.text, "msg 76");
  assert.equal(h.first?.text, "msg 0");
});

test("a path outside ~/.claude/projects or a missing file gives the empty history", async () => {
  const home = tmp();
  const outside = join(tmp(), "t.jsonl");
  writeFileSync(outside, JSON.stringify(user("secret")) + "\n");
  const empty = { total: 0, first: null, recent: [] };
  const a = await collectHistory({ session_id: "x", cwd: "/", transcript_path: outside }, { home });
  assert.deepEqual(a, { session_id: "x", ...empty });
  const b = await collectHistory({ session_id: "y", cwd: "/", transcript_path: join(home, ".claude", "projects", "none.jsonl") }, { home });
  assert.deepEqual(b, { session_id: "y", ...empty });
  // A symlink inside the allowed root that points outside is not allowed either
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const link = join(home, ".claude", "projects", "link.jsonl");
  symlinkSync(outside, link);
  const c = await collectHistory({ session_id: "z", cwd: "/", transcript_path: link }, { home });
  assert.equal(c.total, 0);
});

test("broken lines are skipped", async () => {
  const home = tmp();
  const { session } = transcript(home, ['{"type":"user", broken', user("ok one"), "not json at all", '{"type":"user"}', user("ok two")]);
  const h = await collectHistory(session, { home });
  assert.equal(h.total, 2);
});

test("a subagent decision reads the parent transcript_path", async () => {
  const home = tmp();
  const { session } = transcript(home, [user("parent instruction")]);
  const h = await collectHistory({ ...session, agent_id: "abc", agent_type: "x" } as typeof session, { home });
  assert.equal(h.first?.text, "parent instruction");
});

test("maxBytes limits the read to the head of the file", async () => {
  const home = tmp();
  const { session } = transcript(home, Array.from({ length: 100 }, (_, i) => user(`m${i}`)));
  const h = await collectHistory(session, { home, maxBytes: 1000 });
  assert.ok(h.total > 0 && h.total < 100);
  assert.equal(h.first?.text, "m0");
});

test("caches for 5 seconds by path + mtime", async () => {
  const home = tmp();
  const { path, session } = transcript(home, [user("one")]);
  let t = 1_000_000;
  const now = () => t;
  const a = await collectHistory(session, { home, now });
  assert.equal(a.total, 1);
  // Same mtime, new content: served from the cache
  const mtime = new Date(Date.now() - 60_000);
  utimesSync(path, mtime, mtime);
  const b1 = await collectHistory(session, { home, now });
  writeFileSync(path, JSON.stringify(user("one")) + "\n" + JSON.stringify(user("two")) + "\n");
  utimesSync(path, mtime, mtime);
  const b2 = await collectHistory(session, { home, now });
  assert.equal(b2.total, b1.total);
  t += 6000;
  const c = await collectHistory(session, { home, now });
  assert.equal(c.total, 2);
});

// ---- HTTP ----

async function setup() {
  const home = tmp();
  const h = await start({ port: 0, dataDir: tmp(), home });
  handles.push(h);
  return { h, home, url: `http://127.0.0.1:${h.port}` };
}

async function createDecision(env: { h: ServeHandle; url: string }, session: object, toolUseId: string) {
  const r = await fetch(env.url + "/api/decisions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      tool_use_id: toolUseId,
      kind: "answer_question",
      session,
      request: { questions: [{ question: "A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
    }),
  });
  return (await r.json()) as { id: string };
}

test("GET /api/decisions/:id/history: 200, 404 and 401", async () => {
  const env = await setup();
  const { session } = transcript(env.home, [{ type: "ai-title", aiTitle: "T" }, user("hello"), user("again")]);
  const d = await createDecision(env, session, "tu-1");
  const auth = { authorization: `Bearer ${env.h.token}` };

  const ok = await fetch(`${env.url}/api/decisions/${d.id}/history`, { headers: auth });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { session_id: string; ai_title: string; total: number; first: { text: string }; recent: unknown[] };
  assert.equal(body.session_id, session.session_id);
  assert.equal(body.ai_title, "T");
  assert.equal(body.total, 2);
  assert.equal(body.first.text, "hello");
  assert.equal(body.recent.length, 2);

  assert.equal((await fetch(`${env.url}/api/decisions/nope/history`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${env.url}/api/decisions/${d.id}/history`)).status, 401);

  // A cookie obtained from GET / is accepted too
  const page = await fetch(env.url + "/");
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  assert.equal((await fetch(`${env.url}/api/decisions/${d.id}/history`, { headers: { cookie } })).status, 200);
});

test("GET /api/decisions/:id/history: unreadable transcript gives the empty history", async () => {
  const env = await setup();
  const session = { session_id: "gone", cwd: "/nonexistent", transcript_path: join(env.home, ".claude", "projects", "p", "gone.jsonl") };
  const d = await createDecision(env, session, "tu-2");
  const r = await fetch(`${env.url}/api/decisions/${d.id}/history`, { headers: { authorization: `Bearer ${env.h.token}` } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { session_id: "gone", total: 0, first: null, recent: [] });
});
