import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPele, mermaidIssues, type Pele } from "../../src/hook/mermaid-check.js";

const seq = (msg: string) => `sequenceDiagram\n  A->>B: ${msg}`;

test("a sequence message with a raw ; is reported", () => {
  const issues = mermaidIssues([{ line: 3, source: seq("BEGIN; COMMIT") }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.line, 3);
  assert.match(issues[0]!.message, /Parse error on line/);
});

test("the same message with #59; parses", () => {
  assert.deepEqual(mermaidIssues([{ line: 1, source: seq("BEGIN#59; COMMIT") }]), []);
});

test("an unknown diagram type is reported", () => {
  assert.equal(mermaidIssues([{ line: 1, source: "foo\n  a-->b" }]).length, 1);
});

test("a null loader gives no issues, even for a broken block", () => {
  assert.deepEqual(mermaidIssues([{ line: 1, source: seq("BEGIN; COMMIT") }], () => null), []);
});

test("an empty block list does not call the loader", () => {
  let called = false;
  const out = mermaidIssues([], () => {
    called = true;
    return null;
  });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("valid flowchart and valid sequenceDiagram give no issues", () => {
  const issues = mermaidIssues([
    { line: 1, source: "flowchart TD\n  A[x; y] --> B" },
    { line: 9, source: "sequenceDiagram\n  A->>B: hello" },
  ]);
  assert.deepEqual(issues, []);
});

test("loadPele loads the bundle under tsx", () => {
  const pele: Pele | null = loadPele();
  assert.notEqual(pele, null);
  assert.equal(typeof pele!.parse, "function");
});
