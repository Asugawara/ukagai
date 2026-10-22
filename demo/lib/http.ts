// Static file server for the stage (GET only, 127.0.0.1) and a free-port helper.
import { createServer as createNetServer } from "node:net";
import { createServer, type Server } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

// routes maps a URL prefix to a directory. Paths that resolve outside their directory get 404.
export async function serveStatic(routes: Record<string, string>): Promise<StaticServer> {
  const port = await freePort();
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const prefix = Object.keys(routes)
      .filter((p) => url.pathname.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix === undefined) {
      res.writeHead(404).end();
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      res.writeHead(404).end();
      return;
    }
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const root = resolve(routes[prefix]!);
    const file = resolve(root, rel);
    if (!(file === root || file.startsWith(root + sep)) || !isFile(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((res) => server.listen(port, "127.0.0.1", () => res()));
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}
