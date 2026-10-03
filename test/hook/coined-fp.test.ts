import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCoined, validateExplanation } from "../../src/hook/explain.js";

// False positives found by the Q6 QA: ordinary product / hardware / date / spec codes must pass
const PASS = [
  "ARM64", "H2", "B2B", "T3 stack", "C4 model", "L2 cache", "L3 cache", "L1", "Q3 2026", "Q1", "Q4", "H1 2026", "FY25", "FY2025", "ES6", "ES5", "TS5",
  "M1 Mac", "M2 chip", "M3 Max", "A100 GPU", "H100", "V8 engine", "E2E", "E2E test", "VP9", "AV1", "SOC2", "SAML2", "PCI-DSS", "MPEG-4", "H264",
  "PS5", "IE11", "DB2", "PG16", "S3A", "W3C", "X11", "F-16", "B-52", "CO2", "H2O", "PM2.5", "D3.js", "P256", "P-384", "BM25", "Z3", "R2", "U2",
  "CVE-2024-1234", "US-EAST-1", "AP-NORTHEAST-1", "Day 1", "Week 2", "Tier 1", "UTF-8", "HTTP/2", "ES2022", "Node 22", "x86", "x64", "IPv6", "OAuth2",
  "S3", "EC2", "GPT-4", "COVID-19", "i18n", "k8s", "SHA-256", "OIDC", "I18N", "A11Y", "L10N", "CI", "API", "v0.2.0", "#12", "404",
  "ARM32", "X86", "X64", "ES7", "H265", "PS4", "PCI", "MPEG", "D3", "B2C", "C2C", "P2P", "M4", "L4", "Q2", "T1", "T2", "H1",
];
// As specified: made-up work item codes and ticket ids stay hits
const HIT = ["W3", "P1", "W-T2", "FT4", "TM28", "P-GH", "PR-123", "JIRA-123", "SEV-1", "Phase 2", "Gate B", "Step 1", "Sprint 5", "第3章", "第 3 段階", "フェーズ2"];

test("coined check: ordinary codes (the Q6 false-positive table) are not hits", () => {
  for (const w of PASS) assert.deepEqual(extractCoined(w), [], w);
});

test("coined check: plan codes and ticket ids are still hits", () => {
  for (const w of HIT) assert.ok(extractCoined(w).length > 0, w);
});

test("coined check: Q5-01 is reported whole; CVE ids and regions are skipped", () => {
  assert.deepEqual(extractCoined("see Q5-01 and CVE-2024-1234 in US-EAST-1"), ["Q5-01"]);
});

test("validateExplanation: recommended with (推奨) still matches the label", () => {
  const md = `---
ukagai: 1
question: どちらにしますか?
title: AかBか
reversibility: reversible
scope: file
recommended: A (推奨)
---
## Why this decision is needed now
今日決める。
## Options
| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| A (推奨) | a | Revert it |
| B | a | Revert it |
## Recommendation
Aにします。 If C, choose B.
`;
  const v = validateExplanation(md, "answer_question", ["A (推奨)", "B"], "ja", { question: "どちらにしますか?", descriptions: ["説明"] });
  assert.ok(!v.missing.includes("recommended"), String(v.missing));
  assert.ok(!v.missing.includes("language"));
});
