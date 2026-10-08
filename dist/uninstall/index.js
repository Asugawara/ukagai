import { rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { unifiedDiff } from "../settings/diff.js";
import { readSettings, removeHooks, serialize, writeSettings } from "../settings/merge.js";
import { apply as applyCodex, plan } from "../install/codex.js";
import { hookInvocation, parseTarget } from "../settings/target.js";
async function exists(p) {
    return stat(p).then(() => true, () => false);
}
export async function run(argv) {
    let t;
    try {
        t = parseTarget(argv);
    }
    catch (err) {
        process.stderr.write(`ukagai uninstall: ${err.message}\n`);
        return 2;
    }
    try {
        const fileExists = t.claude && (await exists(t.settingsFile));
        const before = t.claude ? await readSettings(t.settingsFile) : {};
        const after = removeHooks(before);
        const changed = serialize(before) !== serialize(after);
        const skillFile = join(t.skillDir, "SKILL.md");
        const skillExists = t.claude && t.handleSkill && (await exists(skillFile));
        const codexPlan = t.codex
            ? await plan({ home: t.codexHome, invocation: hookInvocation(), timeout: t.timeout, hookArgs: [], noAutostart: false }, "uninstall")
            : undefined;
        if (t.dryRun) {
            if (t.claude) {
                const diff = unifiedDiff(serialize(before), serialize(after), t.settingsFile, `${t.settingsFile} (after)`);
                process.stdout.write(diff === "" ? "settings: no changes\n" : diff);
                if (skillExists)
                    process.stdout.write(`skill: remove ${skillFile}\n`);
            }
            if (codexPlan) {
                for (const [file, a, b] of [
                    [codexPlan.hooksFile, codexPlan.hooksBefore, codexPlan.hooksAfter],
                    [codexPlan.configFile, codexPlan.configBefore, codexPlan.configAfter],
                ]) {
                    const diff = unifiedDiff(a, b, file, `${file} (after)`);
                    process.stdout.write(diff === "" ? `codex: ${file}: no changes\n` : diff);
                }
            }
            process.stdout.write("(--dry-run: nothing was written)\n");
            return 0;
        }
        const out = [];
        if (t.claude) {
            if (fileExists && changed) {
                const bak = await writeSettings(t.settingsFile, after);
                out.push(`settings: removed the ukagai hooks from ${t.settingsFile}`);
                if (bak)
                    out.push(`backup:   ${bak}`);
            }
            else
                out.push("settings: no ukagai hooks are registered");
            if (skillExists) {
                await rm(skillFile);
                await rmdir(t.skillDir).catch(() => undefined);
                out.push(`skill:    removed ${skillFile}`);
            }
        }
        if (codexPlan) {
            const baks = await applyCodex(t.codexHome, codexPlan);
            const changedCodex = codexPlan.hooksBefore !== codexPlan.hooksAfter || codexPlan.configBefore !== codexPlan.configAfter;
            out.push(changedCodex ? `codex:    removed the ukagai hooks and trust from ${codexPlan.hooksFile} / ${codexPlan.configFile}` : "codex:    no ukagai hooks are registered");
            for (const b of baks)
                out.push(`backup:   ${b}`);
        }
        process.stdout.write(out.join("\n") + "\n");
        return 0;
    }
    catch (err) {
        process.stderr.write(`ukagai uninstall: ${err.message}\n`);
        return 1;
    }
}
//# sourceMappingURL=index.js.map