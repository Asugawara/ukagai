import { autostart, defaultDeps, type AutostartDeps } from "./autostart.js";
import { EventInput, HookInputBase } from "../contract.js";
import type { Client } from "./client.js";
import { BLOCKER_REASON, isBlockerMessage } from "./blocker.js";
import { explainDir } from "./explain.js";
import type { HookOptions } from "./options.js";

type Out = Record<string, unknown>;

const OBSERVED = new Set(["UserPromptSubmit", "Stop", "SubagentStop", "PostToolUse", "SessionEnd", "Notification"]);
/** 非同期 hook の観測 event の打ち切り。コールドな Node の最初の fetch を見込む */
const ASYNC_EVENT_TIMEOUT_MS = 1500;
/** SessionEnd は sync(budget 1.5 秒)なので短く */
const SESSION_END_TIMEOUT_MS = 500;
/** Stop は sync(全体 2 秒)なので event の POST は 1 秒で打ち切る */
export const STOP_EVENT_TIMEOUT_MS = 1000;
/** 末尾(空白と Markdown の記号を除く)が ？ / ? なら、文章で質問したとみなす */
export function isEscapedQuestion(text: string | undefined): boolean {
  if (!text) return false;
  return /[？?][\s*_」』)）]*$/.test(text);
}

/** spec 8 節の 5 行。dir は説明ファイルの置き場そのもの */
export function contextText(dir: string): string {
  return [
    "人に判断を求める前に、コードを読みコマンドで確かめて推奨を 1 つ決めること。人でなければ決められない理由(好み、外部の事情、戻せない変更、あなたが知り得ない前提)を 1 文で言えないなら、聞かずに推奨どおり進めて報告する。",
    `聞くときは、人が読む説明を Markdown で ${dir}/ に書くこと。書式は skill ukagai-explain に従う。`,
    "front matter: question は AskUserQuestion の質問文を一字一句そのまま、title は人に決めてほしいこと 1 文、recommended は推す選択肢のラベル、reversibility は reversible / costly / irreversible、scope は file / repo / machine / external。本文: 「なぜ今この判断が要るか」「選択肢」(表。先頭列はラベル、列は選ぶと起きること・リスクと戻し方)「推奨」(理由と、別の選択肢が正しくなる条件)。推奨は 5 文・400 文字以内、表のセルは 160 文字以内。図は、戻しにくい(reversible 以外)か scope が machine / external で、選択肢の違いが構造や流れに出るときだけ Mermaid で描く。",
    "文章で質問せず、AskUserQuestion は最初から 1 問ずつ順に出し(まとめて出さない。先の回答と矛盾する説明は書かない)、決め手は **太字**、戻せない影響は > [!CAUTION] の callout にし、推奨の選択肢を先頭に置いてラベル末尾に (Recommended) を付ける。計画の本文には「影響範囲と可逆性」の節を入れる。plan mode 中の AskUserQuestion には説明ファイルは不要。",
    "認証・権限など人の作業で止まるときは、文章で終えず blocker 形式の説明を書いて AskUserQuestion(対応した / 飛ばして続ける / 中断)で聞く。人が対応したら同じ作業を再試行する。",
  ].join("\n");
}

export async function sessionContext(
  raw: Record<string, unknown>,
  opts: HookOptions,
  deps: AutostartDeps = defaultDeps,
): Promise<Out | null> {
  const base = HookInputBase.safeParse(raw);
  if (!base.success) return null;
  const ev = base.data.hook_event_name;
  if (ev !== "SessionStart" && ev !== "SubagentStart") return null;
  if (ev === "SessionStart") await autostart(opts, deps);
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
    if (isBlockerMessage(typeof msg === "string" ? msg : undefined)) extra["blocker_detected"] = true;
  }
  await post(
    raw,
    extra,
    client,
    name === "Stop" ? STOP_EVENT_TIMEOUT_MS : name === "SessionEnd" ? SESSION_END_TIMEOUT_MS : ASYNC_EVENT_TIMEOUT_MS,
  );
}

/** Stop(sync)の保険: 文章で人の作業待ちと言って止まったら、blocker 形式で聞くよう続行させる(spec 12 節) */
export function stopDecision(raw: Record<string, unknown>): Out | null {
  if (raw["hook_event_name"] !== "Stop") return null;
  if (raw["stop_hook_active"] === true) return null;
  if (raw["permission_mode"] === "plan") return null;
  const msg = raw["last_assistant_message"];
  if (typeof msg !== "string" || !isBlockerMessage(msg)) return null;
  return { decision: "block", reason: BLOCKER_REASON };
}

/** --observe: PreToolUse は start、PostToolUse は end */
export async function observeDecisionTool(raw: Record<string, unknown>, client: Client): Promise<void> {
  const phase = raw["hook_event_name"] === "PreToolUse" ? "start" : "end";
  await post(raw, { observe: { phase } }, client, 500);
}
