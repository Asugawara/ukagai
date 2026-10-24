// Ask (side questions): `a` opens the thread of the shown item's session (wide: it replaces the decision column; narrow: the whole screen),
// Enter sends { question, quote?, decision_id }, `aside.updated` entries render as they stream, Tab quotes the card / section under the cursor,
// Ctrl-X stops, Esc returns to the decision with the cursor where it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { App } from "../../src/tui/app.js";
import type { AsideEntry } from "../../src/contract.js";
import { KeyParser, type Key } from "../../src/tui/keys.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { decision, autoShowApp } from "./helpers.js";

const LONG = readFileSync(new URL("../gui/fixtures/long-plan.md", import.meta.url), "utf8");
const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const esc: Key = { name: "esc" };
const tab: Key = { name: "tab" };
const ctrlX: Key = { name: "ctrl-x" };
const down: Key = { name: "down" };
let clock = Date.parse("2026-10-24T12:00:00.000Z");
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (clock += 10)));
const type = (app: App, s: string) => press(app, ...[...s].map(ch));
const draw = (app: App, cols = 140, rows = 40): string => {
  let frame = renderFrame(app.view(clock), { cols, rows });
  if (app.syncFrame(frame, clock)) frame = renderFrame(app.view(clock), { cols, rows });
  return stripAnsi(frame.text);
};

const entry = (over: Partial<AsideEntry> = {}): AsideEntry => ({
  id: "e1", decision_id: "d1", question: "Why SSE?", answer: "", trace: [], status: "running", created_at: new Date(clock).toISOString(), ...over,
});

function question(): App {
  const app = autoShowApp();
  app.replacePending([decision()], clock);
  return app;
}

function plan(): App {
  const app = autoShowApp();
  app.replacePending([decision({ kind: "approve_plan", request: { plan: LONG, planFilePath: "/p" } } as never)], clock);
  return app;
}

test("a opens the thread: wide replaces the decision column, narrow takes the whole screen", () => {
  const app = question();
  const before = draw(app);
  assert.match(before, /a Ask/);
  assert.match(before, /Should notifications use SSE or WebSocket/);
  press(app, ch("a"));
  const wide = draw(app);
  assert.equal(app.mode, "aside");
  assert.match(wide, /Ask · not kept in the agent's conversation/);
  assert.match(wide, /Background/); // the explanation column stays
  assert.doesNotMatch(wide, /Decision/);
  const split = wide.split("\n")[3]!.indexOf("│");
  assert.equal(140 - split - 2, 70, "the thread takes half the width at 140 columns");
  assert.match(wide, /1 Why the recommendation\?/);
  assert.match(wide, /2 What if I pick «WebSocket»\?/);
  assert.match(wide, /3 What would change the recommendation\?/);
  assert.match(wide, /Enter send · Tab quote · PgUp\/PgDn scroll · Ctrl-X stop · Esc close/);
  const narrow = draw(app, 100);
  assert.doesNotMatch(narrow.split("\n")[0]!, /Should notifications/);
  assert.match(narrow.split("\n")[0]!, /Ask · not kept/);
  assert.match(narrow, /› ▏/);
});

test("typing + Enter sends the question with the decision id; empty Enter sends nothing", () => {
  const app = question();
  press(app, ch("a"));
  assert.deepEqual(press(app, enter), []);
  type(app, "Why SSE?");
  assert.match(draw(app), /› Why SSE\?▏/);
  assert.deepEqual(press(app, enter), [{ type: "aside_ask", sid: "s1", body: { question: "Why SSE?", decision_id: "d1" } }]);
  // not sent twice while the server has not answered
  assert.deepEqual(press(app, enter), []);
  app.asideAsked("s1", entry());
  assert.match(draw(app), /› ▏/);
});

test("a running entry shows Thinking…, then the trace and the streamed text with a trailing ●", () => {
  const app = question();
  press(app, ch("a"));
  app.asideUpdated("s1", entry());
  const t1 = draw(app);
  assert.match(t1, /Why SSE\? ▌/);
  assert.match(t1, /● Thinking…/);
  assert.match(t1, /Ctrl-X stop · PgUp\/PgDn scroll · Esc close/);
  app.asideUpdated("s1", entry({ trace: [{ kind: "read", label: "a.ts" }, { kind: "read", label: "b.ts" }] }));
  const t2 = draw(app);
  assert.doesNotMatch(t2, /Thinking…/);
  assert.match(t2, /● Read 2 files/);
  app.asideUpdated("s1", entry({ answer: "I recommend **SSE** because it is smaller.", trace: [{ kind: "read", label: "a.ts" }] }));
  assert.match(draw(app), /I recommend SSE because it is smaller\. ●/);
});

test("a done entry shows its usage; cost only when present", () => {
  const app = question();
  press(app, ch("a"));
  app.asideUpdated("s1", entry({ status: "done", answer: "Because.", usage: { input_tokens: 31002, output_tokens: 1000, cache_read_tokens: 31000, cost_usd: 0.004 } }));
  const text = draw(app);
  assert.doesNotMatch(text, /Because\. ●/);
  assert.match(text, /32k tokens · \$0\.004/);
  app.asideUpdated("s1", entry({ id: "e2", question: "More?", status: "done", answer: "No.", usage: { input_tokens: 10, output_tokens: 20 } }));
  assert.match(draw(app), /30 tokens(?! ·)/);
});

test("Enter while an entry runs does nothing; Ctrl-X sends the stop effect (only while running)", () => {
  const app = question();
  press(app, ch("a"));
  assert.deepEqual(press(app, ctrlX), []);
  app.asideUpdated("s1", entry());
  type(app, "again");
  assert.deepEqual(press(app, enter), []);
  assert.deepEqual(press(app, ctrlX), [{ type: "aside_stop", sid: "s1" }]);
  app.asideUpdated("s1", entry({ status: "cancelled", answer: "part" }));
  assert.match(draw(app), /Stopped/);
  assert.equal(press(app, enter).length, 1);
});

test("the KeyParser reads Ctrl-X and Ctrl-R", () => {
  assert.deepEqual(new KeyParser().feed("\x18\x12"), [ctrlX, { name: "ctrl-r" }]);
});

test("Tab quotes the option card under the cursor (question) and removes it again", () => {
  const app = question();
  press(app, down, ch("a"), tab);
  assert.match(draw(app), /Quote: 2 WebSocket \(Tab to remove\)/);
  type(app, "latency?");
  assert.deepEqual(press(app, enter), [
    { type: "aside_ask", sid: "s1", body: { question: "latency?", quote: { source: "option", text: "2 WebSocket" }, decision_id: "d1" } },
  ]);
  app.asideAsked("s1", entry({ quote: { source: "option", text: "2 WebSocket" }, question: "latency?" }));
  const text = draw(app);
  assert.doesNotMatch(text, /Quote:/);
  assert.match(text, /┃ 2 WebSocket/);
  press(app, tab);
  assert.match(draw(app), /Quote: 2 WebSocket/);
  press(app, tab);
  assert.doesNotMatch(draw(app), /Quote:/);
});

test("Tab quotes the plan section under the contents cursor (plan)", () => {
  const app = plan();
  press(app, ch("a"));
  assert.match(draw(app), /1 Which step is the riskiest\?/);
  press(app, tab);
  type(app, "why?");
  const [eff] = press(app, enter);
  assert.equal(eff?.type, "aside_ask");
  const body = (eff as { body: { quote?: { source: string; text: string } } }).body;
  assert.equal(body.quote?.source, "plan");
  assert.ok(body.quote!.text.length > 0);
});

test("a digit on an empty thread asks that suggestion", () => {
  const app = question();
  press(app, ch("a"));
  assert.deepEqual(press(app, ch("2")), [{ type: "aside_ask", sid: "s1", body: { question: "What if I pick «WebSocket»?", decision_id: "d1" } }]);
  // with text typed a digit is text
  const other = question();
  press(other, ch("a"), ch("x"), ch("2"));
  assert.match(draw(other), /› x2▏/);
});

test("Esc returns to the decision with the cursor unchanged; a running answer is there on reopening", () => {
  const app = question();
  press(app, down);
  const was = draw(app);
  press(app, ch("a"));
  app.asideUpdated("s1", entry({ answer: "partial" }));
  press(app, esc);
  assert.equal(app.mode, "normal");
  assert.equal(draw(app), was);
  press(app, ch("a"));
  assert.match(draw(app), /partial/);
});

test("in the thread every printable key is text, a first a and r included; only Esc closes", () => {
  const app = question();
  press(app, ch("a"), ch("a"), ch("r"));
  assert.equal(app.mode, "aside");
  assert.match(draw(app), /› ar▏/);
  press(app, esc);
  assert.equal(app.mode, "normal");
});

test("only the latest entry of a regenerate chain is shown; an error offers r to retry", () => {
  const app = question();
  press(app, ch("a"));
  app.asideUpdated("s1", entry({ id: "e1", status: "done", answer: "first answer" }));
  app.asideUpdated("s1", entry({ id: "e2", regenerate_of: "e1", status: "error", error: "timed out after 180 s" }));
  let text = draw(app);
  assert.doesNotMatch(text, /first answer/);
  assert.match(text, /timed out after 180 s/);
  assert.match(text, /Ctrl-R to retry/);
  assert.deepEqual(press(app, ch("r")), []); // r is text now
  press(app, { name: "backspace" });
  const [eff] = press(app, { name: "ctrl-r" });
  assert.deepEqual(eff, { type: "aside_ask", sid: "s1", body: { question: "Why SSE?", decision_id: "d1", regenerate_of: "e2" } });
  app.asideAsked("s1", entry({ id: "e3", regenerate_of: "e2", answer: "second answer" }));
  text = draw(app);
  assert.match(text, /second answer/);
  assert.doesNotMatch(text, /timed out/);
  // typing hides the retry hint
  const typing = question();
  press(typing, ch("a"));
  typing.asideUpdated("s1", entry({ status: "error", error: "boom" }));
  press(typing, ch("x"));
  assert.doesNotMatch(draw(typing), /Ctrl-R to retry/);
  assert.deepEqual(press(typing, { name: "ctrl-r" }).map((e) => e.type), ["aside_ask"]); // Ctrl-R retries whatever is typed
});

test("a separator with the decision title appears when the decision changes", () => {
  const app = question();
  press(app, ch("a"));
  app.asideUpdated("s1", entry({ id: "e1", status: "done", answer: "one", decision_title: "SSE or WebSocket" }));
  app.asideUpdated("s1", entry({ id: "e2", decision_id: "d2", decision_title: "Pick a queue", question: "Which one?", status: "done", answer: "two" }));
  assert.match(draw(app), /── Pick a queue ──/);
});

test("409 shows the running notice, 400 the reason; the typed text stays", () => {
  const app = question();
  press(app, ch("a"));
  type(app, "q");
  press(app, enter);
  app.asideFailed("s1", "running", 409, clock);
  assert.match(draw(app), /An answer is still running/);
  assert.match(draw(app), /› q▏/);
  assert.equal(press(app, enter).length, 1);
  app.asideFailed("s1", "no cwd for this session", 400, clock);
  assert.match(draw(app), /no cwd for this session/);
});

test("an unavailable thread shows the reason", async () => {
  const app = question();
  app.fetchAside = async () => ({ session_id: "s1", agent: "claude", available: false, unavailable_reason: "unknown session", entries: [] });
  press(app, ch("a"));
  await new Promise((r) => setTimeout(r, 5));
  assert.match(draw(app), /unknown session/);
});

test("ja strings", () => {
  const app = question();
  app.lang = "ja";
  press(app, ch("a"));
  const text = draw(app);
  assert.match(text, /質問 · 会話には残りません/);
  assert.match(text, /1 推奨の理由を詳しく/);
  app.asideUpdated("s1", entry());
  assert.match(draw(app), /考え中…/);
});

test("PgUp scrolls a long thread up and PgDn follows the bottom again", () => {
  const app = question();
  press(app, ch("a"));
  app.asideUpdated("s1", entry({ status: "done", answer: Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n\n") }));
  assert.match(draw(app), /line 79/);
  press(app, { name: "pgup" });
  const up = draw(app);
  assert.doesNotMatch(up, /line 79/);
  for (let i = 0; i < 40; i++) press(app, { name: "pgdn" });
  assert.match(draw(app), /line 79/);
});

test("render at 140 and 100 columns (for the report)", () => {
  const app = question();
  press(app, down, ch("a"), tab);
  app.asideUpdated("s1", entry({ id: "e0", status: "done", question: "What is the retry budget?", answer: "Three attempts.\n\n- first, 1 s\n- then 4 s", trace: [{ kind: "read", label: "a" }, { kind: "read", label: "b" }], usage: { input_tokens: 31002, output_tokens: 300, cache_read_tokens: 31000, cost_usd: 0.004 } }));
  app.asideUpdated("s1", entry({ id: "e1", quote: { source: "option", text: "2 WebSocket" }, question: "Is it two-way?", answer: "Yes, but you do not need it" }));
  type(app, "what about the cost?");
  if (process.env["ASIDE_DUMP"]) writeFileSync(process.env["ASIDE_DUMP"], `=== 140 cols ===\n${draw(app, 140, 24)}\n\n=== 100 cols ===\n${draw(app, 100, 24)}\n`);
  assert.match(draw(app, 100, 24), /what about the cost\?▏/);
});
