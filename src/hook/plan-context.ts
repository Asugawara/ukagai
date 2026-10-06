import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the ukagai checkout's copy of the dialect spec lives, or null when this install has no docs next to it (docs/spec/markdown.md section 4) */
function specPath(): string | null {
  try {
    const p = fileURLToPath(new URL("../../docs/spec/markdown.md", import.meta.url));
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** The plan-writing rules handed to the agent at EnterPlanMode (docs/spec/markdown.md section 4); 25 lines at most */
export function planContextText(spec: string | null = specPath()): string {
  return [
    "[ukagai] Write the plan in ukagai Markdown; a human reads it in a GUI / TUI and decides on it. Plan sections, in this order:",
    "- `# Title`: one line saying what the plan does.",
    "- `## Scope and reversibility`: its first 2 lines are exactly `Reversibility: reversible|costly|irreversible` and `Scope: file|repo|machine|external`.",
    "- `## Steps`: an ordered list; each item starts with a **bold title**, then a badge ([done] [todo] [doing] [blocked] [risk] [skip]) and the `path` it touches; nest task lists or details under it.",
    "- `## Risks`: one callout per risk, `> [!CAUTION] Title` for anything irreversible or touching other people / external systems, `> [!WARNING]` for costly to undo.",
    "- `## Verification`: a task list (`- [ ] command or check`) the reader can tick off.",
    "A question you ask while in plan mode needs its explanation inside the plan file between `<!-- ukagai-explain -->` and `<!-- /ukagai-explain -->` (same format as the explanation file; see skill ukagai-explain).",
    "Palette (use what makes the decision easier to read, nothing more):",
    "- callouts with titles `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION] Title`, task lists `- [x]` / `- [ ]`, folding `<details><summary>..</summary>` (blank line after the summary) for long evidence;",
    "- Mermaid of any type (flowchart, sequenceDiagram, stateDiagram-v2, gantt, pie, quadrantChart, ...), code blocks with a title (```ts title=\"src/x.ts\") and ```diff for proposed changes;",
    "- `==mark==` for the one phrase not to miss, `::: columns` (columns split by `---`, closed by `:::`) for before / after (the Options section stays a table), images `![meaningful alt](shots/x.png)` only for a file that already exists next to the plan file (the plan file is the only file you may write).",
    spec
      ? `Full spec: skill ukagai-explain, section "Rich Markdown (ukagai dialect)", or ${spec}.`
      : 'Full spec: skill ukagai-explain, section "Rich Markdown (ukagai dialect)".',
  ].join("\n");
}

const markerPath = (dataDir: string, sessionId: string) => join(dataDir, "plan-context", sessionId.replace(/[^\w.-]/g, "_"));

/** The session ended: its marker is of no use any more (best effort) */
export function removePlanMarker(sessionId: unknown, dataDir: string): void {
  if (typeof sessionId !== "string" || sessionId === "") return;
  try {
    rmSync(markerPath(dataDir, sessionId), { force: true });
  } catch {
    // best effort
  }
}

/** True when this session already got the rules; marker errors mean "not yet" (fail open: inject) */
function takeMarker(dataDir: string, sessionId: unknown): boolean {
  if (typeof sessionId !== "string" || sessionId === "") return true;
  try {
    const dir = join(dataDir, "plan-context");
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath(dataDir, sessionId), "", { flag: "wx" });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "EEXIST";
  }
}

/**
 * Context-only output (no permissionDecision, like the checkpoint path), at most once per session (marker file under the data dir).
 * Two triggers: the agent calls EnterPlanMode (PreToolUse), or the human, who entered plan mode himself and so never causes that call, submits a prompt in plan mode (UserPromptSubmit with permission_mode "plan").
 */
export function planContext(raw: Record<string, unknown>, dataDir: string): Record<string, unknown> | null {
  const ev = raw["hook_event_name"];
  const hit =
    (ev === "PreToolUse" && raw["tool_name"] === "EnterPlanMode") || (ev === "UserPromptSubmit" && raw["permission_mode"] === "plan");
  if (!hit || !takeMarker(dataDir, raw["session_id"])) return null;
  return { hookSpecificOutput: { hookEventName: ev, additionalContext: planContextText() } };
}
