// The human's edited skill (<data-dir>/skill/SKILL.md): the hook texts point at it through an explicit `skillRef`; the copy for Claude Code
// lands in <scratchpad>/ukagai/skill/; any failure leaves today's texts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexContextText, contextText } from "../../src/hook/context-hooks.js";
import { planContext, planContextText } from "../../src/hook/plan-context.js";
import { denyReason, findExplanation } from "../../src/hook/explain.js";
import { resolveSkillRef } from "../../src/hook/skill-ref.js";
import { NO_OPEN } from "../../src/hook/context-hooks.js";
import { runHook } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ukagai-skillref-"));
function dataWithSkill(text = "# my skill\n"): string {
  const d = tmp();
  mkdirSync(join(d, "skill"), { recursive: true });
  writeFileSync(join(d, "skill", "SKILL.md"), text);
  return d;
}
const REF = "/x/ukagai/skill/SKILL.md";
const ENV = {} as NodeJS.ProcessEnv;

// ---- resolveSkillRef ----

test("resolveSkillRef: nothing saved -> undefined", () => {
  assert.equal(resolveSkillRef(tmp(), tmp()), undefined);
  assert.equal(resolveSkillRef(tmp()), undefined);
});

test("resolveSkillRef: Claude (scratchpad) gets a copy in ukagai/skill/, refreshed on the next call; Codex gets the data-dir file", () => {
  const d = dataWithSkill("v1\n");
  const sp = tmp();
  const ref = resolveSkillRef(d, sp);
  assert.equal(ref, join(sp, "ukagai", "skill", "SKILL.md"));
  assert.equal(readFileSync(ref!, "utf8"), "v1\n");
  writeFileSync(join(d, "skill", "SKILL.md"), "v2\n");
  assert.equal(resolveSkillRef(d, sp), ref);
  assert.equal(readFileSync(ref!, "utf8"), "v2\n");
  assert.equal(resolveSkillRef(d), join(d, "skill", "SKILL.md"));
});

test("resolveSkillRef: an unreadable SKILL.md (a directory) or an unwritable scratchpad -> undefined, no throw", () => {
  const d = tmp();
  mkdirSync(join(d, "skill", "SKILL.md"), { recursive: true });
  assert.equal(resolveSkillRef(d, tmp()), undefined);
  assert.equal(resolveSkillRef(d), undefined);
  const ok = dataWithSkill();
  const blocked = tmp();
  writeFileSync(join(blocked, "ukagai"), "a file where the directory should be");
  assert.equal(resolveSkillRef(ok, blocked), undefined);
});

test("the copy in ukagai/skill/ is never taken as an explanation (even one whose question matches, or the only recent file)", async () => {
  const d = dataWithSkill("---\nukagai: 1\nquestion: Q?\n---\n# my skill\n");
  const sp = tmp();
  resolveSkillRef(d, sp);
  assert.equal(await findExplanation(join(sp, "ukagai"), "Q?"), null);
  assert.equal(await findExplanation(join(sp, "ukagai"), "anything"), null);
  assert.ok(existsSync(join(sp, "ukagai", "skill", "SKILL.md")));
});

// ---- the three texts, with and without skillRef, Claude and Codex ----

test("SessionStart (Claude): without skillRef today's text; with it the file replaces the skill and there are still 5 lines", () => {
  const plain = contextText("/d", "en", "claude");
  assert.match(plain, /following skill ukagai-explain\./);
  assert.match(plain, /palette is in skill ukagai-explain, section "Rich Markdown"/);
  assert.equal(plain, contextText("/d", "en", "claude", undefined));
  const t = contextText("/d", "en", "claude", REF);
  assert.equal(t.split("\n").length, 5);
  assert.ok(t.includes(`following ${REF} (the human's edited version of skill ukagai-explain: read that file and do not read skill ukagai-explain; it replaces it).`));
  assert.ok(t.includes(`the palette is in ${REF}, section "Rich Markdown".`));
  assert.ok(!/following skill ukagai-explain/.test(t));
  assert.ok(t.includes(NO_OPEN));
});

test("SessionStart (Codex): one sentence is added to an existing line, the line count does not change", () => {
  const plain = codexContextText("/d", "en");
  const t = codexContextText("/d", "en", REF);
  assert.equal(t.split("\n").length, plain.split("\n").length);
  assert.ok(t.includes(`The human edited these rules in ${REF}: read it before writing an explanation file; where it differs from the format above, the file wins.`));
  assert.ok(!plain.includes("edited"));
  assert.equal(contextText("/d", "en", "codex", REF), t);
  assert.ok(t.includes(NO_OPEN));
});

test("plan context: the skill references point at the file with skillRef; today's text without; the spec path and the line count stay", () => {
  const plain = planContextText("/spec.md", ENV);
  const t = planContextText("/spec.md", ENV, REF);
  assert.match(plain, /see skill ukagai-explain\)/);
  assert.ok(t.includes(`see ${REF} (the human's edited version of skill ukagai-explain; do not read skill ukagai-explain))`));
  assert.ok(t.includes(`Full spec: ${REF}, section "Rich Markdown (ukagai dialect)", or /spec.md.`));
  assert.equal(t.split("\n").length, plain.split("\n").length);
  assert.ok(t.includes(NO_OPEN));
});

const P = { path: "/d/explain.md", question: "Q?", missing: ["a file"], codes: ["file" as const] };
for (const template of ["A", "B"] as const) {
  for (const agent of ["claude", "codex"] as const) {
    test(`deny reason ${template} / ${agent}: names the file once, never the skill as the thing to read, within the limit`, () => {
      const plain = denyReason(template, { ...P, agent });
      const t = denyReason(template, { ...P, agent, skillRef: REF });
      assert.equal(t.split(REF).length - 1, 1, "the path is written once");
      assert.ok(!/read skill ukagai-explain \(if/.test(t));
      assert.ok(!/in skill ukagai-explain/.test(t));
      assert.ok(t.length <= 1600);
      assert.ok(t.startsWith("[ukagai, not a failure] "));
      assert.ok(t.includes("Save to: /d/explain.md") || t.includes("/d/explain.md"));
      if (agent === "codex") {
        assert.ok(!t.includes("AskUserQuestion") && t.includes("request_user_input"));
        assert.ok(plain.includes("request_user_input"));
      } else {
        assert.ok(t.includes("do not read skill ukagai-explain"));
        assert.ok(t.includes("AskUserQuestion"));
      }
    });
  }
}

test("deny reason for a plan (ExitPlanMode) and for a plan-mode question also name the file once", () => {
  for (const template of ["A", "B"] as const) {
    const plan = denyReason(template, { missing: ["Steps"], agent: "claude", skillRef: REF });
    assert.equal(plan.split(REF).length - 1, 1);
    assert.ok(!/skill ukagai-explain\b(?!;)/.test(plan.replace("(the human's edited version of skill ukagai-explain; do not read skill ukagai-explain)", "")));
    const inPlan = denyReason(template, { planFile: "/p/plan.md", question: "Q?", missing: ["a file"], codes: ["file"], agent: "claude", skillRef: REF });
    assert.equal(inPlan.split(REF).length - 1, 1);
    assert.ok(inPlan.includes("/p/plan.md"));
  }
});

test("the diagram rule and the no-open rule are in every context text, with and without skillRef", () => {
  const texts = [contextText("/d"), contextText("/d", "en", "claude", REF), codexContextText("/d"), codexContextText("/d", "en", REF), planContextText(null, ENV), planContextText(null, ENV, REF)];
  for (const t of texts) {
    assert.ok(t.includes("Draw a diagram only when it shows something the Options table cannot"));
    assert.ok(t.includes(NO_OPEN));
  }
});

// ---- planContext() reads the data dir ----

test("planContext: with a saved version it copies for Claude (scratchpad_dir) and refreshes; without one the text is unchanged", () => {
  const d = dataWithSkill("v1\n");
  const sp = tmp();
  const out = planContext({ hook_event_name: "PreToolUse", tool_name: "EnterPlanMode", session_id: "s1", scratchpad_dir: sp }, d) as any;
  const ctx = out.hookSpecificOutput.additionalContext as string;
  assert.ok(ctx.includes(join(sp, "ukagai", "skill", "SKILL.md")));
  const none = planContext({ hook_event_name: "PreToolUse", tool_name: "EnterPlanMode", session_id: "s2", scratchpad_dir: tmp() }, tmp()) as any;
  assert.ok(!none.hookSpecificOutput.additionalContext.includes("edited version"));
  assert.equal(none.hookSpecificOutput.additionalContext, planContextText());
});

// ---- the real hook (stdout, exit code) ----

const start = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: "s1", transcript_path: "/t", cwd: "/c", hook_event_name: "SessionStart", ...extra });

test("hook SessionStart: Claude with scratchpad_dir copies and points at the copy; Codex points at the data-dir file", async () => {
  const d = dataWithSkill("# mine\n");
  const sp = tmp();
  const r = await runHook(["--data-dir", d, "--no-autostart"], start({ scratchpad_dir: sp }));
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  assert.ok(ctx.includes(join(sp, "ukagai", "skill", "SKILL.md")));
  assert.equal(ctx.split("\n").length, 5);
  assert.equal(readFileSync(join(sp, "ukagai", "skill", "SKILL.md"), "utf8"), "# mine\n");
  // refreshed by the next run
  writeFileSync(join(d, "skill", "SKILL.md"), "# mine 2\n");
  await runHook(["--data-dir", d, "--no-autostart"], start({ scratchpad_dir: sp }));
  assert.equal(readFileSync(join(sp, "ukagai", "skill", "SKILL.md"), "utf8"), "# mine 2\n");
  const c = await runHook(["--data-dir", d, "--no-autostart", "--agent", "codex"], start());
  assert.equal(c.code, 0);
  assert.ok((JSON.parse(c.stdout).hookSpecificOutput.additionalContext as string).includes(`The human edited these rules in ${join(d, "skill", "SKILL.md")}`));
});

test("hook SessionStart: an unreadable SKILL.md (a directory) leaves today's text, prints it, exit 0", async () => {
  const d = tmp();
  mkdirSync(join(d, "skill", "SKILL.md"), { recursive: true });
  const r = await runHook(["--data-dir", d, "--no-autostart"], start({ scratchpad_dir: tmp() }));
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /following skill ukagai-explain\./);
});

test("hook: a failing run still prints nothing on stdout and exits 0 (invalid stdin)", async () => {
  const r = await runHook(["--data-dir", dataWithSkill(), "--no-autostart"], "not json");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});
