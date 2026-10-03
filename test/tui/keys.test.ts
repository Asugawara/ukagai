import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyParser, interpret, type Action, type Key, type Kind, type Mode } from "../../src/tui/keys.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
function act(key: Key, o: { mode?: Mode; kind?: Kind; lastG?: number; now?: number } = {}) {
  return interpret(key, { mode: o.mode ?? "normal", kind: o.kind ?? "question", lastG: o.lastG ?? 0, now: o.now ?? 1000 });
}
const type = (key: Key, o?: Parameters<typeof act>[1]): Action["type"] | null => act(key, o).action?.type ?? null;

test("j, k and the arrows move", () => {
  assert.deepEqual(act(ch("j")).action, { type: "move", delta: 1 });
  assert.deepEqual(act(ch("k")).action, { type: "move", delta: -1 });
  assert.deepEqual(act({ name: "down" }).action, { type: "move", delta: 1 });
  assert.deepEqual(act({ name: "up" }).action, { type: "move", delta: -1 });
});

test("gg within a second goes to the top, G goes to the bottom", () => {
  const first = act(ch("g"), { now: 5000 });
  assert.equal(first.action, null);
  assert.equal(first.lastG, 5000);
  assert.equal(type(ch("g"), { lastG: 5000, now: 5500 }), "top");
  assert.equal(type(ch("g"), { lastG: 5000, now: 7000 }), null);
  assert.equal(type(ch("G")), "bottom");
});

test("Space / Enter / i / h / l / b / q", () => {
  assert.equal(type(ch(" ")), "toggle");
  assert.equal(type({ name: "enter" }), "submit");
  assert.equal(type(ch("i")), "free");
  assert.equal(type(ch("h")), "prev");
  assert.equal(type(ch("l")), "next");
  assert.equal(type(ch("b")), "list");
  assert.equal(type(ch("q")), "quit");
  assert.equal(type({ name: "ctrl-c" }), "quit");
});

test("y a n work for a plan and do nothing for a question", () => {
  assert.equal(type(ch("y"), { kind: "plan" }), "approve");
  assert.equal(type(ch("a"), { kind: "plan" }), null);
  assert.equal(type(ch("n"), { kind: "plan" }), "reject");
  assert.equal(type(ch("y")), null);
});

test("while typing, characters are input, Enter confirms and Esc cancels; q is a character too", () => {
  assert.deepEqual(act(ch("q"), { mode: "input" }).action, { type: "input-char", ch: "q" });
  assert.deepEqual(act(ch("あ"), { mode: "input" }).action, { type: "input-char", ch: "あ" });
  assert.equal(type({ name: "enter" }, { mode: "input" }), "input-confirm");
  assert.equal(type({ name: "esc" }, { mode: "input" }), "input-cancel");
  assert.equal(type({ name: "backspace" }, { mode: "input" }), "input-backspace");
  assert.equal(type({ name: "ctrl-c" }, { mode: "input" }), "quit");
});

test("the list uses j/k/Enter/Esc", () => {
  assert.equal(type(ch("j"), { mode: "list" }), "list-move");
  assert.equal(type({ name: "enter" }, { mode: "list" }), "list-pick");
  assert.equal(type({ name: "esc" }, { mode: "list" }), "list-close");
  assert.equal(type(ch("b"), { mode: "list" }), "list-close");
});

test("arrow escape sequences", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\x1b[A\x1b[B\x1b[C\x1b[D"), [{ name: "up" }, { name: "down" }, { name: "right" }, { name: "left" }]);
  assert.deepEqual(p.feed("\x1bOA"), [{ name: "up" }]);
  assert.deepEqual(p.feed("jk"), [ch("j"), ch("k")]);
});

test("a lone Esc is held and becomes esc on flush (after 30 ms); if more arrives it is an arrow", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\x1b"), []);
  assert.ok(p.hasPending);
  assert.deepEqual(p.flush(), [{ name: "esc" }]);
  assert.ok(!p.hasPending);
  // Split arrival
  assert.deepEqual(p.feed("\x1b"), []);
  assert.deepEqual(p.feed("[A"), [{ name: "up" }]);
  // Another key right after Esc
  assert.deepEqual(p.feed("\x1bj"), [{ name: "esc" }, ch("j")]);
});

test("Enter (CR), Backspace, Japanese text, Ctrl-D", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\r"), [{ name: "enter" }]);
  assert.deepEqual(p.feed("\x7f"), [{ name: "backspace" }]);
  assert.deepEqual(p.feed("日本"), [ch("日"), ch("本")]);
  assert.deepEqual(p.feed("\x04"), [{ name: "ctrl-d" }]);
});

test("SGR mouse: wheel up/down with coordinates; clicks and drags are ignored", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\x1b[<65;10;12M"), [{ name: "wheel", dir: "down", x: 10, y: 12 }]);
  assert.deepEqual(p.feed("\x1b[<64;100;3M"), [{ name: "wheel", dir: "up", x: 100, y: 3 }]);
  assert.deepEqual(p.feed("\x1b[<0;5;5M\x1b[<0;5;5m\x1b[<32;6;5M"), []);
  assert.deepEqual(p.feed("\x1b[<66;5;5M"), [{ name: "hwheel", dir: "left" }]);
  assert.deepEqual(p.feed("\x1b[<67;5;5M"), [{ name: "hwheel", dir: "right" }]);
  assert.deepEqual(p.feed("\x1b[H\x1b[F\x1b[1~\x1b[4~\x1bOH\x1bOF"), ["home", "end", "home", "end", "home", "end"].map((name) => ({ name })));
  // The vertical wheel works with modifiers too (Shift = +4)
  assert.deepEqual(p.feed("\x1b[<69;1;1M"), [{ name: "wheel", dir: "down", x: 1, y: 1 }]);
});

test("SGR mouse: a truncated sequence is held and completed by the next chunk, and following keys are still picked up", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\x1b[<65;1"), []);
  assert.ok(p.hasPending);
  assert.deepEqual(p.feed("0;12Mj"), [{ name: "wheel", dir: "down", x: 10, y: 12 }, { name: "char", ch: "j" }]);
});

test("with the background focused, ↑↓ jk scroll one row and gg / G go to the ends; Tab switches focus", () => {
  const ctx = { mode: "normal", kind: "question", focus: "background", lastG: 0, now: 100 } as const;
  assert.deepEqual(interpret({ name: "down" }, ctx).action, { type: "scroll", delta: 1, unit: "line" });
  assert.deepEqual(interpret({ name: "char", ch: "k" }, ctx).action, { type: "scroll", delta: -1, unit: "line" });
  assert.deepEqual(interpret({ name: "char", ch: "G" }, ctx).action, { type: "scroll-edge", to: "bottom" });
  const first = interpret({ name: "char", ch: "g" }, ctx);
  assert.equal(first.action, null);
  assert.deepEqual(interpret({ name: "char", ch: "g" }, { ...ctx, lastG: first.lastG, now: 200 }).action, { type: "scroll-edge", to: "top" });
  assert.deepEqual(interpret({ name: "tab" }, ctx).action, { type: "focus" });
  // With the decision focused, the cursor moves as before
  assert.deepEqual(interpret({ name: "down" }, { ...ctx, focus: "decision" }).action, { type: "move", delta: 1 });
});

test("PageUp / PageDown / Ctrl-U / Ctrl-D scroll half a screen", () => {
  const ctx = { mode: "normal", kind: "question", focus: "decision", lastG: 0, now: 0 } as const;
  for (const n of ["pgdn", "ctrl-d"] as const) assert.deepEqual(interpret({ name: n }, ctx).action, { type: "scroll", delta: 1, unit: "half" });
  for (const n of ["pgup", "ctrl-u"] as const) assert.deepEqual(interpret({ name: n }, ctx).action, { type: "scroll", delta: -1, unit: "half" });
});
