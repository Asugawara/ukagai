// @ts-check
// Pure functions: timeline -> the state of the stage at a time t. No DOM, no Date, no Math.random.
// t is in timeline seconds (the script). Playback seconds = timeline seconds / speed.

/** @typedef {import("./types.js").Timeline} Timeline */
/** @typedef {import("./types.js").Manifest} Manifest */
/** @typedef {import("./types.js").Target} Target */
/** @typedef {import("./types.js").Rect} Rect */
/** @typedef {import("./types.js").Lang} Lang */

// Allowed playback length in seconds, both ends included: a 36 s script plays in 20..30 s at speed 1.2..1.8
export const DURATION_RANGE = [20, 30];

// Reading times, in playback seconds. They do not shrink with speed.
export const KEY_LEAD = 0.15;
export const KEY_TAIL = 0.55;
export const KEY_DOWN = 0.12;
export const CAPTION_FADE = 0.25;
export const RIPPLE = 0.3;
// Timeline seconds (a motion of the script)
export const PULSE = 0.6;

export const WORLD = { w: 1280, h: 720 };
// The camera frames a target inside the part of the screen above the caption band
export const VIEW_H = 656;
export const GUI_W = 680;
export const CHROME_H = 36;
export const TERM_H = 520;
const DIM = 0.35;

/** @param {number} x @param {number} a @param {number} b */
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ u) => a + (b - a) * u;

/** @param {string | undefined} name @param {number} u */
export function ease(name, u) {
  u = clamp(u);
  if (name === "linear") return u;
  if (name === "in") return 1 - Math.cos((u * Math.PI) / 2);
  if (name === "out") return Math.sin((u * Math.PI) / 2);
  return (1 - Math.cos(Math.PI * u)) / 2;
}

/** @param {Timeline} tl */
export const storyLength = (tl) => tl.scenes.reduce((a, s) => a + s.dur, 0);

/** Frames of the loop: N = round(script length / speed * fps) */
export const frameCount = (/** @type {Timeline} */ tl, fps = tl.fps) => Math.round((storyLength(tl) / tl.speed) * fps);

/** @param {{ x: number, y: number, w: number, h: number }} rect @param {number} pad @param {number} [cap] */
export function fitRect(rect, pad, cap = Infinity) {
  const z = Math.min(WORLD.w / (rect.w + 2 * pad), VIEW_H / (rect.h + 2 * pad), cap);
  // The rect sits in the middle of the area above the caption band
  return { z, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 + (WORLD.h / 2 - VIEW_H / 2) / z };
}

const ALL = { z: 1, cx: WORLD.w / 2, cy: WORLD.h / 2 };
const at0 = (/** @type {{ at?: number }} */ e) => e.at ?? 0;
const byAt = (/** @type {{ at: number }} */ a, /** @type {{ at: number }} */ b) => a.at - b.at;

/**
 * Flattens the scenes into absolute-time event lists and resolves the camera targets.
 * @param {Timeline} tl @param {Manifest} manifest
 */
export function compile(tl, manifest) {
  /** @type {any} */
  const c = { tl, manifest, scenes: [], layout: [], camera: [], gui: [], focus: [], keys: [], pulses: [], beams: [], cursor: [], captions: [], cuts: [], term: {}, story: 0 };
  for (const name of Object.keys(tl.windows)) c.term[name] = [];
  let start = 0;
  for (const s of tl.scenes) {
    c.scenes.push({ name: s.name, start, end: start + s.dur });
    if (s.layout) c.layout.push({ at: start + at0(s.layout), dur: s.layout.dur ?? 0.8, to: s.layout.to, ease: s.layout.ease ?? "inOut" });
    for (const e of s.camera ?? []) {
      const ev = { at: start + at0(e), to: e.to, dur: e.dur ?? 0.75, ease: e.ease ?? "inOut", cam: ALL };
      c.camera.push(ev);
      if (ev.dur === 0 && ev.at > 0) c.cuts.push(ev.at);
    }
    for (const e of s.gui ?? []) c.gui.push({ at: start + at0(e), shot: e.shot, scroll: e.scroll });
    for (const e of s.focus ?? []) c.focus.push({ at: start + at0(e), window: e.window });
    for (const e of s.keys ?? []) c.keys.push({ at: start + e.at, key: e.key });
    for (const e of s.pulse ?? []) c.pulses.push({ at: start + e.at, window: e.window });
    for (const e of s.beams ?? []) c.beams.push({ at: start + e.at, from: e.from, to: e.to, dur: e.dur ?? 0.5 });
    for (const e of s.cursor ?? []) c.cursor.push({ at: start + e.at, to: e.to, dur: e.dur ?? 0.5, click: e.click === true });
    for (const [win, lines] of Object.entries(s.term ?? {})) {
      for (const l of lines) (c.term[win] ??= []).push({ at: start + l.at, kind: l.kind, text: l.text });
    }
    if (s.caption !== undefined) {
      if (s.caption === null) c.captions.push({ at: start, key: null });
      else if (typeof s.caption === "string") c.captions.push({ at: start, key: s.caption });
      else c.captions.push({ at: start + s.caption.at, key: s.caption.key });
    }
    start += s.dur;
  }
  c.story = start;
  for (const k of ["layout", "camera", "gui", "focus", "keys", "pulses", "beams", "cursor", "captions"]) c[k].sort(byAt);
  for (const k of Object.keys(c.term)) c.term[k].sort(byAt);
  c.cuts.sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
  // Each camera event's final position is fixed at the time its move ends
  for (const e of c.camera) e.cam = camFor(c, e.to, e.at + e.dur);
  return c;
}

/** @param {any} c @param {string} layoutName @param {string} win */
function layoutBox(c, layoutName, win) {
  const b = c.tl.layouts[layoutName]?.[win];
  if (b) return { x: b.x, y: b.y, s: b.s, opacity: b.opacity ?? 1, dim: b.dim ?? 0, z: b.z ?? 0 };
  // A window the layout does not list waits outside the screen: terminals on the left, the browser on the right
  const def = c.tl.windows[win];
  const other = Object.values(c.tl.layouts).map((l) => /** @type {any} */ (l)[win]).find(Boolean) ?? { y: 150, s: 1 };
  const w = def.w * other.s;
  return { x: def.kind === "browser" ? WORLD.w + 40 : -w - 40, y: other.y, s: other.s, opacity: 0, dim: 0, z: 0 };
}

const lerpBox = (/** @type {any} */ a, /** @type {any} */ b, /** @type {number} */ u) => ({
  x: lerp(a.x, b.x, u),
  y: lerp(a.y, b.y, u),
  s: lerp(a.s, b.s, u),
  opacity: lerp(a.opacity, b.opacity, u),
  dim: lerp(a.dim, b.dim, u),
  z: u < 0.5 ? a.z : b.z,
});

/** Where a window is at time t (the layout moves interpolate) @param {any} c @param {string} win @param {number} t */
export function boxAt(c, win, t) {
  const evs = c.layout;
  let box = layoutBox(c, evs[0].to, win);
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const prev = i === 0 ? box : layoutBox(c, evs[i - 1].to, win);
    const next = layoutBox(c, e.to, win);
    if (t < e.at) return prev;
    if (e.dur <= 0 || t >= e.at + e.dur) {
      box = next;
      continue;
    }
    return lerpBox(prev, next, ease(e.ease, (t - e.at) / e.dur));
  }
  return box;
}

/** The window's size in its own pixels @param {any} c @param {string} win */
function sizeOf(c, win) {
  const d = c.tl.windows[win];
  return { w: d.w, h: d.h ?? (d.kind === "browser" ? CHROME_H + (d.w * c.manifest.viewport.h) / c.manifest.viewport.w : TERM_H) };
}

const guiName = (/** @type {any} */ c) => Object.keys(c.tl.windows).find((k) => c.tl.windows[k].kind === "browser") ?? "gui";

/** The shot the browser window shows at time t, and its scroll position @param {any} c @param {number} t */
export function guiAt(c, t) {
  let e = null;
  for (const g of c.gui) {
    if (g.at <= t) e = g;
    else break;
  }
  if (!e) return null;
  const series = e.shot.endsWith("@");
  const name = series ? e.shot.slice(0, -1) : e.shot;
  const shot = c.manifest.shots[name];
  if (!shot) return null;
  if (!series || !shot.scroll || !e.scroll) {
    return { name, file: shot.file, scrollY: shot.scrollTop, title: shot.title, favicon: shot.favicon, toast: shot.toast };
  }
  const sc = e.scroll;
  const v = lerp(sc.from, sc.to, ease(sc.ease, (t - e.at) / sc.dur));
  const i = Math.round(clamp(v) * (shot.scroll.ys.length - 1));
  return { name, file: shot.scroll.files[i], scrollY: shot.scroll.ys[i], title: shot.title, favicon: shot.favicon, toast: shot.toast };
}

/** @param {any} c @param {string} shot @param {string} name */
function anchorOf(c, shot, name) {
  const s = c.manifest.shots[shot];
  return s?.anchors?.[name] ?? s?.scroll?.anchors?.[name] ?? null;
}

/**
 * The target as a rect in the world, at time t. cap is the largest zoom that keeps a screenshot pixel >= an output pixel.
 * @param {any} c @param {Target} target @param {number} t
 * @returns {{ rect: Rect, cap?: number } | null}
 */
export function resolveRect(c, target, t) {
  if (target === "all") return null;
  if ("window" in target) {
    const b = boxAt(c, target.window, t);
    const { w, h } = sizeOf(c, target.window);
    return { rect: { x: b.x, y: b.y, w: w * b.s, h: h * b.s } };
  }
  if ("rect" in target) return { rect: target.rect };
  const dot = target.anchor.indexOf(".");
  const a = anchorOf(c, target.anchor.slice(0, dot), target.anchor.slice(dot + 1));
  if (!a) return null;
  const g = guiName(c);
  const b = boxAt(c, g, t);
  const k = GUI_W / c.manifest.viewport.w;
  const y = a.inScroll ? a.y - (guiAt(c, t)?.scrollY ?? 0) : a.y;
  return {
    rect: { x: b.x + a.x * k * b.s, y: b.y + (CHROME_H + y * k) * b.s, w: a.w * k * b.s, h: a.h * k * b.s },
    cap: (c.manifest.dsf * c.manifest.viewport.w) / (GUI_W * b.s),
  };
}

/** @param {any} c @param {Target} target @param {number} t */
function camFor(c, target, t) {
  const r = resolveRect(c, target, t);
  if (!r) return ALL;
  const pad = target === "all" ? 0 : (/** @type {any} */ (target).pad ?? 16);
  return fitRect(r.rect, pad, r.cap);
}

/** @param {any} c @param {number} t */
export function cameraAt(c, t) {
  let prev = ALL;
  let cur = null;
  for (const e of c.camera) {
    if (e.at > t) break;
    cur = { e, from: prev };
    prev = e.cam;
  }
  if (!cur) return ALL;
  const { e, from } = cur;
  if (e.dur <= 0 || t >= e.at + e.dur) return e.cam;
  const u = ease(e.ease, (t - e.at) / e.dur);
  return { z: Math.exp(lerp(Math.log(from.z), Math.log(e.cam.z), u)), cx: lerp(from.cx, e.cam.cx, u), cy: lerp(from.cy, e.cam.cy, u) };
}

/** @param {any} c @param {string} win @param {number} t -> a point on the edge facing the other window */
function edge(c, win, t) {
  const b = boxAt(c, win, t);
  const { w, h } = sizeOf(c, win);
  return c.tl.windows[win].kind === "browser" ? { x: b.x, y: b.y + h * b.s * 0.8 } : { x: b.x + w * b.s, y: b.y + (h * b.s) / 2 };
}

/** @param {any} c @param {Target} target @param {number} t */
function pointOf(c, target, t) {
  if (typeof target === "object" && "window" in target) return edge(c, target.window, t);
  const r = resolveRect(c, target, t);
  return r ? { x: r.rect.x + r.rect.w / 2, y: r.rect.y + r.rect.h / 2 } : { x: WORLD.w / 2, y: WORLD.h / 2 };
}

/** @param {any} text @param {Lang} lang */
const pick = (text, lang) => (typeof text === "string" ? text : text[lang]);

/** One frame of the world and the overlays @param {any} c @param {number} t @param {Lang} lang */
function frame(c, t, lang) {
  const tl = c.tl;
  const speed = tl.speed;
  const gui = guiAt(c, t);
  const camera = cameraAt(c, t);

  let focus = null;
  for (const f of c.focus) if (f.at <= t) focus = f.window;

  const wins = {};
  for (const [name, def] of Object.entries(/** @type {Record<string, import("./types.js").WindowDef>} */ (tl.windows))) {
    const box = boxAt(c, name, t);
    const size = sizeOf(c, name);
    const w = {
      name,
      kind: def.kind,
      agent: def.agent,
      x: box.x,
      y: box.y,
      s: box.s,
      w: size.w,
      h: size.h,
      opacity: box.opacity,
      dim: clamp(box.dim + (focus !== null && focus !== name ? DIM : 0)),
      focused: focus === name,
      z: box.z + (def.kind === "browser" ? 2 : 1),
      title: pick(def.title, lang),
      color: def.repo ? c.manifest.repos[def.repo] : null,
      url: def.url ?? "",
      status: def.status ? pick(def.status, lang) : "",
      lines: /** @type {any[]} */ ([]),
      shot: /** @type {any} */ (null),
    };
    if (def.kind === "terminal") {
      for (const l of c.term[name]) {
        if (l.at > t) break;
        if (l.kind === "status") w.status = pick(l.text, lang);
        else w.lines.push({ kind: l.kind, text: pick(l.text, lang) });
      }
    } else {
      w.shot = gui;
    }
    /** @type {any} */ (wins)[name] = w;
  }

  const pulses = c.pulses.filter((/** @type {any} */ p) => p.at <= t && t < p.at + PULSE).map((/** @type {any} */ p) => ({ window: p.window, p: (t - p.at) / PULSE }));

  const beams = [];
  for (const b of c.beams) {
    if (t < b.at || t >= b.at + b.dur) continue;
    const a = edge(c, b.from, t);
    const z = pointOf(c, b.to, t);
    const dist = Math.hypot(z.x - a.x, z.y - a.y);
    const ctrl = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 - 0.22 * dist };
    const at = (/** @type {number} */ u) => ({ x: (1 - u) ** 2 * a.x + 2 * (1 - u) * u * ctrl.x + u * u * z.x, y: (1 - u) ** 2 * a.y + 2 * (1 - u) * u * ctrl.y + u * u * z.y });
    const u = ease("inOut", (t - b.at) / b.dur);
    const pts = [];
    for (let k = 0; k < 5; k++) {
      const uu = u - k * 0.05;
      if (uu >= 0) pts.push({ ...at(uu), a: 1 - k * 0.22 });
    }
    beams.push(pts);
  }

  // The pointer moves to its target, may click, and goes away on a null target
  let pointer = null;
  let ci = -1;
  for (let i = 0; i < c.cursor.length; i++) if (c.cursor[i].at <= t) ci = i;
  if (ci >= 0 && c.cursor[ci].to !== null) {
    const e = c.cursor[ci];
    const prev = ci > 0 && c.cursor[ci - 1].to !== null ? c.cursor[ci - 1] : null;
    const goal = pointOf(c, e.to, Math.max(t, e.at + e.dur));
    const from = prev ? pointOf(c, prev.to, e.at) : { x: goal.x + 90, y: goal.y + 60 };
    const u = e.dur > 0 ? ease("inOut", (t - e.at) / e.dur) : 1;
    pointer = { x: lerp(from.x, goal.x, u), y: lerp(from.y, goal.y, u) };
  }
  let ripple = null;
  for (const e of c.cursor) {
    if (!e.click || e.to === null) continue;
    const p = (t - e.at) / (RIPPLE * speed);
    if (p >= 0 && p < 1) ripple = { ...pointOf(c, e.to, e.at + e.dur), p };
  }

  // Keycaps: out 0.15 s before the press, gone 0.55 s after (playback seconds), earlier at a cut
  const keys = [];
  for (const k of c.keys) {
    const cut = c.cuts.find((/** @type {number} */ x) => x > k.at);
    const end = Math.min(k.at + KEY_TAIL * speed, cut ?? Infinity);
    if (t >= k.at - KEY_LEAD * speed && t < end) keys.push({ key: k.key, down: t >= k.at && t < k.at + KEY_DOWN * speed });
  }

  // Captions: the new one fades in while the old one fades out; the first one is there from frame 0
  const caps = [];
  let ei = -1;
  for (let i = 0; i < c.captions.length; i++) if (c.captions[i].at <= t) ei = i;
  if (ei >= 0) {
    const e = c.captions[ei];
    const prog = ei === 0 ? 1 : clamp((t - e.at) / (CAPTION_FADE * speed));
    const entry = (/** @type {string} */ key, /** @type {number} */ opacity, /** @type {number} */ dy) => ({ key, n: tl.captions[key].n, text: tl.captions[key][lang], opacity, dy });
    if (e.key !== null) caps.push(entry(e.key, prog, (1 - prog) * 10));
    const prev = ei > 0 ? c.captions[ei - 1] : null;
    if (prev && prev.key !== null && prog < 1) caps.push(entry(prev.key, 1 - prog, -prog * 10));
  }

  return { t, camera, wins, pulses, beams, pointer, ripple, keys, caps, ghost: /** @type {any} */ (null) };
}

/**
 * The state of the stage at time t (timeline seconds). In the last loopDissolve seconds a second world, the state of frame 0,
 * fades in over the first, and the captions cross over with the same progress.
 * @param {any} c @param {number} t @param {Lang} lang @param {Manifest} [manifest]
 */
export function stateAt(c, t, lang, manifest) {
  if (manifest && manifest !== c.manifest) throw new Error("stateAt: the timeline was compiled with another manifest");
  const s = frame(c, t, lang);
  const from = c.story - c.tl.loopDissolve;
  if (t > from) {
    const p = clamp((t - from) / c.tl.loopDissolve);
    const g = frame(c, 0, lang);
    s.caps = [...s.caps.map((/** @type {any} */ x) => ({ ...x, opacity: x.opacity * (1 - p) })), ...g.caps.map((/** @type {any} */ x) => ({ ...x, opacity: x.opacity * p }))];
    s.ghost = { p, state: g };
  }
  return s;
}

/**
 * Problems of the timeline against the manifest (empty when fine).
 * @param {Timeline} tl @param {Manifest} manifest
 */
export function validate(tl, manifest) {
  /** @type {string[]} */
  const out = [];
  const bad = (/** @type {string} */ m) => out.push(m);
  if (!(typeof tl.speed === "number" && tl.speed > 0)) bad(`speed must be a positive number, got ${tl.speed}`);
  const total = storyLength(tl);
  const play = total / tl.speed;
  if (tl.speed > 0 && (play < DURATION_RANGE[0] || play > DURATION_RANGE[1])) bad(`playback length ${play.toFixed(2)} s is outside ${DURATION_RANGE[0]}..${DURATION_RANGE[1]} s`);
  const wins = tl.windows;
  const shots = manifest.shots;
  const textOk = (/** @type {any} */ t, /** @type {string} */ where) => {
    if (typeof t === "string") return;
    if (!t || typeof t.en !== "string" || typeof t.ja !== "string" || !t.en || !t.ja) bad(`${where}: en or ja is missing`);
  };
  const layoutOk = (/** @type {string} */ n) => {
    if (!tl.layouts[n]) bad(`undefined layout ${n}`);
  };
  const winOk = (/** @type {string} */ n, /** @type {string} */ where) => {
    if (!wins[n]) bad(`${where}: undefined window ${n}`);
  };
  /** @type {(t: Target, where: string) => void} */
  const targetOk = (t, where) => {
    if (t === "all" || "rect" in t) return;
    if ("window" in t) return winOk(t.window, where);
    const dot = t.anchor.indexOf(".");
    const shot = t.anchor.slice(0, dot);
    const a = shots[shot] ? (shots[shot].anchors?.[t.anchor.slice(dot + 1)] ?? shots[shot].scroll?.anchors?.[t.anchor.slice(dot + 1)]) : null;
    if (!a) bad(`${where}: anchor ${t.anchor} is not in the manifest`);
  };
  for (const [name, w] of Object.entries(wins)) {
    textOk(w.title, `window ${name} title`);
    if (w.status !== undefined) textOk(w.status, `window ${name} status`);
  }
  for (const [name, cap] of Object.entries(tl.captions)) {
    if (!cap.en || !cap.ja) bad(`caption ${name}: en or ja is missing`);
  }
  if (!tl.scenes[0]?.caption) bad("the first scene has no caption");
  /** @type {Record<string, number>} */
  const lastAt = {};
  for (const s of tl.scenes) {
    const where = `scene ${s.name}`;
    if (s.dur < 0) bad(`${where}: negative dur`);
    const inScene = (/** @type {number} */ at, /** @type {string} */ what) => {
      if (at > s.dur) bad(`${where}: ${what} at ${at} is after the scene's dur ${s.dur}`);
    };
    if (s.layout) {
      layoutOk(s.layout.to);
      if ((s.layout.dur ?? 0) < 0) bad(`${where}: negative layout dur`);
      inScene(s.layout.at ?? 0, "layout");
    }
    const layoutNow = s.layout?.to;
    for (const e of s.camera ?? []) {
      if ((e.dur ?? 0) < 0) bad(`${where}: negative camera dur`);
      inScene(e.at ?? 0, "camera");
      targetOk(e.to, `${where} camera`);
      if (typeof e.to === "object" && "window" in e.to && layoutNow && !tl.layouts[layoutNow]?.[e.to.window]) bad(`${where}: camera window ${e.to.window} is not in layout ${layoutNow}`);
    }
    for (const g of s.gui ?? []) {
      inScene(g.at ?? 0, "gui");
      const name = g.shot.endsWith("@") ? g.shot.slice(0, -1) : g.shot;
      if (!shots[name]) bad(`${where}: shot ${g.shot} is not in the manifest`);
      else if (g.shot.endsWith("@") && !shots[name].scroll) bad(`${where}: shot ${name} has no scroll series`);
    }
    for (const f of s.focus ?? []) if (f.window !== null) winOk(f.window, `${where} focus`);
    for (const k of s.keys ?? []) inScene(k.at, "key");
    for (const p of s.pulse ?? []) {
      winOk(p.window, `${where} pulse`);
      inScene(p.at, "pulse");
    }
    for (const b of s.beams ?? []) {
      winOk(b.from, `${where} beam`);
      targetOk(b.to, `${where} beam`);
      inScene(b.at, "beam");
    }
    for (const e of s.cursor ?? []) {
      if (e.to !== null) targetOk(e.to, `${where} cursor`);
      inScene(e.at, "cursor");
    }
    if (s.caption && typeof s.caption === "string" && !tl.captions[s.caption]) bad(`${where}: undefined caption ${s.caption}`);
    if (s.caption && typeof s.caption === "object") {
      if (s.caption.key !== null && !tl.captions[s.caption.key]) bad(`${where}: undefined caption ${s.caption.key}`);
      inScene(s.caption.at, "caption");
    }
    for (const [win, lines] of Object.entries(s.term ?? {})) {
      if (!wins[win]) {
        bad(`${where}: undefined window ${win}`);
        continue;
      }
      let prev = -1;
      for (const l of lines) {
        textOk(l.text, `${where} ${win} line`);
        inScene(l.at, `${win} line`);
        if (l.kind === "status" && wins[win].kind !== "terminal") bad(`${where}: status line in the non-terminal window ${win}`);
        if (l.at < prev) bad(`${where}: ${win} lines are not in time order`);
        prev = l.at;
      }
      void lastAt;
    }
  }
  return out;
}
