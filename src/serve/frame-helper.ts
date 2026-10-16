/**
 * The script ukagai injects into every served HTML page (docs/spec/markdown.md 2.13). The page's own scripts do not run (the CSP allows only this one's nonce);
 * it also keeps links from leaving /api/files (the server has already removed http-equiv, so there is no meta refresh);
 * the frame is sandboxed without allow-same-origin, so the parent cannot measure it or see its wheel / key events: the helper reports and forwards them with postMessage.
 * The size / key / zoom messaging is frame-only; the link guard also runs when the page is opened on its own (new tab). Plain ES5-ish JS, no dependencies.
 */
export const FRAME_HELPER = String.raw`(function () {
  var de = document.documentElement, zoom = 1, queued = false, framed = window.parent !== window;
  var KEYS = { Escape: 1, "+": 1, "=": 1, "-": 1, "0": 1, f: 1 };
  var clamp = function (z) { return Math.min(4, Math.max(0.1, z)); };
  // Navigation guard (frame and new tab alike): a link may only go to another /api/files URL of this server (same-page #fragments included)
  function linkOf(n) {
    for (; n && n.nodeType === 1; n = n.parentElement) {
      var tag = n.localName;
      if (tag === "a" || tag === "area") return n.getAttribute("href") || n.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    }
    return null;
  }
  function guard(e) {
    var raw = linkOf(e.target);
    if (raw === null) return;
    try {
      var u = new URL(raw, location.href);
      if (u.protocol === location.protocol && u.host === location.host && u.pathname === "/api/files") return;
    } catch (err) {}
    e.preventDefault();
  }
  window.addEventListener("click", guard, true);
  window.addEventListener("auxclick", guard, true);
  if (!framed) return;
  // the size of the page at zoom 1, independent of the frame's own height: the body (scroll height, bottom) and the lowest descendant (absolute / floated content), plus the widest horizontal overflow of an inner scroller (an overflow-x:auto wrapper around a wide mock-up)
  function measure() {
    var keep = de.style.zoom, b = document.body;
    de.style.zoom = "";
    var w = de.scrollWidth, h = 0, extra = 0, sy = window.scrollY || 0;
    if (b) {
      h = Math.max(b.scrollHeight, Math.ceil(b.getBoundingClientRect().bottom + sy + (parseFloat(getComputedStyle(b).marginBottom) || 0)));
      var all = b.querySelectorAll("*");
      for (var i = 0; i < all.length && i < 3000; i++) {
        var o = all[i];
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
  // sent values: only a change of 2px or more is sent; two values that keep alternating settle on the larger until the frame width changes
  var last = null, prev = null, floor = 0, floorW = 0;
  function report() {
    queued = false;
    var m = measure(), iw = window.innerWidth;
    if (iw !== floorW) { floorW = iw; floor = 0; prev = null; }
    var h = Math.max(m.h, floor);
    if (last && prev !== null && Math.abs(h - prev.h) < 2 && Math.abs(h - last.h) >= 2) { floor = Math.max(h, last.h); h = floor; }
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
    if (e.ctrlKey || e.metaKey || e.altKey || !KEYS[e.key] || (e.shiftKey && e.key !== "+")) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    parent.postMessage({ ukagai: "key", key: e.key }, "*");
  });
  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    if (e.data.ukagai === "zoom" && typeof e.data.value === "number" && isFinite(e.data.value)) setZoom(e.data.value);
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

/** `<script nonce>` with the helper, as the very first thing of the page: right after a leading doctype (BOM / whitespace allowed before it), else at byte 0 */
export function injectFrameHelper(html: string, nonce: string): string {
  const tag = `<script nonce="${nonce}">${FRAME_HELPER}</script>`;
  const at = /^﻿?\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0;
  return html.slice(0, at) + tag + html.slice(at);
}
