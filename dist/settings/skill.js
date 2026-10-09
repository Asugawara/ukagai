// The human's edited version of the ukagai-explain skill: <data-dir>/skill/{SKILL.md, base.md, meta.json}.
// SKILL.md is the user's version; base.md is the default as it was when editing started (so a later change of the default is detectable);
// meta.json records the ukagai version that default came from.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getVersion } from "../version.js";
import { SKILL_SOURCE } from "./target.js";
export const skillDir = (dataDir) => join(dataDir, "skill");
/** Where the user's version lives (hooks point the agent here, or at a copy of it) */
export const customSkillPath = (dataDir) => join(skillDir(dataDir), "SKILL.md");
const basePath = (dataDir) => join(skillDir(dataDir), "base.md");
const metaPath = (dataDir) => join(skillDir(dataDir), "meta.json");
/** The text of a file, or null when it is missing or unreadable (never throws) */
async function text(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch {
        return null;
    }
}
export async function readSkill(dataDir, defaultPath = SKILL_SOURCE) {
    const [def, custom, base, meta] = await Promise.all([text(defaultPath), text(customSkillPath(dataDir)), text(basePath(dataDir)), text(metaPath(dataDir))]);
    let baseVersion = null;
    if (meta !== null) {
        try {
            const v = JSON.parse(meta).version;
            if (typeof v === "string")
                baseVersion = v;
        }
        catch {
            // a damaged meta.json only loses the version label
        }
    }
    return { default: def, custom, base, baseVersion, stale: custom !== null && base !== def };
}
async function atomicWrite(path, data) {
    const tmp = `${path}.${process.pid}.tmp`;
    try {
        await writeFile(tmp, data, "utf8");
        await rename(tmp, path);
    }
    catch (err) {
        await rm(tmp, { force: true }).catch(() => { });
        throw err;
    }
}
const exists = async (path) => (await text(path)) !== null;
/** Writes one after another per data directory (same pattern as SettingsStore) */
const chains = new Map();
function serial(dataDir, job) {
    const run = (chains.get(dataDir) ?? Promise.resolve()).then(job);
    chains.set(dataDir, run.catch(() => { }));
    return run;
}
/** Save the user's version. base.md and meta.json are written only the first time, so they keep the default from when editing started */
export function writeSkill(dataDir, body, defaultText) {
    return serial(dataDir, async () => {
        await mkdir(skillDir(dataDir), { recursive: true });
        if (!(await exists(basePath(dataDir))))
            await atomicWrite(basePath(dataDir), defaultText);
        if (!(await exists(metaPath(dataDir))))
            await atomicWrite(metaPath(dataDir), JSON.stringify({ version: getVersion() }) + "\n");
        await atomicWrite(customSkillPath(dataDir), body);
    });
}
/** Back to the default: remove the whole skill/ directory */
export function resetSkill(dataDir) {
    return serial(dataDir, () => rm(skillDir(dataDir), { recursive: true, force: true }));
}
//# sourceMappingURL=skill.js.map