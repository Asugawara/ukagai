/**
 * The ukagai mod: while a Claude Code terminal session is open it polls the ukagai server for answered decisions and submits them
 * as `[ukagai]` messages once the agent is idle. Every `$` call is here; the state machine is in core.ts.
 * The types below declare only what is used, so this file does not depend on the `claude-code` typings.
 */
import { MOD_POLL_MS, createSession, enabled, parseConfig, type Host, type ModSession, type PollWaiting } from "./core";

interface Dollar {
  http: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> };
  prompt: { submit(a: { text: string }): Promise<{ drop?: unknown }> };
  session: { id(): Promise<string> };
  fs: { read(path: string): Promise<string> };
  env: { get(name: string): Promise<string | undefined>; set(name: string, value: string | undefined): unknown };
  plugin: { root: string };
  clock: { every(ms: number, fn: () => void): { cancel(): void } };
  /** Absent on a Claude Code without the pane API: the mod then shows nothing */
  ui?: {
    open(pane: { id: string; title?: string; closeOnEscape?: true; rows?: number }): Promise<{ isPlaced: boolean }>;
    close(pane: { id: string }): Promise<void>;
    panes(): Promise<ReadonlyArray<{ id: string; isPlaced: boolean }>>;
    resolve(e: unknown): { Box: unknown; Text: unknown };
    toast(text: string): void;
  };
}
type Next<E> = (e: E) => Promise<unknown>;
type On = {
  (event: "session.start", hook: ($: Dollar, e: { isInteractive: boolean; surface: string | null }, next: Next<unknown>) => Promise<unknown>): void;
  (event: "turn.start" | "turn.complete", hook: ($: Dollar, e: { agentId?: string }, next: Next<unknown>) => Promise<unknown>): void;
  (event: "session.end", hook: ($: Dollar, e: { reason?: string }, next: Next<unknown>) => Promise<unknown>): void;
  (event: "ui.render", match: { component: "Pane"; requestId: string }, hook: ($: Dollar, e: unknown, next: Next<unknown>) => Promise<unknown>): void;
  (event: "ui.close", hook: ($: Dollar, e: { id: string; origin: { kind: "plugin" | "person" | "unload" } }, next: Next<unknown>) => Promise<unknown>): void;
  (event: "tool.call", match: { tool: string }, hook: ($: Dollar, e: unknown, next: Next<unknown>) => Promise<unknown>): void;
};

const PANE_ID = "ukagai-waiting";
type Lang = "en" | "ja";
const TEXT = {
  en: {
    line: (q: string) => `ukagai: waiting for your answer: ${q}`,
    fallback: "(a question)",
    hint: "Esc at an empty prompt withdraws this question · answer it in the GUI to send it as a message",
    failed: "ukagai: could not withdraw the question",
  },
  ja: {
    line: (q: string) => `ukagai: 回答待ち: ${q}`,
    fallback: "(質問)",
    hint: "空のプロンプトで Esc を押すと、この質問を取り下げます · GUI で答えるとメッセージで届きます",
    failed: "ukagai: 質問を取り下げられませんでした",
  },
} as const;
/** The global `h` of the mod runtime (JSX is sugar for it); read at call time, never declared here */
type H = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;
const hyper = (): H => (globalThis as unknown as { h: H }).h;

export const register = (on: On): void => {
  let session: ModSession | undefined;
  let timer: { cancel(): void } | undefined;
  /** What a new ModSession needs again after a /clear: the process goes on, but no session.start follows */
  let rebuild: (() => Promise<void>) | undefined;
  /** The question the pane shows (undefined: none) and the language it is drawn in */
  let waiting: PollWaiting | undefined;
  let lang: Lang = "en";
  let dataDir: string | undefined;
  let reloadCheck = false;

  const readLang = async ($: Dollar): Promise<Lang> => {
    if (dataDir === undefined) return "en";
    try {
      const o = JSON.parse(await $.fs.read(`${dataDir.replace(/[\\/]+$/, "")}/config.json`)) as { lang?: unknown };
      return o.lang === "ja" ? "ja" : "en";
    } catch {
      return "en";
    }
  };
  const openPane = async ($: Dollar, w: PollWaiting): Promise<void> => {
    if (!$.ui) return;
    waiting = w;
    lang = await readLang($);
    await $.ui.open({ id: PANE_ID, title: "ukagai", closeOnEscape: true, rows: 2 });
  };
  const isOpen = async ($: Dollar): Promise<boolean> => ($.ui ? (await $.ui.panes()).some((p) => p.id === PANE_ID) : false);

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
          showWaiting: async (w) => {
            if (!$.ui) return;
            reloadCheck = false;
            if (w !== undefined) return openPane($, w);
            waiting = undefined;
            if (await isOpen($)) await $.ui.close({ id: PANE_ID });
          },
        };
        dataDir = config.dataDir;
        const begin = async (): Promise<void> => {
          const s = createSession(host, config);
          session = s;
          await s.start();
          // after a reload the pane may still be up: the first poll decides whether it stays
          reloadCheck = (await isOpen($).catch(() => false)) && waiting === undefined;
          if (reloadCheck) {
            await s.refresh();
            if (reloadCheck) {
              reloadCheck = false;
              await $.ui?.close({ id: PANE_ID });
            }
          }
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

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e, next) => {
    try {
      if (!$.ui) return next(e);
      const { Box, Text } = $.ui.resolve(e);
      const t = TEXT[lang];
      const h = hyper();
      return h(Box, { flexDirection: "column" }, h(Text, null, t.line(waiting?.question || t.fallback)), h(Text, { dimColor: true }, t.hint));
    } catch {
      return next(e);
    }
  });

  on("ui.close", async ($, e, next) => {
    try {
      if (e.id === PANE_ID && e.origin.kind === "person" && waiting !== undefined && session !== undefined) {
        const id = waiting.decision_id;
        waiting = undefined;
        const r = await session.withdraw(id);
        if (r === "failed") $.ui?.toast(TEXT[lang].failed);
      }
    } catch {
      // fail open
    }
    // never keep the pane open
    return next(e);
  });

  // Kept only if the real-terminal check shows it helps: an open made inside the person's prompt chain counts as "asked",
  // so the pane is drawn below 144 columns too. The poll timer opens it "unasked" first.
  on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
    const r = await next(e);
    try {
      await session?.refresh();
      if (waiting !== undefined && $.ui) {
        const p = (await $.ui.panes()).find((x) => x.id === PANE_ID);
        if (p === undefined || !p.isPlaced) await openPane($, waiting);
      }
    } catch {
      // fail open
    }
    return r;
  });
};
