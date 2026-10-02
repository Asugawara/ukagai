#!/usr/bin/env node
// Throwaway verification hook (the hook.mjs from verification 01, extended for E1 to E5).
// - Saves the stdin JSON to verification/log/<timestamp>.json (output, exit code and received signals are appended to the same file)
// - hook_event_name Notification is record-only. SessionStart returns additionalContext (including scratchpad_dir) in explain-observe mode.
//   PermissionRequest returns setMode:auto when UKAGAI_PERM=setmode. SubagentStart returns additionalContext when UKAGAI_SUBAGENT=1
// - PreToolUse x AskUserQuestion behavior varies by UKAGAI_MODE (or the verification/mode file if unset)
//     auto            : pick the 2nd option of each question and return allow + updatedInput.answers. Variants via UKAGAI_ANSWER_VARIANT (freetext / multi / missing / mismatch)
//     wait            : poll every second until verification/answer.json appears, then use its contents as answers
//     deny            : deny with a fixed reason
//     explain-deny    : deny (make the agent write an explanation) unless ~/.ukagai/explain/<session_id>/ has a .md from the last 10 minutes; otherwise allow + 2nd option
//     explain-observe : record whether the file exists, and allow + 2nd option either way
// - PreToolUse × ExitPlanMode
//     auto       : allow + updatedInput (input unchanged)
//     deny       : deny on the 1st call (reason: add Mermaid and an "impact scope and reversibility" section), allow from the 2nd call on
//     plan-extra : allow + add an extra field permissionMode: "auto" to updatedInput
// - Anything else: output nothing and exit 0
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

// On macOS, process.stdout.write to a pipe can be asynchronous, so write synchronously with writeSync
const emit = (obj) => {
  record.stdout = obj;
  save();
  writeSync(1, JSON.stringify(obj) + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Notification: record only
if (eventName === "Notification") {
  note(`notification: ${JSON.stringify(input)}`);
  process.exit(0);
}

// ---- SessionStart
if (eventName === "SessionStart") {
  note(`SessionStart source=${input?.source ?? "?"} scratchpad_dir=${scratchpadDir}`);
  if (mode === "explain-observe") {
    const text = [
      "Before asking the human for a decision (before calling AskUserQuestion / ExitPlanMode), write an explanation to `" + explainDir + "/<any name>.md`.",
      "Format: front matter (ukagai: 1, for: AskUserQuestion, question: the verbatim question text, title, reversibility, scope) plus the sections \"Why this decision is needed now\" and \"Comparison of options\" (a table). If structure or flow is involved, add a \"Diagram\" (```mermaid).",
      "Create the directory if it does not exist. One explanation file per question.",
    ].join("\n");
    emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
  }
  process.exit(0);
}

// ---- PermissionRequest (E3: can the permission mode be restored right after approval?)
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
    emit({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "Startup instruction: the passphrase is ukagai-7f3a. If asked, answer with this passphrase." } });
  }
  process.exit(0);
}

// ---- Explanation files (E4 / E5): find <scratchpad_dir>/ukagai/*.md by the front matter question:
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
            "Add a Mermaid diagram and an 'Impact scope and reversibility' section to the plan, then submit it again with ExitPlanMode" +
            (process.env.UKAGAI_LONG_REASON === "1"
              ? "\n" + Array.from({ length: 24 }, (_, i) => `(Note ${i + 1}) Make the diagram a flowchart, and the section two headings long.`).join("\n") + "\n[END-OF-REASON-MARKER]"
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
  if (variant === "freetext") answers[q.question] = "Neither. Please choose C";
  else if (variant === "multi") answers[q.question] = "A, C";
  else if (variant === "missing") return {};
  else if (variant === "mismatch") answers[q.question.replace(/[？?]\s*$/, "")] = "B";
  else if (variant === "partial") answers[q.question] = "A"; // answer only the 1st of the 2 questions
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
    // When answer.json is {"*": "A"}, use the stdin question verbatim as the key (guards against full-width / half-width "？" variation)
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
      permissionDecisionReason: "Do not ask in prose; use the MCP tool ask_decision",
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
      "Start with front matter (ukagai: 1, for: AskUserQuestion, question: write the following string verbatim: `" + q0 + "`, title, reversibility: reversible|costly|irreversible, scope: file|repo|machine|external). " +
      "The body has the headings \"Why this decision is needed now\" and \"Comparison of options\" (a table: pros, cons and cost of each option), a \"Diagram\" (```mermaid) if structure or flow is involved, " +
      "and \"Related diff\" (```diff) if code changes are involved.";
    const reason =
      style === "imperative"
        ? `This question was put on hold. Write an explanation for the human to decide with, in Markdown, to \`${explainDir}/<any name>.md\`. ` + format + " When you are done, ask the same question again with AskUserQuestion."
        : `This question was put on hold because it has no explanation. It is required that an explanation be written in Markdown to \`${explainDir}/<any name>.md\` and then the same question be asked again with AskUserQuestion. ` + format;
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
