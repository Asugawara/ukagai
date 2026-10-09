/** Which agents are on this machine, which already have ukagai hooks, and the options those hooks were registered with */
import { access, constants, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { status as codexStatus } from "../install/codex.js";
import { HOOK_EVENTS } from "./hooks-spec.js";
import { findManaged, removeHooks, serialize } from "./merge.js";
import { DEFAULT_SERVER, defaultDataDir, hookArgsOf } from "./target.js";
const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);
const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);
/** Whether an executable `name` is on PATH */
export async function onPath(name, env = process.env) {
    for (const dir of (env["PATH"] ?? "").split(delimiter)) {
        if (dir === "")
            continue;
        const f = join(dir, name);
        if ((await isFile(f)) && (await access(f, constants.X_OK).then(() => true, () => false)))
            return true;
    }
    return false;
}
/** `~` for the home directory, so the lines stay short */
export function tilde(p, home = homedir()) {
    return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}
/**
 * Why Claude Code counts as found, or undefined. `~/.claude` alone does not count: install and uninstall of older versions leave
 * `~/.claude/settings.json` and `skills/` behind on machines that only use Codex.
 */
export async function detectClaude(env = process.env, home = homedir()) {
    if (await onPath("claude", env))
        return "claude on PATH";
    if (await isFile(join(home, ".claude.json")))
        return "~/.claude.json";
    if (await isDir(join(home, ".claude", "projects")))
        return "~/.claude/projects";
    return undefined;
}
/** Why Codex CLI counts as found, or undefined */
export async function detectCodex(codexHome, env = process.env, home = homedir()) {
    if (await onPath("codex", env))
        return "codex on PATH";
    if (await isDir(join(codexHome, "sessions")))
        return `${tilde(codexHome, home)}/sessions`;
    return undefined;
}
/** Whether settings.json holds ukagai hooks */
export const registeredClaude = (s) => serialize(s) !== serialize(removeHooks(s));
/** Whether hooks.json holds ukagai hooks */
export async function registeredCodex(home) {
    return (await codexStatus(home)).rows.some((r) => r.installed);
}
const after = (args, flag) => {
    const i = args.indexOf(flag);
    const v = i >= 0 ? args[i + 1] : undefined;
    return typeof v === "string" ? v : undefined;
};
function fromArgs(sets, sessionStart) {
    const find = (flag) => sets.map((a) => after(a, flag)).find((v) => v !== undefined);
    const budget = Number(find("--budget"));
    return {
        timeout: Number.isInteger(budget) && budget > 0 ? budget + 10 : undefined,
        observe: sets.some((a) => a.includes("--observe")),
        noAutostart: sessionStart?.includes("--no-autostart") ?? false,
        server: find("--server") ?? DEFAULT_SERVER,
        dataDir: find("--data-dir") ?? defaultDataDir(),
    };
}
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
/** The options of the ukagai hooks in settings.json (call only when `registeredClaude`) */
export function claudeOptions(s) {
    const sets = HOOK_EVENTS.map((ev) => findManaged(s, ev)).filter((h) => h !== undefined).map((h) => strings(h["args"]));
    const budgeted = findManaged(s, "PreToolUse", (h) => strings(h["args"]).includes("--budget"));
    return fromArgs(budgeted ? [strings(budgeted["args"]), ...sets] : sets, strings(findManaged(s, "SessionStart")?.["args"]));
}
/** Split a shell command as hook commands are written (bare words, 'single' and "double" quotes, `\'`) */
export function shellSplit(cmd) {
    const out = [];
    let cur;
    let q;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (q === "'") {
            if (c === "'")
                q = undefined;
            else
                cur += c;
        }
        else if (q === '"') {
            if (c === '"')
                q = undefined;
            else if (c === "\\" && i + 1 < cmd.length)
                cur += cmd[++i];
            else
                cur += c;
        }
        else if (c === "'" || c === '"') {
            q = c;
            cur ??= "";
        }
        else if (c === "\\" && i + 1 < cmd.length)
            cur = (cur ?? "") + cmd[++i];
        else if (/\s/.test(c)) {
            if (cur !== undefined)
                out.push(cur);
            cur = undefined;
        }
        else
            cur = (cur ?? "") + c;
    }
    if (cur !== undefined)
        out.push(cur);
    return out;
}
/** The options of the ukagai hooks in hooks.json (call only when `registeredCodex`) */
export async function codexOptions(home) {
    const rows = (await codexStatus(home)).rows.filter((r) => r.command !== undefined);
    const sets = rows.map((r) => shellSplit(r.command));
    const start = rows.findIndex((r) => r.event === "SessionStart");
    return fromArgs(sets, start >= 0 ? sets[start] : undefined);
}
export function resolveOptions(t, prev) {
    const g = t.given;
    const server = g.server ? t.server : (prev?.server ?? t.server);
    const dataDir = g.dataDir ? t.dataDir : (prev?.dataDir ?? t.dataDir);
    return {
        timeout: g.timeout ? t.timeout : (prev?.timeout ?? t.timeout),
        observe: g.observe || (prev?.observe ?? false),
        noAutostart: g.noAutostart || (prev?.noAutostart ?? false),
        server,
        dataDir,
        hookArgs: hookArgsOf(dataDir, server),
    };
}
//# sourceMappingURL=agents.js.map