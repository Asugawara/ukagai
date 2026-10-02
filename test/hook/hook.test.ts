import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEscapedQuestion } from "../../src/hook/context-hooks.js";
import { dataDirWithToken, fakeServer, json, runHook, tmpDir, writeFile, type Fake, type Handler } from "./helpers.js";

const fx = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url)), "utf8"));
const Q = "A と B のどちらにしますか？";
const NOW = () => new Date().toISOString();

const explanationFor = (q: string) => `---
ukagai: 1
question: ${q}
title: A と B のどちらにするか
reversibility: reversible
scope: file
recommended: A
---
## なぜ今この判断が要るか
決める必要がある。
## 選択肢
| 案 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| A | a | b |
| B | a | b |
## 推奨
A を推す。
`;

function t1(scratchpad: string, extra: Record<string, unknown> = {}) {
  return { ...fx("t1-stdin.json"), scratchpad_dir: scratchpad, ...extra };
}

const answerHandler = (answers: unknown): Handler => (req, res) => {
  if (req.method === "GET" && req.path.includes("/wait")) {
    return json(res, 200, { response: { via: "gui", answers, decided_at: NOW() } });
  }
  return false;
};

async function withServer<T>(handler: Handler, fn: (f: Fake, dataDir: string) => Promise<T>): Promise<T> {
  const f = await fakeServer(handler);
  try {
    return await fn(f, dataDirWithToken());
  } finally {
    await f.close();
  }
}

const args = (f: Fake, dataDir: string, ...rest: string[]) => ["--server", f.url, "--data-dir", dataDir, ...rest];

test("T1: GUI の回答が t1-stdout.json と一致し、ack が呼ばれる。説明ファイルは .used.md になる", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(answerHandler({ [Q]: "B" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), fx("t1-stdout.json"));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.auth, "Bearer test-token");
    assert.equal(create?.body.explanation.attached_via, "first_call");
    assert.equal(create?.body.explanation.match, "question");
    assert.equal(create?.body.kind, "answer_question");
    const ack = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions/dec-1/ack");
    assert.ok(ack);
    assert.deepEqual(ack.body, {});
    assert.ok(f.calls.filter((c) => c.method === "POST").every((c) => c.ctype === "application/json"));
    // ack が出力より先(wait → ack の順)
    const order = f.calls.map((c) => c.path);
    assert.ok(order.findIndex((p) => p.includes("/wait")) < order.indexOf("/api/decisions/dec-1/ack"));
  });
  assert.deepEqual(readdirSync(join(sp, "ukagai")), ["e.used.md"]);
});

test("multiSelect が stdin に無くてもフェイルオープンで落ちず出力する", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const input = t1(sp);
  delete input.tool_input.questions[0].multiSelect;
  await withServer(answerHandler({ [Q]: "A" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(input));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
  });
});

test("server 不在(閉じたポート)は stdout 空、exit 0、1.5 秒以内", async () => {
  const f = await fakeServer();
  const port = f.port;
  await f.close();
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const r = await runHook(["--server", `http://127.0.0.1:${port}`, "--data-dir", dataDirWithToken()], JSON.stringify(t1(sp)));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  // node + tsx の起動時間を除いた実処理が短いこと(起動込みで 1.5 秒)
  assert.ok(r.ms < 1500, `ms=${r.ms}`);
});

test("token が無ければ接続不可扱いで stdout 空", async () => {
  await withServer(() => false, async (f) => {
    const sp = tmpDir();
    writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
    const r = await runHook(args(f, tmpDir()), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(f.calls.length, 0);
  });
});

test("--budget 30(poll timeout 既定)なら poll せず fallback を送って stdout 空", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d, "--budget", "30"), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(!f.calls.some((c) => c.path.includes("/wait")));
    const ans = f.calls.find((c) => c.path === "/api/decisions/dec-1/answer");
    assert.deepEqual(ans?.body, { fallback: true });
  });
});

test("常に 204 の server: 残りが poll + 5 秒を切った時点で fallback", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const h: Handler = (req, res) => {
    if (req.path.includes("/wait")) {
      setTimeout(() => res.writeHead(204).end(), 400);
      return true;
    }
    return false;
  };
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d, "--budget", "6.3", "--poll-timeout-ms", "1000"), JSON.stringify(t1(sp)));
    assert.equal(r.stdout, "");
    assert.equal(f.calls.filter((c) => c.path.includes("/wait")).length, 1);
    assert.deepEqual(f.calls.at(-1)?.body, { fallback: true });
  });
});

test("wait が 404 なら stdout 空 exit 0", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer((req, res) => (req.path.includes("/wait") ? (res.writeHead(404).end(), true) : false), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(!f.calls.some((c) => c.path.endsWith("/ack")));
  });
});

test("via: terminal(GUI で「ターミナルで答える」)は stdout 空で ack もしない", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const h: Handler = (req, res) =>
    req.path.includes("/wait") ? json(res, 200, { response: { via: "terminal", decided_at: NOW() } }) : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.stdout, "");
    assert.ok(!f.calls.some((c) => c.path.endsWith("/ack")));
  });
});

test("説明ファイル無し → deny(保存先の絶対パスと question 原文)+ denied_explain を登録", async () => {
  const sp = tmpDir();
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.ok(out.permissionDecisionReason.includes(join(sp, "ukagai", "explain.md")));
    assert.ok(out.permissionDecisionReason.includes(Q));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.status, "denied_explain");
    assert.ok(!f.calls.some((c) => c.path.includes("/wait")));
  });
});

test("形式不備 → deny の理由に足りない項目名が入る", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q).replace(/\| B .*\n/, ""));
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /選択肢の表/);
  });
  assert.ok(existsSync(join(sp, "ukagai", "e.md")), "不備のファイルは rename しない");
});

test("--deny-template B で版 B の文面になる", async () => {
  const sp = tmpDir();
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d, "--deny-template", "B"), JSON.stringify(t1(sp)));
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /書いていただけますか/);
  });
});

const deniedRecord = (createdAt: string, extra: Record<string, unknown> = {}) => ({
  id: "old",
  kind: "answer_question",
  status: "denied_explain",
  created_at: createdAt,
  session: { session_id: "00000000-0000-4000-8000-000000000001", cwd: "/", transcript_path: "/" },
  request: { questions: [{ question: Q }] },
  ...extra,
});

test("2 分以内に denied_explain あり + ファイル無し → deny せず none / loop_guard で登録", async () => {
  const sp = tmpDir();
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [deniedRecord(new Date(Date.now() - 30_000).toISOString())])
      : req.path.includes("/wait")
        ? json(res, 200, { response: { via: "gui", answers: { [Q]: "A" }, decided_at: NOW() } })
        : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.attached_via, "none");
    assert.equal(create?.body.explanation.none_reason, "loop_guard");
    assert.equal(create?.body.status, undefined);
  });
});

test("2 分以内の denied_explain があり説明が付いた → after_deny + first_denied_at", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const at = new Date(Date.now() - 30_000).toISOString();
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [deniedRecord(at)])
      : answerHandler({ [Q]: "A" })(req, res);
  await withServer(h, async (f, d) => {
    await runHook(args(f, d), JSON.stringify(t1(sp)));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.attached_via, "after_deny");
    assert.equal(create?.body.first_denied_at, undefined, "first_denied_at は server が付ける");
  });
});

test("2 分より古い denied_explain はループ保険の対象外(再び deny)", async () => {
  const sp = tmpDir();
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [deniedRecord(new Date(Date.now() - 200_000).toISOString())])
      : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  });
});

test("permission_mode: plan → 説明ファイル無しでも deny せず none / plan_mode", async () => {
  const sp = tmpDir();
  await withServer(answerHandler({ [Q]: "A" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp, { permission_mode: "plan" })));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.attached_via, "none");
    assert.equal(create?.body.explanation.none_reason, "plan_mode");
  });
});

const planWith = (extra: string) => ({ ...fx("t5-stdin.json"), tool_input: { ...fx("t5-stdin.json").tool_input, plan: extra } });
const GOOD_PLAN = "# 計画\n\n## 影響範囲と可逆性\n1 ファイルだけ。revert で戻せる。\n";

test("T5: ExitPlanMode の approve → t5-stdout.json と一致(plan は不備でも 1 回目は deny されるので、節付きの計画で)", async () => {
  const input = fx("t5-stdin.json");
  const withImpact = { ...input, tool_input: { ...input.tool_input, plan: input.tool_input.plan + "\n## 影響範囲と可逆性\nなし。\n" } };
  const h: Handler = (req, res) =>
    req.path.includes("/wait") ? json(res, 200, { response: { via: "gui", approve: true, decided_at: NOW() } }) : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(withImpact));
    const expected = fx("t5-stdout.json");
    expected.hookSpecificOutput.updatedInput = withImpact.tool_input;
    assert.deepEqual(JSON.parse(r.stdout), expected);
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.kind, "approve_plan");
    assert.equal(create?.body.explanation.attached_via, "first_call");
    assert.ok(f.calls.some((c) => c.path.endsWith("/ack")));
  });
});

test("T5 の実 fixture(影響範囲の節なし): 1 回目は deny、2 回目(denied_explain あり)は loop_guard で登録し t5-stdout.json と一致", async () => {
  const input = fx("t5-stdin.json");
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(input));
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /影響範囲と可逆性/);
    assert.equal(f.calls.find((c) => c.method === "POST")?.body.status, "denied_explain");
  });
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [deniedRecord(new Date(Date.now() - 600_000).toISOString(), { kind: "approve_plan", request: { plan: "x" }, session: { session_id: input.session_id, cwd: "/", transcript_path: "/" } })])
      : req.path.includes("/wait")
        ? json(res, 200, { response: { via: "gui", approve: true, decided_at: NOW() } })
        : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(input));
    assert.deepEqual(JSON.parse(r.stdout), fx("t5-stdout.json"));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.none_reason, "loop_guard");
  });
});

test("ExitPlanMode の却下 → deny + reason。set_mode_auto の承認は allow(hook は何もしない)", async () => {
  const h = (response: object): Handler => (req, res) =>
    req.path.includes("/wait") ? json(res, 200, { response: { via: "gui", decided_at: NOW(), ...response } }) : false;
  await withServer(h({ approve: false, reason: "x" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planWith(GOOD_PLAN)));
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.equal(out.permissionDecisionReason, "x");
  });
  await withServer(h({ approve: true, set_mode_auto: true }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planWith(GOOD_PLAN)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(f.calls.filter((c) => c.path.includes("pending-mode-switch")).length, 0);
  });
});

const perm = (extra = {}) => ({
  session_id: "s1",
  transcript_path: "/t",
  cwd: "/c",
  hook_event_name: "PermissionRequest",
  tool_name: "Write",
  ...extra,
});

test("PermissionRequest: pending-mode-switch 有 → setMode auto を出して consume", async () => {
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path === "/api/sessions/s1/pending-mode-switch" ? json(res, 200, { pending: true }) : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(perm()));
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] },
      },
    });
    assert.ok(f.calls.some((c) => c.method === "POST" && c.path === "/api/sessions/s1/pending-mode-switch/consume"));
  });
});

test("PermissionRequest: 無 → 空。Write / Edit 以外も空", async () => {
  await withServer(() => false, async (f, d) => {
    assert.equal((await runHook(args(f, d), JSON.stringify(perm()))).stdout, "");
    assert.equal((await runHook(args(f, d), JSON.stringify(perm({ tool_name: "Bash" })))).stdout, "");
    assert.ok(!f.calls.some((c) => c.path.endsWith("/consume")));
  });
});

for (const ev of ["SessionStart", "SubagentStart"]) {
  test(`${ev} → additionalContext に scratchpad パスが入る(server 不要)`, async () => {
    const sp = "/private/tmp/x/scratchpad";
    const r = await runHook(
      ["--data-dir", tmpDir()],
      JSON.stringify({ session_id: "s1", transcript_path: "/t", cwd: "/c", scratchpad_dir: sp, hook_event_name: ev }),
    );
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, ev);
    assert.ok(out.additionalContext.includes(`${sp}/ukagai/`));
    assert.doesNotMatch(out.additionalContext, /https?:|\/api\//);
    assert.equal(out.additionalContext.split("\n").length, 4);
    assert.ok(out.additionalContext.includes("reversibility は reversible / costly / irreversible、scope は file / repo / machine / external"));
  });
}

test("SessionStart に scratchpad_dir が無ければ data-dir/explain/<session_id>", async () => {
  const dd = tmpDir();
  const r = await runHook(
    ["--data-dir", dd],
    JSON.stringify({ session_id: "s9", transcript_path: "/t", cwd: "/c", hook_event_name: "SessionStart" }),
  );
  assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes(join(dd, "explain", "s9")));
});

const stop = (msg: string) => ({
  session_id: "s1",
  transcript_path: "/t",
  cwd: "/c",
  hook_event_name: "Stop",
  last_assistant_message: msg,
});

test("Stop: 「どちらにしますか？」→ escaped_question: true の event。普通の文は付かない", async () => {
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(stop("A と B のどちらにしますか？")));
    assert.equal(r.stdout, "");
    const ev = f.calls.find((c) => c.path === "/api/events");
    assert.equal(ev?.body.escaped_question, true);
    assert.equal(ev?.body.hook_event_name, "Stop");
    assert.ok(typeof ev?.body.received_at === "string");
    await runHook(args(f, d), JSON.stringify(stop("完了しました。")));
    const evs = f.calls.filter((c) => c.path === "/api/events");
    assert.equal(evs[1]?.body.escaped_question, undefined);
  });
});

test("isEscapedQuestion: 末尾が ？/? のときだけ true(記号は無視、キーワードは見ない)", () => {
  assert.equal(isEscapedQuestion("A と B のどちらにしますか？"), true);
  assert.equal(isEscapedQuestion("次はどうしますか？**"), true);
  assert.equal(isEscapedQuestion("「どうしますか？」"), true);
  assert.equal(isEscapedQuestion("Which one?"), true);
  assert.equal(isEscapedQuestion("『A と B のどちらにしますか？』への回答は『A』でした。"), false);
  assert.equal(isEscapedQuestion("教えてください。"), false);
  assert.equal(isEscapedQuestion(undefined), false);
});

test("SessionEnd / UserPromptSubmit は event を送る", async () => {
  await withServer(() => false, async (f, d) => {
    for (const name of ["SessionEnd", "UserPromptSubmit"]) {
      await runHook(args(f, d), JSON.stringify({ ...stop("x"), hook_event_name: name }));
    }
    assert.deepEqual(f.calls.map((c) => c.body.hook_event_name), ["SessionEnd", "UserPromptSubmit"]);
  });
});

test("--observe: PreToolUse は start、PostToolUse は end を送り、stdout は空(deny も判断登録もしない)", async () => {
  const sp = tmpDir();
  await withServer(() => false, async (f, d) => {
    const pre = await runHook(args(f, d, "--observe"), JSON.stringify(t1(sp)));
    const post = await runHook(args(f, d, "--observe"), JSON.stringify(t1(sp, { hook_event_name: "PostToolUse" })));
    assert.equal(pre.stdout, "");
    assert.equal(post.stdout, "");
    assert.deepEqual(f.calls.map((c) => c.body.observe), [{ phase: "start" }, { phase: "end" }]);
    assert.ok(f.calls.every((c) => c.path === "/api/events"));
  });
});

test("壊れた JSON を stdin → 空 exit 0", async () => {
  const r = await runHook([], "{not json");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("server 不在でも無関係な tool は stdout 空 exit 0", async () => {
  const r = await runHook(["--server", "http://127.0.0.1:1", "--data-dir", tmpDir()], '{"tool_name":"Bash","hook_event_name":"PreToolUse"}');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

const multiInput = (sp: string, extra: Record<string, unknown> = {}) => {
  const base = t1(sp, extra) as { tool_input: { questions: unknown[] } };
  const q2 = { question: "C と D のどちらにしますか？", header: "選択2", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }], multiSelect: false };
  return { ...base, tool_input: { questions: [...base.tool_input.questions, q2] } };
};

test("多問 → 説明ファイルがあっても deny(1 回に 1 問)+ denied_explain 登録", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(multiInput(sp)));
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /1 回に 1 問にしてください\(今回は 2 問\)/);
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.status, "denied_explain");
    assert.equal(create?.body.explanation, undefined);
    assert.ok(!f.calls.some((c) => c.path.includes("/wait")));
  });
  assert.ok(existsSync(join(sp, "ukagai", "e.md")), "説明ファイルは消費しない");
});

test("多問 deny が 2 分以内にある → deny せず none / loop_guard で登録(質問文は照合しない)", async () => {
  const sp = tmpDir();
  const rec = deniedRecord(new Date(Date.now() - 30_000).toISOString(), {
    request: { questions: [{ question: "別の質問" }, { question: "もう一つ" }] },
  });
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [rec])
      : req.path.includes("/wait")
        ? json(res, 200, { response: { via: "gui", answers: { [Q]: "A" }, decided_at: NOW() } })
        : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(multiInput(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.attached_via, "none");
    assert.equal(create?.body.explanation.none_reason, "loop_guard");
  });
});

test("plan mode の多問 → 要求なしで none / plan_mode", async () => {
  const sp = tmpDir();
  await withServer(answerHandler({ [Q]: "A" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(multiInput(sp, { permission_mode: "plan" })));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.none_reason, "plan_mode");
  });
});
