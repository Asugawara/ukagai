/** The files only the plugin tree has (written into the release stage by scripts/write-plugin-files.mjs) */
import { buildHookEntries } from "../settings/hooks-spec.js";
import { CODEX_SPECS, hookCommand } from "../install/codex.js";
const REPO = "https://github.com/Asugawara/ukagai";
const DESCRIPTION = "Answer Claude Code's and Codex's questions and plan approvals together with your team in a GUI.";
const TIMEOUT = 3600;
const json = (v) => JSON.stringify(v, null, 2) + "\n";
/** path (relative to the stage) → content. There is deliberately no hooks/hooks.json: Codex would pick up the Claude file */
export function pluginFiles(version) {
    const claudeHooks = buildHookEntries({
        invocation: { command: "/bin/sh", prefix: ["${CLAUDE_PLUGIN_ROOT}/bin/ukagai"] },
        timeout: TIMEOUT,
        observe: false,
    });
    const codexHooks = {};
    for (const spec of CODEX_SPECS) {
        const command = hookCommand({ home: "", invocation: { command: "${PLUGIN_ROOT}/bin/ukagai", prefix: [] }, timeout: TIMEOUT, hookArgs: [], noAutostart: false }, spec);
        const handler = { type: "command", command, timeout: spec.timeout ?? TIMEOUT };
        (codexHooks[spec.event] ??= []).push(spec.matcher === undefined ? { hooks: [handler] } : { matcher: spec.matcher, hooks: [handler] });
    }
    return {
        ".claude-plugin/plugin.json": json({
            name: "ukagai",
            version,
            description: DESCRIPTION,
            author: { name: "Asugawara" },
            repository: REPO,
            license: "MIT",
            skills: "./skills/",
            hooks: "./hooks/claude.json",
        }),
        "hooks/claude.json": json({ hooks: claudeHooks }),
        "plugin.json": json({
            name: "ukagai",
            version,
            description: DESCRIPTION,
            author: { name: "Asugawara" },
            repository: REPO,
            license: "MIT",
            skills: "./skills/",
            extensions: { "com.openai": { hooks: "./hooks/codex.json" } },
        }),
        // Codex 0.159.3 reads the hooks declaration only from .codex-plugin/plugin.json (or the default hooks/hooks.json, which we never ship)
        ".codex-plugin/plugin.json": json({ name: "ukagai", version, description: DESCRIPTION, hooks: "./hooks/codex.json" }),
        "hooks/codex.json": json({ hooks: codexHooks }),
    };
}
//# sourceMappingURL=build.js.map