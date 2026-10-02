import { EventInput, HookInputBase } from "../contract.js";
import type { Client } from "./client.js";
import { explainDir } from "./explain.js";
import type { HookOptions } from "./options.js";

type Out = Record<string, unknown>;

const OBSERVED = new Set(["UserPromptSubmit", "Stop", "SubagentStop", "PostToolUse", "SessionEnd", "Notification"]);
/** 非同期 hook の観測 event の打ち切り。コールドな Node の最初の fetch を見込む */
const ASYNC_EVENT_TIMEOUT_MS = 1500;
/** SessionEnd は sync(budget 1.5 秒)なので短く */
const SESSION_END_TIMEOUT_MS = 500;
/** 末尾(空白と Markdown の記号を除く)が ？ / ? なら、文章で質問したとみなす */
export function isEscapedQuestion(text: string | undefined): boolean {
  if (!text) return false;
  return /[？?][\s*_」』)）]*$/.test(text);
}

/** spec 8 節の 3 行。dir は説明ファイルの置き場そのもの */
export function contextText(dir: string): string {
  return [
    `人に判断を求める前(AskUserQuestion の前、計画の提示の前)に、人が読む説明を Markdown で ${dir}/ に書くこと。書式は skill ukagai-explain に従う。`,
    "front matter の question: には AskUserQuestion の質問文を一字一句そのまま入れる。選択肢の比較は表に、構造や流れは Mermaid の図にする。",
    "文章で質問せず AskUserQuestion を使い、計画の本文には「影響範囲と可逆性」の節を入れる。plan mode 中の AskUserQuestion には説明ファイルは不要。",
  ].join("\n");
}

export function sessionContext(raw: Record<string, unknown>, opts: HookOptions): Out | null {
  const base = HookInputBase.safeParse(raw);
  if (!base.success) return null;
  const ev = base.data.hook_event_name;
  if (ev !== "SessionStart" && ev !== "SubagentStart") return null;
  const dir = explainDir(base.data.scratchpad_dir, opts.dataDir, base.data.session_id);
  return { hookSpecificOutput: { hookEventName: ev, additionalContext: contextText(dir) } };
}

export async function permissionRequest(raw: Record<string, unknown>, client: Client): Promise<Out | null> {
  const base = HookInputBase.safeParse(raw);
  if (!base.success) return null;
  if (raw["tool_name"] !== "Write" && raw["tool_name"] !== "Edit") return null;
  const id = base.data.session_id;
  if (!(await client.getPendingModeSwitch(id))) return null;
  if (!(await client.consumeModeSwitch(id))) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] },
    },
  };
}

async function post(raw: Record<string, unknown>, extra: Record<string, unknown>, client: Client, timeoutMs: number) {
  const ev = EventInput.safeParse({ ...raw, received_at: new Date().toISOString(), ...extra });
  if (!ev.success) return;
  await client.postEvent(ev.data, timeoutMs);
}

/** Stop(escaped_question 付き)などの観測 event。対象外なら何もしない */
export async function observedEvent(raw: Record<string, unknown>, client: Client): Promise<void> {
  const name = raw["hook_event_name"];
  if (typeof name !== "string" || !OBSERVED.has(name)) return;
  const extra: Record<string, unknown> = {};
  if (name === "Stop") {
    const msg = raw["last_assistant_message"];
    if (isEscapedQuestion(typeof msg === "string" ? msg : undefined)) extra["escaped_question"] = true;
  }
  await post(raw, extra, client, name === "SessionEnd" ? SESSION_END_TIMEOUT_MS : ASYNC_EVENT_TIMEOUT_MS);
}

/** --observe: PreToolUse は start、PostToolUse は end */
export async function observeDecisionTool(raw: Record<string, unknown>, client: Client): Promise<void> {
  const phase = raw["hook_event_name"] === "PreToolUse" ? "start" : "end";
  await post(raw, { observe: { phase } }, client, 500);
}
