// A throwaway `ukagai serve` (temp HOME, free port, src/ run through tsx) and the seed decisions.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./http.js";
import {
  checkoutSource,
  COMPARE_HEADER,
  COMPARE_OPTIONS,
  HERO_HEADER,
  HERO_OPTIONS,
  OWNER,
  PROJECTS,
  SESSION_IDS,
  STORY,
  TOOL_USE_IDS,
  compareExplanation,
  compareHtml,
  frontMatter,
  heroExplanation,
  planTemplate,
  type Lang,
  type SessionKey,
} from "../seeds.js";

export interface Serve {
  port: number;
  base: string;
  home: string;
  dataDir: string;
  // POST /api/sessions/<id>/inbox/poll for the two Claude sessions (mod owner, not idle).
  pollClaude(): Promise<void>;
  seedHero(lang: Lang): Promise<void>;
  seedCompare(lang: Lang): Promise<void>;
  seedPlan(lang: Lang, version: 1 | 2): Promise<void>;
  stop(): Promise<void>;
}

// Writes the seed project files and transcripts under the temp HOME. Serve is not needed for this.
export function prepareHome(home: string, lang: Lang): void {
  for (const key of Object.keys(PROJECTS) as SessionKey[]) {
    const project = PROJECTS[key];
    mkdirSync(join(home, "dev", project), { recursive: true });
    const tdir = join(home, ".claude", "projects", `-dev-${project}`);
    mkdirSync(tdir, { recursive: true });
    const line = { type: "user", message: { role: "user", content: STORY[lang][key].prompt }, timestamp: "2026-10-22T09:00:00.000Z", sessionId: SESSION_IDS[key] };
    writeFileSync(join(tdir, `${SESSION_IDS[key]}.jsonl`), JSON.stringify(line) + "\n");
  }
  const src = join(home, "dev", PROJECTS.cc2, "src", "orders");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "checkout.ts"), checkoutSource());
}

function sessionRef(home: string, key: SessionKey): Record<string, unknown> {
  const project = PROJECTS[key];
  const extra = key === "codex" ? { agent: "codex" } : { permission_mode: "plan" };
  return {
    session_id: SESSION_IDS[key],
    cwd: join(home, "dev", project),
    transcript_path: join(home, ".claude", "projects", `-dev-${project}`, `${SESSION_IDS[key]}.jsonl`),
    ...extra,
  };
}

export async function startServe(opts: { repoRoot: string; tempRoot: string; home: string; dataDir: string; logFile: string; lang: Lang }): Promise<Serve> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logFd = openSync(opts.logFile, "w");
  const proc: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", opts.dataDir, "--no-codex-bridge", "--lease-grace-ms", "600000"],
    {
      cwd: opts.repoRoot,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, HOME: opts.home, GIT_CEILING_DIRECTORIES: opts.tempRoot, UKAGAI_TERMINAL: "none", UKAGAI_DISABLE: "1" },
    },
  );
  let exited = false;
  proc.once("exit", () => (exited = true));
  const stop = async () => {
    if (!exited) {
      proc.kill();
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          res();
        }, 3000);
        proc.once("exit", () => {
          clearTimeout(t);
          res();
        });
      });
    }
    closeSync(logFd);
  };

  const fail = async (msg: string): Promise<never> => {
    await stop();
    const tail = readFileSync(opts.logFile, "utf8").split("\n").slice(-8).join("\n");
    throw new Error(`${msg}\n${tail}`);
  };

  const end = Date.now() + 20_000;
  for (;;) {
    if (exited) await fail("ukagai serve exited during start");
    try {
      if ((await fetch(base + "/healthz")).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > end) await fail("ukagai serve did not start in 20 s");
    await new Promise((r) => setTimeout(r, 100));
  }
  const token = readFileSync(join(opts.dataDir, "token"), "utf8").trim();

  const api = async (path: string, body?: unknown, method?: string): Promise<any> => {
    const r = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };

  const s0 = await api("/api/settings");
  await api("/api/settings", { ...s0, lang: opts.lang, theme: "light" }, "PUT");

  const sess = (key: SessionKey) => sessionRef(opts.home, key);
  const pollOne = (key: SessionKey) => api(`/api/sessions/${SESSION_IDS[key]}/inbox/poll`, { owner: OWNER, idle: false });
  const mustBeMessage = (what: string, d: any) => {
    if (d?.delivery !== "message") throw new Error(`${what}: delivery is ${JSON.stringify(d?.delivery)}, expected "message"`);
    return d;
  };

  const planFile = join(opts.home, ".claude", "plans", "orders-currency.md");

  return {
    port,
    base,
    home: opts.home,
    dataDir: opts.dataDir,
    async pollClaude() {
      await pollOne("cc");
      await pollOne("cc2");
    },
    async seedHero(lang) {
      await pollOne("cc");
      const md = heroExplanation(lang);
      mustBeMessage("hero", await api("/api/decisions", {
        tool_use_id: TOOL_USE_IDS.hero,
        kind: "answer_question",
        mod_owner: OWNER,
        session: sess("cc"),
        request: { questions: [{ question: STORY[lang].cc.question, header: HERO_HEADER[lang], multiSelect: false, options: HERO_OPTIONS[lang] }] },
        explanation: {
          path: join(opts.home, ".claude", "plans", "retry-exports.md#ukagai-explain"),
          ...frontMatter(md),
          markdown: md,
          has: { mermaid: true, table: true, diff: false },
          match: "question",
          attached_via: "first_call",
        },
      }));
    },
    async seedCompare(lang) {
      const dir = join(opts.dataDir, "explain", SESSION_IDS.codex);
      mkdirSync(dir, { recursive: true });
      const md = compareExplanation(lang);
      writeFileSync(join(dir, "explain.md"), md);
      writeFileSync(join(dir, "a.html"), compareHtml(lang, "a"));
      writeFileSync(join(dir, "b.html"), compareHtml(lang, "b"));
      await api("/api/decisions", {
        tool_use_id: TOOL_USE_IDS.compare,
        kind: "answer_question",
        session: sess("codex"),
        request: { questions: [{ question: STORY[lang].codex.question, header: COMPARE_HEADER[lang], multiSelect: false, options: COMPARE_OPTIONS[lang] }] },
        explanation: {
          path: join(dir, "explain.md"),
          ...frontMatter(md),
          markdown: md,
          has: { mermaid: false, table: true, diff: false },
          match: "question",
          attached_via: "first_call",
        },
      });
    },
    async seedPlan(lang, version) {
      await pollOne("cc2");
      const d = mustBeMessage(`plan v${version}`, await api("/api/decisions", {
        tool_use_id: version === 1 ? TOOL_USE_IDS.planV1 : TOOL_USE_IDS.planV2,
        kind: "approve_plan",
        mod_owner: OWNER,
        session: sess("cc2"),
        request: { plan: planTemplate(lang, version), planFilePath: planFile },
      }));
      if (version === 1) {
        // Answered before the GUI opens, so the GUI never shows v1 as pending.
        await api(`/api/decisions/${d.id}/answer`, { instruct: true, text: STORY[lang].cc2.instruction });
      }
    },
    stop,
  };
}
