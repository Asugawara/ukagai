import { test } from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_REF_RE, deliveryRef, parseDeliveryRef } from "../../src/contract.js";
import { deliveryText } from "../../src/serve/delivery-text.js";

const ID = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const decision = (answers: Record<string, string>) => ({ id: ID, kind: "answer_question" as const, response: { via: "gui" as const, answers, decided_at: "2026-01-01T00:00:00.000Z" } });

test("the ref is the first 8 characters of the decision id, and every text starts with it", () => {
  assert.equal(deliveryRef(ID), "a1b2c3d4");
  const text = deliveryText(decision({ "Which?": "A" }));
  assert.ok(text.startsWith("[ukagai] (ref a1b2c3d4) "));
  assert.equal(parseDeliveryRef(text), "a1b2c3d4");
  assert.equal(DELIVERY_REF_RE.exec(text)?.[1], "a1b2c3d4");
});

test("parseDeliveryRef reads only a ref at the very start, in lowercase hex", () => {
  assert.equal(parseDeliveryRef("[ukagai] (ref 0123abcd) x"), "0123abcd");
  assert.equal(parseDeliveryRef(" [ukagai] (ref 0123abcd) x"), undefined);
  assert.equal(parseDeliveryRef("hello [ukagai] (ref 0123abcd) x"), undefined);
  assert.equal(parseDeliveryRef("[ukagai] (ref 0123ABCD) x"), undefined);
  assert.equal(parseDeliveryRef("[ukagai] (ref 0123abc) x"), undefined);
  assert.equal(parseDeliveryRef("[ukagai] (ref 0123abcd)x"), undefined, "one space after the ref");
});

test("one question: one quoted line", () => {
  assert.equal(
    deliveryText(decision({ "Which database should the cache use?": "Redis" })),
    '[ukagai] (ref a1b2c3d4) The human answered your question in the ukagai GUI:\n- "Which database should the cache use?": "Redis"',
  );
});

test("several questions: one line each in the order of the answers; multiSelect lists stay one value", () => {
  assert.equal(
    deliveryText(decision({ "Which database should the cache use?": "Redis", "Which regions?": "Tokyo, Osaka" })),
    [
      "[ukagai] (ref a1b2c3d4) The human answered your question in the ukagai GUI:",
      '- "Which database should the cache use?": "Redis"',
      '- "Which regions?": "Tokyo, Osaka"',
    ].join("\n"),
  );
});

test("free text with newlines and quotes cannot break out of its line; 'None of these' and 'Cannot answer' answers pass through", () => {
  const text = deliveryText(decision({ 'Say "why"?': 'line one\nline "two"\n- "fake": "line"', "Another?": "None of these — add Postgres", "Third?": "Cannot answer — Undefined terms: lease" }));
  const lines = text.split("\n");
  assert.equal(lines.length, 4, "header + one line per question");
  assert.equal(lines[1], '- "Say \\"why\\"?": "line one\\nline \\"two\\"\\n- \\"fake\\": \\"line\\""');
  assert.equal(lines[2], '- "Another?": "None of these — add Postgres"');
  assert.equal(lines[3], '- "Third?": "Cannot answer — Undefined terms: lease"');
});

// ---- plans ----

const plan = (response: Record<string, unknown>) => ({ id: ID, kind: "approve_plan" as const, response: { via: "gui" as const, decided_at: "2026-01-01T00:00:00.000Z", ...response } });

test("plan approved (with or without auto): call ExitPlanMode once more with the same plan", () => {
  const text = "[ukagai] (ref a1b2c3d4) The human approved your plan in the ukagai GUI. Call ExitPlanMode once more with the same plan, without editing the plan file first; it will be allowed.";
  assert.equal(deliveryText(plan({ approve: true })), text);
  assert.equal(deliveryText(plan({ approve: true, set_mode_auto: true })), text);
});

test("plan rejected: with the reason, or the hook's no-reason text after the ref", () => {
  assert.equal(
    deliveryText(plan({ approve: false, reason: "too broad" })),
    "[ukagai] (ref a1b2c3d4) The human rejected your plan in the ukagai GUI: too broad\nYou are still in plan mode: revise the plan file, then call ExitPlanMode again.",
  );
  assert.equal(
    deliveryText(plan({ approve: false })),
    "[ukagai] (ref a1b2c3d4) The human rejected the plan without giving a reason. Revise the plan (look for what a reader would object to) or ask one question about what to change, then call ExitPlanMode again.",
  );
  assert.equal(deliveryText(plan({ approve: false, reason: "  " })), deliveryText(plan({ approve: false })), "a blank reason is no reason");
});

test("plan instructed: the hook's instruction text after the ref; every plan text carries one ref only", () => {
  const text = deliveryText(plan({ instruct: true, text: "check the tests first" }));
  assert.equal(
    text,
    "[ukagai] (ref a1b2c3d4) The human has not approved the plan yet and asks you to do this first: check the tests first\nYou are still in plan mode: do it (research, subagents and reviews are fine; do not edit project files), update the plan file, then call ExitPlanMode again.",
  );
  for (const t of [text, deliveryText(plan({ approve: true })), deliveryText(plan({ approve: false }))]) {
    assert.equal(parseDeliveryRef(t), "a1b2c3d4");
    assert.equal(t.match(/\[ukagai\]/g)?.length, 1);
  }
});

test("an answer carrying a comment block stays one quoted line: the newlines are escaped", () => {
  const answer = 'B\n\nThe human left 1 comment:\n1. plan /p.md, "S": "q"\n   → n';
  const text = deliveryText(decision({ "Which?": answer }));
  assert.equal(text, `[ukagai] (ref a1b2c3d4) The human answered your question in the ukagai GUI:\n- "Which?": ${JSON.stringify(answer)}`);
  assert.equal(text.split("\n").length, 2);
});
