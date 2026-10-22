import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AnswerRequest,
  COMMENTS_MAX,
  Comment,
  Comments,
  PlanInstructRequest,
  parseCannotAnswer,
  AskUserQuestionInput,
  CreateDecisionRequest,
  DecisionStatus,
  EventInput,
  ExitPlanModeInput,
  PermissionRequestAllowExitPlan,
  PermissionRequestAllowSetMode,
  PreToolUseAllow,
  PreToolUseDeny,
  PreToolUseInput,
  SessionStartContext,
  TRANSCRIPT_MAX_BYTES,
  canTransition,
  isPlanFile,
  plansDir,
  realFileUnder,
  isAllowedExplanationPath,
  isAllowedTranscriptPath,
} from "../src/contract.js";

const fx = (name: string): any =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("fixture: t1 / t5 stdin pass PreToolUseInput and each tool_input", () => {
  const t1 = fx("t1-stdin.json");
  assert.ok(PreToolUseInput.safeParse(t1).success);
  assert.ok(AskUserQuestionInput.safeParse(t1.tool_input).success);
  // unknown keys (prompt_id / effort) are kept, not dropped
  assert.equal(PreToolUseInput.parse(t1).prompt_id, t1.prompt_id);

  const t5 = fx("t5-stdin.json");
  assert.ok(PreToolUseInput.safeParse(t5).success);
  assert.ok(ExitPlanModeInput.safeParse(t5.tool_input).success);
});

test("fixture: stdout passes the allow / deny schema and mix-ups are rejected", () => {
  assert.ok(PreToolUseAllow.safeParse(fx("t1-stdout.json")).success);
  assert.ok(PreToolUseAllow.safeParse(fx("t5-stdout.json")).success);
  assert.ok(PreToolUseDeny.safeParse(fx("t4-stdout.json")).success);
  const t6 = PreToolUseDeny.safeParse(fx("t6-stdout.json"));
  assert.ok(t6.success);
  assert.match(t6.data.hookSpecificOutput.additionalContext ?? "", /^\[ukagai/);
  assert.ok(!PreToolUseDeny.safeParse(fx("t1-stdout.json")).success);
  assert.ok(!PreToolUseAllow.safeParse(fx("t4-stdout.json")).success);
});

test("PermissionRequest / SessionStart output shapes", () => {
  assert.ok(
    PermissionRequestAllowSetMode.safeParse({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }],
        },
      },
    }).success,
  );
  // ExitPlanMode's own prompt: a plan approved with auto for message delivery carries the plan back, else Claude Code keeps its dialog
  const exitPlan = fx("permission-request-exit-plan-stdout.json");
  assert.ok(PermissionRequestAllowExitPlan.safeParse(exitPlan).success);
  assert.deepEqual(exitPlan.hookSpecificOutput.decision.updatedInput, fx("permission-request-exit-plan-stdin.json").tool_input);
  assert.ok(!PermissionRequestAllowExitPlan.safeParse({ hookSpecificOutput: { ...exitPlan.hookSpecificOutput, decision: { behavior: "allow", updatedPermissions: exitPlan.hookSpecificOutput.decision.updatedPermissions } } }).success);
  for (const name of ["SessionStart", "SubagentStart"]) {
    assert.ok(
      SessionStartContext.safeParse({ hookSpecificOutput: { hookEventName: name, additionalContext: "x" } }).success,
    );
  }
  assert.ok(
    !SessionStartContext.safeParse({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: "x" } }).success,
  );
});

test("CreateDecisionRequest / EventInput can be built from fixtures", () => {
  const t1 = fx("t1-stdin.json");
  const req = {
    tool_use_id: t1.tool_use_id,
    kind: "answer_question",
    session: {
      session_id: t1.session_id,
      cwd: t1.cwd,
      transcript_path: t1.transcript_path,
      scratchpad_dir: t1.scratchpad_dir,
      permission_mode: t1.permission_mode,
    },
    request: t1.tool_input,
  };
  assert.ok(CreateDecisionRequest.safeParse(req).success);
  assert.ok(!CreateDecisionRequest.safeParse({ ...req, kind: "other" }).success);
  assert.ok(
    EventInput.safeParse({ ...t1, received_at: "2026-10-02T03:09:12.000Z", observe: { phase: "start" } }).success,
  );
});

test("AnswerRequest: accepts the 4 shapes and rejects invalid ones", () => {
  assert.ok(AnswerRequest.safeParse({ answers: { "Which do you choose, A or B?": "B" } }).success);
  assert.ok(AnswerRequest.safeParse({ approve: true }).success);
  assert.ok(AnswerRequest.safeParse({ approve: true, set_mode_auto: true }).success);
  assert.ok(AnswerRequest.safeParse({ approve: false, reason: "too broad" }).success);
  assert.ok(AnswerRequest.safeParse({ approve: false }).success, "a rejection needs no reason");
  assert.ok(AnswerRequest.safeParse({ approve: false, reason: "" }).success);
  assert.ok(AnswerRequest.safeParse({ fallback: true }).success);

  assert.ok(!AnswerRequest.safeParse({ answers: { q: 1 } }).success);
  assert.ok(!AnswerRequest.safeParse({ answers: { q: ["a", "b"] } }).success);
  assert.ok(!AnswerRequest.safeParse({ fallback: false }).success);
  assert.ok(!AnswerRequest.safeParse({}).success);
});

test("canTransition: the 8 allowed transitions are true", () => {
  const allowed: [string, string][] = [
    ["pending", "answer_submitted"],
    ["pending", "fallback"],
    ["pending", "hook_disconnected"],
    ["pending", "cancelled"],
    ["answer_submitted", "answered"],
    ["answer_submitted", "answer_lost"],
    ["hook_disconnected", "cancelled"],
    ["hook_disconnected", "pending"],
  ];
  for (const [from, to] of allowed) {
    assert.equal(canTransition(from as DecisionStatus, to as DecisionStatus), true, `${from}→${to}`);
  }
  // everything outside the allow table is false (only 8 of all 64 pairs are true)
  let trues = 0;
  for (const from of DecisionStatus.options) for (const to of DecisionStatus.options) if (canTransition(from, to)) trues++;
  assert.equal(trues, 8);
});

test("canTransition: invalid transitions and terminal states", () => {
  assert.equal(canTransition("answered", "pending"), false);
  assert.equal(canTransition("answer_submitted", "pending"), false);
  assert.equal(canTransition("pending", "answered"), false);
  for (const to of DecisionStatus.options) assert.equal(canTransition("denied_explain", to), false);
});

test("isAllowedTranscriptPath", () => {
  const home = "/Users/someone";
  assert.equal(isAllowedTranscriptPath(`${home}/.claude/projects/p/s.jsonl`, home), true);
  assert.equal(isAllowedTranscriptPath("/etc/passwd", home), false);
  assert.equal(isAllowedTranscriptPath(`${home}/.claude/projects/x/../../../etc/passwd`, home), false);
  assert.equal(isAllowedTranscriptPath(`${home}/.claude/projects`, home), false);
  assert.equal(isAllowedTranscriptPath(`${home}/.claude/projects-evil/a`, home), false);
  assert.equal(isAllowedTranscriptPath(".claude/projects/a", home), false);
});

test("isAllowedExplanationPath", () => {
  const home = "/Users/someone";
  const sp = "/private/tmp/claude-1/proj/sess/scratchpad";
  assert.equal(isAllowedExplanationPath(`${sp}/ukagai/a.md`, sp, home), true);
  assert.equal(isAllowedExplanationPath(`${home}/.ukagai/explain/sess/a.md`, sp, home), true);
  assert.equal(isAllowedExplanationPath("/tmp/other.md", sp, home), false);
  assert.equal(isAllowedExplanationPath(`${sp}/other.md`, sp, home), false);
  assert.equal(isAllowedExplanationPath(`${sp}/ukagai/../../secret.md`, sp, home), false);
  assert.equal(isAllowedExplanationPath(`${home}/.ukagai/explain/a.md`, undefined, home), true);
  assert.equal(isAllowedExplanationPath(`${sp}/ukagai/a.md`, undefined, home), false);
});

test("isAllowedExplanationPath: a plan-file block path (<plan file>#ukagai-explain) is allowed under home only", () => {
  const home = "/Users/someone";
  assert.equal(isAllowedExplanationPath(`${home}/.claude/plans/p.md#ukagai-explain`, undefined, home), true);
  assert.equal(isAllowedExplanationPath(`${home}/proj/plans/p.md#ukagai-explain`, undefined, home), true);
  assert.equal(isAllowedExplanationPath("/etc/p.md#ukagai-explain", undefined, home), false);
  assert.equal(isAllowedExplanationPath(`${home}/proj/p.txt#ukagai-explain`, undefined, home), false);
  assert.equal(isAllowedExplanationPath(`${home}/../etc/p.md#ukagai-explain`, undefined, home), false);
});

test("plansDir / isPlanFile / TRANSCRIPT_MAX_BYTES", () => {
  assert.equal(plansDir("/h"), "/h/.claude/plans");
  assert.equal(TRANSCRIPT_MAX_BYTES, 64 * 1024 * 1024);
  assert.equal(isPlanFile("a.md"), true);
  for (const n of ["", "a.txt", ".hidden.md", "a/b.md", "a\\b.md", "..md", "a..b.md", "a\0.md"]) assert.equal(isPlanFile(n), false, JSON.stringify(n));
});

test("realFileUnder: a regular file under the root (realpath), not a directory, a missing file, or a link out of it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ukagai-rfu-")));
  const out = realpathSync(mkdtempSync(join(tmpdir(), "ukagai-rfu-out-")));
  mkdirSync(join(root, "d"));
  writeFileSync(join(root, "d", "f.md"), "x");
  writeFileSync(join(out, "o.md"), "x");
  symlinkSync(join(out, "o.md"), join(root, "link.md"));
  symlinkSync(join(root, "d", "f.md"), join(root, "in.md"));
  assert.equal(realFileUnder(root, join(root, "d", "f.md")), join(root, "d", "f.md"));
  assert.equal(realFileUnder(root, join(root, "in.md")), join(root, "d", "f.md"));
  assert.equal(realFileUnder(root, join(root, "d")), null);
  assert.equal(realFileUnder(root, join(root, "nope.md")), null);
  assert.equal(realFileUnder(root, join(root, "link.md")), null);
  assert.equal(realFileUnder(root, join(out, "o.md")), null);
});

test("AnswerRequest: checkpoint shape needs text for instruct and stays exclusive", () => {
  assert.ok(AnswerRequest.safeParse({ kind: "continue" }).success);
  assert.ok(AnswerRequest.safeParse({ kind: "stop" }).success);
  assert.ok(AnswerRequest.safeParse({ kind: "stop", text: "wrap up" }).success);
  assert.ok(AnswerRequest.safeParse({ kind: "instruct", text: "do X" }).success);
  assert.ok(AnswerRequest.safeParse({ kind: "continue", via: "gui", decided_at: "2026-10-04T00:00:00Z" }).success);
  assert.ok(!AnswerRequest.safeParse({ kind: "instruct" }).success);
  assert.ok(!AnswerRequest.safeParse({ kind: "instruct", text: " " }).success);
  assert.ok(!AnswerRequest.safeParse({ kind: "continue", approve: true }).success);
  assert.ok(!AnswerRequest.safeParse({ kind: "other" }).success);
});

// ---- inline comments ----

const okComment = { id: "c-1", kind: "text", source: { kind: "plan" }, quote: "q", note: "n" };

test("Comments: 30 pass, 31 fail, empty fails", () => {
  assert.equal(COMMENTS_MAX, 30);
  assert.equal(Comments.safeParse(Array.from({ length: 30 }, () => okComment)).success, true);
  assert.equal(Comments.safeParse(Array.from({ length: 31 }, () => okComment)).success, false);
  assert.equal(Comments.safeParse([]).success, false);
});

test("Comment: note 1000 passes and 1001 fails; blank note fails; bad id fails", () => {
  assert.equal(Comment.safeParse({ ...okComment, note: "x".repeat(1000) }).success, true);
  assert.equal(Comment.safeParse({ ...okComment, note: "x".repeat(1001) }).success, false);
  assert.equal(Comment.safeParse({ ...okComment, note: "   " }).success, false);
  assert.equal(Comment.safeParse({ ...okComment, id: "bad id!" }).success, false);
  assert.equal(Comment.safeParse({ ...okComment, id: "x".repeat(33) }).success, false);
  assert.equal(Comment.safeParse({ ...okComment, extra: 1 }).success, false);
});

test("Comment: kind text needs a quote, kind region needs a rect", () => {
  const { quote: _q, ...noQuote } = okComment;
  assert.equal(Comment.safeParse(noQuote).success, false);
  const region = { id: "r1", kind: "region", source: { kind: "image", file: "/a.png" }, note: "n" };
  assert.equal(Comment.safeParse(region).success, false);
  assert.equal(Comment.safeParse({ ...region, rect: { x: 0, y: 0, w: 1, h: 1 }, mark: "0123456789abcdef" }).success, true);
  assert.equal(Comment.safeParse({ ...region, rect: { x: 0, y: 0, w: 0, h: 1 } }).success, false);
  assert.equal(Comment.safeParse({ ...region, rect: { x: 0, y: 0, w: 1, h: 1 }, mark: "XYZ" }).success, false);
});

test("Comment: a newline in file, selector or tag is rejected", () => {
  assert.equal(Comment.safeParse({ ...okComment, source: { kind: "page", file: "a\nb.html" } }).success, false);
  assert.equal(Comment.safeParse({ ...okComment, kind: "element", quote: undefined, selector: "button\n.save" }).success, false);
  assert.equal(Comment.safeParse({ ...okComment, kind: "element", quote: undefined, tag: "b\u0000" }).success, false);
  assert.equal(Comment.safeParse({ ...okComment, source: { kind: "page", file: "/s/ok.html" }, selector: "p" }).success, true);
});

test("AnswerRequest: comments ride on answers, reject and instruct; approve + comments is rejected", () => {
  assert.equal(AnswerRequest.safeParse({ answers: { Q: "A" }, comments: [okComment] }).success, true);
  assert.equal(AnswerRequest.safeParse({ approve: false, comments: [okComment] }).success, true);
  assert.equal(AnswerRequest.safeParse({ approve: false, reason: "r", comments: [okComment] }).success, true);
  assert.equal(AnswerRequest.safeParse({ instruct: true, comments: [okComment] }).success, true);
  assert.equal(AnswerRequest.safeParse({ instruct: true, text: "t" }).success, true);
  assert.equal(AnswerRequest.safeParse({ approve: true, comments: [okComment] }).success, false);
});

test("instruct with neither text nor comments is rejected, for the answer and the plan card", () => {
  assert.equal(AnswerRequest.safeParse({ instruct: true }).success, false);
  assert.equal(AnswerRequest.safeParse({ instruct: true, text: "  " }).success, false);
  assert.equal(PlanInstructRequest.safeParse({}).success, false);
  assert.equal(PlanInstructRequest.safeParse({ comments: [okComment] }).success, true);
  assert.equal(PlanInstructRequest.safeParse({ text: "x".repeat(4001) }).success, false);
});

test("parseCannotAnswer judges only the first line: a comment block after a newline is ignored", () => {
  const block = "The human left 1 comment:\n1. plan, \"A\": \"q\"\n   → n";
  assert.deepEqual(parseCannotAnswer(`Cannot answer — Undefined terms: foo, bar\n\n${block}`), { reason: "Undefined terms", terms: ["foo", "bar"], text: "foo, bar" });
  assert.deepEqual(parseCannotAnswer(`Cannot answer — Unclear\n\n${block}`), { reason: "Unclear", terms: [], text: "" });
  assert.equal(parseCannotAnswer(`A\nCannot answer — Unclear`), null);
});
