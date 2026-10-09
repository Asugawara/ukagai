import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { MISSING_LABELS } from "../../src/hook/explain.ts";

const DIR = new URL("../../skills/ukagai-explain/", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, DIR), "utf8");
const skill = read("SKILL.md");
const refs = readdirSync(new URL("reference/", DIR)).filter((f) => f.endsWith(".md"));
const lineCount = (s: string): number => s.replace(/\n$/, "").split("\n").length;

/** Text outside fenced code blocks, with inline code removed */
function prose(text: string): string {
  let fence = false;
  return text
    .split("\n")
    .filter((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        fence = !fence;
        return false;
      }
      return !fence;
    })
    .join("\n")
    .replace(/`[^`\n]*`/g, "");
}

function linkTargets(text: string): string[] {
  return [...prose(text).matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]!.split("#")[0]!).filter((t) => t !== "");
}

test("SKILL.md fits Codex's agent-plugin prompt cap", () => {
  const bytes = Buffer.byteLength(skill, "utf8");
  assert.ok(bytes <= 8000, `${bytes} bytes: Codex truncates an agent-plugin skill at MAX_SKILL_PROMPT_BYTES = 8_000 on a $mention`);
  const lines = lineCount(skill);
  assert.ok(lines <= 200, `${lines} lines: a Codex reading-habit guideline, not a hard cap`);
});

test("front matter: name matches the directory, short description, no allowed-tools", () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
  assert.equal(/^name:\s*(\S+)/m.exec(fm)?.[1], "ukagai-explain");
  const desc = /^description:\s*"(.*)"\s*$/m.exec(fm)?.[1] ?? "";
  assert.ok(desc.length > 0 && desc.length <= 1024, `description is ${desc.length} chars`);
  assert.ok(!/^allowed-tools:/m.test(fm), "a skill with allowed-tools needs a human approval to be invoked");
  assert.ok(skill.includes("ukagai: 1"));
});

test("required headings", () => {
  assert.ok(skill.includes("## Rich Markdown (ukagai dialect)"));
  assert.ok(/^## When stopped by human work/m.test(skill));
});

test("reference files: at most 200 lines; over 100 lines they open with a table of contents", () => {
  assert.ok(refs.length > 0);
  for (const f of refs) {
    const text = read(`reference/${f}`);
    assert.ok(lineCount(text) <= 200, `${f}: ${lineCount(text)} lines`);
    if (lineCount(text) <= 100) continue;
    const head = text.split("\n").slice(0, 10).join("\n");
    let fence = false;
    for (const l of text.split("\n")) {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      const h = !fence && /^## (.+)$/.exec(l)?.[1];
      if (h) assert.ok(head.includes(h), `${f}: H2 "${h}" is not in the first 10 lines`);
    }
  }
});

test("links: SKILL.md targets exist, every reference is linked, references do not link to .md", () => {
  const targets = linkTargets(skill);
  for (const t of targets) if (!/^https?:/.test(t)) assert.ok(existsSync(new URL(t, DIR)), `missing ${t}`);
  for (const f of refs) assert.ok(targets.includes(`reference/${f}`), `reference/${f} is not linked from SKILL.md`);
  for (const f of refs) {
    for (const t of linkTargets(read(`reference/${f}`))) assert.ok(!t.endsWith(".md"), `${f} links to ${t}`);
  }
});

test("checks.md lists every deny code", () => {
  const checks = read("reference/checks.md");
  for (const code of Object.keys(MISSING_LABELS)) assert.ok(checks.includes(`\`${code}\``), `checks.md lacks \`${code}\``);
});
