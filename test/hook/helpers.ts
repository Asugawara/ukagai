import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export interface Recorded {
  method: string;
  path: string;
  body: any;
  auth: string | undefined;
  ctype: string | undefined;
}

export type Handler = (req: Recorded, res: ServerResponse) => boolean | void;

export interface Fake {
  url: string;
  port: number;
  calls: Recorded[];
  close: () => Promise<void>;
}

/** If the handler returns true the response is already sent; otherwise the default response is used */
export async function fakeServer(handler: Handler = () => false): Promise<Fake> {
  const calls: Recorded[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const rec: Recorded = { method: req.method ?? "", path: req.url ?? "", body, auth: req.headers.authorization, ctype: req.headers["content-type"] };
      calls.push(rec);
      if (handler(rec, res)) return;
      defaultResponse(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
}

function defaultResponse(rec: Recorded, res: ServerResponse): void {
  if (rec.method === "POST" && rec.path === "/api/decisions") {
    json(res, 201, { id: "dec-1", status: rec.body?.status ?? "pending", ...rec.body });
  } else if (rec.method === "GET" && rec.path.startsWith("/api/decisions?")) {
    json(res, 200, []);
  } else if (rec.path.endsWith("/ack")) {
    json(res, 200, { id: "dec-1", status: "answered" });
  } else if (rec.path.endsWith("/handoff")) {
    json(res, 200, { id: "dec-1" });
  } else if (rec.path.endsWith("/answer")) {
    json(res, 200, { id: "dec-1" });
  } else if (rec.path.startsWith("/api/events")) {
    res.writeHead(204).end();
  } else if (rec.path.endsWith("/pending-mode-switch")) {
    json(res, 200, { pending: false });
  } else if (rec.path.endsWith("/consume")) {
    json(res, 200, {});
  } else {
    res.writeHead(404).end();
  }
}

export function tmpDir(prefix = "ukagai-hook-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Create a data-dir that holds a token */
export function dataDirWithToken(): string {
  const d = tmpDir();
  writeFileSync(join(d, "token"), "test-token\n");
  return d;
}

export function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

export interface HookResult {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}

export interface RunningHook {
  signal: (sig: NodeJS.Signals) => void;
  result: Promise<HookResult>;
}

/** runHook that can send a signal to the child process */
export function spawnHook(args: string[], input: string, home: string = tmpDir("ukagai-hook-home-")): RunningHook {
  const t0 = Date.now();
  // A fresh HOME per child: a hook under test must never reach the real ~/.ukagai (hook.log, token) or ~/.claude.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (home === "") delete env["HOME"]; // "" = HOME unset
  const p = spawn(process.execPath, ["--import", "tsx", cli, "hook", ...args], { stdio: ["pipe", "pipe", "pipe"], env });
  let stdout = "";
  let stderr = "";
  p.stdout.on("data", (c) => (stdout += c));
  p.stderr.on("data", (c) => (stderr += c));
  const result = new Promise<HookResult>((resolve) => {
    p.on("close", (code) => resolve({ stdout, stderr, code, ms: Date.now() - t0 }));
  });
  p.stdin.end(input);
  return { signal: (sig) => p.kill(sig), result };
}

export function runHook(args: string[], input: string, home?: string): Promise<HookResult> {
  return spawnHook(args, input, home).result;
}
