/** The environment of a child ukagai process: the launcher marker and plugin variables of an outer run must not leak into the node-form assertions */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["UKAGAI_LAUNCHER", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"]) delete env[k];
  return { ...env, ...extra };
}
