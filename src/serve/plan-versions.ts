import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision, PlanInstruction, PlanVersion, PlanVersionsResponse } from "../contract.js";
import { diffPlans } from "./plan-diff.js";

export const MAX_STORED_VERSIONS = 20;

type Entry = { at: string; file: string; instruction: PlanInstruction };

/** Plan snapshots taken when the human instructs on a plan file card: <dataDir>/plan-versions/<session_id>/{index.json,<at>.md} */
export class PlanVersionStore {
  constructor(private readonly dataDir: string) {}

  private dir(sessionId: string): string {
    return join(this.dataDir, "plan-versions", encodeURIComponent(sessionId));
  }

  private index(sessionId: string): Entry[] {
    try {
      const v = JSON.parse(readFileSync(join(this.dir(sessionId), "index.json"), "utf8")) as unknown;
      return Array.isArray(v) ? (v as Entry[]).filter((e) => typeof e?.at === "string" && typeof e.file === "string") : [];
    } catch {
      return [];
    }
  }

  /** Store the plan as it is now, with the instruction the human gave on it. Keeps the newest MAX_STORED_VERSIONS */
  add(sessionId: string, plan: string, instruction: PlanInstruction): void {
    const dir = this.dir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entries = this.index(sessionId);
    let file = `${instruction.at.replace(/[^0-9A-Za-z.-]/g, "-")}.md`;
    for (let k = 1; entries.some((e) => e.file === file); k++) file = `${instruction.at.replace(/[^0-9A-Za-z.-]/g, "-")}-${k}.md`;
    writeFileSync(join(dir, file), plan, { mode: 0o600 });
    entries.push({ at: instruction.at, file, instruction });
    entries.sort((a, b) => a.at.localeCompare(b.at));
    for (const old of entries.splice(0, Math.max(0, entries.length - MAX_STORED_VERSIONS))) rmSync(join(dir, old.file), { force: true });
    const tmp = join(dir, "index.json.tmp");
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, join(dir, "index.json"));
  }

  has(sessionId: string): boolean {
    return existsSync(join(this.dir(sessionId), "index.json"));
  }

  list(sessionId: string): Omit<PlanVersion, "n">[] {
    const dir = this.dir(sessionId);
    const out: Omit<PlanVersion, "n">[] = [];
    for (const e of this.index(sessionId)) {
      try {
        out.push({ at: e.at, source: "file", plan: readFileSync(join(dir, e.file), "utf8"), instruction: e.instruction });
      } catch {}
    }
    return out;
  }
}

/** What the human sent after an approve_plan decision: an `instruct` answer, or a rejection that carried text */
function approvalInstruction(d: Decision): PlanInstruction | undefined {
  const r = d.response;
  if (!r) return undefined;
  if (r.instruct && r.text) return { text: r.text, kind: "instruct", at: r.decided_at };
  if (r.approve === false && r.reason?.trim()) return { text: r.reason, kind: "reject", at: r.decided_at };
  return undefined;
}

/** The versions of a session (approve_plan decisions + stored file snapshots, by `at`), `current` appended when it differs from the last, and the diffs */
export function buildPlanVersions(decisions: Decision[], stored: Omit<PlanVersion, "n">[], current: string | undefined, now = new Date().toISOString()): PlanVersionsResponse {
  const fromDecisions: Omit<PlanVersion, "n">[] = decisions
    .filter((d) => d.kind === "approve_plan" && "plan" in d.request)
    .map((d) => {
      const instruction = approvalInstruction(d);
      return { at: d.created_at, source: "approval" as const, decision_id: d.id, plan: (d.request as { plan: string }).plan, ...(instruction ? { instruction } : {}) };
    });
  const merged = [...fromDecisions, ...stored].sort((a, b) => a.at.localeCompare(b.at));
  if (current !== undefined && merged[merged.length - 1]?.plan !== current) merged.push({ at: now, source: "file", plan: current });
  const versions: PlanVersion[] = merged.map((v, i) => ({ n: i + 1, ...v }));
  const last = versions[versions.length - 1];
  if (current !== undefined && last && last.plan === current) last.current = true;
  return { versions, diffs: versions.map((v, i) => diffPlans(i === 0 ? "" : versions[i - 1]!.plan, v.plan)) };
}
