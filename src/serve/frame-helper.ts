/**
 * The script ukagai injects into every served HTML page (docs/spec/markdown.md 2.13). The page's own scripts do not run (the CSP allows only this one's nonce);
 * the frame is sandboxed without allow-same-origin, so the parent cannot measure it or see its wheel / key events: the helper reports and forwards them with postMessage.
 * It is a no-op when the page is opened on its own (new tab). Plain ES5-ish JS, no dependencies.
 */
export const FRAME_HELPER = String.raw`(function () {
  if (window.parent === window) return;
  var de = document.documentElement, zoom = 1, queued = false;
  var KEYS = { Escape: 1, "+": 1, "=": 1, "-": 1, "0": 1, f: 1 };
  var clamp = function (z) { return Math.min(4, Math.max(0.1, z)); };
  // the size of the page at zoom 1: the document, or the viewport plus the widest horizontal overflow of an inner scroller (an overflow-x:auto wrapper around a wide mock-up)
  function measure() {
    var keep = de.style.zoom;
    de.style.zoom = "";
    var w = de.scrollWidth, h = de.scrollHeight, extra = 0, all = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < all.length && i < 3000; i++) {
      var o = all[i];
      if (o.scrollWidth > o.clientWidth + 1) {
        var ox = getComputedStyle(o).overflowX;
        if (ox === "auto" || ox === "scroll") extra = Math.max(extra, o.scrollWidth - o.clientWidth);
      }
    }
    // scrollHeight is never below the frame's own height: a page shorter than the frame is measured by its body
    if (h <= de.clientHeight && document.body) {
      var b = document.body;
      h = Math.ceil(b.getBoundingClientRect().bottom + (window.scrollY || 0) + (parseFloat(getComputedStyle(b).marginBottom) || 0));
    }
    de.style.zoom = keep;
    return { w: Math.max(w, window.innerWidth + extra), h: h };
  }
  function report() {
    queued = false;
    var m = measure();
    parent.postMessage({ ukagai: "frame", w: m.w, h: m.h, zoom: zoom }, "*");
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
