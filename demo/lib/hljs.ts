// highlight.js 11.9.0 from cdnjs, the same files the GUI loads. Pinned by sha256; the browser gets them through Fetch.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "./cdp.js";

const BASE = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/";

export interface CacheEntry {
  url: string;
  file: string;
  type: string;
  bytes: number;
  sha256: string;
}

export const HLJS: CacheEntry[] = [
  {
    url: `${BASE}highlight.min.js`,
    file: "highlight.min.js",
    type: "application/javascript",
    bytes: 121727,
    sha256: "837a6fa5b0c736b52bbde2b2b6190f305da3fc9ed41681db5321507057b5c846",
  },
  {
    url: `${BASE}styles/github.min.css`,
    file: "github.min.css",
    type: "text/css",
    bytes: 1309,
    sha256: "3a9a5def8b9c311e5ae43abde85c63133185eed4f0d9f67fea4b00a8308cf066",
  },
  {
    url: `${BASE}styles/github-dark.min.css`,
    file: "github-dark.min.css",
    type: "text/css",
    bytes: 1315,
    sha256: "9f208d022102b1d0c7aebfecd8e42ca7997d5de636649d2b31ea63093d809019",
  },
];

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

// Stops when public/index.html names a cdnjs URL this file does not pin.
export function checkPublicUrls(indexHtml: string): void {
  const found = indexHtml.match(/https:\/\/cdnjs\.cloudflare\.com\/[^"' )]+/g) ?? [];
  const unknown = [...new Set(found)].filter((u) => !HLJS.some((h) => h.url === u));
  if (unknown.length > 0) throw new Error(`public/index.html uses cdnjs URLs not pinned in demo/lib/hljs.ts: ${unknown.join(" ")}`);
}

// Fills cacheDir. A file that is present must match its hash; a missing one is fetched once.
export async function ensureCache(cacheDir: string): Promise<void> {
  mkdirSync(cacheDir, { recursive: true });
  for (const h of HLJS) {
    const path = join(cacheDir, h.file);
    if (existsSync(path)) {
      const got = sha256(readFileSync(path));
      if (got !== h.sha256) throw new Error(`highlight.js cache ${path} has sha256 ${got}, expected ${h.sha256}; delete it to refetch`);
      continue;
    }
    let body: Buffer;
    try {
      const r = await fetch(h.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      throw new Error(`cannot fetch ${h.url} (${(e as Error).message}); put the file at ${path} (sha256 ${h.sha256})`);
    }
    const got = sha256(body);
    if (got !== h.sha256) throw new Error(`${h.url} has sha256 ${got}, expected ${h.sha256}`);
    writeFileSync(path, body);
  }
}

// Serves the cached files for cdnjs requests and fails every other cdnjs request.
export async function interceptCdnjs(page: Page, cacheDir: string): Promise<void> {
  page.on("Fetch.requestPaused", async (p) => {
    const hit = HLJS.find((h) => h.url === p.request.url);
    if (hit) {
      await page.send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: hit.type },
          { name: "Access-Control-Allow-Origin", value: "*" },
        ],
        body: readFileSync(join(cacheDir, hit.file)).toString("base64"),
      });
    } else {
      await page.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" });
    }
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "https://cdnjs.cloudflare.com/*" }] });
}
