import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { approvalOutput, approvalQuestion } from "../../src/hook/codex.js";
import { contextText } from "../../src/hook/context-hooks.js";
import { runHook, spawnHook, tmpDir } from "./helpers.js";

const fixture = (n: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/codex/${n}`, import.meta.url)), "utf8");
const permission = (): any => JSON.parse(fixture("permission-request.json"));
const sessionStart = (): any => JSON.parse(fixture("hooks-deny-run.jsonl").split("\n").find((l) => l.includes('"SessionStart"'))!);

const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
});
async function realServer() {
  const dataDir = tmpDir();
  const h = await start({ port: 0, dataDir, home: tmpDir() });
  handles.push(h);
  const url = `http://127.0.0.1:${h.port}`;
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };
  return { dataDir, url, api };
}
async function answerPending(api: (p: string, b?: unknown) => Promise<any>, pick: (q: string) => string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const list = await api("/api/decisions?status=pending");
    if (list.length > 0) {
      const q = list[0].request.questions[0].question;
      await api(`/api/decisions/${list[0].id}/answer`, { answers: { [q]: pick(q) } });
      return list[0];
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no pending decision");
}
const args = (url: string, dir: string, ...rest: string[]) => ["--agent", "codex", "--server", url, "--data-dir", dir, ...rest];

test("approvalQuestion: description, blank line, the command in backticks; long commands are cut", () => {
  const q = approvalQuestion(permission().tool_input);
  assert.match(q, /^Allow creating c1-outside-test2\.txt.*\?\n\n`touch \$HOME\/c1-outside-test2\.txt && echo done`$/s);
  assert.equal(approvalQuestion({ command: "ls" }), "`ls`");
  assert.ok(approvalQuestion({ command: "x".repeat(5000) }).length < 2100);
  assert.equal(approvalQuestion({ path: "/a" }), '`{"path":"/a"}`');
});

test("approvalOutput: Allow allows; Deny and free text deny with the message", () => {
  assert.deepEqual(approvalOutput("Allow"), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  assert.deepEqual(approvalOutput("Deny"), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied in the ukagai GUI" } } });
  assert.equal((approvalOutput("not in $HOME please") as any).hookSpecificOutput.decision.message, "Denied in the ukagai GUI: not in $HOME please");
  assert.equal((approvalOutput("Cannot answer — unclear") as any).hookSpecificOutput.decision.behavior, "deny");
});

test("PermissionRequest fixture: GUI Allow → behavior allow; the decision is an Approval card of agent codex", async () => {
  const s = await realServer();
  const run = spawnHook(args(s.url, s.dataDir), JSON.stringify(permission()));
  const dec = await answerPending(s.api, () => "Allow");
  assert.equal(dec.session.agent, "codex");
  assert.equal(dec.request.questions[0].header, "Approval");
  assert.deepEqual(dec.request.questions[0].options.map((o: any) => o.label), ["Allow", "Deny"]);
  assert.equal(dec.explanation.none_reason, "not_required");
  const r = await run.result;
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
});

test("PermissionRequest fixture: GUI Deny with free text → behavior deny, message carries the text", async () => {
  const s = await realServer();
  const run = spawnHook(args(s.url, s.dataDir), JSON.stringify(permission()));
  await answerPending(s.api, () => "use a temp dir instead");
  const out = JSON.parse((await run.result).stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PermissionRequest");
  assert.deepEqual(out.hookSpecificOutput.decision, { behavior: "deny", message: "Denied in the ukagai GUI: use a temp dir instead" });
});

test("PermissionRequest: no answer within the budget, no server, --observe → prints nothing (Codex shows its own popup)", async () => {
  const s = await realServer();
  const r1 = await runHook(args(s.url, s.dataDir, "--budget", "1"), JSON.stringify(permission()));
  assert.equal(r1.code, 0);
  assert.equal(r1.stdout, "");
  const r2 = await runHook(args("http://127.0.0.1:9", s.dataDir), JSON.stringify(permission()));
  assert.equal(r2.code, 0);
  assert.equal(r2.stdout, "");
  const r3 = await runHook(args(s.url, s.dataDir, "--observe"), JSON.stringify(permission()));
  assert.equal(r3.stdout, "");
});

test("SessionStart for Codex: additionalContext names request_user_input, never AskUserQuestion; Claude's keeps AskUserQuestion", async () => {
  const dataDir = tmpDir();
  const r = await runHook(args("http://127.0.0.1:9", dataDir, "--no-autostart"), JSON.stringify(sessionStart()));
  assert.equal(r.code, 0);
  const ctx: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /request_user_input/);
  assert.match(ctx, /Plan mode/);
  assert.match(ctx, /Default mode/);
  assert.ok(ctx.includes(`${dataDir}/explain/${sessionStart().session_id}`));
  assert.doesNotMatch(ctx, /AskUserQuestion|skill ukagai-explain/);
  assert.ok(ctx.split("\n").length >= 5 && ctx.split("\n").length <= 8);
  assert.match(contextText("/d"), /AskUserQuestion/);
  assert.match(contextText("/d", "ja", "codex"), /Japanese/);
});
