/** The environment of a child ukagai process: the launcher marker of an outer run must not leak into the node-form assertions */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["UKAGAI_LAUNCHER"];
  return { ...env, ...extra };
}
