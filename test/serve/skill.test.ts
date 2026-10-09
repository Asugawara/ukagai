// GET / PUT / DELETE /api/skill: the user's version of the skill, kept under <data-dir>/skill/
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_MAX_BYTES, type SkillView } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), `not in time: ${what}`);
}
const skillEvent = (env: { sse: string[] }) => env.sse.join("").split("\n\n").find((b) => b.startsWith("event: skill.updated"));

type Env = { h: ServeHandle; url: string; dir: string; source: string; sse: string[] };
async function boot(def: string | null = "line one\nline two\n"): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "ukagai-skillapi-"));
  roots.push(root);
  const dir = join(root, "data");
  const source = join(root, "SKILL.md");
  if (def !== null) writeFileSync(source, def);
  const h = await start({ port: 0, dataDir: dir, home: root, skillSource: source });
  handles.push(h);
  const sse: string[] = [];
  const res = await fetch(`http://127.0.0.1:${h.port}/api/stream`, { headers: { authorization: `Bearer ${h.token}` } });
  const reader = res.body!.getReader();
  void (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      sse.push(dec.decode(value));
    }
  })();
  await until(() => sse.join("").includes(": connected"), "the stream is connected"); // the hub's first line: the client is registered
  return { h, url: `http://127.0.0.1:${h.port}`, dir, source, sse };
}
const call = (env: Env, method: string, body?: unknown, o: { raw?: string; type?: string; auth?: boolean } = {}) =>
  fetch(`${env.url}/api/skill`, {
    method,
    headers: { ...(o.auth === false ? {} : { authorization: `Bearer ${env.h.token}` }), "content-type": o.type ?? "application/json" },
    body: o.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
const view = async (r: Response) => (await r.json()) as SkillView;

test("401 without credentials, on GET, PUT and DELETE", async () => {
  const env = await boot();
  for (const m of ["GET", "PUT", "DELETE"]) assert.equal((await call(env, m, m === "PUT" ? { text: "x" } : undefined, { auth: false })).status, 401, m);
});

test("GET with no custom version: the default, an empty diff of unchanged lines", async () => {
  const env = await boot();
  const r = await call(env, "GET");
  assert.equal(r.status, 200);
  const v = await view(r);
  assert.equal(v.default, "line one\nline two\n");
  assert.equal(v.custom, null);
  assert.equal(v.stale, false);
  assert.equal(v.baseVersion, null);
  assert.equal(v.changed, 0);
  assert.ok(v.diff.every((d) => d.kind === "same"));
  assert.equal(v.path, join(env.dir, "skill", "SKILL.md"), "the absolute path under --data-dir (shown by the Skill pane)");
});

test("PUT: 415 for a non-JSON body, 400 for empty / blank / missing / too big text; nothing is saved", async () => {
  const env = await boot();
  assert.equal((await call(env, "PUT", undefined, { raw: "text=x", type: "text/plain" })).status, 415);
  for (const body of [{ text: "" }, { text: "  \n\t " }, {}, { text: 5 }]) assert.equal((await call(env, "PUT", body)).status, 400, JSON.stringify(body));
  assert.equal((await call(env, "PUT", undefined, { raw: "{ nope" })).status, 400);
  assert.equal((await call(env, "PUT", { text: "x".repeat(SKILL_MAX_BYTES + 1) })).status, 400);
  // multi-byte characters count as bytes: 90,000 x 3 bytes is over the limit though under it in characters
  assert.equal((await call(env, "PUT", { text: "あ".repeat(90000) })).status, 400);
  assert.equal(existsSync(join(env.dir, "skill")), false);
  assert.equal((await call(env, "PUT", { text: "x".repeat(SKILL_MAX_BYTES) })).status, 200);
});

test("round trip: PUT saves the files and returns the view with a diff; GET returns the same; SSE skill.updated carries it", async () => {
  const env = await boot();
  const r = await call(env, "PUT", { text: "line one\nline 2\nline three\n" });
  assert.equal(r.status, 200);
  const v = await view(r);
  assert.equal(v.custom, "line one\nline 2\nline three\n");
  assert.equal(v.stale, false);
  assert.ok(v.baseVersion);
  assert.deepEqual(v.diff.filter((d) => d.kind !== "same").map((d) => `${d.kind}:${d.text}`), ["del:line two", "add:line 2", "add:line three"]);
  assert.equal(v.changed, v.diff.filter((d) => d.kind !== "same").length);
  assert.equal(v.path, join(env.dir, "skill", "SKILL.md"));
  assert.equal(readFileSync(join(env.dir, "skill", "SKILL.md"), "utf8"), v.custom);
  assert.equal(readFileSync(join(env.dir, "skill", "base.md"), "utf8"), "line one\nline two\n");
  assert.deepEqual(await view(await call(env, "GET")), v);
  await until(() => skillEvent(env) !== undefined, "skill.updated after PUT");
  const ev = skillEvent(env);
  assert.ok(ev, "skill.updated was broadcast");
  assert.deepEqual(JSON.parse(ev.split("data: ")[1]!), v);
});

test("stale: the shipped skill changed after the first save", async () => {
  const env = await boot();
  await call(env, "PUT", { text: "mine\n" });
  writeFileSync(env.source, "line one\nline two\nline three\n");
  assert.equal((await view(await call(env, "GET"))).stale, true);
});

test("DELETE goes back to the default, removes the directory, broadcasts skill.updated", async () => {
  const env = await boot();
  await call(env, "PUT", { text: "mine\n" });
  await until(() => skillEvent(env) !== undefined, "skill.updated after the first PUT");
  env.sse.length = 0;
  const r = await call(env, "DELETE");
  assert.equal(r.status, 200);
  const v = await view(r);
  assert.equal(v.custom, null);
  assert.equal(existsSync(join(env.dir, "skill")), false);
  await until(() => skillEvent(env) !== undefined, "skill.updated after DELETE");
  assert.equal(JSON.parse(skillEvent(env)!.split("data: ")[1]!).custom, null);
  assert.equal((await call(env, "DELETE")).status, 200); // nothing to remove is fine
});

test("an unreadable default: GET says default null with an empty diff; PUT is refused with 503 and saves nothing", async () => {
  const env = await boot(null);
  const v = await view(await call(env, "GET"));
  assert.deepEqual({ default: v.default, custom: v.custom, diff: v.diff, changed: v.changed }, { default: null, custom: null, diff: [], changed: 0 });
  assert.equal(v.path, join(env.dir, "skill", "SKILL.md"));
  assert.equal((await call(env, "PUT", { text: "mine\n" })).status, 503);
  assert.equal(existsSync(join(env.dir, "skill")), false);
});

test("a pair too big to diff gets an empty diff, not an error", async () => {
  const big = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const env = await boot(big);
  const mine = Array.from({ length: 2100 }, (_, i) => `mine ${i}`).join("\n") + "\n";
  const v = await view(await call(env, "PUT", { text: mine }));
  assert.equal(v.custom, mine);
  assert.deepEqual(v.diff, []);
});
