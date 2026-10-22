// formatComments: the text of inline comments as the agent reads it
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Comment } from "../../src/contract.js";
import { appendBlock, composeWithComments, formatComments, TooLongError } from "../../src/serve/comments.js";

const c = (o: Partial<Comment> & Pick<Comment, "kind" | "source">): Comment => ({ id: "c1", note: "n", ...o });

const ctx = { planFile: "/h/.claude/plans/retry.md", explanationFile: "/s/ukagai/q.md" };

test("one comment uses the singular lead line; text in a plan has the section path and the JSON-quoted quote", () => {
  const out = formatComments([c({ kind: "text", source: { kind: "plan" }, section: ["Steps", "Cap the backoff"], quote: "cap it at 30 seconds", note: "make it 60" })], ctx);
  assert.equal(out, ['The human left 1 comment:', '1. plan /h/.claude/plans/retry.md, "Steps > Cap the backoff": "cap it at 30 seconds"', "   → make it 60"].join("\n"));
});

test("text in an explanation, without a section", () => {
  const out = formatComments([c({ kind: "text", source: { kind: "explanation" }, quote: "the cache", note: "why?" })], ctx);
  assert.equal(out.split("\n")[1], '1. explanation /s/ukagai/q.md: "the cache"');
});

test("the file is omitted when the server does not know it", () => {
  const out = formatComments([c({ kind: "text", source: { kind: "plan" }, section: ["A"], quote: "q" })], {});
  assert.equal(out.split("\n")[1], '1. plan, "A": "q"');
});

test("text inside a page names the selector; an element has its text, or is the whole page without a selector", () => {
  const src = { kind: "page" as const, file: "/s/ukagai/header-b.html" };
  const out = formatComments(
    [
      c({ kind: "text", source: src, selector: "p.lead", quote: "hello" }),
      c({ kind: "element", source: src, selector: "button.save", text: "Save" }),
      c({ kind: "element", source: src }),
    ],
    ctx,
  );
  assert.deepEqual(out.split("\n").filter((l) => /^\d\./.test(l)), [
    '1. page /s/ukagai/header-b.html, element p.lead: "hello"',
    '2. page /s/ukagai/header-b.html, element button.save "Save"',
    "3. page /s/ukagai/header-b.html (whole page)",
  ]);
  assert.ok(out.startsWith("The human left 3 comments:\n"));
});

test("a region names the rectangle, and the marked copy only when the mark resolves", () => {
  const src = { kind: "image" as const, file: "/s/ukagai/color.png" };
  const rect = { x: 200, y: 35, w: 96, h: 18 };
  const withMark = formatComments([c({ kind: "region", source: src, rect, mark: "3f2a0c1d9e8b7a65" })], { markPath: (id) => `/s/ukagai/marks/${id}.png` });
  assert.equal(withMark.split("\n")[1], "1. image /s/ukagai/color.png, region x=200 y=35 w=96 h=18 (marked copy: /s/ukagai/marks/3f2a0c1d9e8b7a65.png)");
  const unresolved = formatComments([c({ kind: "region", source: src, rect, mark: "3f2a0c1d9e8b7a65" })], { markPath: () => undefined });
  assert.equal(unresolved.split("\n")[1], "1. image /s/ukagai/color.png, region x=200 y=35 w=96 h=18");
  assert.equal(formatComments([c({ kind: "region", source: src, rect })], ctx).split("\n")[1], "1. image /s/ukagai/color.png, region x=200 y=35 w=96 h=18");
});

test("an orphan gets the suffix at the end of the where-line", () => {
  const out = formatComments([c({ kind: "text", source: { kind: "plan" }, quote: "gone", orphan: true })], ctx);
  assert.equal(out.split("\n")[1], '1. plan /h/.claude/plans/retry.md: "gone" (no longer in the current text)');
});

test("a multi-line note is indented by 5 spaces after the first line", () => {
  const out = formatComments([c({ kind: "text", source: { kind: "plan" }, quote: "q", note: "right align,\nswap with share\n\nthanks" })], ctx);
  assert.deepEqual(out.split("\n").slice(2), ["   → right align,", "     swap with share", "     ", "     thanks"]);
});

test("a quote over 160 characters is clipped with an ellipsis and JSON-quoted", () => {
  const out = formatComments([c({ kind: "text", source: { kind: "plan" }, quote: 'a"' + "x".repeat(300) })], ctx);
  const where = out.split("\n")[1]!;
  assert.ok(where.endsWith('…"'));
  assert.ok(where.includes('"a\\"'));
  assert.equal(where.slice(where.indexOf(': "') + 2), JSON.stringify(('a"' + "x".repeat(300)).slice(0, 160) + "…"));
});

test("appendBlock joins with a blank line, or is the block alone", () => {
  assert.equal(appendBlock("base", "blk"), "base\n\nblk");
  assert.equal(appendBlock("", "blk"), "blk");
  assert.equal(appendBlock(undefined, "blk"), "blk");
});

test("composeWithComments throws TooLongError with the length when over the cap", () => {
  const comments = [c({ kind: "text", source: { kind: "plan" }, quote: "q" })];
  assert.throws(
    () => composeWithComments("x".repeat(3990), comments, {}),
    (e) => e instanceof TooLongError && e.max === 4000 && e.length > 4000,
  );
  assert.ok(composeWithComments("ok", comments, {}).startsWith("ok\n\nThe human left 1 comment:"));
});
