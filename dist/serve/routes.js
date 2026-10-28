import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { AnswerRequest, AsideRequest, DEFAULT_SETTINGS, CheckpointRequest, AckRequest, ConsumePlanGrantRequest, DecisionAckRequest, PlanReadRequest, PlanInstructRequest, PollRequest, ReleaseRequest, Settings, SkillPut, CreateDecisionRequest, DecisionStatus, EventInput, POLL_TIMEOUT_MS, PLAN_BLOCK_SUFFIX, isAllowedExplanationPath, isPlanFile, plansDir, isAllowedTranscriptPath, DecisionKind, } from "../contract.js";
import { VERSION } from "../version.js";
import { collectGuarded } from "./context.js";
import { collectHistory } from "./history.js";
import { FILE_TYPES, FRAME_CSP, FRAME_POLICY, TAB_CSP, validFileTag, documentDir, isHtmlFile, resolveDocumentFile, rewriteHtml } from "./files.js";
import { injectFrameHelper } from "./frame-helper.js";
import { readSource } from "./source.js";
import { PlanError, listPlans, planFingerprint, planSummary, readPlan } from "./plans.js";
import { createAside } from "./aside.js";
import { PlanSessions } from "./plan-session.js";
import { PlanReady } from "./plan-ready.js";
import { TooLongError, composeWithComments } from "./comments.js";
import { MARK_BODY_LIMIT, MARK_MAX_BYTES, decodePng, markPathIn, marksDir, saveMark } from "./marks.js";
import { PlanVersionStore, buildPlanVersions } from "./plan-versions.js";
import { diffLines, MAX_DIFF_CELLS } from "./plan-diff.js";
import { customSkillPath, readSkill, resetSkill, writeSkill } from "../settings/skill.js";
import { SKILL_SOURCE } from "../settings/target.js";
import { toLines } from "../hook/explain.js";
import { bodyLimit } from "hono/body-limit";
import { HttpError, SESSION_PANEL_OPEN_EVENT } from "./store.js";
export const COOKIE_NAME = "ukagai_session";
const MAX_WAIT_MS = 600000;
const MAX_COOKIES = 1000;
const WAIT_GONE = ["answered", "hook_disconnected", "answer_lost", "cancelled", "denied_explain"];
const MIME = {
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
function safeEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}
const MarkRequest = z
    .strictObject({ decision: z.string().optional(), plan: z.string().optional(), png: z.string().min(1) })
    .refine((b) => (b.decision === undefined) !== (b.plan === undefined), { message: "exactly one of decision / plan", path: ["decision"] });
const GUI_LOG_BODY_LIMIT = 4096;
const Ms = z.number().int().min(0).max(2_147_483_647);
// One diagnostic line from the GUI (POST /api/gui/log), written to serve.log as `gui_<event>`
const GuiLogRequest = z.strictObject({
    event: z.enum(["sse_open", "sse_error", "decision_seen", "decision_shown", "visible", "resume", "error"]),
    tab: z.string().regex(/^[0-9a-z]{1,16}$/),
    hidden: z.union([z.literal(0), z.literal(1)]).optional(),
    build: z.string().max(16).optional(),
    decision: z.string().regex(/^[0-9a-f-]{1,64}$/).optional(),
    kind: DecisionKind.optional(),
    via: z.enum(["sse", "resync", "load"]).optional(),
    lag_ms: Ms.optional(),
    down_ms: Ms.optional(),
    hidden_ms: Ms.optional(),
    frozen_ms: Ms.optional(),
    message: z.string().max(300).optional(),
});
export function createApp(deps) {
    const { store, hub } = deps;
    const app = new Hono();
    const cookies = new Set();
    const aside = deps.aside ?? createAside(store, hub);
    const bearerOk = (c) => {
        const h = c.req.header("authorization") ?? "";
        return h.startsWith("Bearer ") && safeEqual(h.slice(7), deps.token);
    };
    const cookieOk = (c) => {
        const v = getCookie(c, COOKIE_NAME);
        return v !== undefined && cookies.has(v);
    };
    const cookieOnly = (c) => !bearerOk(c) && cookieOk(c);
    const auth = (mode) => async (c, next) => {
        if (bearerOk(c) || (mode === "any" && cookieOk(c)))
            return next();
        return c.json({ error: "unauthorized" }, 401);
    };
    const jsonOnly = async (c, next) => {
        const ct = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (ct !== "application/json")
            return c.json({ error: "content-type must be application/json" }, 415);
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
        if (err instanceof TooLongError)
            return c.json({ error: "too_long", length: err.length, max: err.max }, 400);
        if (err instanceof HttpError) {
            return c.json(err.issues ? { error: err.message, issues: err.issues } : { error: err.message }, err.status);
        }
        return c.json({ error: "internal error" }, 500);
    });
    async function parse(c, schema) {
        let body;
        try {
            body = await c.req.json();
        }
        catch {
            throw new HttpError(400, "invalid JSON");
        }
        const r = schema.safeParse(body);
        if (!r.success)
            throw new HttpError(400, "invalid request", r.error.issues);
        return r.data;
    }
    // ---- No authorization ----
    app.get("/healthz", (c) => c.json({ ok: true, version: VERSION, ...(deps.cliPath !== undefined ? { cli: deps.cliPath } : {}) }));
    // The two pages (/ and /settings) are served alike: session cookie, mtime-versioned asset URLs, the display language injected into <html>
    const page = (file, assets) => async (c) => {
        let html;
        try {
            html = await readFile(join(deps.publicDir, file), "utf8");
        }
        catch {
            return c.json({ error: `${file} not found` }, 404);
        }
        if (!cookieOk(c)) {
            const value = randomBytes(24).toString("hex");
            cookies.add(value);
            if (cookies.size > MAX_COOKIES)
                cookies.delete(cookies.values().next().value);
            setCookie(c, COOKIE_NAME, value, { httpOnly: true, sameSite: "Strict", path: "/" });
        }
        // Add an mtime version to the app.js / app.css URLs so stale copies do not linger (vendor is left unchanged)
        for (const name of assets) {
            try {
                const v = Math.floor((await stat(join(deps.publicDir, name))).mtimeMs).toString(36);
                html = html.replace(`"/public/${name}"`, `"/public/${name}?v=${v}"`);
            }
            catch { }
        }
        const lang = deps.settings?.get().lang ?? deps.lang ?? "en";
        const theme = deps.settings?.get().theme ?? "system";
        html = html.replace(/<html(\s[^>]*)?>/i, (_m, attrs) => {
            const rest = (attrs ?? "").replace(/\s(?:lang|data-lang|data-theme|data-frame-csp)="[^"]*"/gi, "");
            // data-frame-csp: the policy for the embedded HTML view's iframe `csp` attribute (the same string the frame pages are served with)
            return `<html lang="${lang}" data-lang="${lang}" data-frame-csp="${FRAME_POLICY}"${theme === "system" ? "" : ` data-theme="${theme}"`}${rest}>`;
        });
        c.header("Cache-Control", "no-store");
        return c.html(html);
    };
    app.get("/", page("index.html", ["app.js", "app.css"]));
    app.get("/settings", page("settings.html", ["settings.js", "app.css"]));
    app.get("/settings/", page("settings.html", ["settings.js", "app.css"]));
    app.get("/public/*", async (c) => {
        let rel;
        try {
            rel = decodeURIComponent(new URL(c.req.url).pathname.slice("/public/".length));
        }
        catch {
            return c.json({ error: "not found" }, 404);
        }
        const root = resolve(deps.publicDir);
        const file = resolve(root, rel);
        if (file !== root && !file.startsWith(root + sep))
            return c.json({ error: "not found" }, 404);
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
        }
        catch {
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
            if (!CheckpointRequest.safeParse(req.request).success || req.status !== undefined)
                return c.json({ error: "checkpoint needs request {recap, recap_at}" }, 400);
            const made = store.create(req, {});
            return c.json(made.decision, made.created ? 201 : 200);
        }
        const existing = store.findByToolUse(req.tool_use_id);
        if (existing && !(existing.status === "denied_explain" && req.status !== "denied_explain")) {
            return c.json(existing, 200);
        }
        let context = {};
        if (req.status !== "denied_explain") {
            context = await collectGuarded(deps.collect, req.session);
        }
        const { decision, created } = store.create(req, context);
        return c.json(decision, created ? 201 : 200);
    });
    app.get("/api/config", auth("any"), async (c) => {
        // Same value as the ?v= on app.js, so the GUI can tell whether it runs the newest build
        let build = "?";
        try {
            build = Math.floor((await stat(join(deps.publicDir, "app.js"))).mtimeMs).toString(36);
        }
        catch { }
        // `lang` follows the live settings (the GUI reads the rest from GET /api/settings)
        return c.json({ lang: deps.settings?.get().lang ?? deps.lang ?? "en", build });
    });
    app.get("/api/settings", auth("any"), (c) => c.json(deps.settings?.get() ?? DEFAULT_SETTINGS));
    app.put("/api/settings", auth("any"), jsonOnly, async (c) => {
        if (!deps.settings)
            return c.json({ error: "settings unavailable" }, 503);
        let next = await parse(c, Settings);
        // `install` creates config.json (language from the locale) only when it is missing, which can happen while serve runs: a PUT that does not change the language keeps the file's
        if (next.lang === deps.settings.get().lang)
            next = { ...next, lang: await deps.settings.fileLang() };
        await deps.settings.update(next);
        hub.broadcast("settings.updated", next);
        return c.json(next);
    });
    // The user's version of the skill (<dataDir>/skill/): read, replace, and go back to the default. Each answers with the same view and tells the other UIs
    const skillView = async () => {
        const st = await readSkill(deps.dataDir ?? "", deps.skillSource ?? SKILL_SOURCE);
        const path = deps.dataDir === undefined ? {} : { path: customSkillPath(deps.dataDir) };
        if (st.default === null)
            return { default: null, custom: st.custom, stale: st.stale, baseVersion: st.baseVersion, ...path, diff: [], changed: 0 };
        const a = toLines(st.default);
        const b = toLines(st.custom ?? st.default);
        const diff = (a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS ? [] : diffLines(a, b);
        return { default: st.default, custom: st.custom, stale: st.stale, baseVersion: st.baseVersion, ...path, diff, changed: diff.filter((d) => d.kind !== "same").length };
    };
    app.get("/api/skill", auth("any"), async (c) => c.json(await skillView()));
    app.put("/api/skill", auth("any"), jsonOnly, async (c) => {
        if (deps.dataDir === undefined)
            return c.json({ error: "skill unavailable" }, 503);
        const { text } = await parse(c, SkillPut);
        const def = (await readSkill(deps.dataDir, deps.skillSource ?? SKILL_SOURCE)).default;
        if (def === null)
            return c.json({ error: "the default skill cannot be read" }, 503);
        await writeSkill(deps.dataDir, text, def);
        const view = await skillView();
        hub.broadcast("skill.updated", view);
        return c.json(view);
    });
    app.delete("/api/skill", auth("any"), async (c) => {
        if (deps.dataDir === undefined)
            return c.json({ error: "skill unavailable" }, 503);
        await resetSkill(deps.dataDir);
        const view = await skillView();
        hub.broadcast("skill.updated", view);
        return c.json(view);
    });
    // Images of the document being shown (explanation file or plan file): see docs/spec/markdown.md 2.12. Missing and forbidden are both 404
    const filesAuth = auth("any");
    const whoOf = (c) => {
        const d = c.req.query("decision");
        return d !== undefined ? `decision=${encodeURIComponent(d)}` : `plan=${encodeURIComponent(c.req.query("plan") ?? "")}`;
    };
    // Every non-200 answer (401, 404, ...) opts in to a policy too: the GUI's frame refuses a document without one, and would show a broken-page icon instead of the error text
    app.use("/api/files", async (c, next) => {
        await next();
        if (c.res.status !== 200)
            c.header("Content-Security-Policy", "sandbox; default-src 'none'; base-uri 'none'");
    });
    // A page's own sub-resources carry a tag instead of the cookie (a sandboxed frame does not send it): see files.ts fileTag
    app.get("/api/files", (c, next) => (validFileTag(whoOf(c), c.req.query("path") ?? "", c.req.query("tag")) ? next() : filesAuth(c, next)), async (c) => {
        const notFound = () => c.json({ error: "not found" }, 404);
        const written = c.req.query("path") ?? "";
        const decisionId = c.req.query("decision");
        const planName = c.req.query("plan");
        let scope;
        if (decisionId !== undefined) {
            const d = store.get(decisionId);
            const p = d?.explanation?.path;
            // a plan document's relative paths also try the session's <scratchpad>/ukagai after the plans dir (the plan cannot sit next to its mockups)
            const sp = d?.session.scratchpad_dir;
            const fallbackDirs = sp ? [join(sp, "ukagai")] : undefined;
            if (p)
                scope = p.endsWith(PLAN_BLOCK_SUFFIX) ? { baseDir: documentDir(p), fallbackDirs } : { baseDir: documentDir(p), root: documentDir(p) };
            else if (d?.kind === "approve_plan" && d.plan_name)
                scope = { baseDir: plansDir(deps.home), fallbackDirs }; // plan_name is set only for a plan file inside the plans dir
        }
        else if (planName !== undefined && isPlanFile(planName))
            scope = { baseDir: plansDir(deps.home) };
        if (!scope)
            return notFound();
        try {
            const file = resolveDocumentFile(written, scope, deps.home, deps.dataDir);
            if (!file)
                return notFound();
            const body = await readFile(file);
            const headers = {
                "Content-Type": FILE_TYPES[extname(file).toLowerCase()],
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, no-cache",
            };
            if (isHtmlFile(file)) {
                // view=tab ("Open in new tab"): a top-level tab has no embedder enforcing a policy, so it gets no helper and no script at all
                const tab = c.req.query("view") === "tab";
                headers["Content-Security-Policy"] = tab ? TAB_CSP : FRAME_CSP;
                const page = rewriteHtml(body.toString("utf8"), dirname(file), whoOf(c), tab);
                return c.body(tab ? page : injectFrameHelper(page), 200, headers);
            }
            return c.body(new Uint8Array(body), 200, headers);
        }
        catch {
            return notFound();
        }
    });
    // The lines around a `path:line` reference of a decision's document, read from the session's working directory (docs/spec/api.md). Unresolvable and refused are both 404
    app.get("/api/source", filesAuth, (c) => {
        c.header("Cache-Control", "private, no-cache");
        c.header("X-Content-Type-Options", "nosniff");
        const num = (v) => (v !== undefined && /^[0-9]{1,7}$/.test(v) ? Number(v) : null);
        const line = num(c.req.query("line"));
        const endQ = c.req.query("end");
        const end = endQ === undefined ? undefined : num(endQ);
        if (line === null || line < 1 || end === null || (end !== undefined && end < line))
            return c.json({ error: "invalid line" }, 400);
        const d = store.get(c.req.query("decision") ?? "");
        const snippet = d ? readSource(d.session.cwd, c.req.query("path") ?? "", line, end, { home: deps.home, dataDir: deps.dataDir }) : null;
        return snippet ? c.json(snippet) : c.json({ error: "not found" }, 404);
    });
    app.get("/api/decisions", auth("any"), (c) => {
        const q = c.req.query("status");
        if (q === undefined)
            return c.json(store.list());
        const s = DecisionStatus.safeParse(q);
        if (!s.success)
            return c.json({ error: "invalid status" }, 400);
        return c.json(store.list(s.data));
    });
    app.get("/api/decisions/:id", auth("any"), (c) => {
        const d = store.get(c.req.param("id"));
        return d ? c.json(d) : c.json({ error: "decision not found" }, 404);
    });
    // ~/.claude/plans: read-only files, plus a per-plan read mark kept by ukagai (plan.updated / plan.removed come over SSE)
    const { isRead } = deps.planRead;
    const planSessions = deps.planSessions ?? new PlanSessions(() => store.listSessions(), deps.home);
    const planReady = deps.planReady ?? new PlanReady(store, planSessions, (event, data) => hub.broadcast(event, data), deps.dataDir ?? "");
    app.get("/api/plans", auth("any"), async (c) => {
        const plans = await listPlans(deps.home, isRead);
        return c.json({
            plans: await Promise.all(plans.map(async (p) => {
                const session_id = await planSessions.find(p.name);
                return planReady.decorate(session_id ? { ...p, session_id } : p);
            })),
        });
    });
    app.get("/api/plans/:name", auth("any"), async (c) => {
        try {
            const plan = await readPlan(deps.home, c.req.param("name"), isRead);
            const session_id = await planSessions.find(plan.name);
            return c.json({ ...plan, ready: planReady.readyOf(plan, session_id), ...(session_id ? { session_id } : {}) });
        }
        catch (e) {
            if (e instanceof PlanError)
                return c.json({ error: e.message }, e.status);
            throw e;
        }
    });
    /** Where the marks of a session live: its explanation folder's marks/, then <dataDir>/marks */
    const sessionOf = (sessionId) => {
        const d = store.list().find((x) => x.session.session_id === sessionId);
        if (d)
            return { session_id: sessionId, ...(d.session.scratchpad_dir ? { scratchpad_dir: d.session.scratchpad_dir } : {}) };
        return store.listSessions().some((x) => x.session_id === sessionId) ? { session_id: sessionId } : undefined;
    };
    const markDirs = (sessionId) => {
        if (deps.dataDir === undefined)
            return [];
        const sess = sessionId ? sessionOf(sessionId) : undefined;
        return [...(sess ? [marksDir(deps.dataDir, sess)] : []), marksDir(deps.dataDir)];
    };
    const commentCtx = (sessionId, c) => {
        const dirs = markDirs(sessionId);
        return { ...c, markPath: (id) => markPathIn(dirs, id) };
    };
    // A marked copy of an image region (PNG), kept where the agent can open it
    app.post("/api/marks", auth("any"), jsonOnly, bodyLimit({ maxSize: MARK_BODY_LIMIT, onError: (c) => c.json({ error: "payload too large" }, 413) }), async (c) => {
        if (deps.dataDir === undefined)
            return c.json({ error: "marks unavailable" }, 503);
        const body = await parse(c, MarkRequest);
        let sessionId;
        if (body.decision !== undefined) {
            const d = store.get(body.decision);
            if (!d)
                return c.json({ error: "decision not found" }, 404);
            sessionId = d.session.session_id;
        }
        else if (body.plan !== undefined) {
            if (!isPlanFile(body.plan))
                return c.json({ error: "invalid plan name" }, 400);
            sessionId = await planSessions.find(body.plan);
        }
        const b64 = body.png;
        if (Math.floor((b64.length * 3) / 4) > MARK_MAX_BYTES + 3)
            return c.json({ error: "png too large" }, 413);
        const png = decodePng(b64);
        if (!png)
            return c.json({ error: "png is not a PNG" }, 400);
        if (png.length > MARK_MAX_BYTES)
            return c.json({ error: "png too large" }, 413);
        const sess = sessionId ? sessionOf(sessionId) : undefined;
        return c.json({ id: saveMark(marksDir(deps.dataDir, sess), png) });
    });
    // Tell the agent that is writing this plan something, while no hook waits (same queue and terminal typing as a checkpoint reply)
    app.post("/api/plans/:name/instruct", auth("any"), jsonOnly, async (c) => {
        const name = c.req.param("name") ?? "";
        const body = await parse(c, PlanInstructRequest);
        const sessionId = isPlanFile(name) ? await planSessions.find(name) : undefined;
        if (!sessionId)
            return c.json({ error: "no session found for this plan" }, 404);
        // The plan file is the server's own record (the name in the URL), never the client's `source.file`
        const planFile = join(plansDir(deps.home), name);
        const text = body.comments ? composeWithComments(body.text, body.comments, commentCtx(sessionId, { planFile })) : (body.text ?? "");
        // Snapshot the plan as the human saw it: the agent rewrites the file after this (plan versions)
        if (planVersions) {
            try {
                const plan = await readPlan(deps.home, name);
                planVersions.add(sessionId, plan.markdown, { text, kind: "instruct", ...(body.comments ? { comments: body.comments } : {}), at: new Date().toISOString() });
            }
            catch { }
        }
        const delivered_via = await store.queuePlanInstruction(sessionId, text);
        deps.log?.("plan_instructed", { plan: name, session: sessionId, via: delivered_via });
        return c.json({ delivered_via });
    });
    const planVersions = deps.dataDir ? new PlanVersionStore(deps.dataDir) : undefined;
    // The plan versions of a session; `current` names what the client shows (decision:<id> or plan:<name>) so it is the last version
    app.get("/api/sessions/:id/plan-versions", auth("any"), async (c) => {
        const id = c.req.param("id");
        const cur = c.req.query("current");
        let current;
        let currentAt;
        if (cur !== undefined) {
            const m = /^(decision|plan):(.+)$/.exec(cur);
            if (!m)
                return c.json({ error: "invalid current" }, 400);
            if (m[1] === "plan" && !isPlanFile(m[2]))
                return c.json({ error: "invalid current" }, 400);
        }
        const decisions = store.list().filter((d) => d.session.session_id === id && d.kind === "approve_plan");
        const stored = planVersions?.list(id) ?? [];
        if (decisions.length === 0 && stored.length === 0 && !store.listSessions().some((x) => x.session_id === id))
            return c.json({ error: "session not found" }, 404);
        if (cur !== undefined) {
            const m = /^(decision|plan):(.+)$/.exec(cur);
            if (m[1] === "decision") {
                const d = store.get(m[2]);
                if (!d || d.session.session_id !== id || d.kind !== "approve_plan" || !("plan" in d.request))
                    return c.json({ error: "decision not found" }, 404);
                current = String(d.request.plan);
            }
            else {
                try {
                    const plan = await readPlan(deps.home, m[2]);
                    current = plan.markdown;
                    currentAt = plan.mtime;
                }
                catch (e) {
                    if (e instanceof PlanError)
                        return c.json({ error: e.message }, e.status);
                    throw e;
                }
            }
        }
        return c.json(buildPlanVersions(decisions, stored, current, currentAt));
    });
    const setPlanRead = async (c, read) => {
        const name = c.req.param("name") ?? "";
        if (!isPlanFile(name))
            return c.json({ error: "invalid plan name" }, 400);
        let mtime;
        if (read) {
            const body = PlanReadRequest.safeParse(await c.req.json().catch(() => undefined));
            if (!body.success)
                return c.json({ error: "mtime required" }, 400);
            mtime = body.data.mtime;
        }
        const dir = plansDir(deps.home);
        if ((await planFingerprint(dir, name)) === null)
            return c.json({ error: "plan not found" }, 404);
        if (mtime !== undefined)
            deps.planRead.mark(name, mtime);
        else
            deps.planRead.unmark(name);
        const summary = await planSummary(dir, name, isRead);
        if (summary)
            planReady.announce(summary);
        return c.json({ name, read });
    };
    app.post("/api/plans/:name/read", auth("any"), (c) => setPlanRead(c, true));
    app.delete("/api/plans/:name/read", auth("any"), (c) => setPlanRead(c, false));
    app.get("/api/decisions/:id/history", auth("any"), async (c) => {
        const d = store.get(c.req.param("id"));
        if (!d)
            return c.json({ error: "decision not found" }, 404);
        return c.json(await collectHistory(d.session, { home: deps.home }));
    });
    app.get("/api/decisions/:id/wait", auth("bearer"), async (c) => {
        const id = c.req.param("id");
        const raw = Number(c.req.query("timeout_ms") ?? POLL_TIMEOUT_MS);
        const timeoutMs = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), MAX_WAIT_MS) : POLL_TIMEOUT_MS;
        const d = await store.wait(id, timeoutMs, c.req.raw.signal);
        if (!d) {
            const cur = store.get(id);
            if (cur && WAIT_GONE.includes(cur.status))
                return c.json({ error: "decision is closed", status: cur.status }, 410);
            return c.body(null, 204);
        }
        return c.json({ response: d.response });
    });
    app.post("/api/decisions/:id/ack", auth("bearer"), jsonOnly, async (c) => {
        const body = await parse(c, DecisionAckRequest);
        return c.json(store.ack(c.req.param("id"), body.keep_plan_grant === true));
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
        const d = store.get(id);
        if (!d)
            return c.json({ error: "decision not found" }, 404);
        const body = await parse(c, AnswerRequest);
        let patch;
        if ("kind" in body)
            patch = { kind: "checkpoint", answer: body.kind, ...(body.text !== undefined ? { text: body.text } : {}) };
        else if ("answers" in body)
            patch = { kind: "answers", answers: body.answers, ...(body.comments ? { comments: body.comments } : {}) };
        else if ("fallback" in body)
            patch = { kind: "fallback" };
        else if ("instruct" in body) {
            if (d.kind !== "approve_plan")
                return c.json({ error: "instruct is only for approve_plan" }, 400);
            patch = { kind: "instruct_plan", ...(body.text !== undefined ? { text: body.text } : {}), ...(body.comments ? { comments: body.comments } : {}) };
        }
        else if (body.approve)
            patch = { kind: "approve", ...(body.set_mode_auto ? { set_mode_auto: true } : {}) };
        else
            patch = { kind: "reject", ...(body.reason?.trim() ? { reason: body.reason } : {}), ...(body.comments ? { comments: body.comments } : {}) };
        // The files named in the comment text are the server's own records of this decision
        const planFilePath = d.request.planFilePath;
        const explPath = d.explanation?.path;
        const explanationFile = explPath && explPath !== "" ? (explPath.endsWith(PLAN_BLOCK_SUFFIX) ? explPath.slice(0, -PLAN_BLOCK_SUFFIX.length) : explPath) : undefined;
        const ctx = commentCtx(d.session.session_id, {
            ...(d.kind === "approve_plan" && typeof planFilePath === "string" && planFilePath !== "" ? { planFile: planFilePath } : {}),
            ...(explanationFile && !(d.kind === "approve_plan") ? { explanationFile } : {}),
        });
        return c.json(store.submitAnswer(id, patch, ctx));
    });
    // ---- aside: side questions answered by a throwaway fork of the session ----
    app.get("/api/sessions/:id/aside", auth("any"), (c) => {
        const thread = aside.thread(c.req.param("id"));
        return thread ? c.json(thread) : c.json({ error: "session not found" }, 404);
    });
    // The session's cwd, transcript and agent come from the store, never from the body
    app.post("/api/sessions/:id/aside", auth("any"), jsonOnly, async (c) => {
        const id = c.req.param("id");
        const thread = aside.thread(id);
        if (!thread)
            return c.json({ error: "session not found" }, 404);
        const body = await parse(c, AsideRequest);
        if (!thread.available)
            return c.json({ error: "unavailable", reason: thread.unavailable_reason }, 400);
        return c.json({ entry: aside.start(id, body) }, 202);
    });
    app.delete("/api/sessions/:id/aside/running", auth("any"), (c) => {
        const entry = aside.cancel(c.req.param("id"));
        return entry ? c.json({ entry }) : c.json({ error: "nothing running" }, 404);
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
        if (!fingerprint || !toolUseId)
            return c.json({ error: "fingerprint and tool_use_id are required" }, 400);
        const open = store.openFor(c.req.param("id"), c.req.query("agent_id") || undefined, fingerprint, toolUseId);
        if (!open)
            return c.json({ error: "no open decision" }, 404);
        return c.json(open);
    });
    // The human's reply to a progress checkpoint, for the agent's next tool call. Reading it consumes it.
    // `main=1` (the main agent's hook): when there is no reply but an answer is on its way as a message, `waiting` tells the hook to hold the tool back
    app.get("/api/sessions/:id/instruction", auth("bearer"), (c) => {
        const id = c.req.param("id");
        const instruction = store.consumeInstruction(id);
        if (instruction)
            return c.json({ instruction });
        const waiting = c.req.query("main") === "1" ? store.waitingFor(id) : undefined;
        return waiting ? c.json({ waiting }) : c.json({ error: "no instruction" }, 404);
    });
    // The ukagai mod's inbox (message delivery): it polls, takes one answer at a time, then acks or releases it. Any of the three counts as the mod being alive
    const inboxReply = (c, r) => (r.http === 404 ? c.json({ error: "no such item" }, 404) : c.json({ status: r.status }, r.http));
    app.post("/api/sessions/:id/inbox/poll", auth("bearer"), jsonOnly, async (c) => {
        const body = await parse(c, PollRequest);
        const r = store.inboxPoll(c.req.param("id"), body.owner, body.idle);
        return r ? c.json(r) : c.body(null, 204);
    });
    app.post("/api/sessions/:id/inbox/ack", auth("bearer"), jsonOnly, async (c) => {
        const body = await parse(c, AckRequest);
        return inboxReply(c, store.inboxAck(c.req.param("id"), body.owner, body.item_id));
    });
    app.post("/api/sessions/:id/inbox/release", auth("bearer"), jsonOnly, async (c) => {
        const body = await parse(c, ReleaseRequest);
        return inboxReply(c, store.inboxRelease(c.req.param("id"), body.owner, body.item_id, body.drop));
    });
    // A plan the human approved: the same plan is let through once. For message delivery the re-called ExitPlanMode (PreToolUse for a plain
    // approval, PermissionRequest for "approve and auto"); for the waiting hook the PermissionRequest of "approve and auto". Both need the session and the plan's fingerprint to match
    app.get("/api/sessions/:id/plan-grant", auth("bearer"), (c) => {
        const fp = ConsumePlanGrantRequest.safeParse({ fingerprint: c.req.query("fingerprint") });
        if (!fp.success)
            return c.json({ error: "fingerprint is required" }, 400);
        const grant = store.planGrant(c.req.param("id"), fp.data.fingerprint);
        return grant ? c.json({ grant }) : c.json({ error: "no grant" }, 404);
    });
    app.post("/api/sessions/:id/plan-grant/consume", auth("bearer"), jsonOnly, async (c) => {
        const body = await parse(c, ConsumePlanGrantRequest);
        return c.json(store.consumePlanGrant(c.req.param("id"), body.fingerprint));
    });
    // The PreToolUse leaves an "approve and auto" grant to the PermissionRequest of the same call (once; a second hand writes it off)
    app.post("/api/sessions/:id/plan-grant/hand", auth("bearer"), jsonOnly, async (c) => {
        const body = await parse(c, ConsumePlanGrantRequest);
        return c.json(store.handPlanGrant(c.req.param("id"), body.fingerprint));
    });
    app.get("/api/sessions/:id/pending-rewrite", auth("bearer"), (c) => {
        return c.json(store.getRewrite(c.req.param("id")));
    });
    app.post("/api/sessions/:id/pending-rewrite/consume", auth("bearer"), jsonOnly, (c) => {
        return c.json({ consumed: store.consumeRewrite(c.req.param("id")) });
    });
    // ---- metrics / stream ----
    app.get("/api/metrics", auth("any"), (c) => c.json(store.metrics()));
    app.post("/api/gui/open", auth("bearer"), jsonOnly, (c) => c.json({ result: deps.guiOpener?.request() ?? "opened_today" }));
    // Diagnostics from a GUI tab (a dropped stream, a question that arrived late): one serve.log line each, nothing else happens
    app.post("/api/gui/log", auth("any"), jsonOnly, bodyLimit({ maxSize: GUI_LOG_BODY_LIMIT, onError: (c) => c.json({ error: "payload too large" }, 413) }), async (c) => {
        const { event, ...fields } = await parse(c, GuiLogRequest);
        deps.log?.(`gui_${event}`, fields);
        return c.body(null, 204);
    });
    app.post("/api/shutdown", auth("bearer"), jsonOnly, (c) => {
        if (!deps.shutdown)
            return c.json({ error: "shutdown is not available" }, 501);
        // reply first; the server stops on the next tick
        const stop = deps.shutdown;
        setImmediate(stop);
        return c.json({ ok: true });
    });
    app.get("/api/stream", auth("any"), (c) => hub.connect(c.req.raw.signal, cookieOnly(c)));
    return app;
}
//# sourceMappingURL=routes.js.map