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
  (event: "session.end", hook: ($: Dollar, e: { reason?: string }, next: Next<unknown>) => Promise<unknown>): void;
};

export const register = (on: On): void => {
  let session: ModSession | undefined;
  let timer: { cancel(): void } | undefined;
  /** What a new ModSession needs again after a /clear: the process goes on, but no session.start follows */
  let rebuild: (() => Promise<void>) | undefined;

  on("session.start", async ($, e, next) => {
    try {
      timer?.cancel();
      // a re-run that ends up disabled must not leave the earlier session for a later /clear to rebuild
      session = undefined;
      rebuild = undefined;
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
        const begin = async (): Promise<void> => {
          const s = createSession(host, config);
          session = s;
          await s.start();
          timer = $.clock.every(MOD_POLL_MS, () => void s.tick().catch(() => undefined));
        };
        rebuild = begin;
        await begin();
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
    try {
      timer?.cancel();
      session?.end();
      // /clear ends the session but the process goes on under a new id and no session.start follows: start a fresh
      // ModSession (a new owner; it reads the new id on its first poll). Any other reason is a real end
      if (e.reason === "clear" && session !== undefined && rebuild !== undefined) await rebuild();
    } catch {
      // fail open
    }
    return next(e);
  });
};
