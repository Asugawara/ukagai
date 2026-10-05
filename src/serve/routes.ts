import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  AnswerRequest,
  DEFAULT_SETTINGS,
  CheckpointRequest,
  PlanReadRequest,
  PlanInstructRequest,
  Settings,
  CreateDecisionRequest,
  DecisionStatus,
  EventInput,
  POLL_TIMEOUT_MS,
  PLAN_BLOCK_SUFFIX,
  isAllowedExplanationPath,
  isPlanFile,
  plansDir,
  isAllowedTranscriptPath,
  type DecisionContext,
  type DecisionSession,
} from "../contract.js";
import type { Lang } from "../settings/config.js";
import type { SseHub } from "./sse.js";
import { collectGuarded } from "./context.js";
import { collectHistory } from "./history.js";
import { FILE_TYPES, documentDir, resolveDocumentFile, type DocumentScope } from "./files.js";
import { PlanError, listPlans, planFingerprint, planSummary, readPlan } from "./plans.js";
import type { PlanSummary } from "../contract.js";
import { PlanSessions } from "./plan-session.js";
import type { PlanReadStore } from "./plan-read.js";
import type { SettingsStore } from "./settings.js";
import { HttpError, SESSION_PANEL_OPEN_EVENT, type AnswerPatch, type Store } from "./store.js";

export const COOKIE_NAME = "ukagai_session";
const MAX_WAIT_MS = 600000;
const MAX_COOKIES = 1000;
const WAIT_GONE: readonly DecisionStatus[] = ["answered", "hook_disconnected", "answer_lost", "cancelled", "denied_explain"];

export type AppDeps = {
  /** The server's data directory (explanations under <dataDir>/explain/ are allowed) */
  dataDir?: string;
  store: Store;
  hub: SseHub;
  token: string;
  publicDir: string;
  home: string;
  /** Plan read marks (<dataDir>/plans-read.json) */
  planRead: PlanReadStore;
  /** Display language of the GUI / TUI (config.json, read at startup). Defaults to en */
  lang?: Lang;
  /** Live settings (<dataDir>/config.json). Without it GET /api/settings serves the defaults and PUT is refused */
  settings?: SettingsStore;
  getPort: () => number;
  /** One line to serve.log (plan_instructed) */
  log?: (event: string, fields?: Record<string, string | number | undefined>) => void;
  collect: (session: DecisionSession) => Promise<DecisionContext>;
  /** Finds the session of a plan file; the server owns it so it can announce a session found later. Defaults to a fresh one */
  planSessions?: PlanSessions;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createApp(deps: AppDeps): Hono {
  const { store, hub } = deps;
  const app = new Hono();
  const cookies = new Set<string>();

  const bearerOk = (c: Context): boolean => {
    const h = c.req.header("authorization") ?? "";
    return h.startsWith("Bearer ") && safeEqual(h.slice(7), deps.token);
  };
  const cookieOk = (c: Context): boolean => {
    const v = getCookie(c, COOKIE_NAME);
    return v !== undefined && cookies.has(v);
  };
  const cookieOnly = (c: Context): boolean => !bearerOk(c) && cookieOk(c);
  const auth = (mode: "bearer" | "any"): MiddlewareHandler => async (c, next) => {
    if (bearerOk(c) || (mode === "any" && cookieOk(c))) return next();
    return c.json({ error: "unauthorized" }, 401);
  };
  const jsonOnly: MiddlewareHandler = async (c, next) => {
    const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (ct !== "application/json") return c.json({ error: "content-type must be application/json" }, 415);
    return next();
  };

  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    const port = deps.getPort();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return c.json({ error: "bad host" }, 400);
    }
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(err.issues ? { error: err.message, issues: err.issues } : { error: err.message }, err.status);
    }
    return c.json({ error: "internal error" }, 500);
  });

  async function parse<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
    const r = schema.safeParse(body);
    if (!r.success) throw new HttpError(400, "invalid request", r.error.issues);
    return r.data;
  }

  // ---- No authorization ----

  app.get("/healthz", (c) => c.json({ ok: true }));

  // The two pages (/ and /settings) are served alike: session cookie, mtime-versioned asset URLs, the display language injected into <html>
  const page = (file: string, assets: string[]) => async (c: Context) => {
    let html: string;
    try {
      html = await readFile(join(deps.publicDir, file), "utf8");
    } catch {
      return c.json({ error: `${file} not found` }, 404);
    }
    if (!cookieOk(c)) {
      const value = randomBytes(24).toString("hex");
      cookies.add(value);
      if (cookies.size > MAX_COOKIES) cookies.delete(cookies.values().next().value as string);
      setCookie(c, COOKIE_NAME, value, { httpOnly: true, sameSite: "Strict", path: "/" });
    }
    // Add an mtime version to the app.js / app.css URLs so stale copies do not linger (vendor is left unchanged)
    for (const name of assets) {
      try {
        const v = Math.floor((await stat(join(deps.publicDir, name))).mtimeMs).toString(36);
        html = html.replace(`"/public/${name}"`, `"/public/${name}?v=${v}"`);
      } catch {}
    }
    const lang = deps.settings?.get().lang ?? deps.lang ?? "en";
    const theme = deps.settings?.get().theme ?? "system";
    html = html.replace(/<html(\s[^>]*)?>/i, (_m, attrs: string | undefined) => {
      const rest = (attrs ?? "").replace(/\s(?:lang|data-lang|data-theme)="[^"]*"/gi, "");
      return `<html lang="${lang}" data-lang="${lang}"${theme === "system" ? "" : ` data-theme="${theme}"`}${rest}>`;
    });
    c.header("Cache-Control", "no-store");
    return c.html(html);
  };
  app.get("/", page("index.html", ["app.js", "app.css"]));
  app.get("/settings", page("settings.html", ["settings.js", "app.css"]));
  app.get("/settings/", page("settings.html", ["settings.js", "app.css"]));

  app.get("/public/*", async (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname.slice("/public/".length));
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    const root = resolve(deps.publicDir);
    const file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) return c.json({ error: "not found" }, 404);
    try {
      const body = await readFile(file);
      return new Response(new Uint8Array(body), {
        headers: {
          "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          // Force a refetch every time so the browser's heuristic cache does not keep a stale app.js / app.css
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });
  // The browser's default icon request: answer without a body so it does not 404 in the log (the pages link /public/favicon.svg)
  app.get("/favicon.ico", (c) => c.body(null, 204));

  // ---- decisions ----

  app.post("/api/decisions", auth("bearer"), jsonOnly, async (c) => {
    const req = await parse(c, CreateDecisionRequest);
    // Codex has no transcript with --ephemeral: the hook sends "" for it (never allowed for Claude)
    const noTranscript = req.session.agent === "codex" && req.session.transcript_path === "";
    if (!noTranscript && !isAllowedTranscriptPath(req.session.transcript_path, deps.home)) {
      return c.json({ error: "transcript_path not allowed" }, 400);
    }
    if (req.explanation && req.explanation.path !== "" && !isAllowedExplanationPath(req.explanation.path, req.session.scratchpad_dir, deps.home, deps.dataDir)) {
      return c.json({ error: "explanation.path not allowed" }, 400);
    }
    if (req.kind === "checkpoint") {
      if (!CheckpointRequest.safeParse(req.request).success || req.status !== undefined) return c.json({ error: "checkpoint needs request {recap, recap_at}" }, 400);
      const made = store.create(req, {});
      return c.json(made.decision, made.created ? 201 : 200);
    }
    const existing = store.findByToolUse(req.tool_use_id);
    if (existing && !(existing.status === "denied_explain" && req.status !== "denied_explain")) {
      return c.json(existing, 200);
    }

    let context: DecisionContext = {};
    if (req.status !== "denied_explain") {
      context = await collectGuarded(deps.collect, req.session);
    }
    const { decision, created } = store.create(req, context);
    return c.json(decision, created ? 201 : 200);
  });

  app.get("/api/config", auth("any"), async (c) => {
    // Same value as the ?v= on app.js, so the GUI can tell whether it runs the newest build
    let build = "?";
    try { build = Math.floor((await stat(join(deps.publicDir, "app.js"))).mtimeMs).toString(36); } catch {}
    // `lang` follows the live settings (the GUI reads the rest from GET /api/settings)
    return c.json({ lang: deps.settings?.get().lang ?? deps.lang ?? "en", build });
  });

  app.get("/api/settings", auth("any"), (c) => c.json(deps.settings?.get() ?? DEFAULT_SETTINGS));

  app.put("/api/settings", auth("any"), jsonOnly, async (c) => {
    if (!deps.settings) return c.json({ error: "settings unavailable" }, 503);
    let next = await parse(c, Settings);
    // `install --lang` may have rewritten config.json while serve runs: a PUT that does not change the language keeps the file's
    if (next.lang === deps.settings.get().lang) next = { ...next, lang: await deps.settings.fileLang() };
    await deps.settings.update(next);
    hub.broadcast("settings.updated", next);
    return c.json(next);
  });

  // Images of the document being shown (explanation file or plan file): see docs/spec/markdown.md 2.12. Missing and forbidden are both 404
  app.get("/api/files", auth("any"), async (c) => {
    const notFound = () => c.json({ error: "not found" }, 404);
    const written = c.req.query("path") ?? "";
    const decisionId = c.req.query("decision");
    const planName = c.req.query("plan");
    let scope: DocumentScope | undefined;
    if (decisionId !== undefined) {
      const d = store.get(decisionId);
      const p = d?.explanation?.path;
      if (p) scope = p.endsWith(PLAN_BLOCK_SUFFIX) ? { baseDir: documentDir(p) } : { baseDir: documentDir(p), root: documentDir(p) };
      else if (d?.kind === "approve_plan" && d.plan_name) scope = { baseDir: plansDir(deps.home) }; // plan_name is set only for a plan file inside the plans dir
    } else if (planName !== undefined && isPlanFile(planName)) scope = { baseDir: plansDir(deps.home) };
    if (!scope) return notFound();
    try {
      const file = resolveDocumentFile(written, scope, deps.home, deps.dataDir);
      if (!file) return notFound();
      const body = await readFile(file);
      return c.body(new Uint8Array(body), 200, {
        "Content-Type": FILE_TYPES[extname(file).toLowerCase()]!,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-cache",
      });
    } catch {
      return notFound();
    }
  });

  app.get("/api/decisions", auth("any"), (c) => {
    const q = c.req.query("status");
    if (q === undefined) return c.json(store.list());
    const s = DecisionStatus.safeParse(q);
    if (!s.success) return c.json({ error: "invalid status" }, 400);
    return c.json(store.list(s.data));
  });

  app.get("/api/decisions/:id", auth("any"), (c) => {
    const d = store.get(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "decision not found" }, 404);
  });

  // ~/.claude/plans: read-only files, plus a per-plan read mark kept by ukagai (plan.updated / plan.removed come over SSE)
  const { isRead } = deps.planRead;
  const withSession = (p: PlanSummary): PlanSummary => {
    const session_id = planSessions.cached(p.name);
    return session_id ? { ...p, session_id } : p;
  };
  const planSessions = deps.planSessions ?? new PlanSessions(() => store.listSessions(), deps.home);
  app.get("/api/plans", auth("any"), async (c) => {
    const plans = await listPlans(deps.home, isRead);
    return c.json({
      plans: await Promise.all(
        plans.map(async (p) => {
          const session_id = await planSessions.find(p.name);
          return session_id ? { ...p, session_id } : p;
        }),
      ),
    });
  });

  app.get("/api/plans/:name", auth("any"), async (c) => {
    try {
      const plan = await readPlan(deps.home, c.req.param("name"), isRead);
      const session_id = await planSessions.find(plan.name);
      return c.json(session_id ? { ...plan, session_id } : plan);
    } catch (e) {
      if (e instanceof PlanError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });

  // Tell the agent that is writing this plan something, while no hook waits (same queue and terminal typing as a checkpoint reply)
  app.post("/api/plans/:name/instruct", auth("any"), jsonOnly, async (c) => {
    const name = c.req.param("name") ?? "";
    const body = await parse(c, PlanInstructRequest);
    const sessionId = isPlanFile(name) ? await planSessions.find(name) : undefined;
    if (!sessionId) return c.json({ error: "no session found for this plan" }, 404);
    const delivered_via = await store.queuePlanInstruction(sessionId, body.text);
    deps.log?.("plan_instructed", { plan: name, session: sessionId, via: delivered_via });
    return c.json({ delivered_via });
  });

  const setPlanRead = async (c: Context, read: boolean) => {
    const name = c.req.param("name") ?? "";
    if (!isPlanFile(name)) return c.json({ error: "invalid plan name" }, 400);
    let mtime: string | undefined;
    if (read) {
      const body = PlanReadRequest.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ error: "mtime required" }, 400);
      mtime = body.data.mtime;
    }
    const dir = plansDir(deps.home);
    if ((await planFingerprint(dir, name)) === null) return c.json({ error: "plan not found" }, 404);
    if (mtime !== undefined) deps.planRead.mark(name, mtime);
    else deps.planRead.unmark(name);
    const summary = await planSummary(dir, name, isRead);
    if (summary) hub.broadcast("plan.updated", withSession(summary));
    return c.json({ name, read });
  };
  app.post("/api/plans/:name/read", auth("any"), (c) => setPlanRead(c, true));
  app.delete("/api/plans/:name/read", auth("any"), (c) => setPlanRead(c, false));

  app.get("/api/decisions/:id/history", auth("any"), async (c) => {
    const d = store.get(c.req.param("id"));
    if (!d) return c.json({ error: "decision not found" }, 404);
    return c.json(await collectHistory(d.session, { home: deps.home }));
  });

  app.get("/api/decisions/:id/wait", auth("bearer"), async (c) => {
    const id = c.req.param("id");
    const raw = Number(c.req.query("timeout_ms") ?? POLL_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), MAX_WAIT_MS) : POLL_TIMEOUT_MS;
    const d = await store.wait(id, timeoutMs, c.req.raw.signal);
    if (!d) {
      const cur = store.get(id);
      if (cur && WAIT_GONE.includes(cur.status)) return c.json({ error: "decision is closed", status: cur.status }, 410);
      return c.body(null, 204);
    }
    return c.json({ response: d.response });
  });

  app.post("/api/decisions/:id/ack", auth("bearer"), jsonOnly, (c) => {
    return c.json(store.ack(c.req.param("id")));
  });

  // The hook's budget for this leg ended; the agent is asked to call the tool again and the hook re-attaches (GET /api/sessions/:id/open)
  app.post("/api/decisions/:id/handoff", auth("bearer"), jsonOnly, async (c) => {
    const body = await parse(c, z.object({ session_id: z.string() }));
    return c.json(store.handoff(c.req.param("id"), body.session_id));
  });

  app.post("/api/decisions/:id/cancel", auth("bearer"), jsonOnly, (c) => {
    return c.json(store.cancel(c.req.param("id")));
  });

  app.post("/api/decisions/:id/answer", auth("any"), jsonOnly, async (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ error: "decision not found" }, 404);
    const body = await parse(c, AnswerRequest);
    let patch: AnswerPatch;
    if ("kind" in body) patch = { kind: "checkpoint", answer: body.kind, ...(body.text !== undefined ? { text: body.text } : {}) };
    else if ("answers" in body) patch = { kind: "answers", answers: body.answers };
    else if ("fallback" in body) patch = { kind: "fallback" };
    else if ("instruct" in body) {
      if (store.get(id)!.kind !== "approve_plan") return c.json({ error: "instruct is only for approve_plan" }, 400);
      patch = { kind: "instruct_plan", text: body.text };
    } else if (body.approve) patch = { kind: "approve", ...(body.set_mode_auto ? { set_mode_auto: true } : {}) };
    else patch = { kind: "reject", reason: body.reason };
    return c.json(store.submitAnswer(id, patch));
  });

  // ---- events / sessions ----

  app.post("/api/events", auth("any"), jsonOnly, async (c) => {
    const ev = await parse(c, EventInput);
    if (cookieOnly(c) && ev.hook_event_name !== SESSION_PANEL_OPEN_EVENT) {
      return c.json({ error: "cookie may only send ukagai.session_panel_open" }, 403);
    }
    store.addEvent(ev);
    return c.body(null, 204);
  });

  app.get("/api/sessions", auth("any"), (c) => c.json(store.listSessions()));

  app.get("/api/sessions/:id/open", auth("bearer"), (c) => {
    const fingerprint = c.req.query("fingerprint");
    const toolUseId = c.req.query("tool_use_id");
    if (!fingerprint || !toolUseId) return c.json({ error: "fingerprint and tool_use_id are required" }, 400);
    const open = store.findOpen(c.req.param("id"), c.req.query("agent_id") || undefined, fingerprint);
    if (!open) return c.json({ error: "no open decision" }, 404);
    return c.json({ decision: store.reattach(open, toolUseId) });
  });

  // The human's reply to a progress checkpoint, for the agent's next tool call. Reading it consumes it
  app.get("/api/sessions/:id/instruction", auth("bearer"), (c) => {
    const instruction = store.consumeInstruction(c.req.param("id"));
    return instruction ? c.json({ instruction }) : c.json({ error: "no instruction" }, 404);
  });

  app.get("/api/sessions/:id/pending-mode-switch", auth("bearer"), (c) => {
    return c.json(store.getModeSwitch(c.req.param("id")));
  });

  app.post("/api/sessions/:id/pending-mode-switch/consume", auth("bearer"), jsonOnly, (c) => {
    return c.json({ consumed: store.consumeModeSwitch(c.req.param("id")) });
  });

  app.get("/api/sessions/:id/pending-rewrite", auth("bearer"), (c) => {
    return c.json(store.getRewrite(c.req.param("id")));
  });

  app.post("/api/sessions/:id/pending-rewrite/consume", auth("bearer"), jsonOnly, (c) => {
    return c.json({ consumed: store.consumeRewrite(c.req.param("id")) });
  });

  // ---- metrics / stream ----

  app.get("/api/metrics", auth("any"), (c) => c.json(store.metrics()));

  app.get("/api/stream", auth("any"), (c) => hub.connect(c.req.raw.signal));

  return app;
}
