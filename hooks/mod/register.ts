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
  /** Absent on a Claude Code without the pane API: every call is in a try/catch, so the mod then shows nothing. It is never read as a value (the engine refuses that) */
  ui: {
    open(pane: { id: string; title?: string; closeOnEscape?: true; rows?: number }): Promise<{ isPlaced: boolean }>;
    close(pane: { id: string }): Promise<void>;
    panes(): Promise<ReadonlyArray<{ id: string; isPlaced: boolean }>>;
    resolve(e: unknown): { Box: unknown; Text: unknown };
    toast(text: string): void;
    invalidate(event: "ui.render"): void;
  };
}
type Next<E> = (e: E) => Promise<unknown>;
type On = {
  (event: "session.start", hook: ($: Dollar, e: { isInteractive: boolean; surface: string | null }, next: Next<unknown>) => Promise<unknown>): void;
  (event: "turn.start" | "turn.complete", hook: ($: Dollar, e: { agentId?: string }, next: Next<unknown>) => Promise<unknown>): void;
  (event: "session.end", hook: ($: Dollar, e: { reason?: string }, next: Next<unknown>) => Promise<unknown>): void;
  (event: "ui.render", match: { component: "Pane"; requestId: string }, hook: ($: Dollar, e: unknown, next: Next<unknown>) => Promise<unknown>): void;
  (event: "ui.close", hook: ($: Dollar, e: { id: string; origin: { kind: "plugin" | "person" | "unload" } }, next: Next<unknown>) => Promise<unknown>): void;
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

/*
 * The engine's static check on a hooks module (seen as "failed to load" in `claude --debug`, text in the engine's error):
 *  - `$` is spelled `$.noun.method(...)` at every use; `$.ui` is never read as a value (`!$.ui`, `$.ui ?`, `$.ui?.`);
 *  - `$` may be passed only to a function declared at the top level of the module (a function declaration, or a const bound
 *    to one) or imported from a file of the module's own. A function nested inside `register` is refused.
 * So the helpers taking `$` are top-level declarations, their state is module-level, and a Claude Code without `$.ui`
 * is handled by try/catch around the `$.ui.*` calls (the call then throws a TypeError), which keeps the mod fail-open.
 */
let session: ModSession | undefined;
let timer: { cancel(): void } | undefined;
/** What a new ModSession needs again after a /clear: the process goes on, but no session.start follows */
let rebuild: (() => Promise<void>) | undefined;
/** The question the pane shows (undefined: none) and the language it is drawn in */
let waiting: PollWaiting | undefined;
let lang: Lang = "en";
let dataDir: string | undefined;
let reloadCheck = false;

async function readLang($: Dollar): Promise<Lang> {
  if (dataDir === undefined) return "en";
  try {
    const o = JSON.parse(await $.fs.read(`${dataDir.replace(/[\\/]+$/, "")}/config.json`)) as { lang?: unknown };
    return o.lang === "ja" ? "ja" : "en";
  } catch {
    return "en";
  }
}
async function isOpen($: Dollar): Promise<boolean> {
  try {
    return (await $.ui.panes()).some((p) => p.id === PANE_ID);
  } catch {
    return false;
  }
}
/**
 * Shows `w` in the pane: opens it if it is not up, then always asks for a redraw. The terminal reuses its settled evaluation of
 * a pane id (debug log: "terminal reuses its settled evaluation"), also for a pane closed and opened again, so without the
 * invalidate a second question would be drawn with the first one's text and language.
 */
async function openPane($: Dollar, w: PollWaiting): Promise<void> {
  try {
    waiting = w;
    lang = await readLang($);
    if (!(await isOpen($))) await $.ui.open({ id: PANE_ID, title: "ukagai", closeOnEscape: true, rows: 2 });
    $.ui.invalidate("ui.render");
  } catch {
    // no pane API: show nothing
  }
}
async function closePane($: Dollar): Promise<void> {
  try {
    if (await isOpen($)) await $.ui.close({ id: PANE_ID });
  } catch {
    // fail open
  }
}
async function showWaiting($: Dollar, w: PollWaiting | undefined): Promise<void> {
  reloadCheck = false;
  if (w !== undefined) return openPane($, w);
  waiting = undefined;
  return closePane($);
}
function toast($: Dollar, text: string): void {
  try {
    $.ui.toast(text);
  } catch {
    // no pane API
  }
}

export const register = (on: On): void => {
  // a register call starts from nothing (tests register more than once in a process)
  session = timer = rebuild = waiting = dataDir = undefined;
  lang = "en";
  reloadCheck = false;

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
          showWaiting: (w) => showWaiting($, w),
        };
        dataDir = config.dataDir;
        const begin = async (): Promise<void> => {
          const s = createSession(host, config);
          session = s;
          await s.start();
          // after a reload the pane may still be up: the first poll decides whether it stays
          reloadCheck = (await isOpen($)) && waiting === undefined;
          if (reloadCheck) {
            await s.refresh();
            if (reloadCheck) {
              reloadCheck = false;
              await closePane($);
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
      const { Box, Text } = $.ui.resolve(e);
      const t = TEXT[lang];
      const h = hyper();
      // one row each: a long question must not push the hint (the Esc instruction) out of the two-row pane
      return h(
        Box,
        { flexDirection: "column" },
        h(Text, { wrap: "truncate-end" }, t.line(waiting?.question || t.fallback)),
        h(Text, { dimColor: true, wrap: "truncate-end" }, t.hint),
      );
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
        if (r === "failed") toast($, TEXT[lang].failed);
      }
    } catch {
      // fail open
    }
    // never keep the pane open
    return next(e);
  });
};
