/** `install --codex` / `uninstall --codex` / doctor: Codex CLI's hooks.json plus the trust hashes in config.toml */
import { copyFile, mkdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MANAGED_FLAG, MANAGED_VALUE } from "../settings/hooks-spec.js";
import { CODEX_EVENT_LABEL, editState, hookHash, readState, stateKey } from "./codex-trust.js";
/** Events ukagai handles for Codex (docs/spec/api.md "Codex") */
export const CODEX_SPECS = [
    { event: "PreToolUse", matcher: "request_user_input" },
    { event: "PermissionRequest" },
    { event: "Stop" },
    { event: "SessionStart", timeout: 30 },
    // Codex clamps SessionEnd handlers to 3 s and hashes the clamped value: a larger timeout would never match the trust hash
    { event: "SessionEnd", timeout: 3 },
];
const shq = (s) => /^[\w@%+=:,./-]+$/.test(s)
    ? s
    : /^\$\{(?:CLAUDE_)?PLUGIN_ROOT\}\/[\w@%+=:,./-]+$/.test(s)
        ? `"${s}"` // a plugin path: the variable must stay expandable
        : `'${s.replace(/'/g, `'\\''`)}'`;
export function isManagedCommand(command) {
    return typeof command === "string" && new RegExp(`(^|\\s)${MANAGED_FLAG} ${MANAGED_VALUE}(\\s|$)`).test(command);
}
export function hookCommand(o, spec) {
    const parts = [o.invocation.command, ...o.invocation.prefix, "hook", "--agent", "codex"];
    if (spec.event === "SessionStart") {
        if (o.noAutostart)
            parts.push("--no-autostart");
    }
    else if (spec.event !== "SessionEnd")
        parts.push("--budget", String(o.timeout - 10));
    parts.push(...o.hookArgs, MANAGED_FLAG, MANAGED_VALUE);
    return parts.map(shq).join(" ");
}
const eventsOf = (hooks) => {
    const e = hooks["hooks"];
    return typeof e === "object" && e !== null && !Array.isArray(e) ? e : {};
};
/** Every handler of the file with its position (handlers are tracked by object identity) */
function slots(hooks) {
    const res = new Map();
    for (const [event, groups] of Object.entries(eventsOf(hooks))) {
        if (!Array.isArray(groups) || CODEX_EVENT_LABEL[event] === undefined)
            continue;
        groups.forEach((g, gi) => {
            const inner = g?.hooks;
            if (!Array.isArray(inner))
                return;
            const matcher = typeof g.matcher === "string" ? g.matcher : undefined;
            inner.forEach((h, hi) => {
                if (typeof h === "object" && h !== null)
                    res.set(h, { event, group: gi, handler: hi, matcher, command: h.command, h: h });
            });
        });
    }
    return res;
}
/** Remove every ukagai handler; returns, per event, where the first removed group sat (so a re-install keeps the position and other hooks' keys) */
function stripManaged(hooks) {
    const at = new Map();
    const events = eventsOf(hooks);
    for (const [event, groups] of Object.entries(events)) {
        if (!Array.isArray(groups))
            continue;
        const kept = [];
        for (const g of groups) {
            const inner = g?.hooks;
            if (!Array.isArray(inner)) {
                kept.push(g);
                continue;
            }
            const rest = inner.filter((h) => !isManagedCommand(h?.command));
            if (rest.length === inner.length) {
                kept.push(g);
                continue;
            }
            if (!at.has(event))
                at.set(event, kept.length);
            if (rest.length > 0)
                kept.push({ ...g, hooks: rest });
        }
        if (kept.length > 0)
            events[event] = kept;
        else
            delete events[event];
    }
    return at;
}
function addManaged(hooks, at, o) {
    if (typeof hooks["hooks"] !== "object" || hooks["hooks"] === null || Array.isArray(hooks["hooks"]))
        hooks["hooks"] = {};
    const events = hooks["hooks"];
    for (const spec of CODEX_SPECS) {
        const h = { type: "command", command: hookCommand(o, spec), timeout: spec.timeout ?? o.timeout };
        const group = spec.matcher === undefined ? { hooks: [h] } : { matcher: spec.matcher, hooks: [h] };
        const list = (events[spec.event] ??= []);
        list.splice(at.get(spec.event) ?? list.length, 0, group);
    }
}
const RECORD = ".ukagai-codex.json";
/** Indent and final newline of an existing hooks.json, so ukagai's groups are added in the same style */
function hooksFormat(text) {
    const m = /^[ \t]+(?=")/m.exec(text);
    const compact = !text.includes("\n");
    return { indent: text.trim() === "" ? 2 : compact ? 0 : (m ? m[0] : 2), finalNewline: text.trim() === "" ? true : /\n$/.test(text), crlf: text.includes("\r\n") };
}
function serializeHooks(doc, text) {
    const f = hooksFormat(text);
    let out = JSON.stringify(doc, null, f.indent) + (f.finalNewline ? "\n" : "");
    if (f.crlf)
        out = out.replace(/\n/g, "\r\n");
    return out;
}
const exists = (p) => stat(p).then(() => true, () => false);
async function readRecord(home) {
    const raw = await read(join(home, RECORD)).then((t) => (t === "" ? null : t));
    if (raw === null)
        return { raw, rec: null };
    try {
        const v = JSON.parse(raw);
        return { raw, rec: { created: { hooks: !!v.created?.hooks, config: !!v.created?.config }, configNoFinalNewline: !!v.configNoFinalNewline, backups: v.backups ?? {}, createdHome: !!v.createdHome } };
    }
    catch {
        return { raw, rec: null };
    }
}
const trimEnd = (s) => s.replace(/(\r?\n)+$/, "");
/** The backup made by the first install, when it still exists */
async function original(home, name) {
    if (!name)
        return null;
    const f = join(home, basename(name));
    return (await exists(f)) ? readFile(f, "utf8") : null;
}
const read = (f) => readFile(f, "utf8").catch((err) => {
    if (err.code === "ENOENT")
        return "";
    throw err;
});
async function parseHooks(file, text) {
    if (text.trim() === "")
        return {};
    let v;
    try {
        v = JSON.parse(text);
    }
    catch (err) {
        throw new Error(`${file} is not valid JSON: ${err.message}`);
    }
    if (typeof v !== "object" || v === null || Array.isArray(v))
        throw new Error(`${file} does not contain a JSON object at the top level`);
    return v;
}
/** The hooks.json path as Codex spells it (symlinks resolved, e.g. /private/tmp on macOS) */
async function codexPath(home, name) {
    let dir = home;
    try {
        dir = await realpath(home);
    }
    catch {
        // does not exist yet: the spelling given is all there is
    }
    return join(dir, name);
}
export async function plan(o, mode) {
    const hooksFile = await codexPath(o.home, "hooks.json");
    const configFile = join(o.home, "config.toml");
    const hooksExisted = await exists(join(o.home, "hooks.json"));
    const configExisted = await exists(configFile);
    const homeExisted = await exists(o.home);
    const hooksBefore = await read(join(o.home, "hooks.json"));
    const configBefore = await read(configFile);
    const { raw: recordBefore, rec } = await readRecord(o.home);
    const doc = await parseHooks(hooksFile, hooksBefore);
    const before = slots(doc);
    const wasManaged = new Map();
    for (const [h, s] of before)
        if (isManagedCommand(s.command))
            wasManaged.set(h, stateKey(hooksFile, s.event, s.group, s.handler));
    const at = stripManaged(doc);
    const stripped = structuredClone(doc);
    if (mode === "install")
        addManaged(doc, at, o);
    const after = slots(doc);
    const managed = new Map();
    const rename = new Map();
    for (const [h, s] of after) {
        const key = stateKey(hooksFile, s.event, s.group, s.handler);
        if (isManagedCommand(s.command))
            managed.set(key, hookHash(s.event, s.matcher, s.h));
        else {
            const old = before.get(h);
            if (old) {
                const oldKey = stateKey(hooksFile, old.event, old.group, old.handler);
                if (oldKey !== key)
                    rename.set(oldKey, key);
            }
        }
    }
    const drop = [...wasManaged.values()].filter((k) => !managed.has(k));
    const untouched = mode === "uninstall" && wasManaged.size === 0;
    let hooksAfter = untouched ? hooksBefore : serializeHooks(doc, hooksBefore);
    let configAfter = editState(configBefore, { drop, rename, set: managed });
    const fresh = mode === "install" && wasManaged.size === 0;
    let record = rec;
    let hooksDelete = false;
    let configDelete = false;
    if (mode === "install") {
        if (fresh || !rec)
            record = { created: { hooks: !hooksExisted, config: !configExisted }, configNoFinalNewline: configBefore !== "" && !/\n$/.test(configBefore), backups: {}, createdHome: !homeExisted };
    }
    else if (!untouched && rec) {
        // Undo exactly: files install created go away; the others come back to the original bytes when they are semantically the original
        const hooksOrig = await original(o.home, rec.backups.hooks);
        const configOrig = await original(o.home, rec.backups.config);
        const emptyDoc = Object.keys(stripped).every((k) => k === "hooks") && Object.keys(eventsOf(stripped)).length === 0;
        if (rec.created.hooks && emptyDoc)
            hooksDelete = true;
        else if (hooksOrig !== null) {
            try {
                if (isDeepStrictEqual(JSON.parse(hooksOrig), stripped))
                    hooksAfter = hooksOrig;
            }
            catch {
                // the backup is not JSON: keep the line-for-line result
            }
        }
        if (rec.created.config && configAfter.trim() === "")
            configDelete = true;
        else if (configOrig !== null && trimEnd(configOrig) === trimEnd(configAfter))
            configAfter = configOrig;
        else if (rec.configNoFinalNewline && /\n$/.test(configAfter))
            configAfter = configAfter.replace(/\r?\n$/, "");
        record = null;
    }
    else if (!untouched)
        record = null;
    if (hooksDelete)
        hooksAfter = "";
    if (configDelete)
        configAfter = "";
    return { hooksFile, configFile, hooksBefore, hooksAfter, configBefore, configAfter, managed, hooksDelete, configDelete, fresh, record, recordBefore, removeHome: mode === "uninstall" && record === null && !!rec?.createdHome && !untouched };
}
async function backup(file) {
    const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
        await copyFile(file, bak);
        return bak;
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
}
/** Write what changed (with a .bak next to each changed file that existed). Returns the backups made */
export async function apply(home, p) {
    const baks = [];
    const made = {};
    await mkdir(home, { recursive: true });
    for (const [key, file, before, after, del] of [
        ["hooks", join(home, "hooks.json"), p.hooksBefore, p.hooksAfter, p.hooksDelete],
        ["config", p.configFile, p.configBefore, p.configAfter, p.configDelete],
    ]) {
        if (del) {
            await rm(file, { force: true });
            continue;
        }
        if (before === after)
            continue;
        const bak = await backup(file);
        if (bak) {
            baks.push(bak);
            made[key] = basename(bak);
        }
        await writeFile(file, after);
    }
    const recFile = join(home, RECORD);
    if (p.record === null) {
        if (p.recordBefore !== null) {
            await rm(recFile, { force: true });
            if (p.removeHome)
                await rmdir(home).catch(() => undefined);
        }
    }
    else {
        const rec = { ...p.record, backups: { ...p.record.backups } };
        if (p.fresh)
            rec.backups = made;
        const text = JSON.stringify(rec, null, 2) + "\n";
        if (text !== p.recordBefore)
            await writeFile(recFile, text);
    }
    return baks;
}
/** For doctor: is each ukagai handler in hooks.json, and does config.toml hold the hash Codex would compute */
export async function status(home) {
    const hooksFile = await codexPath(home, "hooks.json");
    const doc = await parseHooks(hooksFile, await read(join(home, "hooks.json")));
    const state = readState(await read(join(home, "config.toml")));
    const all = [...slots(doc).values()].filter((s) => isManagedCommand(s.command));
    const rows = CODEX_SPECS.map((spec) => {
        const s = all.find((x) => x.event === spec.event);
        if (!s)
            return { event: spec.event, installed: false };
        const have = state.get(stateKey(hooksFile, s.event, s.group, s.handler));
        const trusted = have === undefined ? "untrusted" : have === hookHash(s.event, s.matcher, s.h) ? "trusted" : "modified";
        return { event: spec.event, installed: true, trusted, command: String(s.command) };
    });
    return { hooksFile, rows };
}
//# sourceMappingURL=codex.js.map