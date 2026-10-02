import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Target {
  settingsFile: string;
  skillDir: string;
  timeout: number;
  observe: boolean;
  dryRun: boolean;
  noSkill: boolean;
  /** skill を配置・削除・診断する対象か(`--settings` 指定時は `--skill` が無ければ false) */
  handleSkill: boolean;
  noAutostart: boolean;
  server: string;
  dataDir: string;
  /** hook の args に足す(既定値と違うときだけ) */
  hookArgs: string[];
}

const DEFAULT_SERVER = "http://127.0.0.1:4818";

export function parseTarget(argv: string[]): Target {
  let settings: string | undefined;
  let project = false;
  let skill = false;
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
      if (v === undefined) throw new Error(`${a} に値がありません`);
      return v;
    };
    if (a === "--settings") settings = resolve(val());
    else if (a === "--project") project = true;
    else if (a === "--dry-run") t.dryRun = true;
    else if (a === "--observe") t.observe = true;
    else if (a === "--no-skill") t.noSkill = true;
    else if (a === "--skill") skill = true;
    else if (a === "--no-autostart") t.noAutostart = true;
    else if (a === "--timeout") {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 15) throw new Error("--timeout は 15 以上の整数(秒)");
      t.timeout = n;
    } else if (a === "--server") t.server = val().replace(/\/+$/, "");
    else if (a === "--data-dir") t.dataDir = resolve(val());
    else throw new Error(`不明な引数: ${a}`);
  }
  const base = project ? join(process.cwd(), ".claude") : join(homedir(), ".claude");
  const hookArgs: string[] = [];
  if (t.dataDir !== defaultDataDir) hookArgs.push("--data-dir", t.dataDir);
  if (t.server !== DEFAULT_SERVER) hookArgs.push("--server", t.server);
  return {
    ...t,
    hookArgs,
    handleSkill: !t.noSkill && (settings === undefined || skill),
    settingsFile: settings ?? join(base, "settings.json"),
    skillDir: join(base, "skills", "ukagai-explain"),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
/** リポジトリ根(src/settings も dist/settings も 2 つ上) */
export const REPO_ROOT = resolve(here, "../..");
export const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");
export const SKILL_SOURCE = join(REPO_ROOT, "skills", "ukagai-explain", "SKILL.md");
