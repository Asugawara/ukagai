import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DIFF_CELLS, diffPlans } from "../../src/serve/plan-diff.js";

const st = (d: ReturnType<typeof diffPlans>) => d.sections.map((s) => `${s.heading}:${s.status}`);

test("identical plans: every section same", () => {
  const p = "## A\n\na\n\n## B\n\nb\n";
  const d = diffPlans(p, p);
  assert.deepEqual(st(d), ["A:same", "B:same"]);
  assert.deepEqual(d.summary, { added: 0, changed: 0, removed: 0, same: 2 });
});

test("added, removed and changed sections, in the order of next with removed last", () => {
  const prev = "## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n";
  const next = "## A\n\na2\n\n## D\n\nd\n\n## C\n\nc\n";
  const d = diffPlans(prev, next);
  assert.deepEqual(st(d), ["A:changed", "D:added", "C:same", "B:removed"]);
  assert.deepEqual(d.summary, { added: 1, changed: 1, removed: 1, same: 1 });
  assert.deepEqual(d.sections[1]!.new_lines, ["## D", "", "d", ""]);
  assert.deepEqual(d.sections[3]!.old_lines, ["## B", "", "b", ""]);
});

test("a changed line is a del followed by an add; unchanged lines stay same", () => {
  const d = diffPlans("## A\n\none\ntwo\nthree\n", "## A\n\none\nTWO\nthree\n");
  assert.deepEqual(d.sections[0]!.lines, [
    { kind: "same", text: "## A" },
    { kind: "same", text: "" },
    { kind: "same", text: "one" },
    { kind: "del", text: "two" },
    { kind: "add", text: "TWO" },
    { kind: "same", text: "three" },
  ]);
});

test("a moved section with identical text is same", () => {
  const d = diffPlans("## A\n\na\n\n## B\n\nb\n", "## B\n\nb\n\n## A\n\na\n");
  assert.deepEqual(st(d), ["B:same", "A:same"]);
});

test("text before the first H2 is a section with an empty heading", () => {
  const d = diffPlans("# T\n\nintro\n\n## A\n\na\n", "# T\n\nintro 2\n\n## A\n\na\n");
  assert.deepEqual(st(d), [":changed", "A:same"]);
});

test("empty prev: everything added; empty next: everything removed", () => {
  const p = "# T\n\n## A\n\na\n\n## B\n\nb\n";
  assert.deepEqual(diffPlans("", p).summary, { added: 3, changed: 0, removed: 0, same: 0 });
  assert.deepEqual(diffPlans(p, "").summary, { added: 0, changed: 0, removed: 3, same: 0 });
});

test("duplicate headings match in order", () => {
  const d = diffPlans("## A\n\nx\n\n## A\n\ny\n", "## A\n\nx\n\n## A\n\ny2\n\n## A\n\nz\n");
  assert.deepEqual(st(d), ["A:same", "A:changed", "A:added"]);
});

test("trailing whitespace and trailing blank lines are ignored", () => {
  const d = diffPlans("## A\n\nline  \nmore\n", "## A\n\nline\nmore\n\n\n");
  assert.deepEqual(st(d), ["A:same"]);
  const e = diffPlans("## A\n\nline  \nx\n", "## A\n\nline\ny\n");
  assert.deepEqual(e.sections[0]!.lines!.map((l) => l.kind), ["same", "same", "same", "del", "add"]);
});

test("a heading inside a code fence does not start a section", () => {
  const d = diffPlans("## A\n\n```\n## not\n```\n", "## A\n\n```\n## not\n```\n");
  assert.deepEqual(st(d), ["A:same"]);
});

const big = (n: number, tag: string) => `## A\n\n${Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n")}\n`;

test("a section pair over MAX_DIFF_CELLS is changed without lines; a smaller pair keeps them", () => {
  assert.equal(MAX_DIFF_CELLS, 4_000_000);
  const huge = diffPlans(big(3000, "old"), big(3000, "new"));
  assert.equal(huge.sections[0]!.status, "changed");
  assert.equal(huge.sections[0]!.lines, undefined);
  assert.deepEqual(huge.summary, { added: 0, changed: 1, removed: 0, same: 0 });
  const ok = diffPlans(big(1000, "old"), big(1000, "new"));
  assert.equal(ok.sections[0]!.status, "changed");
  assert.ok(ok.sections[0]!.lines && ok.sections[0]!.lines.length > 0);
});
