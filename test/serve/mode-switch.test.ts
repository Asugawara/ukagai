import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODE_SWITCH_TTL_MS } from "../../src/contract.js";
import { Store } from "../../src/serve/store.js";

const roots: string[] = [];
const stores: Store[] = [];
after(() => {
  mock.restoreAll();
  for (const s of stores) s.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const SID = "sess-ms";
const session = { session_id: SID, cwd: "/w/proj", transcript_path: "/h/.claude/projects/p/sess-ms.jsonl" };

function open() {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-ms-"));
  roots.push(dir);
  const store = new Store({ dir, leaseGraceMs: 60_000, broadcast: () => {} });
  store.load();
  stores.push(store);
  return store;
}

const plan = (toolUseId: string, text = toolUseId) =>
  ({ tool_use_id: toolUseId, kind: "approve_plan" as const, session, request: { plan: text } });

/** Create an approve_plan decision and approve it with "auto" */
function approveAuto(store: Store, toolUseId: string): void {
  const { decision } = store.create(plan(toolUseId), {});
  store.submitAnswer(decision.id, { kind: "approve", set_mode_auto: true });
}

const endEvent = () =>
  ({ session_id: SID, transcript_path: session.transcript_path, cwd: session.cwd, hook_event_name: "SessionEnd", received_at: new Date().toISOString() });

test("the TTL is 60 minutes: pending just before, gone just after (fake clock)", () => {
  assert.equal(MODE_SWITCH_TTL_MS, 60 * 60 * 1000);
  const store = open();
  const t0 = Date.now();
  const now = mock.method(Date, "now", () => t0);
  approveAuto(store, "toolu_ttl");
  const got = store.getModeSwitch(SID);
  assert.equal(got.pending, true);
  if (got.pending) assert.equal(got.expires_at, new Date(t0 + 60 * 60 * 1000).toISOString());
  now.mock.mockImplementation(() => t0 + 59 * 60 * 1000);
  assert.equal(store.getModeSwitch(SID).pending, true);
  now.mock.mockImplementation(() => t0 + 60 * 60 * 1000 + 1);
  assert.equal(store.getModeSwitch(SID).pending, false);
  assert.equal(store.consumeModeSwitch(SID), false);
  now.mock.restore();
});

test("SessionEnd clears the record; consume returns false afterwards", () => {
  const store = open();
  approveAuto(store, "toolu_end");
  assert.equal(store.getModeSwitch(SID).pending, true);
  store.addEvent(endEvent());
  assert.equal(store.getModeSwitch(SID).pending, false);
  assert.equal(store.consumeModeSwitch(SID), false);
});

test("a new approve_plan decision for the same session clears the old record", () => {
  const store = open();
  approveAuto(store, "toolu_old");
  assert.equal(store.getModeSwitch(SID).pending, true);
  store.create(plan("toolu_new", "another plan"), {});
  assert.equal(store.getModeSwitch(SID).pending, false);
  assert.equal(store.consumeModeSwitch(SID), false);
});

test("a question decision does not clear the record; consume works once", () => {
  const store = open();
  approveAuto(store, "toolu_keep");
  store.create(
    { tool_use_id: "toolu_q", kind: "answer_question", session, request: { questions: [{ question: "A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] } },
    {},
  );
  assert.equal(store.getModeSwitch(SID).pending, true);
  assert.equal(store.consumeModeSwitch(SID), true);
  assert.equal(store.consumeModeSwitch(SID), false);
});
