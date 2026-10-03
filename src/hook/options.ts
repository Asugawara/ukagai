import { homedir } from "node:os";
import { join } from "node:path";
import { POLL_TIMEOUT_MS } from "../contract.js";

export type DenyTemplate = "A" | "B";

export type AgentKind = "claude" | "codex";

export interface HookOptions {
  /** Which agent calls the hook (--agent, default claude) */
  agent: AgentKind;
  /** Time budget of the hook (seconds) */
  budgetSec: number;
  observe: boolean;
  /** Do not auto-start the server or open the GUI on SessionStart */
  noAutostart: boolean;
  server: string;
  dataDir: string;
  pollTimeoutMs: number;
  /** Variant of the deny reason (docs/spec/explain.md section 7) */
  denyTemplate: DenyTemplate;
}

export function parseArgs(argv: string[]): HookOptions {
  const opts: HookOptions = {
    agent: "claude",
    budgetSec: 590,
    observe: false,
    noAutostart: false,
    server: "http://127.0.0.1:4818",
    dataDir: join(homedir(), ".ukagai"),
    pollTimeoutMs: POLL_TIMEOUT_MS,
    denyTemplate: "A",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    if (a === "--observe") opts.observe = true;
    else if (a === "--no-autostart") opts.noAutostart = true;
    else if (a === "--agent") {
      const v = next();
      if (v === "claude" || v === "codex") opts.agent = v;
    } else if (a === "--budget") {
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
