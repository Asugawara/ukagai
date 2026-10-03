import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexHome } from "../serve/codex-bridge/index.js";
import { LANGS, isLang, type Lang } from "./config.js";

export interface Target {
  settingsFile: string;
  skillDir: string;
  timeout: number;
  observe: boolean;
  dryRun: boolean;
  noSkill: boolean;
  /** Whether to place / remove / diagnose the skill (false with `--settings` unless `--skill` is given) */
  handleSkill: boolean;
  noAutostart: boolean;
  server: string;
  dataDir: string;
  /** `--lang`; undefined when not given */
  lang: Lang | undefined;
  /** Touch Claude Code's settings and skill (true unless `--codex` is given alone) */
  claude: boolean;
  /** `--codex`: also (or only) handle Codex CLI's hooks.json / config.toml */
  codex: boolean;
  /** Codex home: `--codex-home`, else $CODEX_HOME, else ~/.codex */
  codexHome: string;
  /** Extra args for the hook (only when they differ from the defaults) */
  hookArgs: string[];
}

const DEFAULT_SERVER = "http://127.0.0.1:4818";

export function parseTarget(argv: string[]): Target {
  let settings: string | undefined;
  let project = false;
  let skill = false;
  let codex = false;
  let claude = false;
  let codexHome: string | undefined;
  let lang: Lang | undefined;
  const t = {
    timeout: 3600,
    observe: false,
    dryRun: false,
    noSkill: false,
    noAutostart: false,
    server: DEFAULT_SERVER,
    dataDir: join(homedir(), ".ukagai"),
  };
  const defaultDataDir = t.dataDir;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--settings") settings = resolve(val());
    else if (a === "--project") project = true;
    else if (a === "--dry-run") t.dryRun = true;
    else if (a === "--observe") t.observe = true;
    else if (a === "--no-skill") t.noSkill = true;
    else if (a === "--skill") skill = true;
    else if (a === "--codex") codex = true;
    else if (a === "--claude") claude = true;
    else if (a === "--codex-home") codexHome = resolve(val());
    else if (a === "--no-autostart") t.noAutostart = true;
    else if (a === "--timeout") {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 15) throw new Error("--timeout must be an integer of 15 or more (seconds)");
      t.timeout = n;
    } else if (a === "--server") t.server = val().replace(/\/+$/, "");
    else if (a === "--lang") {
      const v = val();
      if (!isLang(v)) throw new Error(`--lang must be one of: ${LANGS.join(", ")}`);
      lang = v;
    } else if (a === "--data-dir") t.dataDir = resolve(val());
    else throw new Error(`unknown argument: ${a}`);
  }
  const base = project ? join(process.cwd(), ".claude") : join(homedir(), ".claude");
  const hookArgs: string[] = [];
  if (t.dataDir !== defaultDataDir) hookArgs.push("--data-dir", t.dataDir);
  if (t.server !== DEFAULT_SERVER) hookArgs.push("--server", t.server);
  return {
    ...t,
    lang,
    codex,
    claude: !codex || claude || settings !== undefined || project,
    codexHome: resolve(resolveCodexHome(codexHome)),
    hookArgs,
    handleSkill: !t.noSkill && (settings === undefined || skill),
    settingsFile: settings ?? join(base, "settings.json"),
    skillDir: join(base, "skills", "ukagai-explain"),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root (two levels up from both src/settings and dist/settings) */
export const REPO_ROOT = resolve(here, "../..");
export const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");
export const SKILL_SOURCE = join(REPO_ROOT, "skills", "ukagai-explain", "SKILL.md");
