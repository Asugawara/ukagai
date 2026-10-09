import { stat } from "node:fs/promises";
import { join } from "node:path";
import { unifiedDiff } from "../settings/diff.js";
import { readSettings, removeHooks, serialize, writeSettings } from "../settings/merge.js";
import { apply as applyCodex, plan } from "../install/codex.js";
import { hasSkill, removeSkill } from "../skill/files.js";
import { hookInvocation, parseTarget, type Target } from "../settings/target.js";
import { registeredClaude, registeredCodex } from "../settings/agents.js";
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
  if (!(t.claude && dryRun) && registeredClaude(await readSettings(t.settingsFile))) left.push("Claude Code");
  if (!(t.codex && dryRun) && (await registeredCodex(t.codexHome))) left.push("Codex CLI");
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
    // fail soft: the hook check or the shutdown request failed; say only what is true about the server
    if (!(await healthy(t.server))) return "server:   not running";
  }
  return `server:   still running at ${t.server}; stop it yourself (its process is "ukagai serve" or "dist/cli.js serve")`;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** Remove the ukagai hooks and the skill from Claude Code's settings */
async function uninstallClaude(t: Target, emit: (s: string) => void): Promise<void> {
  const fileExists = await exists(t.settingsFile);
  const before = await readSettings(t.settingsFile);
  const after = removeHooks(before);
  const changed = serialize(before) !== serialize(after);
  const skillExists = t.handleSkill && hasSkill(t.skillDir);
  if (t.dryRun) {
    const diff = unifiedDiff(serialize(before), serialize(after), t.settingsFile, `${t.settingsFile} (after)`);
    emit(diff === "" ? "settings: no changes\n" : diff);
    if (skillExists) emit(`skill: remove ${t.skillDir}/\n`);
    return;
  }
  if (fileExists && changed) {
    const bak = await writeSettings(t.settingsFile, after);
    emit(`settings: removed the ukagai hooks from ${t.settingsFile}\n`);
    if (bak) emit(`backup:   ${bak}\n`);
  } else emit("settings: no ukagai hooks are registered\n");
  if (skillExists) {
    removeSkill(t.skillDir);
    emit(`skill:    removed ${t.skillDir}/\n`);
  }
}

/** Remove the ukagai hooks and their trust from Codex CLI's hooks.json / config.toml */
async function uninstallCodex(t: Target, emit: (s: string) => void): Promise<void> {
  const p = await plan({ home: t.codexHome, invocation: hookInvocation(), timeout: t.timeout, hookArgs: [], noAutostart: false }, "uninstall");
  if (t.dryRun) {
    for (const [file, a, b] of [
      [p.hooksFile, p.hooksBefore, p.hooksAfter],
      [p.configFile, p.configBefore, p.configAfter],
    ] as const) {
      const diff = unifiedDiff(a, b, file, `${file} (after)`);
      emit(diff === "" ? `codex: ${file}: no changes\n` : diff);
    }
    return;
  }
  const baks = await applyCodex(t.codexHome, p);
  const changed = p.hooksBefore !== p.hooksAfter || p.configBefore !== p.configAfter;
  emit(changed ? `codex:    removed the ukagai hooks and trust from ${p.hooksFile} / ${p.configFile}\n` : "codex:    no ukagai hooks are registered\n");
  for (const b of baks) emit(`backup:   ${b}\n`);
}

export async function run(argv: string[]): Promise<number> {
  let t;
  try {
    t = parseTarget(argv, "uninstall");
  } catch (err) {
    process.stderr.write(`ukagai uninstall: ${(err as Error).message}\n`);
    return 2;
  }
  for (const w of t.warnings) process.stderr.write(`ukagai uninstall: warning: ${w}\n`);
  try {
    const out: string[] = [];
    // Without an explicit agent flag both are handled, and one agent's failure does not stop the other
    const isolate = !t.agentsExplicit;
    let failed = false;
    for (const [agent, on, fn] of [
      ["claude", t.claude, uninstallClaude],
      ["codex", t.codex, uninstallCodex],
    ] as const) {
      if (!on) continue;
      try {
        await fn(t, (s) => void out.push(s));
      } catch (err) {
        if (!isolate) throw err;
        failed = true;
        process.stderr.write(`${agent}: error: ${(err as Error).message}\n`);
      }
    }
    // With an agent that failed, whether hooks remain is unknown: leave the server alone
    const line = failed ? (t.settingsGiven || t.projectGiven ? undefined : "server:   left running (an agent failed above; fix it and run uninstall again)") : await serverStep(t, t.dryRun);
    if (line !== undefined) out.push(line + "\n");
    if (t.dryRun) out.push("(--dry-run: nothing was written)\n");
    process.stdout.write(out.join(""));
    return failed ? 1 : 0;
  } catch (err) {
    process.stderr.write(`ukagai uninstall: ${(err as Error).message}\n`);
    return 1;
  }
}
