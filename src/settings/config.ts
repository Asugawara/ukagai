import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_DELAY_MAX_S, CODEX_DELAY_MIN_S, DEFAULT_SETTINGS, INSTRUCTION_PRESETS_MAX, INSTRUCTION_PRESET_MAX_CHARS, type Settings } from "../contract.js";

/** Languages the GUI / TUI can display. Agent-facing text (hook messages, skill) is always English. */
export const LANGS = ["en", "ja"] as const;
export type Lang = (typeof LANGS)[number];

/** Everything in `<data-dir>/config.json`: the language (set on the Settings page) plus the settings page's values */
export type UkagaiConfig = Settings;

export const DEFAULT_CONFIG: UkagaiConfig = DEFAULT_SETTINGS;

export function configPath(dataDir: string): string {
  return join(dataDir, "config.json");
}

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && (LANGS as readonly string[]).includes(v);
}

/** `ja` when the first non-empty of LC_ALL, LC_MESSAGES, LANG starts with `ja`, else `en` (the language a first install starts with) */
export function localeLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const v = [env["LC_ALL"], env["LC_MESSAGES"], env["LANG"]].find((x) => x !== undefined && x !== "");
  return v !== undefined && v.startsWith("ja") ? "ja" : "en";
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);

/** Presets from anything: strings only, trimmed, blanks and over-long ones dropped, capped */
function presets(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "" && x.length <= INSTRUCTION_PRESET_MAX_CHARS)
    .slice(0, INSTRUCTION_PRESETS_MAX);
}

/** A settings object from anything: every unknown or malformed field falls back to its default (never throws) */
export function normalizeConfig(rawIn: unknown): UkagaiConfig {
  const raw = obj(rawIn);
  const d = DEFAULT_SETTINGS;
  const cp = obj(raw.checkpoints);
  const delay = cp.codex_delay_s;
  return {
    lang: isLang(raw.lang) ? raw.lang : d.lang,
    theme: raw.theme === "light" || raw.theme === "dark" || raw.theme === "system" ? raw.theme : d.theme,
    hints: bool(raw.hints, d.hints),
    checkpoints: {
      enabled: bool(cp.enabled, d.checkpoints.enabled),
      codex_delay_s: typeof delay === "number" && Number.isInteger(delay) && delay >= CODEX_DELAY_MIN_S && delay <= CODEX_DELAY_MAX_S ? delay : d.checkpoints.codex_delay_s,
      terminal_delivery: bool(cp.terminal_delivery, d.checkpoints.terminal_delivery),
    },
    plans: { auto_show: bool(obj(raw.plans).auto_show, d.plans.auto_show), instruction_presets: presets(obj(raw.plans).instruction_presets) },
    notify: {
      sound: bool(obj(raw.notify).sound, d.notify.sound),
      browser: bool(obj(raw.notify).browser, d.notify.browser),
      title_badge: bool(obj(raw.notify).title_badge, d.notify.title_badge),
    },
  };
}

/** Read `<data-dir>/config.json`. Missing or malformed file yields the defaults (never throws). */
export async function readConfig(dataDir: string): Promise<UkagaiConfig> {
  try {
    return normalizeConfig(JSON.parse(await readFile(configPath(dataDir), "utf8")));
  } catch {
    return normalizeConfig(undefined);
  }
}

/** Write `<data-dir>/config.json` (the whole object), creating the directory if needed. */
export async function writeConfig(dataDir: string, config: UkagaiConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPath(dataDir), JSON.stringify(config, null, 2) + "\n", "utf8");
}
