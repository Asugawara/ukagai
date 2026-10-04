import { autostart, defaultDeps, type AutostartDeps } from "./autostart.js";
import { EventInput, HookInputBase } from "../contract.js";
import type { Client } from "./client.js";
import { explainDir } from "./explain.js";
import type { HookOptions } from "./options.js";
import { readConfig, type Lang } from "../settings/config.js";

type Out = Record<string, unknown>;

const OBSERVED = new Set(["UserPromptSubmit", "Stop", "SubagentStop", "PostToolUse", "SessionEnd", "Notification"]);
/** Cut-off for observed events of async hooks; allows for the first fetch of a cold Node */
const ASYNC_EVENT_TIMEOUT_MS = 1500;
/** SessionEnd is sync (1.5 second budget), so keep it short */
const SESSION_END_TIMEOUT_MS = 500;
/** If the end (ignoring whitespace and Markdown marks) is ？ / ?, treat it as a question asked in prose */
export function isEscapedQuestion(text: string | undefined): boolean {
  if (!text) return false;
  return /[？?][\s*_」』)）]*$/.test(text);
}

/** The 5 lines of spec section 8. dir is the explanation directory itself */
export function contextText(dir: string, lang: Lang = "en", agent: "claude" | "codex" = "claude"): string {
  if (agent === "codex") return codexContextText(dir, lang);
  const language =
    lang === "ja"
      ? "Write the explanation file in Japanese (the human reads it in Japanese); section headings may be English or Japanese. Also write the AskUserQuestion question, option labels and descriptions in Japanese (code, proper nouns and an option that is itself an English sentence excepted): the recommended label ends with (推奨), and the blocker labels are 完了。続けて / この手順を飛ばして続けて / ここで止める."
      : "Write the explanation file in English.";
  return [
    "Before asking a human, read the code and verify with commands, and settle on one recommendation. If you cannot state in one sentence why only a human can decide (taste, external circumstances, an irreversible change, premises you cannot know), do not ask: proceed with the recommendation and report it.",
    `When you do ask, write the explanation the human reads as Markdown in ${dir}/ following skill ukagai-explain. ${language}`,
    'front matter: question is the AskUserQuestion question verbatim, title is the decision for the human in one sentence, recommended is the label of the option you recommend, reversibility is reversible / costly / irreversible, scope is file / repo / machine / external. Body: "Why this decision is needed now", "Options" (table: first column is the label; columns for what happens if chosen and for risks and how to undo), "Recommendation" (reason, and the condition under which another option is right). Recommendation: first sentence is a conclusion that decides on its own and names the option, last sentence is "if ..., B" (at most 5 sentences and 400 characters); table cells at most 160 characters and each risk cell says how to undo. Also write "What only you know" (1-3 bullets) and "Assumptions" (one per line), and unless reversible + file, "What I checked" with evidence as footnotes ([^1]) cited from the body. Optional: "Terms", "Counterargument", "Affected". Draw a Mermaid diagram only when the decision is hard to undo (anything but reversible) or scope is machine / external, and the options differ in structure or flow. Use no plan codes / phase names (W-T2, Phase 2): the reader cannot know them, so say what each is in plain words.',
    'Do not ask in prose. Call AskUserQuestion one question at a time from the start (never batch; do not write an explanation that contradicts an earlier answer), mark the deciding factor in **bold**, put irreversible effects in a > [!CAUTION] callout, put the recommended option first and append (Recommended) to its label. A plan body needs a "Scope and reversibility" section whose first 2 lines are "Reversibility: reversible|costly|irreversible" and "Scope: file|repo|machine|external". In plan mode, put the explanation into your plan file between <!-- ukagai-explain --> and <!-- /ukagai-explain --> (same format) instead of a separate file. Explanations and plans are written in ukagai Markdown (callouts, task lists, details, Mermaid, badges, columns, images); the palette is in skill ukagai-explain, section "Rich Markdown".',
    "When stopped by human work such as authentication or permissions, do not end in prose: write a blocker-format explanation and ask with AskUserQuestion (Done. Continue / Skip this step and continue / Stop here). After the human acts, retry the same work. If an answer starts with \"None of these — \", act on its type: add options, fix the premise and re-ask, add evidence, or ask later. If it starts with \"Cannot answer — \", do not proceed: replace the undefined terms with plain words (or define them under Terms), shorten, or split the question, then re-ask with a new explanation.",
  ].join("\n");
}

/** The Codex version: request_user_input (Plan mode only) or a prose question (Default mode); no skill, so the file format is spelled out */
export function codexContextText(dir: string, lang: Lang = "en"): string {
  const language =
    lang === "ja"
      ? "Write the explanation file in Japanese (the human reads it in Japanese); section headings may be English or Japanese. Also write the question, option labels and descriptions in Japanese (code and proper nouns excepted): the recommended label ends with (推奨)."
      : "Write the explanation file in English.";
  return [
    "Before asking a human, read the code and verify with commands, and settle on one recommendation. If you cannot state in one sentence why only a human can decide (taste, external circumstances, an irreversible change, premises you cannot know), do not ask: proceed with the recommendation and report it.",
    `When you do ask, first write the explanation the human reads as a Markdown file in ${dir}/ (any file name ending in .md). ${language}`,
    'Format: front matter with ukagai: 1, question (the question verbatim), title (the decision in one sentence), recommended (the label of the option you recommend), reversibility (reversible / costly / irreversible), scope (file / repo / machine / external). Sections in this order: "Why this decision is needed now", "Options" (a table: first column is the option label, then what happens if chosen, then risks and how to undo), "Recommendation" (first sentence names the option and decides on its own; last sentence is "if ..., B"; at most 5 sentences), "What only you know" (1-3 bullets), "Assumptions" (one per line), and unless reversible + file, "What I checked" with footnotes. Table cells at most 160 characters. Explanations and plans may use callouts (`> [!NOTE] Title`, also TIP / IMPORTANT / WARNING / CAUTION), task lists (`- [x]`), `<details><summary>` folds and Mermaid diagrams where they make the decision easier to read.',
    "In Plan mode ask with request_user_input, one question at a time, the recommended option first with (Recommended) appended to its label. request_user_input is not available in Default mode: there, write the question as the last sentence of your reply, ending with a question mark, and stop. ukagai shows it to the human and passes the answer back to you as the reason of a block; do not ask again.",
    "When stopped by human work such as authentication or permissions, do not end in prose without a question: ask it the same way (options: Done. Continue / Skip this step and continue / Stop here). After the human acts, retry the same work.",
    'If an answer starts with "None of these — ", act on its type: add options, fix the premise and re-ask, add evidence, or ask later. If it starts with "Cannot answer — ", do not proceed: replace the undefined terms with plain words, shorten, or split the question, then re-ask with a new explanation file.',
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
  return { hookSpecificOutput: { hookEventName: ev, additionalContext: contextText(dir, (await readConfig(opts.dataDir)).lang, opts.agent) } };
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

/** Observed events such as Stop (with escaped_question). Does nothing for other events */
export async function observedEvent(raw: Record<string, unknown>, client: Client): Promise<void> {
  const name = raw["hook_event_name"];
  if (typeof name !== "string" || !OBSERVED.has(name)) return;
  const extra: Record<string, unknown> = {};
  if (name === "Stop") {
    const msg = raw["last_assistant_message"];
    if (isEscapedQuestion(typeof msg === "string" ? msg : undefined)) extra["escaped_question"] = true;
  }
  await post(
    raw,
    extra,
    client,
    name === "SessionEnd" ? SESSION_END_TIMEOUT_MS : ASYNC_EVENT_TIMEOUT_MS,
  );
}

/** --observe: PreToolUse is start, PostToolUse is end */
export async function observeDecisionTool(raw: Record<string, unknown>, client: Client): Promise<void> {
  const phase = raw["hook_event_name"] === "PreToolUse" ? "start" : "end";
  await post(raw, { observe: { phase } }, client, 500);
}
