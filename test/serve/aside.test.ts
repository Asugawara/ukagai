// Aside (side questions): the fork's command line, prompt, streaming, stop / timeout / errors, and the routes in front of them.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsideEntry, AsideThread, AsideUpdated } from "../../src/contract.js";
import { buildPrompt, claudeArgs, codexArgs, newParseState, parseClaudeLine, parseCodexLine } from "../../src/serve/aside.js";
import { start, type ServeHandle, type ServeOptions } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-aside-"));
  roots.push(d);
  return d;
};
const fixture = (name: string) => readFileSync(new URL(`../fixtures/aside/${name}`, import.meta.url), "utf8");

type Env = { h: ServeHandle; url: string; out: string; cwd: string; transcript: string; rollout: string };

/** A fake agent binary (POSIX sh): saves argv / stdin / env / cwd under `out`, then runs `body` */
function fake(dir: string, name: string, out: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}/${name}.argv'\ncat > '${out}/${name}.stdin'\nenv > '${out}/${name}.env'\npwd > '${out}/${name}.cwd'\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

async function boot(claude: string, codex = "true", extra: Partial<ServeOptions> = {}): Promise<Env> {
  const root = tmp();
  const out = join(root, "out");
  const bin = join(root, "bin");
  const cwd = join(root, "work");
  for (const d of [out, bin, cwd]) mkdirSync(d);
  const transcript = join(root, "s1.jsonl");
  writeFileSync(transcript, ['{"type":"user"}', '{"type":"assistant","message":{"model":"claude-haiku-5-5"}}', '{"type":"system"}'].join("\n") + "\n");
  const h = await start({
    port: 0,
    dataDir: join(root, "data"),
    home: root,
    recapPollMs: 60000,
    asideBins: { claude: fake(bin, "claude", out, claude), codex: fake(bin, "codex", out, codex) },
    ...extra,
  });
  handles.push(h);
  const rollout = join(root, ".codex", "sessions", "rollout.jsonl");
  mkdirSync(join(root, ".codex", "sessions"), { recursive: true });
  writeFileSync(rollout, "{}\n");
  const env = { h, url: `http://127.0.0.1:${h.port}`, out, cwd, transcript, rollout };
  await api(env, "/api/events", { session_id: "s1", transcript_path: transcript, cwd, hook_event_name: "PreToolUse", received_at: new Date().toISOString() });
  return env;
}

const api = (env: Env, path: string, body?: unknown, method?: string) =>
  fetch(env.url + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ask = (env: Env, question = "why?", more: Record<string, unknown> = {}, sid = "s1") => api(env, `/api/sessions/${sid}/aside`, { question, decision_id: "d1", ...more });
const thread = async (env: Env, sid = "s1") => (await (await api(env, `/api/sessions/${sid}/aside`)).json()) as AsideThread;
async function settled(env: Env, sid = "s1"): Promise<AsideEntry> {
  for (let i = 0; i < 400; i++) {
    const last = (await thread(env, sid)).entries.at(-1);
    if (last && last.status !== "running") return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("still running");
}
const read = (env: Env, file: string) => readFileSync(join(env.out, file), "utf8");

/** A Codex session: a decision carries the agent (the event stream does not) */
async function codexSession(env: Env, sid: string, transcript_path: string): Promise<void> {
  // Bridge-registered plan decisions carry transcript_path "" although the rollout exists
  const r = await api(env, "/api/decisions", {
    tool_use_id: `t_${sid}`,
    kind: "approve_plan",
    session: { session_id: sid, cwd: env.cwd, transcript_path, agent: "codex" },
    request: { plan: "# P\n\nbody", planFilePath: join(env.cwd, "plan.md") },
  });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
}

const CLAUDE_OK = `cat <<'JSONL'\n${fixture("claude-fork.jsonl")}JSONL`;

test("Claude: a read-only, hook-less, unsaved fork of the session; the question goes in on stdin", async () => {
  process.env["CLAUDECODE"] = "1";
  process.env["CLAUDE_CODE_ENTRYPOINT"] = "cli";
  process.env["UKAGAI_TOKEN_X"] = "secret";
  try {
    const env = await boot(CLAUDE_OK);
    const r = await ask(env, "Which option is safer?", { quote: { source: "option", text: "keep the queue" } });
    assert.equal(r.status, 202);
    const { entry } = (await r.json()) as { entry: AsideEntry };
    assert.equal(entry.status, "running");
    const done = await settled(env);
    assert.equal(done.id, entry.id);
    assert.equal(done.status, "done");
    assert.equal(done.answer, "PINEAPPLE-42");
    assert.equal(done.usage?.cache_read_tokens, 17808);
    assert.equal(done.usage?.output_tokens, 12);
    assert.ok((done.usage?.cost_usd ?? 0) > 0);
    assert.ok(done.finished_at);

    const argv = read(env, "claude.argv").trim().split("\n");
    assert.deepEqual(argv, [
      "-p", "--resume", "s1", "--fork-session", "--no-session-persistence",
      "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--allowedTools", "Read,Grep,Glob", "--permission-mode", "dontAsk",
      "--settings", '{"disableAllHooks":true}', "--model", "claude-haiku-5-5",
    ]); // prettier-ignore
    assert.ok(!argv.includes("--tools"));
    assert.ok(!argv.some((a) => a.includes("Which option")), "the question is not in argv");
    assert.equal(read(env, "claude.cwd").trim(), readFileSync(join(env.out, "claude.cwd"), "utf8").trim());
    assert.ok(read(env, "claude.cwd").trim().endsWith("work"));

    const stdin = read(env, "claude.stdin");
    assert.match(stdin, /^\[ukagai\] Side question from the human/);
    assert.match(stdin, /Quoted from the option: "keep the queue"/);
    assert.match(stdin, /Question: Which option is safer\?\n$/);

    const envLines = read(env, "claude.env");
    assert.ok(!/^CLAUDECODE=/m.test(envLines) && !/^CLAUDE_CODE_/m.test(envLines) && !/^UKAGAI_/m.test(envLines), "markers of the parent are scrubbed");
    assert.match(envLines, /^PATH=/m);
  } finally {
    delete process.env["CLAUDECODE"];
    delete process.env["CLAUDE_CODE_ENTRYPOINT"];
    delete process.env["UKAGAI_TOKEN_X"];
  }
});

test("Claude: no --model when the transcript has no assistant line", () => {
  assert.ok(!claudeArgs("s", undefined).includes("--model"));
  assert.deepEqual(claudeArgs("s", "m").slice(-2), ["--model", "m"]);
});

test("Codex: exec fork, ephemeral, hooks off, read-only; the noisy stderr line is not an error", async () => {
  const env = await boot("true", `echo "Custom tool call output is missing for call id call_1" >&2\ncat <<'JSONL'\n${fixture("codex-fork-long.jsonl")}JSONL`);
  await codexSession(env, "c1", "");
  const r = await ask(env, "what now?", {}, "c1");
  assert.equal(r.status, 202);
  const done = await settled(env, "c1");
  assert.equal(done.status, "done");
  assert.equal(done.answer, "LIME-5");
  assert.equal(done.error, undefined);
  assert.deepEqual(done.usage, { input_tokens: 16387, output_tokens: 8 });
  assert.deepEqual(read(env, "codex.argv").trim().split("\n"), [
    "exec", "fork", "c1", "--ephemeral", "--json", "--skip-git-repo-check", "--disable", "hooks",
    "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "-",
  ]); // prettier-ignore
  assert.deepEqual(codexArgs("c1").slice(0, 4), ["exec", "fork", "c1", "--ephemeral"]);
  assert.match(read(env, "codex.stdin"), /Question: what now\?/);
  assert.equal((await thread(env, "c1")).agent, "codex");
  assert.equal((await thread(env, "c1")).available, true, "an empty transcript_path (codex bridge) is not unavailable");
});

test("Codex: commands are traced once (started, then completed); the last agent message is the answer", () => {
  const st = newParseState();
  for (const line of fixture("codex-fork.jsonl").split("\n")) if (line) parseCodexLine(st, line);
  assert.equal(st.answer, "MANGO-77");
  const long = newParseState();
  const lines = [
    '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"first"}}',
    '{"type":"item.started","item":{"id":"i2","type":"command_execution","command":"ls -la","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"ls -la","status":"completed"}}',
    '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"final"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}',
    "not json",
  ];
  for (const l of lines) parseCodexLine(long, l);
  assert.deepEqual(long.trace, [{ kind: "command", label: "ls -la" }]);
  assert.equal(long.answer, "final");
  assert.deepEqual(long.usage, { input_tokens: 10, output_tokens: 2, cache_read_tokens: 4 });
  parseCodexLine(long, '{"type":"turn.failed","error":{"message":"quota"}}');
  assert.equal(long.error, "quota");
});

test("Claude parser: deltas stream, a new message resets them, tool uses are traced, `result` is authoritative", () => {
  const st = newParseState();
  const delta = (text: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  const msg = JSON.stringify({ type: "stream_event", event: { type: "message_start", message: {} } });
  parseClaudeLine(st, msg);
  parseClaudeLine(st, delta("Let me "));
  parseClaudeLine(st, delta("look."));
  assert.equal(st.answer, "Let me look.");
  const use = (name: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "u", name, input }] } });
  parseClaudeLine(st, use("Read", { file_path: "/w/a.ts" }));
  parseClaudeLine(st, use("Grep", { pattern: "foo", path: "/w" }));
  parseClaudeLine(st, use("Glob", { pattern: "**/*.md" }));
  parseClaudeLine(st, use("WebFetch", { url: "x" }));
  assert.deepEqual(st.trace, [
    { kind: "read", label: "/w/a.ts" },
    { kind: "search", label: "foo" },
    { kind: "search", label: "**/*.md" },
    { kind: "tool", label: "WebFetch" },
  ]);
  parseClaudeLine(st, msg);
  assert.equal(st.answer, "");
  parseClaudeLine(st, delta("Answer"));
  parseClaudeLine(st, JSON.stringify({ type: "result", is_error: false, result: "Final answer", total_cost_usd: 0.5, usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 100 } }));
  assert.equal(st.answer, "Final answer");
  assert.deepEqual(st.usage, { input_tokens: 3, output_tokens: 7, cache_read_tokens: 100, cost_usd: 0.5 });
  parseClaudeLine(st, JSON.stringify({ type: "result", is_error: true, result: "boom" }));
  assert.equal(st.error, "boom");
});

test("the answer is cut at 64 KiB", () => {
  const st = newParseState();
  parseClaudeLine(st, JSON.stringify({ type: "result", result: "x".repeat(100 * 1024) }));
  assert.ok(Buffer.byteLength(st.answer) <= 64 * 1024 + 3);
  assert.ok(st.answer.endsWith("…"));
});

test("prompt: kind and title, the rules, earlier Q&A (latest of a chain), the quote, then the question", () => {
  const e = (id: string, question: string, answer: string, extra: Partial<AsideEntry> = {}): AsideEntry => ({
    id, decision_id: "d", question, answer, trace: [], status: "done", created_at: "t", ...extra,
  }); // prettier-ignore
  const p = buildPrompt({
    pending: { kind: "plan", title: "Retry plan" },
    question: "and step 3?",
    quote: { source: "plan", text: "cap at 30 s" },
    history: [
      e("a", "first q", "first a"),
      e("b", "second q", "old answer"),
      e("b2", "second q", "new answer", { regenerate_of: "b" }),
      e("c", "failed q", "", { status: "error" }),
    ],
  });
  assert.match(p, /^\[ukagai\] Side question from the human, asked while your plan "Retry plan" waits in ukagai\.\n/);
  assert.match(p, /change nothing and ask nothing back/);
  assert.match(p, /not part of your main conversation; the human answers the pending plan separately/);
  assert.match(p, /Q: first q\nA: first a/);
  assert.match(p, /Q: second q\nA: new answer/);
  assert.ok(!p.includes("old answer") && !p.includes("failed q"));
  assert.match(p, /Quoted from the plan: "cap at 30 s"\nQuestion: and step 3\?\n$/);
  assert.ok(p.indexOf("Earlier side questions") < p.indexOf("Quoted from"));
});

test("prompt: at most 6 earlier Q&A and 8,000 chars, oldest dropped first", () => {
  const e = (i: number, answer: string): AsideEntry => ({ id: `e${i}`, decision_id: "d", question: `q${i}`, answer, trace: [], status: "done", created_at: "t" });
  const six = buildPrompt({ question: "x", history: Array.from({ length: 9 }, (_, i) => e(i, "a")) });
  assert.ok(!six.includes("Q: q2\n") && six.includes("Q: q3\n") && six.includes("Q: q8\n"));
  const big = buildPrompt({ question: "x", history: [e(1, "z".repeat(5000)), e(2, "y".repeat(5000))] });
  assert.ok(!big.includes("z") && big.includes("y"));
});

test("streaming: aside.updated carries the growing answer and the trace, then the final entry", async () => {
  const line = (o: object) => JSON.stringify(o).replace(/'/g, "'\\''");
  const delta = (t: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
  const body = [
    `echo '${line({ type: "stream_event", event: { type: "message_start", message: {} } })}'`,
    `echo '${line(delta("Hel"))}'`,
    `echo '${line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/w/x.ts" } }] } })}'`,
    "sleep 0.4",
    `echo '${line(delta("lo"))}'`,
    "sleep 0.4",
    `echo '${line({ type: "result", result: "Hello", usage: { input_tokens: 1, output_tokens: 2 } })}'`,
  ].join("\n");
  const env = await boot(body);
  const ac = new AbortController();
  const res = await fetch(env.url + "/api/stream", { headers: { authorization: `Bearer ${env.h.token}` }, signal: ac.signal });
  const events: AsideUpdated[] = [];
  const pump = (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith("event: aside.updated")) events.push(JSON.parse(block.split("data: ")[1]!) as AsideUpdated);
        }
      }
    } catch {
      // aborted
    }
  })();
  await ask(env);
  await settled(env);
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  await pump;
  assert.ok(events.length >= 3, `got ${events.length} events`);
  assert.equal(events[0]!.entry.status, "running");
  assert.equal(events[0]!.session_id, "s1");
  const mid = events.find((ev) => ev.entry.status === "running" && ev.entry.answer.length > 0);
  assert.ok(mid, "a progress event with part of the answer");
  assert.ok(mid.entry.answer.startsWith("Hel"));
  assert.deepEqual(mid.entry.trace, [{ kind: "read", label: "/w/x.ts" }]);
  const last = events.at(-1)!.entry;
  assert.equal(last.status, "done");
  assert.equal(last.answer, "Hello");
  assert.ok(new Set(events.map((ev) => ev.entry.id)).size === 1);
});

test("a second question while one runs is a 409; DELETE stops it and kills the process", async () => {
  const env = await boot(`echo $$ > '${"$OUT"}'\nexec sleep 30`.replace("'$OUT'", "\"$0.pid\""));
  const r = await ask(env);
  assert.equal(r.status, 202);
  const { entry } = (await r.json()) as { entry: AsideEntry };
  const second = await ask(env, "another");
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: "running" });
  let pid = 0;
  for (let i = 0; i < 100 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const f = join(env.out, "..", "bin", "claude.pid");
    if (existsSync(f)) pid = Number(readFileSync(f, "utf8").trim());
  }
  assert.ok(pid > 0, "the fake agent started");
  const del = await api(env, "/api/sessions/s1/aside/running", undefined, "DELETE");
  assert.equal(del.status, 200);
  const stopped = ((await del.json()) as { entry: AsideEntry }).entry;
  assert.equal(stopped.id, entry.id);
  assert.equal(stopped.status, "cancelled");
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    await new Promise((r) => setTimeout(r, 30));
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the process is gone");
  assert.equal((await thread(env)).entries[0]!.status, "cancelled");
  assert.equal((await api(env, "/api/sessions/s1/aside/running", undefined, "DELETE")).status, 404);
  // The slot is free again
  assert.equal((await ask(env)).status, 202);
});

test("a run past the time limit is killed and ends as an error", async () => {
  const env = await boot("exec sleep 30", "true", { asideTimeoutMs: 300, asideKillGraceMs: 200 });
  await ask(env);
  const done = await settled(env);
  assert.equal(done.status, "error");
  assert.match(done.error ?? "", /^timed out after \d+ s$/);
});

test("a non-zero exit without an answer is an error carrying the stderr tail", async () => {
  const env = await boot("echo 'No conversation found with session ID: s1' >&2\nexit 1");
  await ask(env);
  const done = await settled(env);
  assert.equal(done.status, "error");
  assert.match(done.error ?? "", /No conversation found/);
  assert.equal(done.answer, "");
});

test("`result` with is_error ends as an error with its text", async () => {
  const env = await boot(`echo '{"type":"result","is_error":true,"result":"Credit balance is too low"}'`);
  await ask(env);
  const done = await settled(env);
  assert.equal(done.status, "error");
  assert.equal(done.error, "Credit balance is too low");
});

test("a regenerated entry re-asks the question and quote of the first, and the history uses the latest of the chain", async () => {
  const env = await boot(CLAUDE_OK);
  const first = (await (await ask(env, "original?", { quote: { source: "explanation", text: "the cache" } })).json()) as { entry: AsideEntry };
  await settled(env);
  const re = (await (await ask(env, "ignored", { regenerate_of: first.entry.id })).json()) as { entry: AsideEntry };
  assert.equal(re.entry.question, "original?");
  assert.deepEqual(re.entry.quote, { source: "explanation", text: "the cache" });
  assert.equal(re.entry.regenerate_of, first.entry.id);
  await settled(env);
  await ask(env, "next one");
  await settled(env);
  const stdin = read(env, "claude.stdin");
  assert.equal(stdin.match(/Q: original\?/g)?.length, 1, "one Q&A for the chain");
  assert.equal((await ask(env, "x", { regenerate_of: "nope" })).status, 400);
});

test("the thread survives the decision: separators come from decision_id / title; entries are kept oldest first", async () => {
  const env = await boot(CLAUDE_OK);
  await ask(env, "one");
  await settled(env);
  await api(env, "/api/sessions/s1/aside", { question: "two", decision_id: "d2" });
  await settled(env);
  const t = await thread(env);
  assert.equal(t.available, true);
  assert.deepEqual(t.entries.map((e) => [e.question, e.decision_id]), [["one", "d1"], ["two", "d2"]]);
});

test("routes: unknown session 404, unavailable 400, bad body 400, no empty thread for a known session", async () => {
  const env = await boot(CLAUDE_OK);
  assert.equal((await api(env, "/api/sessions/nope/aside")).status, 404);
  assert.equal((await ask(env, "q", {}, "nope")).status, 404);
  const empty = await thread(env);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.agent, "claude");
  await api(env, "/api/events", { session_id: "u1", transcript_path: env.transcript, cwd: "", hook_event_name: "PreToolUse", received_at: new Date().toISOString() });
  const gone = await ask(env, "q", {}, "u1");
  assert.equal(gone.status, 400);
  const body = (await gone.json()) as { error: string; reason: string };
  assert.equal(body.error, "unavailable");
  assert.match(body.reason, /working directory/);
  assert.equal((await thread(env, "u1")).available, false);
  assert.equal((await api(env, "/api/sessions/s1/aside", { question: "", decision_id: "d1" })).status, 400);
  assert.equal((await api(env, "/api/sessions/s1/aside", { question: "q" })).status, 400);
  // cwd / transcript / agent are never taken from the body
  assert.equal((await api(env, "/api/sessions/s1/aside", { question: "q", decision_id: "d", cwd: "/etc" })).status, 400);
});

test("auth: no token is 401 on all three routes; a POST must be JSON", async () => {
  const env = await boot(CLAUDE_OK);
  for (const [method, path] of [["GET", "/api/sessions/s1/aside"], ["POST", "/api/sessions/s1/aside"], ["DELETE", "/api/sessions/s1/aside/running"]] as const) {
    const r = await fetch(env.url + path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
  const text = await fetch(env.url + "/api/sessions/s1/aside", { method: "POST", headers: { authorization: `Bearer ${env.h.token}`, "content-type": "text/plain" }, body: "{}" });
  assert.equal(text.status, 415);
});

test("Codex: a thread without a rollout is not refused up front; the fork's own error (stderr tail) is shown", async () => {
  const env = await boot("true", "echo 'Error: no rollout found for thread id c3' >&2\nexit 1");
  await codexSession(env, "c3", "");
  assert.equal((await ask(env, "q", {}, "c3")).status, 202);
  const done = await settled(env, "c3");
  assert.equal(done.status, "error");
  assert.match(done.error ?? "", /no rollout found/);
});

test("DELETE kills the whole process tree: a sleeping grandchild is gone too", async () => {
  const env = await boot(`sleep 30 &\necho $! > "$0.child"\nwait`);
  assert.equal((await ask(env)).status, 202);
  const f = join(env.out, "..", "bin", "claude.child");
  let pid = 0;
  for (let i = 0; i < 100 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (existsSync(f)) pid = Number(readFileSync(f, "utf8").trim());
  }
  assert.ok(pid > 0, "the grandchild started");
  process.kill(pid, 0);
  assert.equal((await api(env, "/api/sessions/s1/aside/running", undefined, "DELETE")).status, 200);
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    await new Promise((r) => setTimeout(r, 30));
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the grandchild is gone");
});
