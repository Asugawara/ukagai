import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import type { Key } from "../../src/tui/keys.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { BLOCKER_Q, Q, V2_MD, blockerDecision, decision, withExplanation } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
let t = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (t += 10)));

test("single select: starts on the recommended option, j moves = selects, Enter sends answers (original label)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  assert.deepEqual(press(app, enter), [
    { type: "answer", id: "d1", body: { answers: { [Q]: "SSE (Recommended)" } } },
  ]);
});

test("j moves to WebSocket and sends; a double submit is ignored", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  const eff = press(app, ch("j"), enter);
  assert.equal((eff[0] as { body: { answers: Record<string, string> } }).body.answers[Q], "WebSocket");
  assert.deepEqual(press(app, enter), []);
});

test("free text: i, type, Enter to confirm, Enter to send (replaces the selection)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  const eff = press(app, ch("i"), ch("あ"), ch("い"), { name: "backspace" }, ch("x"), enter, enter);
  assert.deepEqual((eff[0] as { body: unknown }).body, { answers: { [Q]: "あx" } });
});

test("Esc in free text cancels (unconfirmed text is discarded)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  press(app, ch("i"), ch("z"), { name: "esc" });
  assert.equal(app.mode, "normal");
  assert.equal(app.view(t).free.text, "");
});

test("multi select: Space toggles, answers are joined with a comma", () => {
  const d = decision({
    request: { questions: [{ question: "Which one?", header: "h", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] },
  } as never);
  const app = new App();
  app.upsert(d, t);
  assert.deepEqual(press(app, enter), []); // cannot send with nothing selected
  const eff = press(app, ch(" "), ch("j"), ch("j"), ch(" "), enter);
  assert.deepEqual((eff[0] as { body: unknown }).body, { answers: { "Which one?": "A, C" } });
});

test("gg / G go to the top / bottom (the bottom is free text)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  press(app, ch("G"));
  assert.equal(app.view(t).cursor, 4, "cards, None of these, Can't answer this, free text");
  press(app, ch("g"), ch("g"));
  assert.equal(app.view(t).cursor, 0);
});

test("plan: y approves, a approves with auto, n asks for a reason then Enter rejects", () => {
  const plan = decision({ kind: "approve_plan", request: { plan: "# P\n\n## Scope and reversibility\n\nx", planFilePath: "/p" } } as never);
  let app = new App();
  app.upsert(plan, t);
  assert.deepEqual(press(app, ch("y")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: false } }]);
  app = new App();
  app.upsert(plan, t);
  assert.deepEqual(press(app, ch("a")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }]);
  app = new App();
  app.upsert(plan, t);
  assert.deepEqual(press(app, ch("n"), enter), []); // empty reason
  assert.deepEqual(press(app, ch("n"), ch("o"), enter), [{ type: "answer", id: "d1", body: { approve: false, reason: "no" } }]);
});

test("h/l switch pending, pick from the b list, move on to the next pending after answering", () => {
  const app = new App();
  const mk = (id: string, at: string) => decision({ id, tool_use_id: id, created_at: at } as never);
  app.upsert(mk("a", "2026-10-02T00:00:00Z"), t);
  app.upsert(mk("b", "2026-10-02T00:00:01Z"), t);
  assert.equal(app.shownId, "a");
  press(app, ch("l"));
  assert.equal(app.shownId, "b");
  press(app, ch("h"));
  assert.equal(app.shownId, "a");
  press(app, ch("b"), ch("j"), enter);
  assert.equal(app.shownId, "b");
  app.answered({ ...mk("b", "2026-10-02T00:00:01Z"), status: "answer_submitted" }, t);
  assert.equal(app.shownId, "a");
  assert.equal(app.view(t).toast, "Delivering…");
  app.upsert({ ...mk("b", "2026-10-02T00:00:01Z"), status: "answered" }, t + 10);
  assert.equal(app.view(t + 20).toast, "Delivered");
  assert.equal(app.view(t + 3000).toast, null);
});

test("a decision with 2 or more questions cannot be answered", () => {
  const d = decision({
    request: { questions: [
      { question: "a?", header: "h", options: [{ label: "x" }] },
      { question: "b?", header: "h", options: [{ label: "y" }] },
    ] },
  } as never);
  const app = new App();
  app.upsert(d, t);
  assert.deepEqual(press(app, enter), []);
  assert.match(app.model()!.unsupported ?? "", /GUI/);
});

test("blocker: Enter alone sends the Done option; c copies the first code block", () => {
  const app = new App();
  app.upsert(blockerDecision(), t);
  assert.deepEqual(press(app, ch("c")), [{ type: "copy", text: "gcloud auth login\ngcloud auth application-default login" }]);
  assert.deepEqual(press(app, enter), [
    { type: "answer", id: "d1", body: { answers: { [BLOCKER_Q]: "Done. Continue (Recommended)" } } },
  ]);
});

test("c does nothing for a non-blocker decision", () => {
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD)), t);
  assert.deepEqual(press(app, ch("c")), []);
});

// ---- scrolling ----

const LONG = V2_MD + "\n" + Array.from({ length: 80 }, (_, i) => `- row ${i}`).join("\n") + "\n";
const wheel = (dir: "up" | "down", x: number, y = 10): Key => ({ name: "wheel", dir, x, y });
const SIZE = { cols: 140, rows: 24 };

function longApp(): App {
  const app = new App();
  app.upsert(decision(withExplanation(LONG)), t);
  app.syncFrame(renderFrame(app.view(t), SIZE));
  return app;
}
const redraw = (app: App) => {
  const f = renderFrame(app.view(t), SIZE);
  app.syncFrame(f);
  return f;
};

test("wheel: the left column scrolls the background 3 rows, the right column scrolls the decision; both stop at the ends", () => {
  const app = longApp();
  assert.equal(app.scroll, 0);
  press(app, wheel("down", 10));
  assert.equal(app.scroll, 3);
  press(app, wheel("up", 10), wheel("up", 10));
  assert.equal(app.scroll, 0, "stops at the top");
  const f = redraw(app);
  for (let i = 0; i < 100; i++) press(app, wheel("down", 10));
  assert.equal(app.scroll, f.scrollMax, "stops at the bottom");
  // The right column (past split) does not move the background; nothing happens if the decision does not overflow
  const before = app.scroll;
  press(app, wheel("up", f.split + 5));
  assert.equal(app.scroll, before);
});

test("wheel: when the right column overflows it scrolls the decision, and moving the cursor goes back to following", () => {
  const app = longApp();
  const small = { cols: 140, rows: 14 };
  const f = renderFrame(app.view(t), small);
  app.syncFrame(f);
  assert.ok(f.rightMax > 0, "right column overflows");
  press(app, wheel("down", f.split + 5));
  assert.equal(app.rscroll, Math.min(f.rightMax, f.rightOff + 3));
  assert.equal(app.scroll, 0);
  press(app, ch("j"));
  assert.equal(app.rscroll, null);
});

test("PgDn / PgUp scroll half a screen, as do Ctrl-D / Ctrl-U; both stop at the ends", () => {
  const app = longApp();
  const f = redraw(app);
  const half = Math.floor(f.bodyRows / 2);
  press(app, { name: "pgdn" });
  assert.equal(app.scroll, half);
  press(app, { name: "ctrl-d" });
  assert.equal(app.scroll, half * 2);
  press(app, { name: "pgup" }, { name: "ctrl-u" }, { name: "pgup" });
  assert.equal(app.scroll, 0);
  for (let i = 0; i < 50; i++) press(app, { name: "pgdn" });
  assert.equal(app.scroll, f.scrollMax);
});

test("Tab switches focus; with the background focused j/k scroll one row, G / gg go to the ends, and the decision cursor does not move", () => {
  const app = longApp();
  const cursorBefore = app.view(t).cursor;
  assert.equal(app.focus, "decision");
  press(app, { name: "tab" });
  assert.equal(app.focus, "background");
  const f = redraw(app);
  assert.match(stripAnsi(f.lines.find((l) => l.includes("Background"))!), /Background/);
  assert.ok(f.lines.some((l) => l.includes("\x1b[7m ▶ Background")), "the focused column heading is inverted + ▶");
  press(app, ch("j"), ch("j"), { name: "down" });
  assert.equal(app.scroll, 3);
  press(app, ch("k"));
  assert.equal(app.scroll, 2);
  press(app, ch("G"));
  assert.equal(app.scroll, f.scrollMax);
  press(app, ch("g"), ch("g"));
  assert.equal(app.scroll, 0);
  assert.equal(app.view(t).cursor, cursorBefore);
  press(app, { name: "tab" });
  assert.equal(app.focus, "decision");
  press(app, ch("j"));
  assert.notEqual(app.view(t).cursor, cursorBefore);
});

test("stacked layout: wheel and PgDn scroll the whole screen (focus has no effect)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(LONG)), t);
  const narrow = { cols: 80, rows: 20 };
  const f = renderFrame(app.view(t), narrow);
  app.syncFrame(f);
  assert.ok(!f.wide && f.scrollMax > 0);
  press(app, { name: "tab" }, ch("j"));
  assert.equal(app.view(t).cursor, 1, "in the stacked layout j moves the decision cursor");
  press(app, wheel("down", 5));
  assert.ok(app.scroll >= 3);
  press(app, { name: "pgdn" });
  assert.ok(app.scroll >= 3 + Math.floor(f.bodyRows / 2));
});

test("wheel is ignored while typing or in the list; the position resets when moving to another decision", () => {
  const app = longApp();
  press(app, wheel("down", 10));
  press(app, ch("b"));
  press(app, wheel("down", 10));
  assert.equal(app.scroll, 3);
});

// ---- wide diagrams (horizontal scroll, full width) ----

const chain = (n: number) => Array.from({ length: n }, (_, i) => `N${i}[調査${i}]`).join(" --> ");
const FIG = (n: number) => `${V2_MD.split("## Diagram")[0]}## Diagram\n\n\`\`\`mermaid\nflowchart LR\n  ${chain(n)}\n\`\`\`\n`;
const WIDE_FIG = FIG(9); // width about 110: exceeds the background column (89 at 140 columns) but fits the 140-column terminal
const HUGE_FIG = FIG(14); // does not fit even the 140-column terminal
const body = (f: { lines: string[] }) => f.lines.map(stripAnsi);
const row = (f: { lines: string[] }, mark: string) => body(f).find((l) => l.includes(mark))!;

function figApp(md: string, size = SIZE): { app: App; frame: () => ReturnType<typeof renderFrame> } {
  const app = new App();
  app.upsert(decision(withExplanation(md)), t);
  const frame = () => {
    const f = renderFrame(app.view(t), size);
    app.syncFrame(f, t);
    return f;
  };
  frame();
  return { app, frame };
}

test("wide diagram: drawn truncated, with a note and hMax; no fallback text", () => {
  const { frame } = figApp(WIDE_FIG);
  const f = frame();
  const text = body(f).join("\n");
  assert.match(text, /\(Diagram: \d+ columns wide\. ←→ \/ horizontal wheel to scroll · f for full width\)/);
  assert.ok(!text.includes("widen the terminal"));
  assert.ok(text.includes("┌"));
  assert.ok(f.hMax > 0);
});

test("horizontal scroll: → moves 8 columns without Tab and only overflowing rows shift; h / l switch pending; stops at the ends and ◀▶ appears", () => {
  const { app, frame } = figApp(WIDE_FIG);
  const before = frame();
  const textRow = body(before).find((l) => l.includes("Why this decision is needed now"))!;
  const figRow = row(before, "調査0");
  // Even with the decision focused, → scrolls the diagram sideways
  press(app, { name: "right" });
  assert.equal(app.hscroll, 8);
  const after = frame();
  assert.notEqual(row(after, "調査1"), figRow);
  assert.equal(body(after).find((l) => l.includes("Why this decision is needed now")), textRow, "wrapped text does not move");
  assert.match(body(after).at(-2)!, /◀▶ 8\/\d+/);
  assert.ok(!body(before).join("\n").includes("◀▶"));
  press(app, { name: "right" });
  assert.equal(app.hscroll, 16);
  press(app, { name: "left" });
  assert.equal(app.hscroll, 8);
  press(app, { name: "left" });
  assert.equal(app.hscroll, 0);
  press(app, ch("l"), ch("h"), ch("]"), ch("["));
  assert.equal(app.hscroll, 0, "h l [ ] are not horizontal scrolling");
  for (let i = 0; i < 30; i++) press(app, { name: "right" });
  const end = frame();
  assert.equal(app.hscroll, end.hMax, "stops at the right end");
  assert.ok(end.hMax > 0);
  for (let i = 0; i < 30; i++) press(app, { name: "left" });
  assert.equal(app.hscroll, 0, "stops at the left end");
});

test("f for full width: the decision column disappears and the background widens; Esc / f / Tab go back", () => {
  const { app, frame } = figApp(WIDE_FIG);
  const normal = frame();
  assert.ok(body(normal).some((l) => l.includes("Decision")) && body(normal).some((l) => l.includes("│ ")));
  press(app, ch("f"));
  const full = frame();
  assert.ok(full.full && app.full);
  assert.ok(!body(full).join("\n").includes("Should notifications"), "the decision column is hidden");
  assert.ok(full.hMax === 0, "the diagram fits at full width");
  assert.ok(body(full).join("\n").includes("調査6"), "even the rightmost node is visible");
  assert.ok(!body(full).join("\n").includes("◀▶"));
  assert.match(body(full).at(-1)!, /f \/ Esc back/);
  assert.deepEqual(press(app, enter), [], "cannot submit at full width");
  press(app, { name: "esc" });
  assert.ok(!app.full);
  assert.ok(body(frame()).at(-1)!.includes("h/l switch"));
  press(app, ch("f"), ch("f"));
  assert.ok(!app.full);
  press(app, ch("f"), { name: "tab" });
  assert.ok(!app.full);
});

test("a diagram that does not fit even at full width can scroll sideways", () => {
  const { app, frame } = figApp(HUGE_FIG);
  press(app, ch("f"));
  const f = frame();
  assert.ok(f.hMax > 0);
  press(app, { name: "right" }, ch("l"));
  assert.equal(app.hscroll, 16);
  assert.match(body(frame()).at(-2)!, /◀▶ 16\/\d+/);
});

test("hint: shown once, only when the diagram exceeds the column but fits at full width", () => {
  const { app, frame } = figApp(WIDE_FIG);
  // The first draw in figApp starts the hint
  assert.ok(body(frame()).at(-1)!.includes("Diagram too wide: f for full width"));
  press(app, ch("f"));
  assert.ok(!body(frame()).at(-1)!.includes("Diagram too wide"), "not shown at full width");
  press(app, { name: "esc" });
  // Never shown twice for the same decision (after time passes)
  t += 10000;
  assert.ok(!body(frame()).at(-1)!.includes("Diagram too wide"));
  assert.ok(!body(frame()).at(-1)!.includes("Diagram too wide"));

  const huge = figApp(HUGE_FIG);
  assert.ok(!body(huge.frame()).at(-1)!.includes("Diagram too wide"), "no hint for a diagram that does not fit even at full width");
  const plain = figApp(V2_MD);
  assert.ok(!body(plain.frame()).at(-1)!.includes("Diagram too wide"));
});

test("stacked layout: ← → scroll sideways without Tab, h l still switch pending, f does nothing", () => {
  const narrow = { cols: 80, rows: 24 };
  const app = new App();
  const mk = (id: string, at: string) => decision({ id, tool_use_id: id, created_at: at, ...withExplanation(WIDE_FIG) } as never);
  app.upsert(mk("a", "2026-10-02T00:00:00Z"), t);
  app.upsert(mk("b", "2026-10-02T00:00:01Z"), t);
  const draw = () => {
    const f = renderFrame(app.view(t), narrow);
    app.syncFrame(f, t);
    return f;
  };
  const f0 = draw();
  assert.ok(!f0.wide && f0.hMax > 0);
  press(app, { name: "pgdn" }, { name: "pgdn" }, { name: "pgdn" });
  const f1 = draw();
  assert.ok(body(f1).join("\n").includes("(Diagram:"));
  assert.ok(!body(f1).join("\n").includes("f for full width"), "the stacked layout note does not mention f");
  app.scroll = 0;
  press(app, { name: "right" });
  assert.equal(app.hscroll, 8);
  assert.equal(app.shownId, "a");
  press(app, ch("l"));
  assert.equal(app.shownId, "b", "l switches pending");
  assert.equal(app.hscroll, 0, "switching resets the horizontal position");
  press(app, ch("f"));
  assert.ok(!app.full);
  for (let i = 0; i < 20; i++) press(app, { name: "right" });
  const f2 = draw();
  assert.equal(app.hscroll, f2.hMax, "stops at the end");
  assert.match(body(f2).at(-2)!, new RegExp(`◀▶ ${f2.hMax}/\\d+`));
});

test("→ scrolls a diagram sideways without switching pending if there is one, otherwise it switches pending; h/l/[/] always switch", () => {
  const two = (md: string) => {
    const app = new App();
    app.upsert(decision({ id: "a", tool_use_id: "a", created_at: "2026-10-02T00:00:00Z", ...withExplanation(md) } as never), t);
    app.upsert(decision({ id: "b", tool_use_id: "b", created_at: "2026-10-02T00:00:01Z", ...withExplanation(md) } as never), t);
    app.syncFrame(renderFrame(app.view(t), SIZE), t);
    return app;
  };
  const w = two(WIDE_FIG);
  press(w, { name: "right" }, { name: "right" });
  assert.equal(w.shownId, "a");
  assert.equal(w.hscroll, 16);
  press(w, ch("l"));
  assert.equal(w.shownId, "b");
  press(w, ch("["));
  assert.equal(w.shownId, "a");
  press(w, ch("]"));
  assert.equal(w.shownId, "b");
  const p = two(V2_MD);
  press(p, { name: "right" });
  assert.equal(p.shownId, "b", "without a diagram, → switches pending");
});

test("horizontal wheel (66 / 67) scrolls sideways; Home / End go to the start / end only when the background is focused", () => {
  const { app, frame } = figApp(WIDE_FIG);
  press(app, { name: "hwheel", dir: "right" }, { name: "hwheel", dir: "right" });
  assert.equal(app.hscroll, 16);
  press(app, { name: "hwheel", dir: "left" });
  assert.equal(app.hscroll, 8);
  press(app, { name: "end" });
  assert.equal(app.hscroll, 8, "Home / End are ignored with the decision focused");
  press(app, { name: "tab" }, { name: "end" });
  const f = frame();
  assert.equal(app.hscroll, f.hMax);
  press(app, { name: "home" });
  assert.equal(app.hscroll, 0);
});

test("column widths: decision is clamp(round(cols*0.34), 44, 58), the background gets the rest (1 column separator)", () => {
  const split = (cols: number) => {
    const { frame } = figApp(V2_MD, { cols, rows: 30 });
    return frame().split;
  };
  // split = background width + 3-column separator (" │ "); decision width = cols - split
  assert.equal(120 - split(120), 44);
  assert.equal(147 - split(147), 50);
  assert.equal(200 - split(200), 58);
  assert.equal(split(147) - 3, 94 + 0, "147 columns: decision 50 / background 94 + 3-column separator");
});

test("long recommendation: when over half the column height it is cut at 8 rows with an expand hint, and . toggles full text / folded", () => {
  const sentences = Array.from({ length: 24 }, (_, i) => `This is sentence number ${i} used to build a long recommendation. `).join("");
  const app = new App();
  app.upsert(decision(withExplanation(V2_MD.replace("I recommend SSE. It is the smaller implementation.", sentences))), t);
  const size = { cols: 140, rows: 30 };
  const draw = () => {
    const f = renderFrame(app.view(t), size);
    app.syncFrame(f);
    return stripAnsi(f.text);
  };
  let text = draw();
  assert.ok(text.includes("… (. to expand)"), "cut it and show the hint");
  assert.ok(!text.includes("sentence number 23"), "the last sentence is hidden");
  press(app, ch("."));
  text = draw();
  
  assert.equal(app.view(t).recFull, true);
  assert.ok(!text.includes("… (. to expand)"));
  press(app, ch("."));
  assert.equal(app.view(t).recFull, false);
  assert.ok(draw().includes("… (. to expand)"));
  // A short recommendation (the V2_MD default) is not cut
  const short = new App();
  short.upsert(decision(withExplanation(V2_MD)), t);
  assert.ok(!stripAnsi(renderFrame(short.view(t), size).text).includes("(. to expand)"));
});
