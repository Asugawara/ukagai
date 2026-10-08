/** The name the agent reads the explanation skill by: plugin skills are namespaced (`ukagai:ukagai-explain`) */
export function skillName(env = process.env, agent) {
    const inPlugin = (env["CLAUDE_PLUGIN_ROOT"] ?? "") !== "";
    return inPlugin && agent !== "codex" ? "ukagai:ukagai-explain" : "ukagai-explain";
}
//# sourceMappingURL=skill-name.js.map