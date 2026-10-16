/**
 * The script ukagai injects into every page of the embedded view (docs/spec/markdown.md 2.13). It is allowed by the hash of this exact text (FRAME_POLICY in files.ts);
 * the page's own scripts do not run. The security boundary is the iframe's `csp` attribute (CSP Embedded Enforcement): every document the frame navigates to must carry the same policy or is refused.
 * The link guard below is only a cheap extra that keeps an ordinary click inside /api/files; it is not complete (it cannot see into closed shadow roots, for one) and nothing relies on it.
 * The frame is sandboxed without allow-same-origin, so the parent cannot measure it or see its wheel / key events: the helper reports and forwards them with postMessage.
 * Zoom (Ctrl/⌘ + wheel, pinch, zoom keys) is only active once the parent says the frame is in the full-screen overlay ({ukagai:"mode", overlay:true}); inline the browser's own Ctrl/⌘ + wheel is left alone. Shift + wheel works in both.
 * Pages sized by the viewport (`100vh`, `height:100%`) follow the frame's own height, so they may grow to the parent's 70vh cap. Plain ES5-ish JS, no dependencies.
 */
export const FRAME_HELPER = String.raw`(function () {
  var de = document.documentElement, zoom = 1, queued = false, framed = window.parent !== window, overlay = false;
  var KEYS = { Escape: 1, "+": 1, "=": 1, "-": 1, "0": 1, f: 1 };
  var clamp = function (z) { return Math.min(4, Math.max(0.1, z)); };
  // Navigation guard (extra, not the boundary): a click whose path holds a link may only go to another /api/files URL of this server (same-page #fragments included).
  // Every node of the composed path is tested with instanceof (never localName / parentElement, which a page can clobber); an SVG <use> is a closed shadow tree, so a click through one is always stopped
  function allowed(raw) {
    if (!raw) return true;
    try {
      var u = new URL(raw, location.href);
      return u.protocol === location.protocol && u.host === location.host && u.pathname === "/api/files";
    } catch (err) { return false; }
  }
  function blocked(e) {
    var path = e.composedPath();
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (n instanceof SVGUseElement) return true;
      if (n instanceof SVGAElement) {
        if (!allowed(n.href.animVal) || !allowed(n.href.baseVal) || !allowed(n.getAttributeNS("http://www.w3.org/1999/xlink", "href"))) return true;
      } else if ((n instanceof HTMLAnchorElement || n instanceof HTMLAreaElement) && !allowed(n.href)) return true;
    }
    return false;
  }
  function guard(e) { if (blocked(e)) e.preventDefault(); }
  window.addEventListener("click", guard, true);
  window.addEventListener("auxclick", guard, true);
  if (!framed) return;
  // the size of the page at zoom 1, independent of the frame's own height: the body (scroll height, bottom) and the lowest descendant (absolute / floated content), plus the widest horizontal overflow of an inner scroller (an overflow-x:auto wrapper around a wide mock-up)
  function measure() {
    var keep = de.style.zoom, b = document.body;
    de.style.zoom = "";
    var w = de.scrollWidth, h = 0, extra = 0, sy = window.scrollY || 0;
    if (b) {
      var dcs = getComputedStyle(de);
      // the body's bottom plus its own margin and the document element's margin and padding below it
      h = Math.max(b.scrollHeight, Math.ceil(b.getBoundingClientRect().bottom + sy + (parseFloat(getComputedStyle(b).marginBottom) || 0) + (parseFloat(dcs.paddingBottom) || 0) + (parseFloat(dcs.marginBottom) || 0)));
      var all = b.querySelectorAll("*");
      for (var i = 0; i < all.length && i < 3000; i++) {
        var o = all[i];
        // not laid out (display:none, a closed <details>'s content) or pinned to the viewport (position:fixed): neither says how tall the page is
        if (o.getClientRects().length === 0 || getComputedStyle(o).position === "fixed") continue;
        h = Math.max(h, Math.ceil(o.getBoundingClientRect().bottom + sy));
        if (o.scrollWidth > o.clientWidth + 1) {
          var ox = getComputedStyle(o).overflowX;
          if (ox === "auto" || ox === "scroll") extra = Math.max(extra, o.scrollWidth - o.clientWidth);
        }
      }
    }
    de.style.zoom = keep;
    return { w: Math.max(w, window.innerWidth + extra), h: h };
  }
  // sent values: only a change of 2px or more is sent. Two heights that keep alternating because the page follows the frame's own height (the parent resizes the frame to what we sent) settle on the larger
  // until the frame width changes; a measurement taken while the frame's height has not changed since the previous one comes from the page itself (a toggle, an accordion) and clears that lock
  var last = null, prev = null, floor = 0, floorW = 0, lastIH = null;
  function report() {
    queued = false;
    var m = measure(), iw = window.innerWidth, ih = window.innerHeight, frameMoved = lastIH !== null && ih !== lastIH;
    lastIH = ih;
    if (iw !== floorW || !frameMoved) { floorW = iw; floor = 0; prev = null; }
    var h = Math.max(m.h, floor);
    if (frameMoved && last && prev !== null && Math.abs(h - prev.h) < 2 && Math.abs(h - last.h) >= 2) { floor = Math.max(h, last.h); h = floor; }
    if (last && Math.abs(h - last.h) < 2 && Math.abs(m.w - last.w) < 2 && zoom === last.zoom) return;
    if (last && Math.abs(h - last.h) >= 2) prev = last;
    last = { w: m.w, h: h, zoom: zoom };
    parent.postMessage({ ukagai: "frame", w: m.w, h: h, zoom: zoom }, "*");
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(report);
  }
  function setZoom(z) {
    zoom = clamp(z);
    de.style.zoom = zoom === 1 ? "" : String(zoom);
    schedule();
  }
  function fit() {
    var m = measure();
    setZoom(Math.min(window.innerWidth / m.w, window.innerHeight / m.h, 1));
  }
  function hScroller(n) {
    for (; n && n.nodeType === 1; n = n.parentElement) {
      var ox = getComputedStyle(n).overflowX;
      if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth) return n;
    }
    return document.scrollingElement || de;
  }
  window.addEventListener("wheel", function (e) {
    if (e.ctrlKey || e.metaKey) {
      if (!overlay) return;
      e.preventDefault();
      var dy = e.deltaMode === 0 ? e.deltaY : e.deltaY * 33;
      setZoom(zoom * (Math.abs(dy) >= 40 ? (dy < 0 ? 1.1 : 1 / 1.1) : Math.exp(-dy * 0.02)));
    } else if (e.shiftKey && e.deltaX === 0 && e.deltaY !== 0) {
      var s = hScroller(e.target), before = s.scrollLeft;
      s.scrollLeft += e.deltaY;
      if (s.scrollLeft !== before) e.preventDefault();
    }
  }, { passive: false });
  window.addEventListener("keydown", function (e) {
    if (!overlay || e.ctrlKey || e.metaKey || e.altKey || !KEYS[e.key] || (e.shiftKey && e.key !== "+")) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    parent.postMessage({ ukagai: "key", key: e.key }, "*");
  });
  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    if (e.data.ukagai === "mode") overlay = e.data.overlay === true;
    else if (e.data.ukagai === "zoom" && typeof e.data.value === "number" && isFinite(e.data.value)) setZoom(e.data.value);
    else if (e.data.ukagai === "fit") fit();
  });
  window.addEventListener("load", schedule);
  window.addEventListener("resize", schedule);
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(schedule);
    ro.observe(de);
    document.addEventListener("DOMContentLoaded", function () { if (document.body) ro.observe(document.body); });
  }
  schedule();
})();`;

/** `<script>` with the helper (allowed by its hash), as the very first thing of the page: right after a leading doctype (BOM / whitespace allowed before it), else at byte 0 */
export function injectFrameHelper(html: string): string {
  const tag = `<script>${FRAME_HELPER}</script>`;
  const at = /^﻿?\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0;
  return html.slice(0, at) + tag + html.slice(at);
}
