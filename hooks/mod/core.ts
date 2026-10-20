/**
 * The ukagai mod's state machine. It never touches `$`: register.ts builds a Host from it, so the machine is tested with a fake Host.
 * The mod does not import src/: the constants and the wire shapes below are copies of src/contract.ts (the contract test catches drift).
 */

export const MOD_POLL_MS = 1000;
export const MOD_BACKOFF_MAX_MS = 5000;
export const DEFAULT_SERVER = "http://127.0.0.1:4818";
const DROP_MAX = 500;
const SERVER_RE = /^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}$/;

type Maybe<T> = T | Promise<T>;

export interface Host {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; text: string }>;
  /** Resolves when the prompt started a turn; `{ drop }` when it did not go through */
  submit(text: string): Promise<{ ok: true } | { drop: string }>;
  sessionId(): Maybe<string>;
  now(): number;
  /** undefined when the file is missing or unreadable */
  readFile(path: string): Maybe<string | undefined>;
  getEnv(name: "UKAGAI_DISABLE" | "UKAGAI_MOD" | "HOME"): Maybe<string | undefined>;
  setEnv(name: "UKAGAI_MOD_OWNER", value: string): Maybe<void>;
}

export interface Config {
  server: string;
  /** undefined when it cannot be decided: the mod then does nothing */
  dataDir: string | undefined;
}

export function enabled(a: { env: { UKAGAI_DISABLE?: string | undefined; UKAGAI_MOD?: string | undefined }; isInteractive: boolean; surface: string | null }): boolean {
  if (a.env.UKAGAI_DISABLE === "1") return false;
  if (["0", "false", "off"].includes((a.env.UKAGAI_MOD ?? "").trim().toLowerCase())) return false;
  return a.isInteractive && a.surface === "terminal";
}

const isAbsolute = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);

/** `json` is the text of hooks/mod/config.json (or undefined); anything unusable falls back to the default */
export function parseConfig(json: string | undefined, home: string | undefined): Config {
  let raw: unknown;
  try {
    raw = json === undefined ? undefined : JSON.parse(json);
  } catch {
    raw = undefined;
  }
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const server = typeof o["server"] === "string" && SERVER_RE.test(o["server"]) ? o["server"] : DEFAULT_SERVER;
  const dir = o["dataDir"];
  const dataDir = typeof dir === "string" && isAbsolute(dir) ? dir : home !== undefined && home !== "" ? `${home.replace(/[\\/]+$/, "")}/.ukagai` : undefined;
  return { server, dataDir };
}

const randomOwner = (): string => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

type Record_ =
  | { session_id: string; state: "delivering" }
  | { session_id: string; state: "ack" }
  | { session_id: string; state: "release"; drop?: string };

export interface ModSession {
  start(): Promise<void>;
  tick(): Promise<void>;
  turnStart(agentId?: string): void;
  turnComplete(agentId?: string): void;
  end(): void;
}

export function createSession(host: Host, config: Config, newOwner: () => string = randomOwner): ModSession {
  let owner = "";
  let token: string | undefined;
  let stopped = false;
  let ticking = false;
  let busy = false;
  let waitForTurnComplete = false;
  let failures = 0;
  let nextAt = 0;
  const records = new Map<string, Record_>();

  async function readToken(): Promise<string | undefined> {
    if (config.dataDir === undefined) return undefined;
    const text = await host.readFile(`${config.dataDir.replace(/[\\/]+$/, "")}/token`);
    const t = text?.trim();
    return t === undefined || t === "" ? undefined : t;
  }

  /** undefined: no token or a transport failure. A 401 forgets the token so the next request reads it again */
  async function post(session: string, action: "poll" | "ack" | "release", body: object): Promise<{ status: number; text: string } | undefined> {
    try {
      token ??= await readToken();
      if (token === undefined) return undefined;
      const res = await host.fetch(`${config.server}/api/sessions/${encodeURIComponent(session)}/inbox/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) token = undefined;
      return res;
    } catch {
      return undefined;
    }
  }

  async function deliver(id: string, text: string): Promise<void> {
    let next: Record_;
    const session = records.get(id)?.session_id ?? "";
    try {
      const r = await host.submit(text);
      if ("drop" in r) {
        next = { session_id: session, state: "release", drop: String(r.drop).slice(0, DROP_MAX) };
        waitForTurnComplete = true;
      } else next = { session_id: session, state: "ack" };
    } catch {
      next = { session_id: session, state: "release" };
    }
    if (records.has(id)) records.set(id, next);
  }

  /** Returns true when the request went wrong in a way that should slow the polling down */
  async function flush(): Promise<boolean> {
    let bad = false;
    for (const [id, rec] of [...records]) {
      if (rec.state === "delivering") continue;
      const body = rec.state === "ack" ? { owner, item_id: id } : { owner, item_id: id, ...(rec.drop !== undefined ? { drop: rec.drop } : {}) };
      const res = await post(rec.session_id, rec.state === "ack" ? "ack" : "release", body);
      if (res === undefined) bad = true;
      else if (res.status === 200 || res.status === 404 || res.status === 409) records.delete(id);
      else if (res.status !== 401) bad = true;
    }
    return bad;
  }

  async function poll(): Promise<boolean> {
    const session = await host.sessionId();
    const idle = !busy && records.size === 0 && !waitForTurnComplete;
    const res = await post(session, "poll", { owner, idle });
    if (res === undefined) return true;
    if (res.status === 401) return false;
    if (res.status === 204) return false;
    if (res.status !== 200) return true;
    let json: { held?: { item_id?: unknown }; item?: { item_id?: unknown; text?: unknown } };
    try {
      json = JSON.parse(res.text) as typeof json;
    } catch {
      return true;
    }
    const held = json.held?.item_id;
    if (typeof held === "string") {
      if (!records.has(held)) records.set(held, { session_id: session, state: "release" });
      return false;
    }
    const id = json.item?.item_id;
    const text = json.item?.text;
    if (typeof id === "string" && typeof text === "string") {
      records.set(id, { session_id: session, state: "delivering" });
      // not awaited: submit resolves when the turn starts, and the heartbeat must go on meanwhile
      void deliver(id, text);
    }
    return false;
  }

  return {
    async start() {
      owner = newOwner();
      try {
        await host.setEnv("UKAGAI_MOD_OWNER", owner);
        token = await readToken();
      } catch {
        // fail open
      }
    },
    async tick() {
      if (stopped || ticking || host.now() < nextAt) return;
      ticking = true;
      try {
        const badFlush = await flush();
        const badPoll = await poll();
        failures = badFlush || badPoll ? failures + 1 : 0;
        nextAt = failures === 0 ? 0 : host.now() + Math.min(MOD_POLL_MS * 2 ** failures, MOD_BACKOFF_MAX_MS);
      } catch {
        failures += 1;
        nextAt = host.now() + Math.min(MOD_POLL_MS * 2 ** failures, MOD_BACKOFF_MAX_MS);
      } finally {
        ticking = false;
      }
    },
    turnStart(agentId) {
      if (agentId === undefined) busy = true;
    },
    turnComplete(agentId) {
      if (agentId !== undefined) return;
      busy = false;
      waitForTurnComplete = false;
    },
    end() {
      stopped = true;
      if (token === undefined) return;
      // one last ack, not awaited; no release: the server closes what is left on SessionEnd
      for (const [id, rec] of records) {
        if (rec.state !== "ack") continue;
        void host
          .fetch(`${config.server}/api/sessions/${encodeURIComponent(rec.session_id)}/inbox/ack`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ owner, item_id: id }),
          })
          .catch(() => undefined);
      }
    },
  };
}
