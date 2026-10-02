import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyParser, interpret, type Action, type Key, type Kind, type Mode } from "../../src/tui/keys.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
function act(key: Key, o: { mode?: Mode; kind?: Kind; lastG?: number; now?: number } = {}) {
  return interpret(key, { mode: o.mode ?? "normal", kind: o.kind ?? "question", lastG: o.lastG ?? 0, now: o.now ?? 1000 });
}
const type = (key: Key, o?: Parameters<typeof act>[1]): Action["type"] | null => act(key, o).action?.type ?? null;

test("j k と矢印は移動", () => {
  assert.deepEqual(act(ch("j")).action, { type: "move", delta: 1 });
  assert.deepEqual(act(ch("k")).action, { type: "move", delta: -1 });
  assert.deepEqual(act({ name: "down" }).action, { type: "move", delta: 1 });
  assert.deepEqual(act({ name: "up" }).action, { type: "move", delta: -1 });
});

test("gg は 1 秒以内の 2 回目で先頭、G は末尾", () => {
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

test("計画は y a n、質問では効かない", () => {
  assert.equal(type(ch("y"), { kind: "plan" }), "approve");
  assert.equal(type(ch("a"), { kind: "plan" }), "approve-auto");
  assert.equal(type(ch("n"), { kind: "plan" }), "reject");
  assert.equal(type(ch("y")), null);
});

test("入力中は文字が入力になり、Enter 確定 / Esc 取りやめ。q も文字", () => {
  assert.deepEqual(act(ch("q"), { mode: "input" }).action, { type: "input-char", ch: "q" });
  assert.deepEqual(act(ch("あ"), { mode: "input" }).action, { type: "input-char", ch: "あ" });
  assert.equal(type({ name: "enter" }, { mode: "input" }), "input-confirm");
  assert.equal(type({ name: "esc" }, { mode: "input" }), "input-cancel");
  assert.equal(type({ name: "backspace" }, { mode: "input" }), "input-backspace");
  assert.equal(type({ name: "ctrl-c" }, { mode: "input" }), "quit");
});

test("一覧は j/k/Enter/Esc", () => {
  assert.equal(type(ch("j"), { mode: "list" }), "list-move");
  assert.equal(type({ name: "enter" }, { mode: "list" }), "list-pick");
  assert.equal(type({ name: "esc" }, { mode: "list" }), "list-close");
  assert.equal(type(ch("b"), { mode: "list" }), "list-close");
});

test("矢印のエスケープ列", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\x1b[A\x1b[B\x1b[C\x1b[D"), [{ name: "up" }, { name: "down" }, { name: "right" }, { name: "left" }]);
  assert.deepEqual(p.feed("\x1bOA"), [{ name: "up" }]);
  assert.deepEqual(p.feed("jk"), [ch("j"), ch("k")]);
});

test("Esc 単独は保留され、flush(30 ms 後)で esc になる。続きが来れば矢印", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\x1b"), []);
  assert.ok(p.hasPending);
  assert.deepEqual(p.flush(), [{ name: "esc" }]);
  assert.ok(!p.hasPending);
  // 分割到着
  assert.deepEqual(p.feed("\x1b"), []);
  assert.deepEqual(p.feed("[A"), [{ name: "up" }]);
  // Esc のあとに別のキー
  assert.deepEqual(p.feed("\x1bj"), [{ name: "esc" }, ch("j")]);
});

test("Enter(CR)・Backspace・日本語・Ctrl-D", () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed("\r"), [{ name: "enter" }]);
  assert.deepEqual(p.feed("\x7f"), [{ name: "backspace" }]);
  assert.deepEqual(p.feed("日本"), [ch("日"), ch("本")]);
  assert.deepEqual(p.feed("\x04"), [{ name: "ctrl-d" }]);
});
