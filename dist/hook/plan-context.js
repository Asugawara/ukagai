import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skillName } from "./skill-name.js";
import { fileURLToPath } from "node:url";
import { resolveSkillRef } from "./skill-ref.js";
/** Where the ukagai checkout's copy of the dialect spec lives, or null when this install has no docs next to it (docs/spec/markdown.md section 4) */
function specPath() {
    try {
        const p = fileURLToPath(new URL("../../docs/spec/markdown.md", import.meta.url));
        return existsSync(p) ? p : null;
    }
    catch {
        return null;
    }
}
/** The plan-writing rules handed to the agent at EnterPlanMode (docs/spec/markdown.md section 4); 25 lines at most */
export function planContextText(spec = specPath(), env = process.env, skillRef) {
    const sk = skillName(env);
    // With the human's edited version the references point at the file (and the skill is not to be read)
    const skillSrc = skillRef === undefined ? `skill ${sk}` : `${skillRef} (the human's edited version of skill ${sk}; do not read skill ${sk})`;
    return [
        "[ukagai] Write the plan in ukagai Markdown; a human reads it in a GUI / TUI and decides on it. Plan sections, in this order:",
        "- `# Title`: one line saying what the plan does.",
        "- `## Scope and reversibility`: its first 2 lines are exactly `Reversibility: reversible|costly|irreversible` and `Scope: file|repo|machine|external`.",
        "- `## Steps`: an ordered list; each item starts with a **bold title**, then a badge ([done] [todo] [doing] [blocked] [risk] [skip]) and the `path` it touches; nest task lists or details under it.",
        "- `## Risks`: one callout per risk, `> [!CAUTION] Title` for anything irreversible or touching other people / external systems, `> [!WARNING]` for costly to undo.",
        "- `## Verification`: a task list (`- [ ] command or check`) the reader can tick off.",
        `A question you ask while in plan mode needs its explanation inside the plan file between \`<!-- ukagai-explain -->\` and \`<!-- /ukagai-explain -->\` (same format as the explanation file; see ${skillSrc}).`,
        "Palette (use what makes the decision easier to read, nothing more):",
        "- callouts with titles `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION] Title`, task lists `- [x]` / `- [ ]`, folding `<details><summary>..</summary>` (blank line after the summary) for long evidence;",
        "- Mermaid of any type (flowchart, sequenceDiagram, stateDiagram-v2, gantt, pie, quadrantChart, ...), code blocks with a title (```ts title=\"src/x.ts\") and ```diff for proposed changes;",
        "- Draw a diagram only when it shows something the Options table cannot: a sequence of 3 or more steps between 2 or more actors, a state machine with 4 or more states, or a data flow between 3 or more components (a flowchart needs 5 or more nodes). Never draw the options themselves as nodes (a branch into A / B / C) and never restate the table; at most one diagram; when in doubt, none. When the decision is not reversible or the scope is machine / external, a diagram that meets this rule is required; if none does, write none and say why in one line under Options (\"No diagram: <why>\").",
        "- `==mark==` for the one phrase not to miss, `::: columns` (columns split by `---`, closed by `:::`) for before / after (the Options section stays a table), images and HTML pages `![meaningful alt](/…/scratchpad/ukagai/x.png)`: the explanation folder the SessionStart context names (`<scratchpad_dir>/ukagai/`) stays writable in plan mode, so put mockups and screenshots there and reference them by **absolute path** (a relative path in a plan resolves against `~/.claude/plans/`, not the scratchpad); reference a file only once it exists.",
        "- A plan that hinges on a visual choice (UI variants, layouts): build the candidates in the scratchpad and ask with AskUserQuestion before ExitPlanMode, with each candidate embedded in the explanation; never schedule \"make the mockups\" as a step after approval.",
        "Never open a file or a URL for the human (`open`, `xdg-open`, a browser): put it in the explanation — images `![alt](x.png)`, HTML pages `![alt](x.html)` (the GUI renders them in a sandboxed frame); files next to the explanation file or under the session's scratchpad.",
        spec
            ? `Full spec: ${skillRef ?? `skill ${sk}`}, section "Rich Markdown (ukagai dialect)", or ${spec}.`
            : `Full spec: ${skillRef ?? `skill ${sk}`}, section "Rich Markdown (ukagai dialect)".`,
    ].join("\n");
}
export const markerPath = (dataDir, sessionId) => join(dataDir, "plan-context", sessionId.replace(/[^\w.-]/g, "_"));
/** The session ended: its marker is of no use any more (best effort) */
export function removePlanMarker(sessionId, dataDir) {
    if (typeof sessionId !== "string" || sessionId === "")
        return;
    try {
        rmSync(markerPath(dataDir, sessionId), { force: true });
    }
    catch {
        // best effort
    }
}
/** True when this session already got the rules; marker errors mean "not yet" (fail open: inject) */
function takeMarker(dataDir, sessionId) {
    if (typeof sessionId !== "string" || sessionId === "")
        return true;
    try {
        const dir = join(dataDir, "plan-context");
        mkdirSync(dir, { recursive: true });
        writeFileSync(markerPath(dataDir, sessionId), "", { flag: "wx" });
        return true;
    }
    catch (err) {
        return err.code !== "EEXIST";
    }
}
/**
 * Context-only output (no permissionDecision, like the checkpoint path), at most once per session (marker file under the data dir).
 * Two triggers: the agent calls EnterPlanMode (PreToolUse), or the human, who entered plan mode himself and so never causes that call, submits a prompt in plan mode (UserPromptSubmit with permission_mode "plan").
 */
export function planContext(raw, dataDir) {
    const ev = raw["hook_event_name"];
    const hit = (ev === "PreToolUse" && raw["tool_name"] === "EnterPlanMode") || (ev === "UserPromptSubmit" && raw["permission_mode"] === "plan");
    if (!hit || !takeMarker(dataDir, raw["session_id"]))
        return null;
    const scratchpad = raw["scratchpad_dir"];
    const skillRef = resolveSkillRef(dataDir, typeof scratchpad === "string" && scratchpad !== "" ? scratchpad : undefined);
    return { hookSpecificOutput: { hookEventName: ev, additionalContext: planContextText(specPath(), process.env, skillRef) } };
}
//# sourceMappingURL=plan-context.js.map