// POST /api/marks: auth, content type, PNG check, size caps, the folder a mark lands in, pruning
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { MARK_MAX_AGE_MS, MARK_MAX_FILES, markPathIn, pruneMarks } from "../../src/serve/marks.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-marks-"));
  roots.push(d);
  return d;
};

type Env = { h: ServeHandle; home: string; dataDir: string; url: string };
async function boot(): Promise<Env> {
  const home = tmp();
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  const dataDir = tmp();
  const h = await start({ port: 0, dataDir, home, recapPollMs: 60000 });
  handles.push(h);
  return { h, home, dataDir, url: `http://127.0.0.1:${h.port}` };
}
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size = 64) => Buffer.concat([PNG_HEAD, Buffer.alloc(size - PNG_HEAD.length, 7)]);
const post = (env: Env, body: unknown, o: { auth?: boolean; contentType?: string } = {}) =>
  fetch(env.url + "/api/marks", {
    method: "POST",
    headers: { ...(o.auth === false ? {} : { authorization: `Bearer ${env.h.token}` }), "content-type": o.contentType ?? "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const register = async (env: Env, sid: string, scratchpad?: string) => {
  const r = await fetch(env.url + "/api/decisions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      tool_use_id: "tu-" + sid,
      kind: "answer_question",
      session: { session_id: sid, cwd: "/w", transcript_path: join(env.home, ".claude", "projects", "p", `${sid}.jsonl`), ...(scratchpad ? { scratchpad_dir: scratchpad } : {}) },
      request: { questions: [{ question: "Which do you choose, A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
    }),
  });
  return ((await r.json()) as { id: string }).id;
};

test("401 without auth, 415 without JSON, 400 for a bad body, 400 for a non-PNG", async () => {
  const env = await boot();
  const id = await register(env, "s1");
  assert.equal((await post(env, { decision: id, png: png().toString("base64") }, { auth: false })).status, 401);
  assert.equal((await post(env, "x", { contentType: "text/plain" })).status, 415);
  assert.equal((await post(env, { png: png().toString("base64") })).status, 400, "neither decision nor plan");
  assert.equal((await post(env, { decision: id, plan: "a.md", png: png().toString("base64") })).status, 400, "both");
  assert.equal((await post(env, "not json")).status, 400);
  assert.equal((await post(env, { decision: id, png: Buffer.from("GIF89a-not-a-png").toString("base64") })).status, 400);
  assert.equal((await post(env, { decision: id, png: "!!not base64!!" })).status, 400);
  assert.equal((await post(env, { decision: "nope", png: png().toString("base64") })).status, 404);
});

test("413 over 4 MB decoded and over 6 MB of body", async () => {
  const env = await boot();
  const id = await register(env, "s1");
  const ok = await post(env, { decision: id, png: png(4 * 1024 * 1024).toString("base64") });
  assert.equal(ok.status, 200);
  assert.equal((await post(env, { decision: id, png: png(4 * 1024 * 1024 + 4096).toString("base64") })).status, 413);
  assert.equal((await post(env, { decision: id, png: png(6 * 1024 * 1024).toString("base64") })).status, 413);
});

test("the mark lands in the session's explanation folder (scratchpad, else the data dir's explain folder), mode 0600, 16 hex", async () => {
  const env = await boot();
  const sp = tmp();
  const id1 = await register(env, "s-sp", sp);
  const r1 = await post(env, { decision: id1, png: png().toString("base64") });
  assert.equal(r1.status, 200);
  const { id } = (await r1.json()) as { id: string };
  assert.match(id, /^[0-9a-f]{16}$/);
  const file = join(sp, "ukagai", "marks", `${id}.png`);
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const id2 = await register(env, "s-codex");
  const { id: id2m } = (await (await post(env, { decision: id2, png: png().toString("base64") })).json()) as { id: string };
  assert.ok(existsSync(join(env.dataDir, "explain", "s-codex", "marks", `${id2m}.png`)));
});

test("a plan whose session is unknown lands in <data-dir>/marks", async () => {
  const env = await boot();
  const r = await post(env, { plan: "lonely.md", png: png().toString("base64") });
  assert.equal(r.status, 200);
  const { id } = (await r.json()) as { id: string };
  assert.ok(existsSync(join(env.dataDir, "marks", `${id}.png`)));
  assert.equal((await post(env, { plan: "../x", png: png().toString("base64") })).status, 400);
});

test("markPathIn resolves an id in the first folder that has it, and nothing for a bad id", () => {
  const a = tmp();
  const b = tmp();
  writeFileSync(join(b, "0123456789abcdef.png"), "x");
  assert.equal(markPathIn([a, b], "0123456789abcdef"), join(b, "0123456789abcdef.png"));
  assert.equal(markPathIn([a], "0123456789abcdef"), undefined);
  assert.equal(markPathIn([a, b], "../../etc/passwd"), undefined);
});

test("pruning drops files older than 7 days and keeps at most 100 (the newest)", () => {
  const dir = tmp();
  const now = Date.now();
  const name = (i: number) => i.toString(16).padStart(16, "0") + ".png";
  for (let i = 0; i < 105; i++) {
    writeFileSync(join(dir, name(i)), "x");
    utimesSync(join(dir, name(i)), new Date(now - i * 1000), new Date(now - i * 1000));
  }
  writeFileSync(join(dir, name(1000)), "x");
  utimesSync(join(dir, name(1000)), new Date(now - MARK_MAX_AGE_MS - 60_000), new Date(now - MARK_MAX_AGE_MS - 60_000));
  writeFileSync(join(dir, "keep.txt"), "x");
  pruneMarks(dir, now);
  const left = readdirSync(dir).filter((f) => f.endsWith(".png"));
  assert.equal(left.length, MARK_MAX_FILES);
  assert.ok(left.includes(name(0)) && !left.includes(name(104)) && !left.includes(name(1000)));
  assert.ok(existsSync(join(dir, "keep.txt")));
});

test("each POST prunes its folder", async () => {
  const env = await boot();
  const dir = join(env.dataDir, "marks");
  mkdirSync(dir, { recursive: true });
  const old = join(dir, "aaaaaaaaaaaaaaaa.png");
  writeFileSync(old, "x");
  const t = new Date(Date.now() - MARK_MAX_AGE_MS - 60_000);
  utimesSync(old, t, t);
  assert.equal((await post(env, { plan: "lonely.md", png: png().toString("base64") })).status, 200);
  assert.equal(existsSync(old), false);
});
