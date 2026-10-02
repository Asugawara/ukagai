import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  AnswerRequest,
  CreateDecisionRequest,
  DecisionStatus,
  EventInput,
  POLL_TIMEOUT_MS,
  isAllowedExplanationPath,
  isAllowedTranscriptPath,
  type DecisionContext,
  type DecisionSession,
} from "../contract.js";
import type { SseHub } from "./sse.js";
import { HttpError, type AnswerPatch, type Store } from "./store.js";

export const COOKIE_NAME = "ukagai_session";
const CONTEXT_GUARD_MS = 1500;
const MAX_WAIT_MS = 600000;

export type AppDeps = {
  store: Store;
  hub: SseHub;
  token: string;
  publicDir: string;
  home: string;
  getPort: () => number;
  collect: (session: DecisionSession) => Promise<DecisionContext>;
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

  // ---- 認可なし ----

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/", async (c) => {
    let html: string;
    try {
      html = await readFile(join(deps.publicDir, "index.html"), "utf8");
    } catch {
      return c.json({ error: "index.html not found" }, 404);
    }
    if (!cookieOk(c)) {
      const value = randomBytes(24).toString("hex");
      cookies.add(value);
      setCookie(c, COOKIE_NAME, value, { httpOnly: true, sameSite: "Strict", path: "/" });
    }
    return c.html(html);
  });

  app.get("/public/*", async (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname.slice("/public/".length));
    const root = resolve(deps.publicDir);
    const file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) return c.json({ error: "not found" }, 404);
    try {
      const body = await readFile(file);
      return new Response(new Uint8Array(body), {
        headers: { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" },
      });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  // ---- decisions ----

  app.post("/api/decisions", auth("bearer"), jsonOnly, async (c) => {
    const req = await parse(c, CreateDecisionRequest);
    if (!isAllowedTranscriptPath(req.session.transcript_path, deps.home)) {
      return c.json({ error: "transcript_path not allowed" }, 400);
    }
    if (req.explanation && !isAllowedExplanationPath(req.explanation.path, req.session.scratchpad_dir, deps.home)) {
      return c.json({ error: "explanation.path not allowed" }, 400);
    }
    const existing = store.findByToolUse(req.tool_use_id);
    if (existing) return c.json(existing, 200);

    let context: DecisionContext = {};
    if (req.status !== "denied_explain") {
      const guard = new Promise<DecisionContext>((r) => setTimeout(() => r({}), CONTEXT_GUARD_MS).unref());
      context = await Promise.race([deps.collect(req.session).catch((): DecisionContext => ({})), guard]);
    }
    const { decision, created } = store.create(req, context);
    return c.json(decision, created ? 201 : 200);
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

  app.get("/api/decisions/:id/wait", auth("bearer"), async (c) => {
    const id = c.req.param("id");
    const raw = Number(c.req.query("timeout_ms") ?? POLL_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), MAX_WAIT_MS) : POLL_TIMEOUT_MS;
    const d = await store.wait(id, timeoutMs, c.req.raw.signal);
    if (!d) return c.body(null, 204);
    return c.json({ response: d.response });
  });

  app.post("/api/decisions/:id/ack", auth("bearer"), jsonOnly, (c) => {
    return c.json(store.ack(c.req.param("id")));
  });

  app.post("/api/decisions/:id/answer", auth("any"), jsonOnly, async (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ error: "decision not found" }, 404);
    const body = await parse(c, AnswerRequest);
    let patch: AnswerPatch;
    if ("answers" in body) patch = { kind: "answers", answers: body.answers };
    else if ("fallback" in body) patch = { kind: "fallback" };
    else if (body.approve) patch = { kind: "approve", ...(body.set_mode_auto ? { set_mode_auto: true } : {}) };
    else patch = { kind: "reject", reason: body.reason };
    return c.json(store.submitAnswer(id, patch));
  });

  // ---- events / sessions ----

  app.post("/api/events", auth("any"), jsonOnly, async (c) => {
    const ev = await parse(c, EventInput);
    store.addEvent(ev);
    return c.body(null, 204);
  });

  app.get("/api/sessions", auth("any"), (c) => c.json(store.listSessions()));

  app.get("/api/sessions/:id/pending-mode-switch", auth("bearer"), (c) => {
    return c.json(store.getModeSwitch(c.req.param("id")));
  });

  app.post("/api/sessions/:id/pending-mode-switch/consume", auth("bearer"), jsonOnly, (c) => {
    return c.json({ consumed: store.consumeModeSwitch(c.req.param("id")) });
  });

  // ---- metrics / stream ----

  app.get("/api/metrics", auth("any"), (c) => c.json(store.metrics()));

  app.get("/api/stream", auth("any"), (c) => hub.connect(c.req.raw.signal));

  return app;
}
