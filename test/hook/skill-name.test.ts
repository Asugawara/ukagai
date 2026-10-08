import { test } from "node:test";
import assert from "node:assert/strict";
import { skillName } from "../../src/hook/skill-name.js";
import { contextText } from "../../src/hook/context-hooks.js";
import { planContextText } from "../../src/hook/plan-context.js";
import { denyReason } from "../../src/hook/explain.js";

const IN = { CLAUDE_PLUGIN_ROOT: "/p" } as NodeJS.ProcessEnv;
const OUT = {} as NodeJS.ProcessEnv;

async function withEnv<T>(env: NodeJS.ProcessEnv, f: () => T): Promise<T> {
  const old = process.env["CLAUDE_PLUGIN_ROOT"];
  if (env["CLAUDE_PLUGIN_ROOT"] === undefined) delete process.env["CLAUDE_PLUGIN_ROOT"];
  else process.env["CLAUDE_PLUGIN_ROOT"] = env["CLAUDE_PLUGIN_ROOT"];
  try {
    return f();
  } finally {
    if (old === undefined) delete process.env["CLAUDE_PLUGIN_ROOT"];
    else process.env["CLAUDE_PLUGIN_ROOT"] = old;
  }
}

test("skillName: namespaced only inside a Claude plugin", () => {
  assert.equal(skillName(IN), "ukagai:ukagai-explain");
  assert.equal(skillName(OUT), "ukagai-explain");
  assert.equal(skillName(IN, "claude"), "ukagai:ukagai-explain");
  assert.equal(skillName(IN, "codex"), "ukagai-explain");
  assert.equal(skillName({ CLAUDE_PLUGIN_ROOT: "" }), "ukagai-explain");
});

test("SessionStart context names the skill by env", async () => {
  const inside = await withEnv(IN, () => contextText("/d"));
  assert.match(inside, /following skill ukagai:ukagai-explain\./);
  assert.match(inside, /palette is in skill ukagai:ukagai-explain, section "Rich Markdown"/);
  const outside = await withEnv(OUT, () => contextText("/d"));
  assert.match(outside, /following skill ukagai-explain\./);
  assert.match(outside, /palette is in skill ukagai-explain, section/);
  assert.ok(!outside.includes("ukagai:ukagai-explain"));
});

test("plan context names the skill by env", () => {
  const inside = planContextText(null, IN);
  assert.match(inside, /see skill ukagai:ukagai-explain\)/);
  assert.match(inside, /Full spec: skill ukagai:ukagai-explain, section/);
  const outside = planContextText(null, OUT);
  assert.match(outside, /see skill ukagai-explain\)/);
  assert.match(outside, /Full spec: skill ukagai-explain, section/);
  assert.ok(!outside.includes("ukagai:ukagai-explain"));
});

const base = { missing: ["x"], question: "Q?" };
const cases: [string, "A" | "B", Record<string, unknown>][] = [
  ["file A", "A", { path: "/d/e.md" }],
  ["file B", "B", { path: "/d/e.md" }],
  ["plan-mode block A", "A", { planFile: "/p.md" }],
  ["plan-mode block B", "B", { planFile: "/p.md" }],
  ["ExitPlanMode A", "A", {}],
  ["ExitPlanMode B", "B", {}],
];
for (const [name, tpl, extra] of cases) {
  test(`deny reason (${name}): skill name follows env`, async () => {
    const p = { ...base, ...(name.startsWith("Exit") ? { question: undefined } : {}), ...extra } as Parameters<typeof denyReason>[1];
    const inside = await withEnv(IN, () => denyReason(tpl, p));
    assert.match(inside, /skill ukagai:ukagai-explain/);
    const outside = await withEnv(OUT, () => denyReason(tpl, p));
    assert.match(outside, /skill ukagai-explain/);
    assert.ok(!outside.includes("ukagai:ukagai-explain"));
    // Codex rewrites either spelling
    const codex = await withEnv(IN, () => denyReason(tpl, { ...p, agent: "codex" }));
    assert.ok(!codex.includes("ukagai-explain)") && !/skill (ukagai:)?ukagai-explain/.test(codex), codex);
  });
}
