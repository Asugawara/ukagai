import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOutput } from "../../src/hook/decision.js";
import { checkpointInstruction } from "../../src/hook/checkpoint.js";
import type { Client } from "../../src/hook/client.js";
import type { DecisionResponse, Instruction } from "../../src/contract.js";

const at = "2026-10-05T00:00:00.000Z";
const toolInput = { plan: "p" };

test("buildOutput: { instruct, text } denies ExitPlanMode with the exact reason", () => {
  const out = buildOutput("approve_plan", toolInput, { via: "gui", instruct: true, text: "have Fable review it", decided_at: at } satisfies DecisionResponse);
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "[ukagai] The human has not approved the plan yet and asks you to do this first: have Fable review it\nYou are still in plan mode: do it (research, subagents and reviews are fine; do not edit project files), update the plan file, then call ExitPlanMode again.",
    },
  });
});

test("buildOutput: approve and reject are unchanged", () => {
  const ok = buildOutput("approve_plan", toolInput, { via: "gui", approve: true, decided_at: at });
  assert.equal((ok as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, "allow");
  const no = buildOutput("approve_plan", toolInput, { via: "gui", approve: false, reason: "too vague", decided_at: at });
  assert.equal((no as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason, "too vague");
});

test("checkpoint hook: a plan instruction is worded as being about the plan being written", async () => {
  const ins: Instruction = { decision_id: "", kind: "instruct", text: "add a rollback section", created_at: at, about: "plan" };
  const client = { takeInstruction: async () => ins } as unknown as Client;
  const out = (await checkpointInstruction({ session_id: "s" }, client)) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(out.hookSpecificOutput.additionalContext, /^\[ukagai\] About the plan you are writing: add a rollback section\n/);
});
