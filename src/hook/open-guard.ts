/** Why a Bash call that opens a file for the human is refused */
export const OPEN_DENY_REASON =
  "[ukagai] Do not open files for the human; they read ukagai. Reference the file from the explanation instead: ![alt](x.png) for an image, ![alt](x.html) for an HTML page (the GUI renders it in a sandboxed frame).";

const OPENERS = new Set(["open", "xdg-open", "start"]);
const FILE_EXT = /\.(?:html?|png|jpe?g|gif|webp|pdf|md)$/i;
const SCRATCHPAD = /\/claude-[^/\s]+\/(?:[^/\s]+\/)*scratchpad\//;

const unquote = (s: string): string => s.replace(/^["']|["']$/g, "");

/** True when `target` is a file the human would be sent to: a scratchpad / data-dir path or a document / image file */
function isFileTarget(target: string, dataDir: string | undefined): boolean {
  const t = unquote(target);
  if (t === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  if (SCRATCHPAD.test(t.startsWith("/") ? t : `/${t}`) || /(?:^|\/)scratchpad\//.test(t)) return true;
  if (dataDir && (t === dataDir || t.startsWith(dataDir.replace(/\/$/, "") + "/"))) return true;
  return FILE_EXT.test(t);
}

/** PreToolUse deny output when the Bash command (first 600 chars) opens a file for the human, else null */
export function openGuard(input: Record<string, unknown>, dataDir?: string): Record<string, unknown> | null {
  if (input["tool_name"] !== "Bash") return null;
  const ti = input["tool_input"];
  const cmd = typeof ti === "object" && ti !== null ? (ti as Record<string, unknown>)["command"] : undefined;
  if (typeof cmd !== "string") return null;
  // Each simple command of the line: split on ; & | and newlines (quotes are kept inside words)
  for (const part of cmd.slice(0, 600).split(/[;&|\n]+/)) {
    const words = part.match(/"[^"]*"|'[^']*'|\S+/g);
    if (!words) continue;
    let i = 0;
    while (i < words.length && /^\w+=/.test(words[i]!)) i++; // VAR=x prefix
    if (!OPENERS.has(unquote(words[i] ?? ""))) continue;
    const args = words.slice(i + 1);
    const targets: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (a === "-a" || a === "-b" || a === "--args") {
        k++; // the application name / bundle id
        continue;
      }
      if (a.startsWith("-")) continue;
      targets.push(a);
    }
    if (targets.some((t) => isFileTarget(t, dataDir))) {
      return {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: OPEN_DENY_REASON },
      };
    }
  }
  return null;
}
