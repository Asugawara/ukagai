// Draws the state of core.js into the DOM. The frame loop in demo/render.ts calls window.stage.render(t) and takes a screenshot.
import timeline from "/timeline.js";
import { compile, frameCount, stateAt, storyLength, validate } from "./core.js";

const lang = new URLSearchParams(location.search).get("lang") === "ja" ? "ja" : "en";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const GUI_BODY_H = (w, m) => (w * m.viewport.h) / m.viewport.w;

const PREFIX = {
  claude: { user: "> ", tool: "⏺ ", result: "  ⎿  ", error: "  ⎿  ", text: "⏺ ", message: "> " },
  codex: { user: "› ", tool: "• ", result: "  └ ", error: "", text: "• ", message: "› " },
};

function lineHtml(agent, l) {
  const pf = PREFIX[agent][l.kind];
  const color = l.kind === "tool" && agent === "claude" ? ' class="g"' : "";
  let body;
  if (l.kind === "tool") {
    const m = /^([A-Za-z_][\w]*)(\(.*\))?$/s.exec(l.text);
    body = m ? `<b>${esc(m[1])}</b>${esc(m[2] ?? "")}` : `<b>${esc(l.text)}</b>`;
  } else if (l.kind === "message") {
    body = esc(l.text).replace("[ukagai]", '<span class="a">[ukagai]</span>');
  } else {
    body = esc(l.text);
  }
  return `<div class="ln ${l.kind}"><span class="pf"${color}>${esc(pf)}</span><span class="tx">${body}</span></div>`;
}

class World {
  constructor(root, compiled) {
    this.root = root;
    this.c = compiled;
    this.wins = {};
    for (const [name, def] of Object.entries(compiled.tl.windows)) {
      const el = document.createElement("div");
      el.className = "win " + (def.kind === "browser" ? "gui" : "term");
      if (def.kind === "terminal") {
        el.innerHTML = `<div class="tbar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><b><em></em><span></span></b></div><div class="tt"><div class="inner"></div></div><div class="inp"><span>${def.agent === "codex" ? "› " : "> "}</span><u></u></div><div class="st"></div><div class="dimmer"></div>`;
      } else {
        el.innerHTML = `<div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span class="tab"><img><span></span></span><span class="url"></span></div><div class="view"><img></div><div class="dimmer"></div>`;
      }
      root.append(el);
      this.wins[name] = { el, key: "", img: "" };
    }
    this.fx = document.createElement("div");
    this.fx.className = "fx";
    root.append(this.fx);
  }

  // Returns the promises of images that changed
  apply(s, manifest) {
    const jobs = [];
    this.root.style.transform = `translate(${640 - s.camera.cx * s.camera.z}px, ${360 - s.camera.cy * s.camera.z}px) scale(${s.camera.z})`;
    const z = s.camera.z;
    for (const [name, w] of Object.entries(s.wins)) {
      const h = this.wins[name];
      const el = h.el;
      el.style.width = `${w.w}px`;
      el.style.height = `${w.h}px`;
      el.style.transform = `translate(${w.x}px, ${w.y}px) scale(${w.s})`;
      el.style.opacity = String(w.opacity);
      el.style.zIndex = String(w.z);
      el.classList.toggle("focused", w.focused);
      el.querySelector(".dimmer").style.opacity = String(w.dim);
      if (w.kind === "terminal") {
        const key = JSON.stringify([w.lines, w.status, w.title]);
        if (key !== h.key) {
          h.key = key;
          el.querySelector(".tbar b span").textContent = w.title;
          el.querySelector(".tbar b em").style.background = w.color ?? "transparent";
          const inner = el.querySelector(".inner");
          inner.innerHTML = w.lines.map((l) => lineHtml(w.agent, l)).join("");
          const over = Math.max(0, inner.offsetHeight - el.querySelector(".tt").clientHeight);
          inner.style.transform = `translateY(${-over}px)`;
          el.querySelector(".st").textContent = w.status;
        }
      } else if (w.shot) {
        el.querySelector(".tab span").textContent = w.shot.title;
        el.querySelector(".url").textContent = w.url;
        const fav = el.querySelector(".tab img");
        if (fav.getAttribute("src") !== w.shot.favicon) fav.setAttribute("src", w.shot.favicon);
        const view = el.querySelector(".view");
        view.style.height = `${GUI_BODY_H(w.w, manifest)}px`;
        const img = view.querySelector("img");
        const src = `/shots/${w.shot.file}`;
        if (h.img !== src) {
          h.img = src;
          img.src = src;
          jobs.push(img.decode().catch(() => {}));
        }
      }
    }
    // Effects are redrawn every frame; sizes that should look constant on the screen are divided by the zoom
    let fx = "";
    for (const p of s.pulses) {
      const w = s.wins[p.window];
      const grow = 1 + 0.12 * p.p;
      fx += `<div class="pulse" style="left:${w.x}px;top:${w.y}px;width:${w.w * w.s}px;height:${w.h * w.s}px;opacity:${1 - p.p};transform:scale(${grow});border-width:${4 / z}px"></div>`;
    }
    for (const b of s.beams) {
      for (let i = b.length - 1; i >= 0; i--) {
        const r = (i === 0 ? 8 : 6 - i * 0.8) / z;
        fx += `<div class="dot" style="left:${b[i].x - r}px;top:${b[i].y - r}px;width:${2 * r}px;height:${2 * r}px;opacity:${b[i].a}"></div>`;
      }
    }
    if (s.ripple) {
      const r = (10 + 34 * s.ripple.p) / z;
      fx += `<div class="ripple" style="left:${s.ripple.x - r}px;top:${s.ripple.y - r}px;width:${2 * r}px;height:${2 * r}px;opacity:${1 - s.ripple.p};border-width:${3 / z}px"></div>`;
    }
    if (s.pointer) {
      fx += `<svg class="ptr" width="26" height="30" viewBox="0 0 26 30" style="left:${s.pointer.x}px;top:${s.pointer.y}px;transform:scale(${1 / z})"><path d="M2 2 L2 23 L8 18 L12 27 L16 25 L12 17 L20 17 Z" fill="#fff" stroke="#111" stroke-width="2" stroke-linejoin="round"/></svg>`;
    }
    this.fx.innerHTML = fx;
    return jobs;
  }
}

const state = { compiled: null, manifest: null, worlds: null };
const caps = document.getElementById("caps");
const keysEl = document.getElementById("keys");

async function init() {
  const manifest = await (await fetch("/shots/manifest.json")).json();
  await document.fonts.ready;
  const problems = validate(timeline, manifest);
  const compiled = compile(timeline, manifest);
  state.manifest = manifest;
  state.compiled = compiled;
  state.worlds = [new World(document.getElementById("world"), compiled), new World(document.getElementById("world2"), compiled)];
  const total = storyLength(timeline);
  const frames = frameCount(timeline);
  const scenes = compiled.scenes.map((s) => ({ name: s.name, start: s.start, end: s.end, playStart: s.start / timeline.speed, playEnd: s.end / timeline.speed }));
  return { story: total, speed: timeline.speed, frames, fps: timeline.fps, width: timeline.width, height: timeline.height, scenes, problems };
}

async function render(t) {
  const s = stateAt(state.compiled, t, lang);
  const jobs = state.worlds[0].apply(s, state.manifest);
  const ghost = document.getElementById("world2");
  if (s.ghost) {
    jobs.push(...state.worlds[1].apply(s.ghost.state, state.manifest));
    ghost.style.visibility = "visible";
    ghost.style.opacity = String(s.ghost.p);
  } else {
    ghost.style.visibility = "hidden";
  }
  caps.innerHTML = s.caps
    .map((c) => `<div class="cap" style="opacity:${c.opacity};transform:translate(-50%, ${c.dy}px)"><i>${esc(c.n)}</i><span>${esc(c.text)}</span></div>`)
    .join("");
  keysEl.innerHTML = s.keys.map((k) => `<div class="key${k.down ? " down" : ""}">${esc(k.key)}</div>`).join("");
  await Promise.all(jobs);
  await raf2();
}

window.stage = { ready: init(), render };
