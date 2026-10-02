import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AnswerRequest,
  AskUserQuestionInput,
  CreateDecisionRequest,
  DecisionStatus,
  EventInput,
  ExitPlanModeInput,
  PermissionRequestAllowSetMode,
  PreToolUseAllow,
  PreToolUseDeny,
  PreToolUseInput,
  SessionStartContext,
  canTransition,
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
  assert.ok(AnswerRequest.safeParse({ fallback: true }).success);

  assert.ok(!AnswerRequest.safeParse({ answers: { q: 1 } }).success);
  assert.ok(!AnswerRequest.safeParse({ answers: { q: ["a", "b"] } }).success);
  assert.ok(!AnswerRequest.safeParse({ approve: false }).success);
  assert.ok(!AnswerRequest.safeParse({ approve: false, reason: "" }).success);
  assert.ok(!AnswerRequest.safeParse({ fallback: false }).success);
  assert.ok(!AnswerRequest.safeParse({}).success);
});

test("canTransition: the 7 allowed transitions are true", () => {
  const allowed: [string, string][] = [
    ["pending", "answer_submitted"],
    ["pending", "fallback"],
    ["pending", "hook_disconnected"],
    ["pending", "cancelled"],
    ["answer_submitted", "answered"],
    ["answer_submitted", "answer_lost"],
    ["hook_disconnected", "cancelled"],
  ];
  for (const [from, to] of allowed) {
    assert.equal(canTransition(from as DecisionStatus, to as DecisionStatus), true, `${from}→${to}`);
  }
  // everything outside the allow table is false (only 7 of all 64 pairs are true)
  let trues = 0;
  for (const from of DecisionStatus.options) for (const to of DecisionStatus.options) if (canTransition(from, to)) trues++;
  assert.equal(trues, 7);
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
