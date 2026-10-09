import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planContext, planContextText } from "../../src/hook/plan-context.js";
import { buildHookEntries } from "../../src/settings/hooks-spec.js";
import { fakeServer, runHook, tmpDir } from "./helpers.js";

const input = (tool = "EnterPlanMode") => JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, cwd: "/w" });
const prompt = (mode = "plan", sid = "s-1") => JSON.stringify({ session_id: sid, hook_event_name: "UserPromptSubmit", permission_mode: mode, prompt: "go", cwd: "/w" });
const args = () => ["--plan-context", "--data-dir", tmpDir()];

test("--plan-context: additionalContext only (no decision), exit 0, no server needed", async () => {
  const r = await runHook([...args(), "--server", "http://127.0.0.1:1"], input());
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(typeof out.hookSpecificOutput.additionalContext, "string");
});

test("the text names every plan section and the palette, is English and at most 25 lines", () => {
  const t = planContextText("/repo/docs/spec/markdown.md");
  assert.ok(t.split("\n").length <= 25);
  for (const s of ["# Title", "## Scope and reversibility", "Reversibility: reversible|costly|irreversible", "Scope: file|repo|machine|external", "## Steps", "bold title", "## Risks", "[!CAUTION]", "## Verification", "task list", "<!-- ukagai-explain -->", "<!-- /ukagai-explain -->"]) {
    assert.ok(t.includes(s), s);
  }
  for (const s of ["callouts with titles", "task lists", "<details>", "Mermaid of any type", 'title="src/x.ts"', "```diff", "==mark==", "::: columns", "![meaningful alt](/…/scratchpad/ukagai/x.png)", "absolute path", "before ExitPlanMode"]) {
    assert.ok(t.includes(s), s);
  }
  assert.ok(t.includes('skill ukagai-explain, section "Rich Markdown (ukagai dialect)", or /repo/docs/spec/markdown.md.'));
  assert.ok(!planContextText(null).includes("/docs/spec/markdown.md"));
  assert.doesNotMatch(t, /[ぁ-んァ-ン一-龥]/);
});

test("plan mode may write the scratchpad: the old no-write wording is gone from the hook text and the skill", () => {
  const skill = readFileSync(new URL("../../skills/ukagai-explain/SKILL.md", import.meta.url), "utf8");
  for (const [name, text] of [["planContextText", planContextText(null)], ["SKILL.md", skill]] as const) {
    for (const s of ["next to the plan file", "only file you may write", "write no image"]) assert.ok(!text.includes(s), `${name}: ${s}`);
    assert.ok(text.includes("before ExitPlanMode"), name);
  }
});

test("the default text names the repo's docs/spec/markdown.md when it exists", () => {
  const m = planContextText().match(/or (\/\S+\/docs\/spec\/markdown\.md)\.$/);
  assert.ok(m, "path expected in the checkout");
  assert.ok(existsSync(m[1]!));
});

test("planContext ignores other tools, events and modes", () => {
  const d = tmpDir();
  assert.equal(planContext({ hook_event_name: "PreToolUse", tool_name: "Bash" }, d), null);
  assert.equal(planContext({ hook_event_name: "PostToolUse", tool_name: "EnterPlanMode" }, d), null);
  assert.equal(planContext({ hook_event_name: "UserPromptSubmit", permission_mode: "default", session_id: "s" }, d), null);
  assert.equal(planContext({ hook_event_name: "UserPromptSubmit", session_id: "s" }, d), null);
});

test("never calls the server (both triggers)", async () => {
  const f = await fakeServer();
  try {
    const d = tmpDir();
    const r1 = await runHook(["--plan-context", "--server", f.url, "--data-dir", d], input());
    const r2 = await runHook(["--plan-context", "--server", f.url, "--data-dir", d], prompt("plan", "s-2"));
    assert.ok(r1.stdout !== "" && r2.stdout !== "");
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("UserPromptSubmit in plan mode injects once per session (marker file); other modes and sessions are independent", async () => {
  const d = tmpDir();
  const a = ["--plan-context", "--data-dir", d];
  const r1 = await runHook(a, prompt());
  const out = JSON.parse(r1.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "UserPromptSubmit");
  assert.equal(out.permissionDecision, undefined);
  assert.equal(out.additionalContext, planContextText());
  assert.deepEqual(readdirSync(join(d, "plan-context")), ["s-1"]);
  assert.equal((await runHook(a, prompt())).stdout, "");
  assert.equal((await runHook(a, input())).stdout, "", "EnterPlanMode after the prompt trigger: same session, already told");
  assert.equal((await runHook(a, prompt("default", "s-3"))).stdout, "");
  assert.ok((await runHook(a, prompt("plan", "s-4"))).stdout.includes("Plan sections"));
});

test("marker errors mean inject (data dir is a file)", async () => {
  const d = tmpDir();
  const file = join(d, "afile");
  writeFileSync(file, "x");
  const a = ["--plan-context", "--data-dir", file];
  assert.ok((await runHook(a, prompt())).stdout.includes("Plan sections"));
  assert.ok((await runHook(a, prompt())).stdout.includes("Plan sections"));
});

test("explain.md section 6.1 holds exactly planContextText", () => {
  const md = readFileSync(new URL("../../docs/spec/explain.md", import.meta.url), "utf8");
  const sec = md.slice(md.indexOf("### 6.1"), md.indexOf("## 7."));
  const blocks = [...sec.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.ok(blocks.includes(planContextText("<repo>/docs/spec/markdown.md")));
});

test("broken stdin, non-object stdin and a missing HOME print nothing and exit 0", async () => {
  for (const stdin of ["{not json", "[]", "null", ""]) {
    const r = await runHook(args(), stdin);
    assert.equal(r.code, 0, stdin);
    assert.equal(r.stdout, "", stdin);
  }
  const r = await runHook(["--plan-context", "--data-dir", join(tmpDir(), "none")], input(), join(tmpDir(), "missing"));
  assert.equal(r.code, 0);
  const unset = await runHook(["--plan-context", "--data-dir", tmpDir()], input(), "");
  assert.equal(unset.code, 0);
});

test("--observe prints nothing", async () => {
  const r = await runHook([...args(), "--observe"], input());
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("buildHookEntries: the plan-context group is sync, 3 s, and omitted with --observe", () => {
  const e = buildHookEntries({ invocation: { command: "node", prefix: ["cli.js"] }, timeout: 3600, observe: false });
  const g = e["PreToolUse"]!.find((x) => x.matcher === "EnterPlanMode")!;
  assert.ok(g);
  assert.equal(g.hooks[0]?.timeout, 3);
  assert.equal(g.hooks[0]?.async, undefined);
  assert.equal(g.hooks[0]?.statusMessage, undefined);
  assert.ok(g.hooks[0]?.args.includes("--plan-context"));
  const u = e["UserPromptSubmit"]!;
  assert.equal(u.length, 2);
  assert.equal(u[0]!.hooks[0]?.async, true);
  assert.ok(!u[0]!.hooks[0]!.args.includes("--plan-context"));
  assert.equal(u[1]!.matcher, undefined);
  assert.equal(u[1]!.hooks[0]?.timeout, 3);
  assert.equal(u[1]!.hooks[0]?.async, undefined);
  assert.ok(u[1]!.hooks[0]!.args.includes("--plan-context"));
  const o = buildHookEntries({ invocation: { command: "node", prefix: ["cli.js"] }, timeout: 3600, observe: true });
  assert.equal(o["PreToolUse"]!.some((x) => x.matcher === "EnterPlanMode"), false);
  assert.equal(o["UserPromptSubmit"]!.length, 1);
});

test("SessionEnd removes the session's marker (and only that one); a missing marker is fine", async () => {
  const d = tmpDir();
  assert.ok(planContext({ hook_event_name: "PreToolUse", tool_name: "EnterPlanMode", session_id: "s-end" }, d));
  assert.ok(planContext({ hook_event_name: "PreToolUse", tool_name: "EnterPlanMode", session_id: "s-keep" }, d));
  assert.deepEqual(readdirSync(join(d, "plan-context")).sort(), ["s-end", "s-keep"]);
  const f = await fakeServer();
  try {
    const { Client } = await import("../../src/hook/client.js");
    const { observedEvent } = await import("../../src/hook/context-hooks.js");
    const client = new Client(f.url, d);
    await observedEvent({ session_id: "s-end", hook_event_name: "SessionEnd", cwd: "/w" }, client, d);
    assert.deepEqual(readdirSync(join(d, "plan-context")), ["s-keep"]);
    await observedEvent({ session_id: "s-gone", hook_event_name: "SessionEnd", cwd: "/w" }, client, d); // no marker: no error
    // after the end a resumed session gets the rules again
    assert.ok(planContext({ hook_event_name: "PreToolUse", tool_name: "EnterPlanMode", session_id: "s-end" }, d));
  } finally {
    await f.close();
  }
});
