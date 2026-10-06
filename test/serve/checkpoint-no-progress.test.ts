import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../../src/contract.js";
import { Store } from "../../src/serve/store.js";

const roots: string[] = [];
const stores: Store[] = [];
after(() => {
  for (const s of stores) s.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Checkpoint created_at and event times are wall-clock ms: keep steps strictly apart */
const tick = () => sleep(8);

const SID = "sess-np";
const session = { session_id: SID, state: "idle" as const, last_event_at: new Date().toISOString(), cwd: "/w/proj", transcript_path: "/h/.claude/projects/p/sess-np.jsonl" };

function open(dir = mkdtempSync(join(tmpdir(), "ukagai-np-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  const emitted: string[] = [];
  const store = new Store({ dir, leaseGraceMs: 60_000, broadcast: (e) => emitted.push(e) });
  store.load();
  stores.push(store);
  return { store, dir, emitted };
}

const hookEvent = (store: Store, name: string, sid = SID) =>
  store.addEvent({ session_id: sid, transcript_path: session.transcript_path, cwd: "/w/proj", hook_event_name: name, received_at: new Date().toISOString() });

/** An event with extra fields (wakeup, tool_name) */
const evt = (store: Store, name: string, extra: Record<string, unknown> = {}) =>
  store.addEvent({ session_id: SID, transcript_path: session.transcript_path, cwd: "/w/proj", hook_event_name: name, received_at: new Date().toISOString(), ...extra });

/** A wake-up turn as a monitoring session shows it: the harness prompt, then Stop / Notification / SubagentStop */
async function wakeupTurn(store: Store, middle: () => Promise<void> | void = () => {}) {
  evt(store, "UserPromptSubmit", { wakeup: true });
  await tick();
  await middle();
  for (const n of ["Stop", "Notification", "SubagentStop"]) {
    evt(store, n);
    await tick();
  }
}

const question = (id: string) => ({
  tool_use_id: id,
  kind: "answer_question" as const,
  session: { session_id: SID, cwd: "/w/proj", transcript_path: session.transcript_path },
  request: { questions: [{ question: "Q?", header: "Q", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] },
});

const cps = (store: Store): Decision[] => store.list().filter((d) => d.kind === "checkpoint");

test("no activity since the last card: the next recap is skipped as no_progress and the first card stays pending", async () => {
  const { store, emitted } = open();
  const first = store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  assert.equal(first.created, true);
  await tick();
  const before = emitted.filter((e) => e === "decision.created").length;
  const second = store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z");
  assert.deepEqual({ created: second.created, skipped: second.skipped }, { created: false, skipped: "no_progress" });
  assert.equal(cps(store).length, 1);
  assert.equal(store.get(first.decision!.id)!.status, "pending");
  assert.equal(emitted.filter((e) => e === "decision.created").length, before);
});

test("a hook event between two recaps: the second card is created and the first superseded", async () => {
  const { store } = open();
  const first = store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  hookEvent(store, "PostToolUse");
  await tick();
  const second = store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z");
  assert.equal(second.created, true);
  assert.equal(store.get(first.decision!.id)!.status_reason, "superseded");
  assert.equal(second.decision!.status, "pending");
});

test("the human cancelled the first card and nothing happened: still skipped", async () => {
  const { store } = open();
  const first = store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  store.cancel(first.decision!.id, "dismissed");
  await tick();
  const second = store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z");
  assert.equal(second.skipped, "no_progress");
  assert.equal(cps(store).length, 1);
});

test("answered continue, then the reply typed into the terminal (UserPromptSubmit), then a recap: created", async () => {
  const { store } = open();
  const first = store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  store.submitAnswer(first.decision!.id, { kind: "checkpoint", answer: "continue" });
  await tick();
  assert.equal(store.createCheckpoint(session, "again", "2026-10-05T01:10:00.000Z").skipped, "no_progress");
  hookEvent(store, "UserPromptSubmit");
  await tick();
  const second = store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z");
  assert.equal(second.created, true);
  assert.equal(cps(store).length, 2);
});

test("a decision registered by the session's hook counts as activity", async () => {
  const { store } = open();
  store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  store.create(question("toolu_1"), {});
  await tick();
  assert.equal(store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").created, true);
});

test("after_stop wins over no_progress", async () => {
  const { store } = open();
  const first = store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  store.submitAnswer(first.decision!.id, { kind: "checkpoint", answer: "stop" });
  assert.equal(store.consumeInstruction(SID, "terminal")?.kind, "stop");
  await tick();
  const res = store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z");
  assert.equal(res.skipped, "after_stop");
  // Even with activity afterwards, until the next UserPromptSubmit the stop holds
  hookEvent(store, "PostToolUse");
  await tick();
  assert.equal(store.createCheckpoint(session, "third", "2026-10-05T02:00:00.000Z").skipped, "after_stop");
});

test("the first recap of a session is created even when the session had events", async () => {
  const { store } = open();
  hookEvent(store, "SessionStart");
  assert.equal(store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z").created, true);
});

test("setTerminal and answering are not activity", async () => {
  const { store } = open();
  hookEvent(store, "SessionStart");
  await tick();
  const first = store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  store.setTerminal(SID, "herdr:w1:p1");
  store.submitAnswer(first.decision!.id, { kind: "checkpoint", answer: "continue" });
  await tick();
  assert.equal(store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").skipped, "no_progress");
});

test("rebuilt from disk: no activity after the card keeps skipping; events after it allow a card", async () => {
  const a = open();
  hookEvent(a.store, "SessionStart");
  await tick();
  a.store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  const b = open(a.dir);
  assert.equal(b.store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").skipped, "no_progress");
  hookEvent(a.store, "PostToolUse");
  await tick();
  const c = open(a.dir);
  assert.equal(c.store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").created, true);
});

test("rebuilt from disk: a decision registered after the card counts as activity", async () => {
  const a = open();
  a.store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  a.store.create(question("toolu_2"), {});
  await tick();
  const b = open(a.dir);
  assert.equal(b.store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").created, true);
});

test("a Codex session is not subject to the rule", async () => {
  const { store } = open();
  store.createCheckpoint({ ...session, agent: "codex" }, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  assert.equal(store.createCheckpoint({ ...session, agent: "codex" }, "second", "2026-10-05T01:30:00.000Z").created, true);
});

// ---- wake-up turns ----

test("a wake-up turn (UserPromptSubmit wakeup, Stop, Notification, SubagentStop) between two recaps creates no card", async () => {
  const { store } = open();
  store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  await wakeupTurn(store);
  const second = store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z");
  assert.deepEqual({ created: second.created, skipped: second.skipped }, { created: false, skipped: "no_progress" });
  assert.equal(cps(store).length, 1);
  // and again, 30 minutes later: still nothing
  await wakeupTurn(store);
  assert.equal(store.createCheckpoint(session, "third", "2026-10-05T02:00:00.000Z").skipped, "no_progress");
});

test("the same wake-up turn with a PostToolUse of a file tool creates a card (Edit, Write, MultiEdit, NotebookEdit); Bash / Read do not", async () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    const { store } = open();
    store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
    await tick();
    await wakeupTurn(store, async () => {
      evt(store, "PostToolUse", { tool_name: tool });
      await tick();
    });
    assert.equal(store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").created, true, tool);
  }
  for (const tool of ["Bash", "Read", "Monitor"]) {
    const { store } = open();
    store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
    await tick();
    await wakeupTurn(store, async () => {
      evt(store, "PostToolUse", { tool_name: tool });
      await tick();
    });
    assert.equal(store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").skipped, "no_progress", tool);
  }
});

test("a decision registered in a wake-up turn counts as activity", async () => {
  const { store } = open();
  store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  await wakeupTurn(store, async () => {
    store.create(question("toolu_w"), {});
    await tick();
  });
  assert.equal(store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").created, true);
});

test("a human prompt after a wake-up turn counts as activity again", async () => {
  const { store } = open();
  store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  await wakeupTurn(store);
  evt(store, "UserPromptSubmit"); // typed by a human: no wakeup
  await tick();
  assert.equal(store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").created, true);
});

test("the wake-up flag is per session", async () => {
  const { store } = open();
  store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  store.addEvent({ session_id: "other", transcript_path: "/o", cwd: "/o", hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString(), wakeup: true });
  await tick();
  hookEvent(store, "PostToolUse");
  await tick();
  assert.equal(store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").created, true);
});

test("the wake-up flag survives a store reload (replayed events), and the wake-up turn is still not activity", async () => {
  const a = open();
  a.store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  evt(a.store, "UserPromptSubmit", { wakeup: true });
  await tick();
  const b = open(a.dir);
  evt(b.store, "Stop"); // arrives after the reload, still inside the wake-up turn
  await tick();
  assert.equal(b.store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").skipped, "no_progress");
  const c = open(a.dir);
  assert.equal(c.store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").skipped, "no_progress");
  // a Write after the reload still counts
  evt(c.store, "PostToolUse", { tool_name: "Write" });
  await tick();
  assert.equal(c.store.createCheckpoint(session, "third", "2026-10-05T02:00:00.000Z").created, true);
});

test("SessionEnd clears the wake-up flag: events of a resumed session count again", async () => {
  const { store } = open();
  store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  evt(store, "UserPromptSubmit", { wakeup: true });
  await tick();
  evt(store, "SessionEnd");
  await tick();
  evt(store, "SessionStart"); // resumed: no UserPromptSubmit in between
  await tick();
  assert.equal(store.createCheckpoint(session, "second", "2026-10-05T01:30:00.000Z").created, true);
});

// ---- a wake-up prompt is not the human speaking ----

test("a pending card survives a wake-up turn (same id, no new decision, no_progress); a human prompt still cancels it with new_prompt", async () => {
  const { store } = open();
  const first = store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  evt(store, "UserPromptSubmit", { wakeup: true });
  evt(store, "Stop");
  await tick();
  assert.equal(store.get(first.decision!.id)!.status, "pending"); // fails if the wake-up prompt runs cancelPending
  const again = store.createCheckpoint(session, "first", "2026-10-05T01:30:00.000Z");
  assert.deepEqual({ created: again.created, skipped: again.skipped }, { created: false, skipped: "no_progress" });
  assert.equal(cps(store).length, 1);
  assert.equal(cps(store)[0]!.id, first.decision!.id);
  evt(store, "UserPromptSubmit"); // the human
  const d = store.get(first.decision!.id)!;
  assert.deepEqual({ status: d.status, reason: d.status_reason }, { status: "cancelled", reason: "new_prompt" });
});

test("a delivered stop holds through a wake-up turn (after_stop); a human prompt lifts it", async () => {
  const { store } = open();
  const first = store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
  await tick();
  store.submitAnswer(first.decision!.id, { kind: "checkpoint", answer: "stop" });
  assert.equal(store.consumeInstruction(SID, "terminal")?.kind, "stop");
  await tick();
  evt(store, "UserPromptSubmit", { wakeup: true });
  evt(store, "PostToolUse", { tool_name: "Write" }); // activity, so only the stop can skip
  await tick();
  assert.equal(store.createCheckpoint(session, "second", "2026-10-05T02:00:00.000Z").skipped, "after_stop"); // fails if the wake-up prompt runs stoppedSessions.delete
  evt(store, "UserPromptSubmit"); // the human
  await tick();
  assert.equal(store.createCheckpoint(session, "third", "2026-10-05T02:30:00.000Z").created, true);
});

test("a queued stop survives a wake-up prompt and is delivered; a human prompt drops it", async () => {
  for (const wakeup of [true, false]) {
    const { store } = open();
    hookEvent(store, "UserPromptSubmit"); // working: a stop is queued, not a no-op
    await tick();
    const cp = store.createCheckpoint(session, "first", "2026-10-05T01:00:00.000Z");
    store.submitAnswer(cp.decision!.id, { kind: "checkpoint", answer: "stop" });
    evt(store, "UserPromptSubmit", wakeup ? { wakeup: true } : {});
    const ins = store.consumeInstruction(SID, "hook");
    if (wakeup) assert.equal(ins?.kind, "stop"); // fails if the wake-up prompt runs dropQueuedStop
    else assert.equal(ins, undefined);
  }
});
