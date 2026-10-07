// `ready`: a plan file is worth showing only when its session is known, not working, not asking in the terminal and has no decision pending (plus the Steps / Verification format when ukagai handed it to the session).
// It is computed by the server and re-announced (plan.updated) when it flips without the file changing.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, PlanSummary } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
const aborts: AbortController[] = [];
after(async () => {
  for (const a of aborts) a.abort();
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-plready-"));
  roots.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!cond()) {
    assert.ok(Date.now() < end, "condition not met in time");
    await sleep(20);
  }
}

const COMPLETE = [
  "# Plan",
  "",
  "## Scope and reversibility",
  "Reversibility: reversible",
  "Scope: file",
  "",
  "## Steps",
  "1. **Do it** [todo] `src/x.ts`",
  "",
  "## Risks",
  "Nothing outside the repo is touched.",
  "A revert undoes it.",
  "No data is migrated.",
  "No other service is called.",
  "",
  "## Verification",
  "- [ ] npm test",
  "",
].join("\n");
/** Not ukagai's headings (another plan format) */
const FREE_FORM = ["# Plan", "", "## Approach", "a", "b", "c", "d", "", "## Checks", "e", "f", "g", "h", ""].join("\n");

async function boot() {
  const home = tmp();
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  const dataDir = tmp();
  const h = await start({ port: 0, dataDir, home, planDebounceMs: 30, planPollMs: 100, recapPollMs: 60000 });
  handles.push(h);
  const url = `http://127.0.0.1:${h.port}`;
  const headers = { authorization: `Bearer ${h.token}`, "content-type": "application/json" };
  const api = (path: string, body?: unknown) => fetch(url + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const transcript = join(home, ".claude", "projects", "p", "s1.jsonl");
  writeFileSync(transcript, `{"type":"user","slug":"fox"}\n{"type":"assistant","slug":"fox"}\n`);
  const event = (name: string, escaped = false) => api("/api/events", { session_id: "s1", transcript_path: transcript, cwd: "/w", hook_event_name: name, received_at: new Date().toISOString(), ...(escaped ? { escaped_question: true } : {}) });
  const ac = new AbortController();
  aborts.push(ac);
  const updates: PlanSummary[] = [];
  const res = await fetch(`${url}/api/stream`, { headers, signal: ac.signal });
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
  /** ukagai handed its plan format to this session (the plan-context marker) */
  const marker = () => {
    mkdirSync(join(dataDir, "plan-context"), { recursive: true });
    writeFileSync(join(dataDir, "plan-context", "s1"), "");
  };
  const plan = (md: string) => writeFileSync(join(home, ".claude", "plans", "fox.md"), md);
  const listed = async () => ((await (await api("/api/plans")).json()) as { plans: PlanSummary[] }).plans.find((p) => p.name === "fox.md");
  const detail = async () => (await (await api("/api/plans/fox.md")).json()) as { ready: boolean };
  const ask = async () => {
    const r = await api("/api/decisions", {
      tool_use_id: "toolu_q",
      kind: "answer_question",
      session: { session_id: "s1", cwd: "/w", transcript_path: transcript },
      request: { questions: [{ question: "Which one, A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
    });
    return (await r.json()) as Decision;
  };
  return { h, home, marker, api, event, updates, plan, listed, detail, ask };
}

test("ready is false while the session is working and true after Stop; the flip is announced without a file change", async () => {
  const e = await boot();
  await e.event("UserPromptSubmit");
  e.plan(COMPLETE);
  await until(() => e.updates.some((u) => u.name === "fox.md"));
  assert.equal((await e.listed())!.ready, false, "working: the file is in flux");
  assert.equal((await e.detail()).ready, false);
  assert.equal(e.updates.at(-1)!.ready, false);
  const before = e.updates.length;
  await e.event("Stop"); // the file did not change
  await until(() => e.updates.length > before);
  const flip = e.updates.at(-1)!;
  assert.equal(flip.ready, true);
  assert.equal(flip.session_id, "s1");
  assert.equal((await e.listed())!.ready, true);
  assert.equal((await e.detail()).ready, true);
  // the agent works again: not ready, announced
  const n = e.updates.length;
  await e.event("UserPromptSubmit");
  await until(() => e.updates.length > n);
  assert.equal(e.updates.at(-1)!.ready, false);
});

test("no size threshold: an idle session with a tiny plan (1 section, 3 lines, no marker) is ready", async () => {
  const e = await boot();
  await e.event("Stop");
  e.plan("# Plan\n\n## Approach\n\nline one\nline two\nline three\n");
  await until(() => e.updates.some((u) => u.name === "fox.md" && u.ready));
  assert.equal((await e.listed())!.ready, true);
  assert.equal((await e.detail()).ready, true);
});

test("a Stop that ends with a question (escaped_question) is not ready; the next UserPromptSubmit + a Stop without a question is; both flips are announced", async () => {
  const e = await boot();
  e.plan("# Plan\n\n## Scope and reversibility\n\n(範囲の確定待ち。確定後に Steps / Risks / Verification を書く)\n");
  await e.event("Stop", true); // the agent asked in the terminal and waits there
  await until(() => e.updates.some((u) => u.name === "fox.md"));
  assert.equal((await e.listed())!.ready, false);
  assert.equal((await e.detail()).ready, false);
  assert.equal(e.updates.at(-1)!.ready, false);
  const n = e.updates.length;
  await e.event("UserPromptSubmit"); // the human answered: working (not ready either; nothing to announce)
  await e.event("Stop"); // no question this time
  await until(() => e.updates.length > n);
  assert.equal(e.updates.at(-1)!.ready, true);
  assert.equal((await e.listed())!.ready, true);
  // a new question flips it back
  const m = e.updates.length;
  await e.event("UserPromptSubmit");
  await e.event("Stop", true);
  await sleep(200);
  assert.equal((await e.listed())!.ready, false);
  assert.equal(e.updates.at(-1)!.ready, false);
  assert.ok(e.updates.length > m);
});

test("format: with the plan-context marker a plan without Steps / Verification is not ready; with it, or with no marker, it is", async () => {
  const e = await boot();
  e.marker();
  await e.event("Stop");
  e.plan(FREE_FORM);
  await until(() => e.updates.some((u) => u.name === "fox.md"));
  const p = (await e.listed())!;
  assert.equal(p.format_ok, false);
  assert.equal(p.ready, false, "ukagai asked for Steps / Verification and the file has neither");
  assert.equal((await e.detail()).ready, false);
  const n = e.updates.length;
  e.plan(COMPLETE);
  await until(() => e.updates.length > n);
  assert.equal(e.updates.at(-1)!.ready, true);
  assert.equal((await e.listed())!.format_ok, true);
});

test("format: without the marker (the session never got ukagai's rules) any plan is ready", async () => {
  const e = await boot();
  await e.event("Stop");
  e.plan(FREE_FORM);
  await until(() => e.updates.some((u) => u.name === "fox.md" && u.ready));
  const p = (await e.listed())!;
  assert.equal(p.format_ok, false);
  assert.equal(p.ready, true);
  assert.equal((await e.detail()).ready, true);
});

test("ready is false while a decision of the session is pending and true after it is answered (announced both ways)", async () => {
  const e = await boot();
  await e.event("Stop");
  e.plan(COMPLETE);
  await until(() => e.updates.some((u) => u.name === "fox.md" && u.ready));
  const n = e.updates.length;
  const d = await e.ask();
  await until(() => e.updates.length > n);
  assert.equal(e.updates.at(-1)!.ready, false, "the human is asked something first");
  assert.equal((await e.listed())!.ready, false);
  const m = e.updates.length;
  const r = await e.api(`/api/decisions/${d.id}/answer`, { answers: { "Which one, A or B?": "A" } });
  assert.equal(r.status, 200);
  await until(() => e.updates.length > m);
  assert.equal(e.updates.at(-1)!.ready, true);
  assert.equal((await e.listed())!.ready, true);
});

test("ready is false without a session (no transcript carries the plan's slug)", async () => {
  const e = await boot();
  await e.event("Stop");
  writeFileSync(join(e.home, ".claude", "plans", "ghost.md"), COMPLETE);
  await until(() => e.updates.some((u) => u.name === "ghost.md"));
  const ghost = ((await (await e.api("/api/plans")).json()) as { plans: PlanSummary[] }).plans.find((p) => p.name === "ghost.md")!;
  assert.equal(ghost.session_id, undefined);
  assert.equal(ghost.ready, false);
  assert.equal(e.updates.find((u) => u.name === "ghost.md")!.ready, false);
});

test("nothing is announced when ready did not change (other session events)", async () => {
  const e = await boot();
  await e.event("Stop");
  e.plan(COMPLETE);
  await until(() => e.updates.some((u) => u.name === "fox.md" && u.ready));
  await sleep(300);
  const n = e.updates.length;
  await e.event("PreToolUse");
  await e.event("Stop");
  await sleep(300);
  assert.equal(e.updates.length, n);
});
