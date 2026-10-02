#!/usr/bin/env node
// 使い捨ての検証用 PreToolUse hook。
// - stdin の JSON を verification/log/<timestamp>.json に保存する(hook の出力・終了コード・受信シグナルも同じファイルに追記)
// - tool_name が AskUserQuestion のとき、UKAGAI_MODE(無ければ verification/mode ファイル)で動作を変える
//     auto : 各質問の 2 番目の選択肢を選び allow + updatedInput.answers を返す
//     wait : verification/answer.json が現れるまで 1 秒おきに待ち、その中身を answers に使う
//     deny : deny + permissionDecisionReason を返す
// - tool_name が ExitPlanMode のとき(T5 用)、auto なら allow + updatedInput(入力をそのまま返す)
// - それ以外は何も出力せず exit 0
import { readFileSync, writeFileSync, writeSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logDir = join(here, "log");
mkdirSync(logDir, { recursive: true });

const startedAt = new Date();
const ts = startedAt.toISOString().replace(/[:.]/g, "-");
const logPath = join(logDir, `${ts}.json`);

const record = {
  started_at: startedAt.toISOString(),
  ended_at: null,
  pid: process.pid,
  ppid: process.ppid,
  mode: null,
  mode_source: null,
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
record.tool_name = input?.tool_name ?? null;
save();

const toolName = input?.tool_name;
const toolInput = input?.tool_input ?? {};

// macOS ではパイプへの process.stdout.write が非同期になりうるので writeSync で同期的に書く
const emit = (obj) => {
  record.stdout = obj;
  save();
  writeSync(1, JSON.stringify(obj) + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (toolName === "ExitPlanMode") {
  if (mode === "auto") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: toolInput,
      },
    });
  } else if (mode === "deny") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "計画の承認は MCP ツール approve_plan で求めてください",
      },
    });
  } else {
    note(`ExitPlanMode passthrough (mode=${mode})`);
  }
  process.exit(0);
}

if (toolName !== "AskUserQuestion") {
  note(`passthrough: tool_name=${toolName}`);
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

const allowWith = (answers) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { questions, answers },
  },
});

if (mode === "auto") {
  emit(allowWith(pickSecond()));
  process.exit(0);
} else if (mode === "wait") {
  const answerPath = join(here, "answer.json");
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
} else {
  note(`AskUserQuestion passthrough (mode=${mode ?? "unset"})`);
  process.exit(0);
}
