// TUI: the origin colour follows the repository, and the cursor landing on a text-box card opens the box at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import type { Decision } from "../../src/contract.js";
import type { Key } from "../../src/tui/keys.js";
import { readFileSync } from "node:fs";
import { PLANS_ANSI, repoAnsi, repoSlot } from "../../src/tui/model.js";
import { stripAnsi } from "../../src/tui/width.js";
import { renderFrame } from "../../src/tui/render.js";
import { V2_MD, decision, withExplanation } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const esc: Key = { name: "esc" };
const up: Key = { name: "up" };
const down: Key = { name: "down" };
let clock = Date.parse("2026-10-04T12:00:00.000Z");
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (clock += 10)));
const type = (app: App, text: string) => press(app, ...[...text].map(ch));
const T = (app: App) => app.view(clock);

const inRepo = (repo: string): Decision =>
  decision({ session: { session_id: "s1", cwd: `/Users/a/.herdr/worktrees/${repo}/feat-x`, transcript_path: "/x" }, ...withExplanation(V2_MD) });
const rawOf = (d: Decision): string => {
  const app = new App();
  app.upsert(d, clock);
  return renderFrame(app.view(clock), { cols: 140, rows: 40 }).text;
};

test("origin colour: the same repo always gets the same colour, different repos spread over the slots", () => {
  assert.equal(repoAnsi("ukagai"), repoAnsi("ukagai"));
  const slots = new Set(["ukagai", "whoknows", "awm", "dotfiles", "blog", "infra", "api", "web", "docs", "tools"].map(repoSlot));
  assert.ok(slots.size >= 6, `spread over ${slots.size} slots`);
  // two repos with different colours (found by search, so the test does not hard-code the hash)
  const names = ["ukagai", "whoknows", "awm", "dotfiles", "blog"];
  const other = names.find((n) => repoAnsi(n) !== repoAnsi("ukagai"))!;
  const a = rawOf(inRepo("ukagai"));
  const b = rawOf(inRepo(other));
  assert.ok(a.includes(`\x1b[1m${repoAnsi("ukagai")}ukagai`));
  assert.ok(b.includes(`\x1b[1m${repoAnsi(other)}${other}`));
  assert.notEqual(repoAnsi("ukagai"), repoAnsi(other));
  assert.equal(rawOf(inRepo("ukagai")), a, "stable between renders");
});

const FREE = 4; // 2 options + None of these + Can't answer this, then the free-text card

test("question: the cursor landing on the free-text card opens the box; Esc leaves it with the text", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), clock);
  press(app, ch("G"));
  assert.equal(T(app).cursor, FREE);
  assert.equal(app.mode, "input");
  type(app, "hello");
  press(app, esc);
  assert.equal(app.mode, "normal");
  assert.equal(T(app).free.text, "hello");
  press(app, up);
  assert.equal(app.mode, "normal");
  assert.equal(T(app).cursor, FREE - 1);
});

test("question: ↑ in an empty box walks to the neighbouring card; with text it does nothing", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), clock);
  press(app, ch("G"));
  type(app, "x");
  press(app, up);
  assert.equal(app.mode, "input");
  assert.equal(T(app).cursor, FREE);
  press(app, { name: "backspace" }, up);
  assert.equal(app.mode, "normal");
  assert.equal(T(app).cursor, FREE - 1);
  press(app, down);
  assert.equal(app.mode, "input");
});

test("question: Enter on the typed text sends it; i still opens the box", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), clock);
  press(app, ch("G"));
  type(app, "my own");
  const eff = press(app, enter);
  assert.equal((eff[0] as { body: { answers: Record<string, string> } }).body.answers["Should notifications use SSE or WebSocket?"], "my own");
  const b = new App();
  b.upsert(decision(withExplanation(V2_MD)), clock);
  press(b, ch("i"));
  assert.equal(b.mode, "input");
});

const checkpoint = (): Decision =>
  ({
    id: "ck1", kind: "checkpoint", tool_use_id: "checkpoint:s:1", session: { session_id: "s", cwd: "/Users/a/.herdr/worktrees/ukagai/feat-ck" },
    request: { recap: "Did a thing.", recap_at: "2026-10-04T11:50:00.000Z" }, context: {}, status: "pending", created_at: "2026-10-04T11:50:00.000Z",
  }) as Decision;

test("checkpoint: ↓ onto the instruction card opens the box; text + Enter sends; ↑ in an empty box moves on", () => {
  const app = new App();
  app.upsert(checkpoint(), clock);
  press(app, down);
  assert.equal(app.mode, "input");
  type(app, "bump it");
  press(app, esc);
  assert.equal(T(app).free.text, "bump it");
  press(app, down);
  assert.equal(app.mode, "normal");
  press(app, up);
  assert.equal(app.mode, "input", "back on the card: the box opens again with the kept text");
  assert.deepEqual(press(app, enter), [{ type: "answer", id: "ck1", body: { kind: "instruct", text: "bump it" } }]);
  const b = new App();
  b.upsert(checkpoint(), clock);
  press(b, down, up);
  assert.equal(b.mode, "normal");
  assert.equal(T(b).cursor, 0);
});

test("repo colour: each slot gets the ANSI colour nearest to its GUI hue, non-bright, never the same as the plain-bold branch", () => {
  const NEAR: Record<number, number> = { 238: 34, 265: 34, 292: 35, 319: 35, 346: 31, 13: 31, 40: 33, 67: 33, 94: 32, 121: 32, 148: 32, 175: 36 };
  const ANSI_HUE: Record<number, number> = { 31: 0, 33: 60, 32: 120, 36: 180, 34: 240, 35: 300 };
  const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  for (let slot = 0; slot < 12; slot++) {
    const hue = (238 + slot * 27) % 360;
    assert.ok(hue < 200 || hue > 235, `slot ${slot} hue ${hue} avoids the UI accent range`);
    assert.equal(NEAR[hue] !== undefined, true);
    const nearest = Object.entries(ANSI_HUE).sort((x, y) => dist(x[1], hue) - dist(y[1], hue))[0]![0];
    assert.equal(String(NEAR[hue]), nearest, `slot ${slot}`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) seen.add(repoAnsi(`repo-${i}`));
  for (const a of seen) assert.match(a, /^\x1b\[3[1-6]m$/);
});

test("the TUI and the GUI hash a repo name to the same slot (repoSlot extracted from public/app.js)", () => {
  const src = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
  const m = /const repoSlot = (\(name\) => \{[\s\S]*?\n\});/.exec(src);
  assert.ok(m, "repoSlot found in app.js");
  const gui = new Function(`return ${m![1]}`)() as (n: string) => number;
  for (const n of ["ukagai", "whoknows", "awm", "cc-switch", "日本語リポジトリ", "😀repo", "", "x".repeat(300), "a/b"]) assert.equal(gui(n), repoSlot(n), n);
  for (let i = 0; i < 2000; i++) { const n = Math.random().toString(36).slice(2) + String.fromCodePoint(0x3042 + (i % 80)); assert.equal(gui(n), repoSlot(n), n); }
});

test("plan files in the origin line are grey, not a repo colour", () => {
  assert.equal(PLANS_ANSI, "\x1b[90m");
});

test("input hints: a free / instruction box says Esc back; a note box keeps cancel", () => {
  const b = new App();
  b.upsert(decision(withExplanation(V2_MD)), clock);
  press(b, ch("i"));
  const hintOf = (app: App) => stripAnsi(renderFrame(app.view(clock), { cols: 140, rows: 40 }).text);
  assert.match(hintOf(b), /Enter send · Esc back/);
  const c = new App();
  c.upsert(checkpoint(), clock);
  press(c, ch("i"));
  assert.match(hintOf(c), /Esc back/);
  const n = new App();
  n.upsert(decision(withExplanation(V2_MD)), clock);
  press(n, ch("n"), ch("i"));
  assert.match(hintOf(n), /Esc cancel/);
});

test("plan approval: ↑ from Approve lands on the instruction card and opens the box; ↓ in the empty box leaves it (same rules as the free-text card)", () => {
  const app = new App();
  app.upsert(decision({ kind: "approve_plan", request: { plan: "# P\n\n## Scope and reversibility\n\nx", planFilePath: "/p" } } as never), clock);
  assert.equal(T(app).cursor, 1);
  assert.equal(app.mode, "normal");
  press(app, up);
  assert.equal(app.mode, "input");
  type(app, "x");
  press(app, down);
  assert.equal(app.mode, "input");
  press(app, { name: "backspace" }, down);
  assert.equal(app.mode, "normal");
  assert.equal(T(app).cursor, 1);
});
