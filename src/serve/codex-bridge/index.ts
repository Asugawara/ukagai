import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DecisionContext, DecisionSession } from "../../contract.js";
import type { Lang } from "../../settings/config.js";
import type { Store } from "../store.js";
import { RpcClient } from "./client.js";
import { createBridgeLog, type BridgeLog } from "./log.js";
import { PlanBridge } from "./plan.js";

export const SOCKET_RELATIVE = join("app-server-control", "app-server-control.sock");
const POLL_MS = 30000;
const BACKOFF_MAX_MS = 30000;

export type CodexBridgeOptions = {
  store: Store;
  dataDir: string;
  lang: Lang;
  /** Codex home (default: $CODEX_HOME, else ~/.codex) */
  codexHome?: string;
  collect?: (session: DecisionSession) => Promise<DecisionContext>;
  /** Poll interval while the socket is missing (for tests) */
  pollMs?: number;
  /** First reconnect delay; doubles up to 30 s (for tests) */
  backoffMs?: number;
  waitMs?: number;
  log?: BridgeLog;
};

export type CodexBridge = { socketPath: string; close: () => void };

export function resolveCodexHome(explicit?: string): string {
  return explicit ?? (process.env["CODEX_HOME"] || join(homedir(), ".codex"));
}

/**
 * Second client of the Codex app-server daemon, living inside `serve`. Never throws and never blocks serve:
 * failures are logged to `<data-dir>/codex-bridge.log` and retried.
 */
export function startCodexBridge(opts: CodexBridgeOptions): CodexBridge {
  const socketPath = join(resolveCodexHome(opts.codexHome), SOCKET_RELATIVE);
  const log = opts.log ?? createBridgeLog(opts.dataDir);
  const bridge = new PlanBridge({ store: opts.store, log, lang: opts.lang, collect: opts.collect, waitMs: opts.waitMs });
  const pollMs = opts.pollMs ?? POLL_MS;
  const backoffStart = opts.backoffMs ?? 1000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let client: RpcClient | undefined;
  let backoff = backoffStart;

  const later = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void connect(), ms);
    timer.unref();
  };

  async function connect(): Promise<void> {
    if (stopped) return;
    if (!existsSync(socketPath)) {
      later(pollMs);
      return;
    }
    const c = new RpcClient();
    client = c;
    c.onNotification = (n) => bridge.handle(n);
    c.onServerRequest = (n) => bridge.onServerRequest(n);
    c.onClose = (code) => {
      if (client !== c) return;
      client = undefined;
      bridge.detach();
      if (stopped) return;
      log("disconnected", { code });
      later(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
    try {
      await c.connect(socketPath);
      if (stopped) return c.close();
      log("connected", { socket: socketPath });
      backoff = backoffStart;
      await bridge.attach(c);
    } catch (err) {
      log("connect_failed", { error: err instanceof Error ? err.message : String(err) });
      if (client === c) {
        // onClose is not fired when the handshake never opened
        client = undefined;
        c.close();
        later(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  void connect();

  return {
    socketPath,
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      bridge.stop();
      client?.close();
    },
  };
}
