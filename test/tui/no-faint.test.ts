// TX1: no faint text. Hierarchy is bold / default attributes / position; ANSI DIM (\x1b[2m) survives only on separators and box edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { App } from "../../src/tui/app.js";
import type { Decision } from "../../src/contract.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { V2_MD, decision, withExplanation } from "./helpers.js";

const LONG = readFileSync(new URL("../gui/fixtures/long-plan.md", import.meta.url), "utf8");
const NOW = Date.parse("2026-10-02T00:00:30.000Z");

const checkpoint = (): Decision =>
  ({
    id: "ck1",
    kind: "checkpoint",
    tool_use_id: "checkpoint:s-ck:2026-10-02T00:00:00.000Z",
    session: { session_id: "s-ck", cwd: "/Users/a/.herdr/worktrees/ukagai/feat-ck" },
    request: { recap: "Added the retry to the uploader and the tests pass. Next I would wire it into the CLI.", recap_at: "2026-10-02T00:00:00.000Z" },
    context: {},
    status: "pending",
    created_at: "2026-10-02T00:00:00.000Z",
  }) as Decision;

function frameOf(d: Decision, cols = 140, rows = 40): string {
  const app = new App();
  app.upsert(d, NOW);
  let frame = renderFrame(app.view(NOW), { cols, rows });
  if (app.syncFrame(frame, NOW)) frame = renderFrame(app.view(NOW), { cols, rows });
  return frame.text;
}

/** DIM spans that hold only rule / box-edge / scrollbar characters are separators; anything else dim is faint text */
const withoutSeparators = (raw: string): string => raw.replace(/\x1b\[2m[─│┌┐└┘░▌▏ ]*\x1b\[0m/g, "");

const SCREENS: Array<[string, () => Decision]> = [
  ["question", () => decision(withExplanation(V2_MD))],
  ["checkpoint", checkpoint],
  ["plan", () => decision({ kind: "approve_plan", request: { plan: LONG, planFilePath: "/p/plan.md" } } as never)],
];

for (const [name, make] of SCREENS) {
  test(`TX1: the ${name} screen has no dim text (DIM only on separators and box edges)`, () => {
    for (const cols of [140, 80]) assert.equal(withoutSeparators(frameOf(make(), cols, 50)).includes("\x1b[2m"), false, `${name} at ${cols} columns`);
  });
}

test("TX1 (P3): the title row is bold; the context line is bracket chips in default attributes, the repo bold in its colour", () => {
  const lines = frameOf(decision(withExplanation(V2_MD))).split("\n");
  assert.ok(lines[0]!.includes("\x1b[1m"), "bold title");
  assert.ok(!lines[1]!.includes("\x1b[2m"), "context line not dim");
  assert.ok(lines[1]!.includes("\x1b[1mukagai"), "repo name bold");
  assert.match(stripAnsi(lines[1]!), /^\[● ukagai\] \[⎇ feat\/tui\] \[⧉ feat-tui\] \[\S.*\] \[\d/);
});

test("TX1 (P3): the goal line is a bold label + text followed by a rule line; the condition starts with a bold label", () => {
  const app = new App();
  app.fetchHistory = async () => ({ session_id: "s1", total: 1, first: { at: "2026-10-01T00:00:00.000Z", text: "Make the header calm" }, recent: [{ at: "2026-10-01T00:00:00.000Z", text: "Make the header calm" }] });
  app.upsert(decision(withExplanation(V2_MD)), NOW);
  return new Promise<void>((resolve) => setImmediate(() => {
    const raw = renderFrame(app.view(NOW), { cols: 140, rows: 40 }).text.split("\n");
    const left = (l: string) => stripAnsi(l).split(" │ ")[0]!;
    const i = raw.findIndex((l) => left(l).startsWith("Goal Make the header calm"));
    assert.ok(i >= 0, "goal line");
    assert.ok(raw[i]!.includes("\x1b[1mGoal"), "bold label");
    assert.match(left(raw[i + 1]!), /^─+$/, "rule under the goal");
    assert.ok(raw[i + 1]!.includes("\x1b[2m"), "the rule may be dim");
    resolve();
  }));
});

test("TX1: a frame of the question screen without escape codes (for the report)", () => {
  const out = process.env.TX1_FRAME_OUT;
  if (out) writeFileSync(out, stripAnsi(frameOf(decision(withExplanation(V2_MD)), 140, 40)));
});
