import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexHome } from "../serve/codex-bridge/index.js";

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
  /** Which options were given on the command line (the others may be read back from an existing registration) */
  given: { timeout: boolean; observe: boolean; noAutostart: boolean; server: boolean; dataDir: boolean };
  /** `--refresh` (install only): re-register only the agents that already have ukagai hooks */
  refresh: boolean;
  /** Handle Claude Code's settings and skill. Without an explicit agent flag this is a candidate (true); each command narrows it */
  claude: boolean;
  /** Handle Codex CLI's hooks.json / config.toml. Without an explicit agent flag this is a candidate (true); each command narrows it */
  codex: boolean;
  /** `--claude` / `--codex` / `--settings` / `--project` was given: `claude` and `codex` are exactly what was asked for */
  agentsExplicit: boolean;
  /** Notes for stderr (ignored old arguments) */
  warnings: string[];
  /** Codex home: `--codex-home`, else $CODEX_HOME, else ~/.codex */
  codexHome: string;
  /** Extra args for the hook (only when they differ from the defaults) */
  hookArgs: string[];
  /** `--force`: register in settings.json / hooks.json even when the ukagai plugin is enabled */
  force: boolean;
  /** `--settings <file>` was given */
  settingsGiven: boolean;
  /** `--project` was given */
  projectGiven: boolean;
  /** Settings files that can enable the plugin, in Claude Code's precedence order (local > project > user): the first one that mentions a ukagai@ key decides. Project files only with `--project` */
  pluginSettingsFiles: string[];
}

export const DEFAULT_SERVER = "http://127.0.0.1:4818";
export const defaultDataDir = (): string => join(homedir(), ".ukagai");

/** The args that point a hook at a non-default server / data dir */
export function hookArgsOf(dataDir: string, server: string): string[] {
  const args: string[] = [];
  if (dataDir !== defaultDataDir()) args.push("--data-dir", dataDir);
  if (server !== DEFAULT_SERVER) args.push("--server", server);
  return args;
}

export function parseTarget(argv: string[], command: "install" | "uninstall" | "doctor" = "doctor"): Target {
  let settings: string | undefined;
  let project = false;
  let skill = false;
  let force = false;
  let codex = false;
  let claude = false;
  let codexHome: string | undefined;
  let refresh = false;
  const warnings: string[] = [];
  const given = { timeout: false, observe: false, noAutostart: false, server: false, dataDir: false };
  const t = {
    timeout: 3600,
    observe: false,
    dryRun: false,
    noSkill: false,
    noAutostart: false,
    server: DEFAULT_SERVER,
    dataDir: defaultDataDir(),
  };
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
    else if (a === "--observe") t.observe = given.observe = true;
    else if (a === "--no-skill") t.noSkill = true;
    else if (a === "--skill") skill = true;
    else if (a === "--force") force = true;
    else if (a === "--codex") codex = true;
    else if (a === "--claude") claude = true;
    else if (a === "--codex-home") codexHome = resolve(val());
    else if (a === "--no-autostart") t.noAutostart = given.noAutostart = true;
    else if (a === "--refresh" && command === "install") refresh = true;
    else if (a === "--timeout") {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 15) throw new Error("--timeout must be an integer of 15 or more (seconds)");
      t.timeout = n;
      given.timeout = true;
    } else if (a === "--server") {
      t.server = val().replace(/\/+$/, "");
      given.server = true;
    } else if (a === "--lang" || a.startsWith("--lang=")) {
      // The language is chosen on the Settings page now; skip the value too (not validated)
      if (a === "--lang" && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) i++;
      warnings.push("--lang is ignored: change the language on the Settings page");
    } else if (a === "--data-dir") {
      t.dataDir = resolve(val());
      given.dataDir = true;
    } else throw new Error(`unknown argument: ${a}`);
  }
  const base = project ? join(process.cwd(), ".claude") : join(homedir(), ".claude");
  const agentsExplicit = codex || claude || settings !== undefined || project;
  return {
    ...t,
    given,
    refresh,
    warnings,
    agentsExplicit,
    codex: !agentsExplicit || codex,
    claude: !agentsExplicit || claude || settings !== undefined || project,
    codexHome: resolve(resolveCodexHome(codexHome)),
    hookArgs: hookArgsOf(t.dataDir, t.server),
    force,
    settingsGiven: settings !== undefined,
    projectGiven: project,
    pluginSettingsFiles: [...(project ? [join(base, "settings.local.json"), join(base, "settings.json")] : []), join(homedir(), ".claude", "settings.json")],
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

/** How a hook command is spelled in the registered settings */
export interface Invocation {
  command: string;
  /** Args before `hook` (the node form puts dist/cli.js here) */
  prefix: string[];
  /** True when the stable launcher (bin/ukagai) is used */
  launcher: boolean;
}

/**
 * The launcher form when this process was started through this tree's bin/ukagai (UKAGAI_LAUNCHER is the path as invoked,
 * symlinks not resolved, so hooks keep pointing at the stable path); otherwise node + dist/cli.js. Never throws.
 */
export function hookInvocation(env: NodeJS.ProcessEnv = process.env): Invocation {
  const l = env["UKAGAI_LAUNCHER"];
  try {
    if (l !== undefined && isAbsolute(l) && realpathSync(l) === realpathSync(join(REPO_ROOT, "bin", "ukagai"))) {
      return { command: l, prefix: [], launcher: true };
    }
  } catch {
    // fall through to the node form
  }
  return { command: process.execPath, prefix: [CLI_PATH], launcher: false };
}
