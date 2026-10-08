import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isManagedHook } from "./hooks-spec.js";
export async function readSettings(file) {
    let text;
    try {
        text = await readFile(file, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return {};
        throw err;
    }
    if (text.trim() === "")
        return {};
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        throw new Error(`${file} is not valid JSON: ${err.message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${file} does not contain a JSON object at the top level`);
    }
    return parsed;
}
export function serialize(s) {
    return JSON.stringify(s, null, 2) + "\n";
}
/** Copy to <file>.bak-<ISO time> before writing. No bak is made if the file does not exist */
export async function writeSettings(file, s) {
    let bak = null;
    try {
        bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await copyFile(file, bak);
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
        bak = null;
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serialize(s));
    return bak;
}
function hooksOf(s) {
    const h = s["hooks"];
    if (h === undefined)
        return {};
    if (typeof h !== "object" || h === null || Array.isArray(h)) {
        throw new Error("hooks in settings is not an object");
    }
    return h;
}
function stripManaged(groups) {
    if (!Array.isArray(groups))
        return [];
    const out = [];
    for (const g of groups) {
        const inner = g?.hooks;
        if (typeof g !== "object" || g === null || !Array.isArray(inner)) {
            out.push(g);
            continue;
        }
        const kept = inner.filter((h) => !isManagedHook(h));
        if (kept.length === inner.length)
            out.push(g);
        else if (kept.length > 0)
            out.push({ ...g, hooks: kept });
    }
    return out;
}
/** Replace the marked entries and keep the rest. The input is not modified */
export function mergeHooks(existing, entries) {
    const removed = removeHooks(existing);
    const hooks = { ...hooksOf(removed) };
    for (const [event, groups] of Object.entries(entries)) {
        const cur = hooks[event];
        hooks[event] = [...(Array.isArray(cur) ? cur : []), ...groups];
    }
    return { ...removed, hooks };
}
/** Remove only the marked entries. Events and hooks that become empty are dropped */
export function removeHooks(existing) {
    if (existing["hooks"] === undefined)
        return { ...existing };
    const hooks = {};
    for (const [event, groups] of Object.entries(hooksOf(existing))) {
        const kept = Array.isArray(groups) ? stripManaged(groups) : groups;
        if (Array.isArray(kept) && kept.length === 0 && Array.isArray(groups) && groups.length > 0)
            continue;
        hooks[event] = kept;
    }
    const { hooks: _drop, ...rest } = existing;
    return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}
export function hasManaged(existing, event) {
    const groups = hooksOf(existing)[event];
    return (Array.isArray(groups) &&
        groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isManagedHook)));
}
export function findManaged(existing, event, where = () => true) {
    const groups = hooksOf(existing)[event];
    if (!Array.isArray(groups))
        return undefined;
    for (const g of groups) {
        const inner = g?.hooks;
        if (!Array.isArray(inner))
            continue;
        const h = inner.find((x) => isManagedHook(x) && where(x));
        if (h)
            return h;
    }
    return undefined;
}
//# sourceMappingURL=merge.js.map