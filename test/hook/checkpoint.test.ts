import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { buildHookEntries } from "../../src/settings/hooks-spec.js";
import { dataDirWithToken, fakeServer, json, runHook, type Fake, type Handler } from "./helpers.js";

const input = (tool = "Bash", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, cwd: "/w", ...extra });
const args = (f: { url: string }, d: string) => ["--checkpoint", "--server", f.url, "--data-dir", d];

async function withServer<T>(handler: Handler, fn: (f: Fake, d: string) => Promise<T>): Promise<T> {
  const f = await fakeServer(handler);
  try {
    return await fn(f, dataDirWithToken());
  } finally {
    await f.close();
  }
}
const ins = (kind: "instruct" | "stop", text: string): Handler => (req, res) =>
  req.path === "/api/sessions/s-1/instruction" ? json(res, 200, { instruction: { decision_id: "d1", kind, text, created_at: new Date().toISOString() } }) : false;

test("instruct: additionalContext with the exact wording, no decision, tool runs", async () => {
  await withServer(ins("instruct", "do the migration next"), async (f, d) => {
    const r = await runHook(args(f, d), input());
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "[ukagai] The human read your progress recap and says: do the migration next\nFollow this before continuing; do not ask for confirmation of this message.",
      },
    });
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/sessions/s-1/instruction"]);
    assert.equal(f.calls[0]?.auth, "Bearer test-token");
  });
});

test("stop: deny with the reason (+ text when given)", async () => {
  await withServer(ins("stop", ""), async (f, d) => {
    const out = JSON.parse((await runHook(args(f, d), input("Edit"))).stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.equal(
      out.permissionDecisionReason,
      "[ukagai] The human read your progress recap and asked you to stop. Do not run more tools: write a short status (done / in progress / next) and end your turn.",
    );
  });
  await withServer(ins("stop", "wait for review"), async (f, d) => {
    const out = JSON.parse((await runHook(args(f, d), input("Write"))).stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /asked you to stop\..*\nThe human adds: wait for review$/s);
  });
});

test("404: prints nothing, logs nothing; unknown tool names are fine", async () => {
  await withServer(() => false, async (f, d) => {
    for (const tool of ["Bash", "Agent", "SomethingNew"]) {
      const r = await runHook(args(f, d), input(tool));
      assert.equal(r.code, 0);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, "");
    }
    assert.equal(f.calls.length, 3);
  });
});

test("decision tools and other events are ignored without a request", async () => {
  await withServer(ins("stop", ""), async (f, d) => {
    for (const raw of [input("AskUserQuestion"), input("ExitPlanMode"), input("Bash", { hook_event_name: "PostToolUse" }), input("Bash", { session_id: undefined })]) {
      const r = await runHook(args(f, d), raw);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, "");
    }
    assert.equal(f.calls.length, 0);
  });
});

test("closed port and a server that hangs: nothing printed, exit 0, within 1.5 s", async () => {
  const f = await fakeServer();
  const dead = f.url;
  await f.close();
  const d = dataDirWithToken();
  let r = await runHook(["--checkpoint", "--server", dead, "--data-dir", d], input());
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.ok(r.ms < 1500, `ms=${r.ms}`);
  await withServer(() => true, async (h, dd) => {
    r = await runHook(args(h, dd), input());
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(r.ms < 1500, `hang ms=${r.ms}`);
  });
});

test("buildHookEntries: the checkpoint group sits next to the decision group", () => {
  const e = buildHookEntries({ invocation: { command: "node", prefix: ["cli.js"] }, timeout: 3600, observe: false });
  assert.equal(e["PreToolUse"]?.length, 3);
  assert.equal(e["PreToolUse"]?.[0]?.matcher, "AskUserQuestion|ExitPlanMode");
  const g = e["PreToolUse"]![1]!;
  assert.equal(g.matcher, "Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|TodoWrite");
  assert.equal(g.hooks[0]?.timeout, 3);
  assert.equal(g.hooks[0]?.statusMessage, undefined);
  assert.equal(g.hooks[0]?.async, undefined);
  assert.ok(g.hooks[0]?.args.includes("--checkpoint"));
  assert.equal(buildHookEntries({ invocation: { command: "node", prefix: ["cli.js"] }, timeout: 3600, observe: true })["PreToolUse"]?.length, 1);
});

let h: ServeHandle | undefined;
const roots: string[] = [];
after(async () => {
  await h?.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

test("integration with the real server: instruct delivered once, then nothing", async () => {
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), "ukagai-ckh-"));
    roots.push(d);
    return d;
  };
  const home = mk();
  const dataDir = mk();
  const tdir = join(home, ".claude", "projects", "p");
  mkdirSync(tdir, { recursive: true });
  const transcript = join(tdir, "s-1.jsonl");
  writeFileSync(transcript, "");
  h = await start({ port: 0, dataDir, home, recapPollMs: 100 });
  const url = `http://127.0.0.1:${h.port}`;
  const api = (path: string, body?: unknown) =>
    fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${h!.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ev = await api("/api/events", { session_id: "s-1", transcript_path: transcript, cwd: "/w", hook_event_name: "SessionStart", received_at: new Date().toISOString() });
  assert.equal(ev.status, 204);
  const at = new Date().toISOString();
  const c = await api("/api/decisions", { tool_use_id: `checkpoint:s-1:${at}`, kind: "checkpoint", session: { session_id: "s-1", cwd: "/w", transcript_path: transcript }, request: { recap: "Done A; next B.", recap_at: at } });
  assert.ok(c.status === 200 || c.status === 201, `seed ${c.status} ${await c.clone().text()}`);
  const id = ((await c.json()) as { id: string }).id;
  const a = await api(`/api/decisions/${id}/answer`, { kind: "instruct", text: "go with B" });
  assert.equal(a.status, 200);
  const hargs = ["--checkpoint", "--server", url, "--data-dir", dataDir];
  const first = await runHook(hargs, input());
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /says: go with B\n/);
  const second = await runHook(hargs, input());
  assert.equal(second.stdout, "");
});
