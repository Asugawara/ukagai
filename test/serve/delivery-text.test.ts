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
