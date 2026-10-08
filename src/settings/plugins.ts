/** Is the ukagai plugin enabled? (then hooks and the skill come from the plugin, not from settings.json / hooks.json) */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PLUGIN_KEY = /^ukagai@/;

/**
 * The `ukagai@<marketplace>` key that enables the plugin. `settingsFiles` are in Claude Code's precedence order
 * (local > project > user); the first file that mentions any `ukagai@…` key decides: `true` → that key, `false` → undefined.
 * Unreadable files are skipped.
 */
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
    const mine = Object.entries(ep).filter(([key]) => PLUGIN_KEY.test(key));
    if (mine.length === 0) continue;
    return mine.find(([, v]) => v === true)?.[0];
  }
  return undefined;
}

// A TOML key: basic ("…", with escapes) or literal ('…')
const QKEY = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)')`;
const COMMENT = String.raw`\s*(#.*)?$`;
const PLUGIN_HEADER = new RegExp(String.raw`^\s*\[\s*plugins\s*\.\s*${QKEY}\s*\]${COMMENT}`);
const PLUGINS_HEADER = new RegExp(String.raw`^\s*\[\s*plugins\s*\]${COMMENT}`);
const ANY_HEADER = /^\s*\[/;
const ENABLED = new RegExp(String.raw`^\s*enabled\s*=\s*true${COMMENT}`);
const DOTTED = new RegExp(String.raw`^\s*${QKEY}\s*\.\s*enabled\s*=\s*true${COMMENT}`); // inside [plugins]
const DOTTED_ROOT = new RegExp(String.raw`^\s*plugins\s*\.\s*${QKEY}\s*\.\s*enabled\s*=\s*true${COMMENT}`); // at the top level
const INLINE = new RegExp(String.raw`^\s*${QKEY}\s*=\s*\{[^}]*\benabled\s*=\s*true\b[^}]*\}${COMMENT}`); // inside [plugins]

const keyOf = (m: RegExpExecArray): string => (m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2]!);

/**
 * The `ukagai@<marketplace>` key of a plugin enabled in <codexHome>/config.toml. Line-based, no TOML parser: only these
 * spellings are recognised: `[plugins."k"]` / `[plugins.'k']` with `enabled = true`, and under `[plugins]` the lines
 * `"k".enabled = true` and `"k" = { enabled = true }` (the top-level `plugins."k".enabled = true` too).
 */
export async function enabledCodexPlugin(codexHome: string): Promise<string | undefined> {
  let toml: string;
  try {
    toml = await readFile(join(codexHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  let section: { kind: "root" | "plugins" | "plugin" | "other"; key?: string } = { kind: "root" };
  for (const line of toml.split(/\r?\n/)) {
    if (ANY_HEADER.test(line)) {
      const h = PLUGIN_HEADER.exec(line);
      section = h ? { kind: "plugin", key: keyOf(h) } : PLUGINS_HEADER.test(line) ? { kind: "plugins" } : { kind: "other" };
      continue;
    }
    let m: RegExpExecArray | null = null;
    if (section.kind === "plugin") {
      if (ENABLED.test(line) && PLUGIN_KEY.test(section.key!)) return section.key;
    } else if (section.kind === "plugins") m = DOTTED.exec(line) ?? INLINE.exec(line);
    else if (section.kind === "root") m = DOTTED_ROOT.exec(line);
    if (m) {
      const key = keyOf(m);
      if (PLUGIN_KEY.test(key)) return key;
    }
  }
  return undefined;
}
