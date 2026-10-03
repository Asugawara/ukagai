import { test } from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXPLAIN_BLOCK_CLOSE, EXPLAIN_BLOCK_OPEN, extractExplainBlocks, stripExplainBlocks } from "../../src/contract.js";
import { blockFor, findPlanFile } from "../../src/hook/plan-file.js";
import { tmpDir } from "./helpers.js";

// The wording of Claude Code's plan-mode reminder
const reminder = (p: string) =>
  `Plan mode is active. You should create your plan at ${p} using the Write tool. You should build your plan incrementally by writing to or editing this file.`;
const record = (text: string) => JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text }] } });

function setup() {
  const home = tmpDir("ukagai-pf-home-");
  const plans = join(home, ".claude", "plans");
  mkdirSync(plans, { recursive: true });
  const tp = join(home, "t.jsonl");
  return { home, plans, tp };
}
const block = (q: string) => `${EXPLAIN_BLOCK_OPEN}\n---\nukagai: 1\nquestion: ${q}\ntitle: T\n---\n## Why this decision is needed now\nx\n${EXPLAIN_BLOCK_CLOSE}\n`;

test("findPlanFile: the path named in the reminder is found; the last mention wins", async () => {
  const { home, plans, tp } = setup();
  writeFileSync(join(plans, "a.md"), "# a\n");
  writeFileSync(join(plans, "b.md"), "# b\n");
  writeFileSync(tp, [record(reminder(join(plans, "a.md"))), record("hello"), record(reminder(join(plans, "b.md")))].join("\n") + "\n");
  assert.equal(await findPlanFile(tp, home), await realpath(join(plans, "b.md")));
});

test("findPlanFile: the JSON-escaped form (\\/) and the second wording are found", async () => {
  const { home, plans, tp } = setup();
  writeFileSync(join(plans, "c.md"), "# c\n");
  const escaped = JSON.stringify({ text: reminder(join(plans, "c.md")) }).replace(/\//g, "\\/");
  assert.ok(escaped.includes("\\/"));
  writeFileSync(tp, escaped + "\n");
  assert.equal(await findPlanFile(tp, home), await realpath(join(plans, "c.md")));
  writeFileSync(tp, record(`A plan file already exists at ${join(plans, "c.md")}. You can read it.`) + "\n");
  assert.equal(await findPlanFile(tp, home), await realpath(join(plans, "c.md")));
});

test("findPlanFile: a configured plans directory elsewhere under home is accepted", async () => {
  const { home, tp } = setup();
  mkdirSync(join(home, "proj", "docs", "plans"), { recursive: true });
  const f = join(home, "proj", "docs", "plans", "x.md");
  writeFileSync(f, "# x\n");
  writeFileSync(tp, record(reminder(f)) + "\n");
  assert.equal(await findPlanFile(tp, home), await realpath(f));
});

test("findPlanFile: a path outside home (or a link out of it) is rejected; a missing file is rejected", async () => {
  const { home, plans, tp } = setup();
  const outside = tmpDir("ukagai-pf-out-");
  writeFileSync(join(outside, "o.md"), "# o\n");
  writeFileSync(tp, record(reminder(join(outside, "o.md"))) + "\n");
  assert.equal(await findPlanFile(tp, home), null);
  symlinkSync(join(outside, "o.md"), join(plans, "link.md"));
  writeFileSync(tp, record(reminder(join(plans, "link.md"))) + "\n");
  assert.equal(await findPlanFile(tp, home), null);
  writeFileSync(tp, record(reminder(join(plans, "missing.md"))) + "\n");
  assert.equal(await findPlanFile(tp, home), null);
});

test("findPlanFile: no match → null; fallback finds the newest recent plan holding a block for the question", async () => {
  const { home, plans, tp } = setup();
  writeFileSync(tp, record("nothing about plans here, just a plan to refactor") + "\n");
  assert.equal(await findPlanFile(tp, home), null);
  assert.equal(await findPlanFile(tp, home, "Q?"), null);
  writeFileSync(join(plans, "old.md"), block("Q?"));
  const old = new Date(Date.now() - 3 * 3600_000);
  utimesSync(join(plans, "old.md"), old, old);
  assert.equal(await findPlanFile(tp, home, "Q?"), null); // too old
  writeFileSync(join(plans, "other.md"), block("Another?"));
  assert.equal(await findPlanFile(tp, home, "Q?"), null); // no block for this question
  writeFileSync(join(plans, "new.md"), "# plan\n" + block("Q?"));
  assert.equal(await findPlanFile(tp, home, "Q?"), await realpath(join(plans, "new.md")));
  assert.equal(await findPlanFile(undefined, home, "Q?"), await realpath(join(plans, "new.md")));
});

test("extractExplainBlocks: 0 / 1 / 2 blocks, unterminated ignored, verbatim question match", () => {
  assert.deepEqual(extractExplainBlocks("# plan\n"), []);
  const one = extractExplainBlocks(`# plan\n${block("Q1?")}`);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.question, "Q1?");
  assert.ok(one[0]!.body.startsWith("---\nukagai: 1"));
  assert.ok(one[0]!.body.endsWith("x"));
  const two = extractExplainBlocks(`${block("Q1?")}\n## mid\n${block("Q2?")}`);
  assert.deepEqual(two.map((b) => b.question), ["Q1?", "Q2?"]);
  assert.equal(blockFor(two, "Q2?")?.question, "Q2?");
  assert.equal(blockFor(two, "q2?"), undefined);
  assert.equal(blockFor(two, "Q2? "), undefined);
  const unterminated = `${EXPLAIN_BLOCK_OPEN}\n---\nquestion: U?\n---\nbody\n`;
  assert.deepEqual(extractExplainBlocks(unterminated), []);
  // an unterminated block before a good one does not swallow it
  const mixed = extractExplainBlocks(unterminated + block("Q3?"));
  assert.deepEqual(mixed.map((b) => b.question), ["Q3?"]);
});

test("stripExplainBlocks removes the blocks and leaves the rest byte-identical", () => {
  const plan = "# Plan\n\n## Steps\n\n1. a\r\n2. b\n\n## Scope and reversibility\nReversibility: reversible\n";
  assert.equal(stripExplainBlocks(plan), plan);
  const withBlocks = "# Plan\n\n## Steps\n\n1. a\r\n2. b\n\n" + block("Q1?") + "## Scope and reversibility\nReversibility: reversible\n" + block("Q2?");
  assert.equal(stripExplainBlocks(withBlocks), plan);
  const unterminated = plan + `${EXPLAIN_BLOCK_OPEN}\nhalf\n`;
  assert.equal(stripExplainBlocks(unterminated), unterminated);
});
