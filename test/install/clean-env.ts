/**
 * The environment of a child ukagai process: the launcher marker and plugin variables of an outer run must not leak into the
 * node-form assertions, and neither may the developer machine: its locale, CODEX_HOME and a `claude` / `codex` on PATH would
 * change which agents install finds and which language it starts with.
 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["UKAGAI_LAUNCHER", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "LANG", "LC_ALL", "LC_MESSAGES", "CODEX_HOME"]) delete env[k];
  return { ...env, PATH: "/usr/bin:/bin", ...extra };
}
