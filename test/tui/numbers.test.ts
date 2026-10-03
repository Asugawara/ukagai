import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import type { Key } from "../../src/tui/keys.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { Q, V2_MD, decision, withExplanation } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
let now = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (now += 10)));
const answerOf = (e: ReturnType<typeof press>): string | undefined => {
  const a = e.find((x) => x.type === "answer");
  return a && a.type === "answer" ? (a.body["answers"] as Record<string, string>)[Q] : undefined;
};
const open = (md: string, over: Record<string, unknown> = {}): App => {
  const app = new App();
  app.upsert(decision({ ...withExplanation(md), ...over }), now);
  return app;
};

test("2 sends the second card at once, without moving first", () => {
  const app = open(V2_MD);
  assert.equal(answerOf(press(app, ch("2"))), "WebSocket");
});

test("1 sends the first card (the label as the agent wrote it)", () => {
  assert.equal(answerOf(press(open(V2_MD), ch("1"))), "SSE (Recommended)");
});

test("irreversible: the first key moves the cursor and arms; the second sends (also Enter)", () => {
  const md = V2_MD.replace("reversibility: costly", "reversibility: irreversible");
  const a = open(md);
  assert.deepEqual(press(a, ch("2")), []);
  assert.equal(a.view(now).cursor, 1);
  assert.ok(a.view(now).notice);
  assert.equal(answerOf(press(a, ch("2"))), "WebSocket");
  const b = open(md);
  press(b, ch("2"));
  assert.equal(answerOf(press(b, enter)), "WebSocket");
  // arming 2 then pressing 1 does not send 1
  const c = open(md);
  press(c, ch("2"));
  assert.deepEqual(press(c, ch("1")), []);
});

test("a card whose risk says it cannot be undone is heavy too", () => {
  const md = V2_MD.replace("Adds a dependency.", "It cannot be undone (irreversible).");
  const a = open(md);
  assert.deepEqual(press(a, ch("2")), []);
  assert.equal(answerOf(press(a, ch("2"))), "WebSocket");
});

test("while typing, a digit is text; in a picker it does nothing", () => {
  const a = open(V2_MD);
  press(a, ch("i"), ch("1"));
  assert.equal(a.mode, "input");
  assert.deepEqual(press(a, ch("2")), []);
  const n = open(V2_MD);
  press(n, ch("n"));
  assert.deepEqual(press(n, ch("1")), []);
  const c = open(V2_MD);
  press(c, ch("x"));
  assert.deepEqual(press(c, ch("1")), []);
});

test("plan: digits are ignored; a number with no card (7 of 2) is ignored", () => {
  const p = new App();
  p.upsert({ ...decision(), kind: "approve_plan", request: { plan: "# P\n\n1. x\n" } } as never, now);
  assert.deepEqual(press(p, ch("1")), []);
  assert.deepEqual(press(open(V2_MD), ch("7")), []);
});

test("cards carry a dim number and the hint lists 1-9", () => {
  const app = open(V2_MD);
  const text = stripAnsi(renderFrame(app.view(now), { cols: 160, rows: 70 }).text);
  assert.match(text, /1 ▸ ● SSE/);
  assert.match(text, /2   ○ WebSocket/);
  assert.match(text, / 1-9 /);
});
