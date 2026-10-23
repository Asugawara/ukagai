import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { explainDir } from "../hook/explain.js";

/** Marked copies of images (POST /api/marks): PNG files the agent can open, pruned by age and count */
export const MARK_MAX_BYTES = 4 * 1024 * 1024;
export const MARK_BODY_LIMIT = 6 * 1024 * 1024;
export const MARK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MARK_MAX_FILES = 100;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MARK_FILE = /^[0-9a-f]{16}\.png$/;

/** Decodes the base64 of a PNG; null when it is not a PNG (or not base64) */
export function decodePng(b64: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  return buf.length >= PNG_SIGNATURE.length && buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? buf : null;
}

/** `<session's explanation folder>/marks`, or `<dataDir>/marks` when the session is not known */
export function marksDir(dataDir: string, session?: { session_id: string; scratchpad_dir?: string | undefined }): string {
  return session ? join(explainDir(session.scratchpad_dir, dataDir, session.session_id), "marks") : join(dataDir, "marks");
}

/** Removes marks older than 7 days and all but the newest 100 of a folder. Never throws */
export function pruneMarks(dir: string, now = Date.now()): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => MARK_FILE.test(f))
      .flatMap((f) => {
        try {
          return [{ f, mtime: statSync(join(dir, f)).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
    files.forEach((x, i) => {
      if (i >= MARK_MAX_FILES || now - x.mtime > MARK_MAX_AGE_MS) rmSync(join(dir, x.f), { force: true });
    });
  } catch {}
}

/** Saves a PNG as `<dir>/<16 hex>.png` (0600), pruning the folder first. Returns the id */
export function saveMark(dir: string, png: Buffer): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomBytes(8).toString("hex");
  writeFileSync(join(dir, `${id}.png`), png, { mode: 0o600 });
  pruneMarks(dir);
  return id;
}

/** The path of mark `id` in the first of `dirs` that holds it */
export function markPathIn(dirs: readonly string[], id: string): string | undefined {
  if (!/^[0-9a-f]{16}$/.test(id)) return undefined;
  for (const dir of dirs) {
    const p = join(dir, `${id}.png`);
    if (existsSync(p)) return p;
  }
  return undefined;
}
