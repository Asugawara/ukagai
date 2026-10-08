/** Is the ukagai plugin enabled? (then hooks and the skill come from the plugin, not from settings.json / hooks.json) */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PLUGIN_KEY = /^ukagai@/;

/** The `ukagai@<marketplace>` key of `enabledPlugins` set to true in any of the settings files (unreadable files are skipped) */
export async function enabledClaudePlugin(settingsFiles: string[]): Promise<string | undefined> {
  for (const file of settingsFiles) {
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    const ep = typeof doc === "object" && doc !== null ? (doc as { enabledPlugins?: unknown }).enabledPlugins : undefined;
    if (typeof ep !== "object" || ep === null || Array.isArray(ep)) continue;
    for (const [key, v] of Object.entries(ep)) if (PLUGIN_KEY.test(key) && v === true) return key;
  }
  return undefined;
}

const PLUGIN_HEADER = /^\s*\[plugins\."((?:[^"\\]|\\.)*)"\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;

/** The `ukagai@<marketplace>` key of a `[plugins."…"]` table with `enabled = true` in <codexHome>/config.toml */
export async function enabledCodexPlugin(codexHome: string): Promise<string | undefined> {
  let toml: string;
  try {
    toml = await readFile(join(codexHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = PLUGIN_HEADER.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!.replace(/\\(["\\])/g, "$1");
    if (!PLUGIN_KEY.test(key)) continue;
    for (let j = i + 1; j < lines.length && !ANY_HEADER.test(lines[j]!); j++) {
      if (/^\s*enabled\s*=\s*true\s*(#.*)?$/.test(lines[j]!)) return key;
    }
  }
  return undefined;
}
