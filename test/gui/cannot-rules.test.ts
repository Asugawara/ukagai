// public/app.js keeps a copy of the coined-terms rules of src/hook/explain.ts (the block between `// <coined>` and `// </coined>`).
// The copy is run here, with no DOM, and compared with the original.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COINED_ALLOW, COINED_PHASE_EN, COINED_PHASE_JA, COINED_TOKEN, extractCoined,
} from "../../src/hook/explain.js";

const APP = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
const block = /\/\/ <coined>[\s\S]*?\/\/ <\/coined>/.exec(APP)![0];
const copy = new Function(
  `${block}\nreturn { COINED_ALLOW, COINED_TOKEN, COINED_PHASE_EN, COINED_PHASE_JA, extractCoined, termDefines };`,
)() as {
  COINED_ALLOW: Set<string>; COINED_TOKEN: RegExp; COINED_PHASE_EN: RegExp; COINED_PHASE_JA: RegExp;
  extractCoined(s: string): string[]; termDefines(s: string): boolean;
};

test("app.js coined-terms rules == src/hook/explain.ts: regex sources, flags, allowlist", () => {
  for (const k of ["COINED_TOKEN", "COINED_PHASE_EN", "COINED_PHASE_JA"] as const) {
    const [a, b] = [copy[k], { COINED_TOKEN, COINED_PHASE_EN, COINED_PHASE_JA }[k]];
    assert.equal(a.source, b.source, k);
    assert.equal(a.flags, b.flags, k);
  }
  assert.deepEqual([...copy.COINED_ALLOW].sort(), [...COINED_ALLOW].sort());
});

test("app.js extractCoined gives the same tokens as explain.ts", () => {
  const samples = [
    "W-T2 FT4 G-T2 TM28 P-GH and GHCR, but not CI or SHA256 or HTTP",
    "Phase 2 then Gate B; step by step is fine. 第 3 段階 and フェーズ2",
    "see https://example.com/W-T2 and v0.2.0-DT1 plus P50 P99 S3 EC2",
    "ＦＴ４ in full width",
  ];
  for (const s of samples) assert.deepEqual(copy.extractCoined(s), extractCoined(s), s);
  assert.deepEqual(copy.extractCoined(samples[0]!), ["W-T2", "FT4", "G-T2", "TM28", "P-GH"]);
});

test("app.js termDefines: 12 characters, and a pointer defines nothing", () => {
  assert.equal(copy.termDefines("the GitHub Container Registry"), true);
  assert.equal(copy.termDefines("the gate"), false);
  assert.equal(copy.termDefines("plan の行 plan の行 plan の行"), false);
  assert.equal(copy.termDefines("see plan, the plan item"), false);
});
