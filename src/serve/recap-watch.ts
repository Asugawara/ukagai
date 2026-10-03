import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAllowedTranscriptPath, isClaudeTranscriptPath } from "../contract.js";
import type { Store } from "./store.js";

const LIVE_WINDOW_MS = 6 * 3600 * 1000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS_PER_TICK = 8;
const MAX_RECAP_CHARS = 8000;

export type RecapWatcherOptions = {
  store: Store;
  home: string;
  pollMs?: number;
};

type Cursor = { path: string; offset: number };

/** The `away_summary` lines of a chunk of transcript text, in order */
function recapsOf(text: string): { recap: string; at: string }[] {
  const out: { recap: string; at: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"away_summary"')) continue;
    try {
      const j = JSON.parse(line) as { type?: unknown; subtype?: unknown; content?: unknown; timestamp?: unknown };
      if (j.type !== "system" || j.subtype !== "away_summary" || typeof j.content !== "string" || j.content.trim() === "") continue;
      const at = typeof j.timestamp === "string" && Number.isFinite(Date.parse(j.timestamp)) ? j.timestamp : new Date().toISOString();
      out.push({ recap: j.content.trim().slice(0, MAX_RECAP_CHARS), at });
    } catch {
      // A partial or foreign line
    }
  }
  return out;
}

/**
 * Claude Code writes a "session recap" into the transcript as a `system` / `away_summary` line when the human has been away.
 * No hook sees it, so each live session's transcript is tailed (from where it was first seen, never replaying old recaps)
 * and every new recap becomes a checkpoint decision. Only files under ~/.claude/projects are read.
 */
export function startRecapWatcher(opts: RecapWatcherOptions): { stop(): void; poll(sessionId?: string, discard?: boolean): void } {
  const { store, home, pollMs = 5000 } = opts;
  const cursors = new Map<string, Cursor>();
  let stopped = false;

  function scan(sessionId: string, path: string, discard: boolean): void {
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) return;
      size = st.size;
    } catch {
      return;
    }
    const cur = cursors.get(sessionId);
    if (!cur || cur.path !== path) {
      // First sight: start at the end
      cursors.set(sessionId, { path, offset: size });
      return;
    }
    if (size > MAX_FILE_BYTES) return;
    if (size < cur.offset) {
      // Truncated or replaced
      cur.offset = size;
      return;
    }
    if (size === cur.offset) return;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    try {
      for (let i = 0; i < MAX_CHUNKS_PER_TICK && cur.offset < size; i++) {
        const want = Math.min(CHUNK_BYTES, size - cur.offset);
        const buf = Buffer.allocUnsafe(want);
        const got = readSync(fd, buf, 0, want, cur.offset);
        if (got <= 0) break;
        const end = buf.subarray(0, got).lastIndexOf(0x0a);
        if (end < 0) {
          // Either a line still being written, or one longer than a chunk (skipped)
          if (got < CHUNK_BYTES) break;
          cur.offset += got;
          continue;
        }
        cur.offset += end + 1;
        if (discard) continue;
        for (const r of recapsOf(buf.subarray(0, end).toString("utf8"))) {
          const s = store.listSessions().find((x) => x.session_id === sessionId);
          if (s) store.createCheckpoint(s, r.recap, r.at);
        }
      }
    } catch {
      // Unreadable now; try again next tick
    } finally {
      closeSync(fd);
    }
  }

  function poll(only?: string, discard = false): void {
    if (stopped) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const s of store.listSessions()) {
      if (s.state === "ended" || !s.transcript_path) continue;
      if (now - Date.parse(s.last_event_at) > LIVE_WINDOW_MS) continue;
      if (!isAllowedTranscriptPath(s.transcript_path, home) || !isClaudeTranscriptPath(s.transcript_path, home)) continue;
      seen.add(s.session_id);
      if (only === undefined || only === s.session_id) scan(s.session_id, s.transcript_path, discard);
    }
    if (only === undefined) for (const id of cursors.keys()) if (!seen.has(id)) cursors.delete(id);
  }

  const timer = setInterval(() => poll(), pollMs);
  timer.unref();
  // The human just spoke in the terminal: a recap written before that is already stale
  store.onSessionEvent = (id, ev) => poll(id, ev === "UserPromptSubmit");
  poll();

  return {
    poll,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (store.onSessionEvent) store.onSessionEvent = undefined;
    },
  };
}
