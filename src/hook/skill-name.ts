/** The name the agent reads the explanation skill by: plugin skills are namespaced (`ukagai:ukagai-explain`) */
export function skillName(env: NodeJS.ProcessEnv = process.env, agent?: string): string {
  const inPlugin = (env["CLAUDE_PLUGIN_ROOT"] ?? "") !== "";
  return inPlugin && agent !== "codex" ? "ukagai:ukagai-explain" : "ukagai-explain";
}
