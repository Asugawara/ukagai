import { homedir } from "node:os";
import { join } from "node:path";
import { POLL_TIMEOUT_MS } from "../contract.js";

export type DenyTemplate = "A" | "B";

export interface HookOptions {
  /** hook の持ち時間(秒) */
  budgetSec: number;
  observe: boolean;
  server: string;
  dataDir: string;
  pollTimeoutMs: number;
  /** deny 理由文の版(docs/spec/explain.md 7 節。E4 で確定するまで切り替え可) */
  denyTemplate: DenyTemplate;
}

export function parseArgs(argv: string[]): HookOptions {
  const opts: HookOptions = {
    budgetSec: 590,
    observe: false,
    server: "http://127.0.0.1:4818",
    dataDir: join(homedir(), ".ukagai"),
    pollTimeoutMs: POLL_TIMEOUT_MS,
    denyTemplate: "A",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    if (a === "--observe") opts.observe = true;
    else if (a === "--budget") {
      const n = Number(next());
      if (Number.isFinite(n) && n > 0) opts.budgetSec = n;
    } else if (a === "--server") {
      const v = next();
      if (v) opts.server = v.replace(/\/+$/, "");
    } else if (a === "--data-dir") {
      const v = next();
      if (v) opts.dataDir = v;
    } else if (a === "--poll-timeout-ms") {
      const n = Number(next());
      if (Number.isFinite(n) && n > 0) opts.pollTimeoutMs = n;
    } else if (a === "--deny-template") {
      const v = next();
      if (v === "A" || v === "B") opts.denyTemplate = v;
    }
  }
  return opts;
}
