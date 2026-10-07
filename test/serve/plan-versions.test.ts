// Plan versions: GET /api/sessions/:id/plan-versions, the file snapshots taken by POST /api/plans/:name/instruct
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, PlanVersionsResponse } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { MAX_STORED_VERSIONS } from "../../src/serve/plan-versions.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-pv-"));
  roots.push(d);
  return d;
};

type Env = { h: ServeHandle; home: string; dataDir: string; url: string };

async function boot(home = tmp(), dataDir = tmp()): Promise<Env> {
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  const h = await start({ port: 0, dataDir, home, terminalPollMs: 5, recapPollMs: 60000 });
  handles.push(h);
  return { h, home, dataDir, url: `http://127.0.0.1:${h.port}` };
}
const api = (env: Env, path: string, body?: unknown) =>
  fetch(env.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const tpath = (env: Env, sid: string) => join(env.home, ".claude", "projects", "p", `${sid}.jsonl`);
const planDecision = async (env: Env, sid: string, toolUse: string, plan: string): Promise<Decision> => {
  const r = await api(env, "/api/decisions", {
    tool_use_id: toolUse,
    kind: "approve_plan",
    session: { session_id: sid, cwd: "/w", transcript_path: tpath(env, sid) },
    request: { plan, planFilePath: join(env.home, ".claude", "plans", "x.md") },
  });
  return (await r.json()) as Decision;
};
const versions = async (env: Env, sid: string, q = "") => {
  const r = await api(env, `/api/sessions/${sid}/plan-versions${q}`);
  return { status: r.status, body: (await r.json()) as PlanVersionsResponse };
};
/** A live session whose transcript carries the slug of a plan file */
async function liveSession(env: Env, sid: string, slug: string): Promise<void> {
  writeFileSync(tpath(env, sid), [`{"type":"user","sessionId":"${sid}","slug":"${slug}"}`, `{"type":"assistant","slug":"${slug}"}`].join("\n") + "\n");
  await api(env, "/api/events", { session_id: sid, transcript_path: tpath(env, sid), cwd: "/w", hook_event_name: "PreToolUse", received_at: new Date().toISOString() });
}
const writePlan = (env: Env, name: string, md: string) => writeFileSync(join(env.home, ".claude", "plans", name), md);

const V1 = "# P\n\n## Goal\n\nold goal\n\n## Steps\n\n1. a\n";
const V2 = "# P\n\n## Goal\n\nnew goal\n\n## Steps\n\n1. a\n\n## Risks\n\nnone\n";

test("two approve_plan decisions with an instruct answer between them: 2 versions, v1 carries the instruction, diffs[1] shows the change", async () => {
  const env = await boot();
  const d1 = await planDecision(env, "s1", "t1", V1);
  await api(env, `/api/decisions/${d1.id}/answer`, { instruct: true, text: "add a risks section" });
  await new Promise((r) => setTimeout(r, 5));
  const d2 = await planDecision(env, "s1", "t2", V2);
  const { status, body } = await versions(env, "s1", `?current=decision:${d2.id}`);
  assert.equal(status, 200);
  assert.equal(body.versions.length, 2);
  assert.deepEqual(body.versions.map((v) => [v.n, v.source, v.decision_id]), [[1, "approval", d1.id], [2, "approval", d2.id]]);
  assert.equal(body.versions[0]!.instruction?.kind, "instruct");
  assert.equal(body.versions[0]!.instruction?.text, "add a risks section");
  assert.equal(body.versions[1]!.instruction, undefined);
  assert.equal(body.versions[1]!.current, true);
  assert.deepEqual(body.diffs[0]!.summary, { added: 3, changed: 0, removed: 0, same: 0 });
  assert.deepEqual(body.diffs[1]!.sections.map((s) => `${s.heading}:${s.status}`), [":same", "Goal:changed", "Steps:same", "Risks:added"]);
  assert.deepEqual(body.diffs[1]!.summary, { added: 1, changed: 1, removed: 0, same: 2 });
});

test("POST answer { approve: false } (no reason) is 200, the response carries no reason and the next version carries a reject instruction with empty text", async () => {
  const env = await boot();
  const d1 = await planDecision(env, "s1", "t1", V1);
  const r = await api(env, `/api/decisions/${d1.id}/answer`, { approve: false });
  assert.equal(r.status, 200);
  const got = (await (await api(env, `/api/decisions/${d1.id}`)).json()) as Decision;
  assert.equal(got.response?.approve, false);
  assert.equal("reason" in got.response!, false);
  await planDecision(env, "s1", "t2", V2);
  const { body } = await versions(env, "s1");
  assert.deepEqual(body.versions[0]!.instruction && { kind: body.versions[0]!.instruction.kind, text: body.versions[0]!.instruction.text }, { kind: "reject", text: "" });
});

test("a rejection with a reason is a reject instruction; the next, still pending version carries none", async () => {
  const env = await boot();
  const d1 = await planDecision(env, "s1", "t1", V1);
  await api(env, `/api/decisions/${d1.id}/answer`, { approve: false, reason: "narrow it" });
  await planDecision(env, "s1", "t2", V2);
  const { body } = await versions(env, "s1");
  assert.deepEqual(body.versions[0]!.instruction && { kind: body.versions[0]!.instruction.kind, text: body.versions[0]!.instruction.text }, { kind: "reject", text: "narrow it" });
  assert.equal(body.versions[1]!.instruction, undefined);
});

test("versions are per session", async () => {
  const env = await boot();
  await planDecision(env, "s1", "t1", V1);
  await planDecision(env, "s2", "t2", V2);
  assert.equal((await versions(env, "s1")).body.versions.length, 1);
  assert.equal((await versions(env, "s2")).body.versions[0]!.plan, V2);
});

test("a file instruct stores the content at that moment, even after the file changed; current is the file's content", async () => {
  const env = await boot();
  writePlan(env, "swift-otter.md", V1);
  await liveSession(env, "s1", "swift-otter");
  assert.equal((await api(env, "/api/plans/swift-otter.md/instruct", { text: "add risks" })).status, 200);
  writePlan(env, "swift-otter.md", V2);
  const { body } = await versions(env, "s1", "?current=plan:swift-otter.md");
  assert.equal(body.versions.length, 2);
  assert.equal(body.versions[0]!.source, "file");
  assert.equal(body.versions[0]!.plan, V1);
  assert.equal(body.versions[0]!.instruction?.text, "add risks");
  assert.equal(body.versions[1]!.plan, V2);
  assert.equal(body.versions[1]!.current, true);
  assert.equal(body.versions[1]!.instruction, undefined);
  assert.deepEqual(body.diffs[1]!.summary, { added: 1, changed: 1, removed: 0, same: 2 });
});

test("current is appended only when it differs from the last version", async () => {
  const env = await boot();
  const d1 = await planDecision(env, "s1", "t1", V1);
  const same = await versions(env, "s1", `?current=decision:${d1.id}`);
  assert.equal(same.body.versions.length, 1);
  assert.equal(same.body.versions[0]!.current, true);
  // the plan file now holds a newer text than any decision: it is appended as the last version
  writePlan(env, "x.md", V2);
  const newer = await versions(env, "s1", "?current=plan:x.md");
  assert.equal(newer.body.versions.length, 2);
  assert.equal(newer.body.versions[1]!.plan, V2);
  assert.equal(newer.body.versions[1]!.current, true);
  // without `current` nothing is appended and nothing is marked
  const none = await versions(env, "s1");
  assert.equal(none.body.versions.length, 1);
  assert.equal(none.body.versions[0]!.current, undefined);
});

test("at most 20 stored versions per session: the oldest are dropped, and their files with them", async () => {
  const env = await boot();
  writePlan(env, "swift-otter.md", "x");
  await liveSession(env, "s1", "swift-otter");
  for (let i = 1; i <= MAX_STORED_VERSIONS + 3; i++) {
    writePlan(env, "swift-otter.md", `## S\n\nversion ${i}\n`);
    assert.equal((await api(env, "/api/plans/swift-otter.md/instruct", { text: `i${i}` })).status, 200);
  }
  const { body } = await versions(env, "s1");
  assert.equal(body.versions.length, MAX_STORED_VERSIONS);
  assert.equal(body.versions[0]!.plan, "## S\n\nversion 4\n");
  assert.equal(body.versions[MAX_STORED_VERSIONS - 1]!.plan, `## S\n\nversion ${MAX_STORED_VERSIONS + 3}\n`);
  assert.deepEqual(body.versions.map((v) => v.n), Array.from({ length: MAX_STORED_VERSIONS }, (_, i) => i + 1));
  const dir = join(env.dataDir, "plan-versions", "s1");
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".md")).length, MAX_STORED_VERSIONS);
});

test("restart reloads the stored snapshots", async () => {
  const home = tmp();
  const dataDir = tmp();
  const a = await boot(home, dataDir);
  writePlan(a, "swift-otter.md", V1);
  await liveSession(a, "s1", "swift-otter");
  await api(a, "/api/plans/swift-otter.md/instruct", { text: "go" });
  assert.ok(existsSync(join(dataDir, "plan-versions", "s1", "index.json")));
  await a.h.close();
  handles.splice(handles.indexOf(a.h), 1);
  const b = await boot(home, dataDir);
  const { status, body } = await versions(b, "s1");
  assert.equal(status, 200);
  assert.equal(body.versions.length, 1);
  assert.equal(body.versions[0]!.plan, V1);
  assert.equal(body.versions[0]!.instruction?.text, "go");
});

test("404 for an unknown session, a decision of another session and a missing plan; 400 for a malformed current", async () => {
  const env = await boot();
  const d = await planDecision(env, "s1", "t1", V1);
  assert.equal((await versions(env, "nope")).status, 404);
  assert.equal((await versions(env, "s1", `?current=decision:${d.id}`)).status, 200);
  await planDecision(env, "s2", "t2", V2);
  assert.equal((await versions(env, "s2", `?current=decision:${d.id}`)).status, 404);
  assert.equal((await versions(env, "s1", "?current=decision:missing")).status, 404);
  assert.equal((await versions(env, "s1", "?current=plan:missing.md")).status, 404);
  for (const bad of ["x", "decision:", "plan:", "other:1", "plan:../etc.md", "plan:notmd"]) {
    assert.equal((await versions(env, "s1", `?current=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
});

test("auth: no token and no cookie is 401", async () => {
  const env = await boot();
  await planDecision(env, "s1", "t1", V1);
  const r = await fetch(`${env.url}/api/sessions/s1/plan-versions`);
  assert.equal(r.status, 401);
});

const approve = (env: Env, id: string) => api(env, `/api/decisions/${id}/answer`, { approve: true });
const pause = () => new Promise((r) => setTimeout(r, 5));

test("after an approval, a changed current file starts a new list of one version", async () => {
  const env = await boot();
  const d1 = await planDecision(env, "s1", "t1", V1);
  await approve(env, d1.id);
  await pause();
  writePlan(env, "x.md", V2);
  const { body } = await versions(env, "s1", "?current=plan:x.md");
  assert.equal(body.versions.length, 1);
  assert.equal(body.versions[0]!.plan, V2);
  assert.equal(body.versions[0]!.current, true);
  assert.equal(body.diffs.length, 1);
});

test("versions begin after the last approval: an instruct decision, an approval, then a snapshot and a changed current", async () => {
  const env = await boot();
  writePlan(env, "swift-otter.md", V1);
  await liveSession(env, "s1", "swift-otter");
  const d1 = await planDecision(env, "s1", "t1", V1);
  await api(env, `/api/decisions/${d1.id}/answer`, { instruct: true, text: "again" });
  await pause();
  const d2 = await planDecision(env, "s1", "t2", V2);
  await approve(env, d2.id);
  await pause();
  const V3 = V2 + "\n## More\n\nx\n";
  writePlan(env, "swift-otter.md", V3);
  assert.equal((await api(env, "/api/plans/swift-otter.md/instruct", { text: "next" })).status, 200);
  await pause();
  const V4 = V3 + "\n## Even more\n\ny\n";
  writePlan(env, "swift-otter.md", V4);
  const { body } = await versions(env, "s1", "?current=plan:swift-otter.md");
  assert.deepEqual(body.versions.map((v) => [v.n, v.source, v.plan]), [[1, "file", V3], [2, "file", V4]]);
  assert.equal(body.versions[0]!.instruction?.text, "next");
});

test("a rejected decision before the approval is dropped with it", async () => {
  const env = await boot();
  writePlan(env, "swift-otter.md", V1);
  await liveSession(env, "s1", "swift-otter");
  const d1 = await planDecision(env, "s1", "t1", V1);
  await api(env, `/api/decisions/${d1.id}/answer`, { approve: false, reason: "no" });
  await pause();
  const d2 = await planDecision(env, "s1", "t2", V2);
  await approve(env, d2.id);
  await pause();
  assert.equal((await api(env, "/api/plans/swift-otter.md/instruct", { text: "later" })).status, 200);
  await pause();
  writePlan(env, "swift-otter.md", V1 + "\n## Z\n\nz\n");
  const { body } = await versions(env, "s1", "?current=plan:swift-otter.md");
  assert.equal(body.versions.length, 2);
  assert.deepEqual(body.versions.map((v) => v.source), ["file", "file"]);
  assert.equal(body.versions[0]!.instruction?.text, "later");
  assert.equal(body.versions[1]!.current, true);
});

test("two fetches of an unchanged plan file are byte-identical (the current version's at is the file's mtime)", async () => {
  const env = await boot();
  writePlan(env, "x.md", V2);
  await planDecision(env, "s1", "t1", V1);
  const get = async () => (await api(env, "/api/sessions/s1/plan-versions?current=plan:x.md")).text();
  const a = await get();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(await get(), a);
  assert.equal((JSON.parse(a) as PlanVersionsResponse).versions.length, 2);
});
