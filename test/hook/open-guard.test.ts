import { test } from "node:test";
import assert from "node:assert/strict";
import { OPEN_DENY_REASON, openGuard } from "../../src/hook/open-guard.js";
import { contextText } from "../../src/hook/context-hooks.js";
import { planContextText } from "../../src/hook/plan-context.js";
import { readFileSync } from "node:fs";
import { dataDirWithToken, runHook } from "./helpers.js";

const bash = (command: string, tool = "Bash") =>
  JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd: "/w" });
const args = () => ["--checkpoint", "--server", "http://127.0.0.1:1", "--data-dir", dataDirWithToken()];
const SP = "/private/tmp/claude-501/-proj/sess/scratchpad";

const denied = async (cmd: string) => {
  const r = await runHook(args(), bash(cmd));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny", cmd);
  assert.equal(out.permissionDecisionReason, OPEN_DENY_REASON);
};
const passes = async (cmd: string, tool = "Bash") => {
  const r = await runHook(args(), bash(cmd, tool));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", cmd);
};

test("the deny reason is the exact sentence", () => {
  assert.equal(
    OPEN_DENY_REASON,
    "[ukagai] Do not open files for the human; they read ukagai. Reference the file from the explanation instead: ![alt](x.png) for an image, ![alt](x.html) for an HTML page (the GUI renders it in a sandboxed frame).",
  );
});

test("open on a scratchpad file, an html / image / pdf / md file: deny through the hook command", async () => {
  await denied("open scratchpad/x.html");
  await denied(`open ${SP}/ukagai/compare.html`);
  await denied(`open -a "Google Chrome" x.png`);
  await denied("xdg-open /tmp/x.pdf");
  await denied("cd /w && start notes.md");
  await denied(`open ${SP}/ukagai`); // a scratchpad directory
});

test("open on a URL, a directory or a non-file passes; other commands and other tools are untouched", async () => {
  await passes("open https://example.com/x.html");
  await passes("open .");
  await passes("open -a Finder .");
  await passes("echo open x.html");
  await passes("ls scratchpad/x.html");
  await passes("open scratchpad/x.html", "Edit");
  await passes("open scratchpad/x.html", "Read");
});

test("data-dir paths are denied; a command after the first 600 chars is not looked at", () => {
  const input = (c: string) => ({ tool_name: "Bash", tool_input: { command: c } });
  assert.ok(openGuard(input("open /home/u/.ukagai/explain"), "/home/u/.ukagai"));
  assert.equal(openGuard(input("open /home/u/other"), "/home/u/.ukagai"), null);
  assert.equal(openGuard(input(" ".repeat(600) + "open x.html")), null);
  assert.equal(openGuard({ tool_name: "Bash", tool_input: {} }), null);
  assert.equal(openGuard({ tool_name: "Bash" }), null);
});

test("context text (Claude and Codex), plan context and the skill carry the rule", () => {
  const rule = "Never open a file or a URL for the human (`open`, `xdg-open`, a browser): put it in the explanation — images `![alt](x.png)`, HTML pages `![alt](x.html)` (the GUI renders them in a sandboxed frame); files next to the explanation file or under the session's scratchpad.";
  assert.ok(contextText("/d", "en", "claude").includes(rule));
  assert.ok(contextText("/d", "ja", "claude").includes(rule));
  assert.ok(contextText("/d", "en", "codex").includes(rule));
  assert.ok(planContextText(null).includes(rule));
  assert.ok(readFileSync(new URL("../../skills/ukagai-explain/SKILL.md", import.meta.url), "utf8").includes(rule));
  assert.ok(readFileSync(new URL("../../docs/spec/explain.md", import.meta.url), "utf8").includes(rule));
});
