import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Languages the GUI / TUI can display. Agent-facing text (hook messages, skill) is always English. */
export const LANGS = ["en", "ja"] as const;
export type Lang = (typeof LANGS)[number];

export interface UkagaiConfig {
  /** Display language for the GUI / TUI, and the language the agent writes explanations in. */
  lang: Lang;
}

export const DEFAULT_CONFIG: UkagaiConfig = { lang: "en" };

export function configPath(dataDir: string): string {
  return join(dataDir, "config.json");
}

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && (LANGS as readonly string[]).includes(v);
}

/** Read `<data-dir>/config.json`. Missing or malformed file yields the defaults (never throws). */
export async function readConfig(dataDir: string): Promise<UkagaiConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(dataDir), "utf8")) as Record<string, unknown>;
    return { lang: isLang(raw.lang) ? raw.lang : DEFAULT_CONFIG.lang };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Write `<data-dir>/config.json`, creating the directory if needed. */
export async function writeConfig(dataDir: string, config: UkagaiConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPath(dataDir), JSON.stringify(config, null, 2) + "\n", "utf8");
}
