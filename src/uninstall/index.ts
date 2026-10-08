import { rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { unifiedDiff } from "../settings/diff.js";
import { readSettings, removeHooks, serialize, writeSettings } from "../settings/merge.js";
import { apply as applyCodex, plan } from "../install/codex.js";
import { hookInvocation, parseTarget, type Target } from "../settings/target.js";
import { Client } from "../hook/client.js";

const HEALTHZ_TIMEOUT_MS = 2000;
const SHUTDOWN_TIMEOUT_MS = 2000;
const STOP_WAIT_MS = 3000;
const POLL_INTERVAL_MS = 200;

/** Whether /healthz answers 200. A referenced timer rather than AbortSignal.timeout: see src/hook/autostart.ts probe */
async function healthy(server: string): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${HEALTHZ_TIMEOUT_MS} ms`)), HEALTHZ_TIMEOUT_MS);
  try {
    return (await fetch(`${server}/healthz`, { signal: ac.signal })).status === 200;
  } catch {
    return false;
  }
  finally {
    clearTimeout(timer);
  }
}

/** Which agents still have ukagai hooks registered after this run (dryRun: as if this run had been applied) */
async function remainingHooks(t: Target, dryRun: boolean): Promise<string[]> {
  const left: string[] = [];
  // a Claude run removes the Claude hooks; otherwise whatever is registered stays
  if (!(t.claude && dryRun)) {
    const settings = await readSettings(t.settingsFile);
    if (serialize(settings) !== serialize(removeHooks(settings))) left.push("Claude Code");
  }
  if (!(t.codex && dryRun)) {
    const p = await plan({ home: t.codexHome, invocation: hookInvocation(), timeout: t.timeout, hookArgs: [], noAutostart: false }, "uninstall");
    if (p.hooksBefore !== p.hooksAfter) left.push("Codex CLI");
  }
  return left;
}

/** The server step of uninstall: stop the server once no hook is left. Returns the line to print, or undefined */
async function serverStep(t: Target, dryRun: boolean): Promise<string | undefined> {
  // --settings / --project target a development setup: the server belongs to the real one
  if (t.settingsGiven || t.projectGiven) return undefined;
  try {
    const left = await remainingHooks(t, dryRun);
    if (left.length > 0) return `server:   left running (ukagai hooks are still registered for ${left.join(" and ")})`;
    const up = await healthy(t.server);
    if (dryRun) return up ? `server:   would stop ${t.server}` : undefined;
    if (!up) return "server:   not running";
    await new Client(t.server, t.dataDir).shutdown(SHUTDOWN_TIMEOUT_MS);
    for (let waited = 0; waited < STOP_WAIT_MS; waited += POLL_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (!(await healthy(t.server))) return `server:   stopped ${t.server}`;
    }
  } catch {
    // fail soft: fall through to the manual hint
  }
  return `server:   still running at ${t.server}; stop it yourself (its process is "ukagai serve" or "dist/cli.js serve")`;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

export async function run(argv: string[]): Promise<number> {
  let t;
  try {
    t = parseTarget(argv);
  } catch (err) {
    process.stderr.write(`ukagai uninstall: ${(err as Error).message}\n`);
    return 2;
  }
  try {
    const fileExists = t.claude && (await exists(t.settingsFile));
    const before = t.claude ? await readSettings(t.settingsFile) : {};
    const after = removeHooks(before);
    const changed = serialize(before) !== serialize(after);
    const skillFile = join(t.skillDir, "SKILL.md");
    const skillExists = t.claude && t.handleSkill && (await exists(skillFile));
    const codexPlan = t.codex
      ? await plan({ home: t.codexHome, invocation: hookInvocation(), timeout: t.timeout, hookArgs: [], noAutostart: false }, "uninstall")
      : undefined;

    if (t.dryRun) {
      if (t.claude) {
        const diff = unifiedDiff(serialize(before), serialize(after), t.settingsFile, `${t.settingsFile} (after)`);
        process.stdout.write(diff === "" ? "settings: no changes\n" : diff);
        if (skillExists) process.stdout.write(`skill: remove ${skillFile}\n`);
      }
      if (codexPlan) {
        for (const [file, a, b] of [
          [codexPlan.hooksFile, codexPlan.hooksBefore, codexPlan.hooksAfter],
          [codexPlan.configFile, codexPlan.configBefore, codexPlan.configAfter],
        ] as const) {
          const diff = unifiedDiff(a, b, file, `${file} (after)`);
          process.stdout.write(diff === "" ? `codex: ${file}: no changes\n` : diff);
        }
      }
      const line = await serverStep(t, true);
      if (line !== undefined) process.stdout.write(line + "\n");
      process.stdout.write("(--dry-run: nothing was written)\n");
      return 0;
    }

    const out: string[] = [];
    if (t.claude) {
      if (fileExists && changed) {
        const bak = await writeSettings(t.settingsFile, after);
        out.push(`settings: removed the ukagai hooks from ${t.settingsFile}`);
        if (bak) out.push(`backup:   ${bak}`);
      } else out.push("settings: no ukagai hooks are registered");
      if (skillExists) {
        await rm(skillFile);
        await rmdir(t.skillDir).catch(() => undefined);
        out.push(`skill:    removed ${skillFile}`);
      }
    }
    if (codexPlan) {
      const baks = await applyCodex(t.codexHome, codexPlan);
      const changedCodex = codexPlan.hooksBefore !== codexPlan.hooksAfter || codexPlan.configBefore !== codexPlan.configAfter;
      out.push(changedCodex ? `codex:    removed the ukagai hooks and trust from ${codexPlan.hooksFile} / ${codexPlan.configFile}` : "codex:    no ukagai hooks are registered");
      for (const b of baks) out.push(`backup:   ${b}`);
    }
    const line = await serverStep(t, false);
    if (line !== undefined) out.push(line);
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`ukagai uninstall: ${(err as Error).message}\n`);
    return 1;
  }
}
