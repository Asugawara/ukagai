/**
 * The ukagai mod: while a Claude Code terminal session is open it polls the ukagai server for answered decisions and submits them
 * as `[ukagai]` messages once the agent is idle. Every `$` call is here; the state machine is in core.ts.
 * The types below declare only what is used, so this file does not depend on the `claude-code` typings.
 */
import { MOD_POLL_MS, createSession, enabled, parseConfig, type Host, type ModSession } from "./core";

interface Dollar {
  http: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> };
  prompt: { submit(a: { text: string }): Promise<{ drop?: unknown }> };
  session: { id(): Promise<string> };
  fs: { read(path: string): Promise<string> };
  env: { get(name: string): Promise<string | undefined>; set(name: string, value: string | undefined): unknown };
  plugin: { root: string };
  clock: { every(ms: number, fn: () => void): { cancel(): void } };
}
type Next<E> = (e: E) => Promise<unknown>;
type On = {
  (event: "session.start", hook: ($: Dollar, e: { isInteractive: boolean; surface: string | null }, next: Next<unknown>) => Promise<unknown>): void;
  (event: "turn.start" | "turn.complete", hook: ($: Dollar, e: { agentId?: string }, next: Next<unknown>) => Promise<unknown>): void;
  (event: "session.end", hook: ($: Dollar, e: unknown, next: Next<unknown>) => Promise<unknown>): void;
};

export const register = (on: On): void => {
  let session: ModSession | undefined;
  let timer: { cancel(): void } | undefined;

  on("session.start", async ($, e, next) => {
    try {
      timer?.cancel();
      const read = async (path: string): Promise<string | undefined> => $.fs.read(path).catch(() => undefined);
      const env = { UKAGAI_DISABLE: await $.env.get("UKAGAI_DISABLE"), UKAGAI_MOD: await $.env.get("UKAGAI_MOD") };
      const config = parseConfig(await read(`${$.plugin.root}/hooks/mod/config.json`), await $.env.get("HOME"));
      if (enabled({ env, isInteractive: e.isInteractive, surface: e.surface }) && config.dataDir !== undefined) {
        const host: Host = {
          fetch: (url, init) => $.http.fetch(url, init),
          submit: async (text) => {
            const r = await $.prompt.submit({ text });
            return r.drop !== undefined ? { drop: String(r.drop) } : { ok: true };
          },
          sessionId: () => $.session.id(),
          now: () => Date.now(),
          readFile: read,
          getEnv: (name) => (name === "UKAGAI_DISABLE" ? $.env.get("UKAGAI_DISABLE") : name === "UKAGAI_MOD" ? $.env.get("UKAGAI_MOD") : $.env.get("HOME")),
          setEnv: async (_name, value) => void (await $.env.set("UKAGAI_MOD_OWNER", value)),
        };
        session = createSession(host, config);
        await session.start();
        const s = session;
        timer = $.clock.every(MOD_POLL_MS, () => void s.tick().catch(() => undefined));
      }
    } catch {
      // fail open: the hooks keep working without the mod
    }
    return next(e);
  });

  on("turn.start", async (_$, e, next) => {
    session?.turnStart(e.agentId);
    return next(e);
  });
  on("turn.complete", async (_$, e, next) => {
    session?.turnComplete(e.agentId);
    return next(e);
  });
  on("session.end", async (_$, e, next) => {
    timer?.cancel();
    session?.end();
    return next(e);
  });
};
