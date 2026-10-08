import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffPlans } from "./plan-diff.js";
export const MAX_STORED_VERSIONS = 20;
/** Plan snapshots taken when the human instructs on a plan file card: <dataDir>/plan-versions/<session_id>/{index.json,<at>.md} */
export class PlanVersionStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    dir(sessionId) {
        return join(this.dataDir, "plan-versions", encodeURIComponent(sessionId));
    }
    index(sessionId) {
        try {
            const v = JSON.parse(readFileSync(join(this.dir(sessionId), "index.json"), "utf8"));
            return Array.isArray(v) ? v.filter((e) => typeof e?.at === "string" && typeof e.file === "string") : [];
        }
        catch {
            return [];
        }
    }
    /** Store the plan as it is now, with the instruction the human gave on it. Keeps the newest MAX_STORED_VERSIONS */
    add(sessionId, plan, instruction) {
        const dir = this.dir(sessionId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const entries = this.index(sessionId);
        let file = `${instruction.at.replace(/[^0-9A-Za-z.-]/g, "-")}.md`;
        for (let k = 1; entries.some((e) => e.file === file); k++)
            file = `${instruction.at.replace(/[^0-9A-Za-z.-]/g, "-")}-${k}.md`;
        writeFileSync(join(dir, file), plan, { mode: 0o600 });
        entries.push({ at: instruction.at, file, instruction });
        entries.sort((a, b) => a.at.localeCompare(b.at));
        for (const old of entries.splice(0, Math.max(0, entries.length - MAX_STORED_VERSIONS)))
            rmSync(join(dir, old.file), { force: true });
        const tmp = join(dir, "index.json.tmp");
        writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
        renameSync(tmp, join(dir, "index.json"));
    }
    has(sessionId) {
        return existsSync(join(this.dir(sessionId), "index.json"));
    }
    list(sessionId) {
        const dir = this.dir(sessionId);
        const out = [];
        for (const e of this.index(sessionId)) {
            try {
                out.push({ at: e.at, source: "file", plan: readFileSync(join(dir, e.file), "utf8"), instruction: e.instruction });
            }
            catch { }
        }
        return out;
    }
}
/** What the human sent after an approve_plan decision: an `instruct` answer, or a rejection (its text may be empty) */
function approvalInstruction(d) {
    const r = d.response;
    if (!r)
        return undefined;
    if (r.instruct && r.text)
        return { text: r.text, kind: "instruct", at: r.decided_at };
    if (r.approve === false)
        return { text: r.reason?.trim() ? r.reason : "", kind: "reject", at: r.decided_at };
    return undefined;
}
/** The versions of a session (approve_plan decisions + stored file snapshots, by `at`), `current` appended when it differs from the last, and the diffs */
export function buildPlanVersions(decisions, stored, current, now = new Date().toISOString()) {
    // The versions begin after the latest approval: what was approved is done, a later plan is a new one
    const approvedAt = decisions.filter((d) => d.kind === "approve_plan" && d.response?.approve === true).reduce((m, d) => (d.created_at > m ? d.created_at : m), "");
    const fromDecisions = decisions
        .filter((d) => d.kind === "approve_plan" && "plan" in d.request && d.created_at > approvedAt)
        .map((d) => {
        const instruction = approvalInstruction(d);
        return { at: d.created_at, source: "approval", decision_id: d.id, plan: d.request.plan, ...(instruction ? { instruction } : {}) };
    });
    const merged = [...fromDecisions, ...stored.filter((v) => v.at > approvedAt)].sort((a, b) => a.at.localeCompare(b.at));
    if (current !== undefined && merged[merged.length - 1]?.plan !== current)
        merged.push({ at: now, source: "file", plan: current });
    const versions = merged.map((v, i) => ({ n: i + 1, ...v }));
    const last = versions[versions.length - 1];
    if (current !== undefined && last && last.plan === current)
        last.current = true;
    return { versions, diffs: versions.map((v, i) => diffPlans(i === 0 ? "" : versions[i - 1].plan, v.plan)) };
}
//# sourceMappingURL=plan-versions.js.map