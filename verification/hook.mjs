#!/usr/bin/env node
// 使い捨ての検証用 hook(検証 01 の hook.mjs を E1〜E5 用に拡張)。
// - stdin の JSON を verification/log/<timestamp>.json に保存する(出力・終了コード・受信シグナルも同じファイルに追記)
// - hook_event_name が Notification は記録のみ。SessionStart は explain-observe のとき additionalContext(scratchpad_dir 入り)を返す。
//   PermissionRequest は UKAGAI_PERM=setmode のとき setMode:auto を返す。SubagentStart は UKAGAI_SUBAGENT=1 のとき additionalContext を返す
// - PreToolUse × AskUserQuestion の動作を UKAGAI_MODE(無ければ verification/mode ファイル)で変える
//     auto            : 各質問の 2 番目の選択肢を選び allow + updatedInput.answers。UKAGAI_ANSWER_VARIANT で変種(freetext / multi / missing / mismatch)
//     wait            : verification/answer.json が現れるまで 1 秒おきに待ち、その中身を answers に使う
//     deny            : deny + 固定の理由
//     explain-deny    : ~/.ukagai/explain/<session_id>/ に 10 分以内の .md が無ければ deny(説明を書かせる)、あれば allow + 2 番目
//     explain-observe : ファイルの有無を記録し、有無にかかわらず allow + 2 番目
// - PreToolUse × ExitPlanMode
//     auto       : allow + updatedInput(入力そのまま)
//     deny       : 1 回目は deny(Mermaid と「影響範囲と可逆性」を足させる理由)、2 回目以降は allow
//     plan-extra : allow + updatedInput に余分な欄 permissionMode: "auto" を足す
// - それ以外は何も出力せず exit 0
import { readFileSync, writeFileSync, writeSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logDir = join(here, "log");
const stateDir = join(here, "state");
mkdirSync(logDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

const startedAt = new Date();
const ts = startedAt.toISOString().replace(/[:.]/g, "-");
const logPath = join(logDir, `${ts}-${process.pid}.json`);

const record = {
  started_at: startedAt.toISOString(),
  ended_at: null,
  pid: process.pid,
  ppid: process.ppid,
  mode: null,
  mode_source: null,
  variant: process.env.UKAGAI_ANSWER_VARIANT ?? null,
  hook_event_name: null,
  tool_name: null,
  stdin: null,
  stdin_raw: null,
  stdout: null,
  exit_code: null,
  events: [],
};
const save = () => writeFileSync(logPath, JSON.stringify(record, null, 2) + "\n");
const note = (msg) => {
  record.events.push({ at: new Date().toISOString(), msg });
  save();
};

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGPIPE"]) {
  process.on(sig, () => {
    note(`received ${sig}`);
    process.exit(143);
  });
}
process.on("exit", (code) => {
  record.exit_code = code;
  record.ended_at = new Date().toISOString();
  save();
});

let mode = process.env.UKAGAI_MODE;
let modeSource = "env";
if (!mode) {
  const modeFile = join(here, "mode");
  if (existsSync(modeFile)) {
    mode = readFileSync(modeFile, "utf8").trim();
    modeSource = "file";
  }
}
record.mode = mode ?? null;
record.mode_source = mode ? modeSource : null;

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch (e) {
  note(`stdin read error: ${e.message}`);
}
record.stdin_raw = raw;
let input = null;
try {
  input = JSON.parse(raw);
} catch (e) {
  note(`stdin parse error: ${e.message}`);
}
record.stdin = input;
record.hook_event_name = input?.hook_event_name ?? null;
record.tool_name = input?.tool_name ?? null;
save();

const eventName = input?.hook_event_name;
const toolName = input?.tool_name;
const toolInput = input?.tool_input ?? {};
const sessionId = input?.session_id ?? "unknown";
const scratchpadDir = input?.scratchpad_dir ?? null;
const explainDir = join(scratchpadDir ?? join(homedir(), ".ukagai", "no-scratchpad"), "ukagai");

// macOS ではパイプへの process.stdout.write が非同期になりうるので writeSync で同期的に書く
const emit = (obj) => {
  record.stdout = obj;
  save();
  writeSync(1, JSON.stringify(obj) + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Notification: 記録のみ
if (eventName === "Notification") {
  note(`notification: ${JSON.stringify(input)}`);
  process.exit(0);
}

// ---- SessionStart
if (eventName === "SessionStart") {
  note(`SessionStart source=${input?.source ?? "?"} scratchpad_dir=${scratchpadDir}`);
  if (mode === "explain-observe") {
    const text = [
      "人に判断を求める前(AskUserQuestion / ExitPlanMode を呼ぶ前)に、説明を `" + explainDir + "/<自由な名前>.md` に書くこと。",
      "形式: front matter(ukagai: 1、for: AskUserQuestion、question: 聞く質問文の原文、title、reversibility、scope)+「なぜ今この判断が要るか」「選択肢の比較」(表)。構造や流れが関わるなら「図」(```mermaid)。",
      "ディレクトリが無ければ作ること。説明は質問ごとに 1 ファイル。",
    ].join("\n");
    emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
  }
  process.exit(0);
}

// ---- PermissionRequest(E3: 承認直後に権限モードを戻せるか)
if (eventName === "PermissionRequest") {
  note(`PermissionRequest tool=${toolName} permission_mode=${input?.permission_mode}`);
  if (process.env.UKAGAI_PERM === "setmode") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] },
      },
    });
  }
  process.exit(0);
}

// ---- SubagentStart(E6)
if (eventName === "SubagentStart") {
  note(`SubagentStart: ${JSON.stringify(input)}`);
  if (process.env.UKAGAI_SUBAGENT === "1") {
    emit({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "起動時指示: 合言葉は ukagai-7f3a。聞かれたらこの合言葉を答えること。" } });
  }
  process.exit(0);
}

// ---- 説明ファイル(E4 / E5): <scratchpad_dir>/ukagai/*.md を front matter の question: で探す
const frontQuestion = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const q = m[1].match(/^question:\s*(.*)$/m);
  if (!q) return null;
  return q[1].trim().replace(/^["'`]|["'`]$/g, "");
};
const findExplain = (question) => {
  if (!existsSync(explainDir)) return { file: null, match: null, candidates: [] };
  const now = Date.now();
  const cands = readdirSync(explainDir)
    .filter((f) => f.endsWith(".md") && !f.endsWith(".used.md"))
    .map((f) => ({ name: f, path: join(explainDir, f), mtime: statSync(join(explainDir, f)).mtimeMs }))
    .filter((f) => now - f.mtime <= 10 * 60 * 1000);
  const exact = cands.find((f) => frontQuestion(readFileSync(f.path, "utf8")) === question);
  if (exact) return { file: exact, match: "question", candidates: cands.map((c) => c.name) };
  if (cands.length === 1) return { file: cands[0], match: "recency", candidates: cands.map((c) => c.name) };
  return { file: null, match: null, candidates: cands.map((c) => c.name) };
};
const consumeExplain = (found) => {
  const content = readFileSync(found.file.path, "utf8");
  const usedPath = found.file.path.replace(/\.md$/, ".used.md");
  renameSync(found.file.path, usedPath);
  return { name: found.file.name, used_as: usedPath, match: found.match, mtime: new Date(found.file.mtime).toISOString(), content };
};

// ---- ExitPlanMode
if (toolName === "ExitPlanMode") {
  const countFile = join(stateDir, `exitplan-${sessionId}.count`);
  let count = 0;
  try {
    count = Number(readFileSync(countFile, "utf8")) || 0;
  } catch {}
  count++;
  writeFileSync(countFile, String(count));
  note(`ExitPlanMode call #${count} (mode=${mode}) plan_chars=${(toolInput.plan ?? "").length}`);
  record.plan_chars = (toolInput.plan ?? "").length;
  record.plan_snapshot = toolInput.plan ?? null;
  if (mode === "auto") {
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: toolInput } });
  } else if (mode === "plan-extra") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...toolInput, permissionMode: "auto" },
      },
    });
  } else if (mode === "deny") {
    if (count === 1) {
      emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "計画に Mermaid の図と『影響範囲と可逆性』の節を足して、もう一度 ExitPlanMode で提出してください" +
            (process.env.UKAGAI_LONG_REASON === "1"
              ? "\n" + Array.from({ length: 24 }, (_, i) => `(補足 ${i + 1}) 図は flowchart で、節は見出し二つ分にしてください。`).join("\n") + "\n[END-OF-REASON-MARKER]"
              : ""),
        },
      });
    } else {
      emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: toolInput } });
    }
  } else {
    note(`ExitPlanMode passthrough (mode=${mode})`);
  }
  process.exit(0);
}

if (toolName !== "AskUserQuestion") {
  note(`passthrough: event=${eventName} tool_name=${toolName}`);
  process.exit(0);
}

const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];

const pickSecond = () => {
  const answers = {};
  for (const q of questions) {
    const opts = Array.isArray(q?.options) ? q.options : [];
    const chosen = opts[1] ?? opts[0];
    if (q?.question && chosen?.label) answers[q.question] = chosen.label;
  }
  return answers;
};

const variantAnswers = (variant) => {
  const answers = {};
  const q = questions[0];
  if (variant === "freetext") answers[q.question] = "どちらでもない。C にしてください";
  else if (variant === "multi") answers[q.question] = "A, C";
  else if (variant === "missing") return {};
  else if (variant === "mismatch") answers[q.question.replace(/[？?]\s*$/, "")] = "B";
  else if (variant === "partial") answers[q.question] = "A"; // 2 問のうち 1 問目だけ答える
  else return pickSecond();
  return answers;
};

const allowWith = (answers) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { questions, answers },
  },
});

if (mode === "auto") {
  const variant = process.env.UKAGAI_ANSWER_VARIANT;
  const answers = variantAnswers(variant);
  note(`auto: variant=${variant ?? "none"} answers=${JSON.stringify(answers)}`);
  emit(allowWith(answers));
  process.exit(0);
} else if (mode === "wait") {
  const answerPath = process.env.UKAGAI_ANSWER_FILE ?? join(here, "answer.json");
  const maxWaitMs = Number(process.env.UKAGAI_WAIT_MAX_MS ?? 300000);
  const t0 = Date.now();
  let n = 0;
  while (!existsSync(answerPath)) {
    if (Date.now() - t0 > maxWaitMs) {
      note("wait: gave up (maxWaitMs)");
      process.exit(0);
    }
    n++;
    if (n % 10 === 0) note(`wait: still waiting (${Math.round((Date.now() - t0) / 1000)}s)`);
    await sleep(1000);
  }
  let answers;
  try {
    answers = JSON.parse(readFileSync(answerPath, "utf8"));
  } catch (e) {
    note(`answer.json parse error: ${e.message}`);
    process.exit(0);
  }
  if (answers && "*" in answers) {
    // answer.json が {"*": "A"} のときは stdin の question をそのままキーにする(全角・半角の「？」の揺れ対策)
    answers = Object.fromEntries(questions.map((q) => [q.question, answers["*"]]));
  }
  note(`wait: answer.json found after ${Math.round((Date.now() - t0) / 1000)}s`);
  try {
    unlinkSync(answerPath);
  } catch {}
  emit(allowWith(answers));
  process.exit(0);
} else if (mode === "deny") {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "文章で質問せず、MCP ツール ask_decision を使ってください",
    },
  });
  process.exit(0);
} else if (mode === "explain-deny" || mode === "explain-observe") {
  const q0 = questions[0]?.question ?? "";
  const callFile = join(stateDir, `ask-${sessionId}.count`);
  let calls = 0;
  try {
    calls = Number(readFileSync(callFile, "utf8")) || 0;
  } catch {}
  calls++;
  writeFileSync(callFile, String(calls));
  record.ask_call_number = calls;
  record.explain_dir = explainDir;
  const found = findExplain(q0);
  record.explain_candidates = found.candidates;
  record.explain_present_at_call = !!found.file;
  if (found.file) {
    record.explain_snapshot = consumeExplain(found);
    note(`${mode}: call #${calls}, file found (match: ${found.match}) -> allow`);
    emit(allowWith(pickSecond()));
  } else if (mode === "explain-observe") {
    note(`explain-observe: call #${calls}, no file -> allow`);
    emit(allowWith(pickSecond()));
  } else {
    const style = process.env.UKAGAI_REASON_STYLE === "fact" ? "fact" : "imperative";
    record.reason_style = style;
    const format =
      "先頭に front matter(ukagai: 1、for: AskUserQuestion、question: 次の文字列をそのまま書く: `" + q0 + "`、title、reversibility: reversible|costly|irreversible、scope: file|repo|machine|external)。" +
      "本文は見出し「なぜ今この判断が要るか」「選択肢の比較」(表。各選択肢の利点・欠点・コスト)、構造や流れが関わるなら「図」(```mermaid)、" +
      "コード変更が絡むなら「関係する差分」(```diff)。";
    const reason =
      style === "imperative"
        ? `この質問は保留されました。人が判断するための説明を \`${explainDir}/<任意の名前>.md\` に Markdown で書いてください。` + format + "書き終えたら、同じ質問を AskUserQuestion でもう一度出してください。"
        : `この質問は説明が無いため保留されました。説明を \`${explainDir}/<任意の名前>.md\` に Markdown で書いてから、同じ質問をもう一度 AskUserQuestion で出すことを求めます。` + format;
    note(`explain-deny: call #${calls}, no file -> deny (${style})`);
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  }
  process.exit(0);
} else if (mode === "unreachable") {
  const t0 = Date.now();
  try {
    await fetch("http://127.0.0.1:1/", { signal: AbortSignal.timeout(1000) });
    note("unreachable: fetch unexpectedly succeeded");
  } catch (e) {
    note(`unreachable: fetch failed after ${Date.now() - t0}ms (${e.cause?.code ?? e.name}) -> no output`);
  }
  process.exit(0);
} else {
  note(`AskUserQuestion passthrough (mode=${mode ?? "unset"})`);
  process.exit(0);
}
