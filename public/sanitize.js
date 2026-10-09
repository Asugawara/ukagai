// Sanitizer for marked output, shared by app.js and settings.js (the skill preview).
// Everything is decided on the parsed DOM (allowTags): an allowlist of tags, attributes and link schemes, so entity / whitespace tricks cannot slip through
export const sanitize = (html) => allowTags(html);

// A link target the dialect keeps: http(s), mailto, an in-page `#`, a root-relative `/` path or a relative path. The decoded value is checked with
// control characters and spaces removed (browsers ignore them inside a scheme: `jav&#x09;ascript:`)
function safeHref(value) {
  const v = value.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
  if (v.startsWith("//")) return false;
  return /^(?:https?:|mailto:|#|\/)/.test(v) || !/^[a-z][a-z0-9+.-]*:/.test(v);
}

// The dialect's tag allowlist (docs/spec/markdown.md 2.3): what marked emits plus <details> / <summary> / <br> / <sub> / <sup>. Every other tag is dropped
// (its text stays; script-like elements go with their content). Attributes are an allowlist too; class only with the values the renderer itself writes
const ALLOWED_TAGS = new Set("a blockquote br code del details em h1 h2 h3 h4 h5 h6 hr img input li ol p pre strong sub summary sup table tbody td th thead tr ul".split(" "));
const DROP_WITH_CONTENT = new Set("script style iframe frame frameset object embed applet form noscript template textarea select button svg math title head link meta base noembed noframes xmp plaintext audio video canvas".split(" "));
const ALLOWED_ATTRS = new Set("href src alt title tabindex open checked disabled type align start data-fn data-def data-title".split(" "));
const ALLOWED_CLASS = /^(language-[\w+-]+|fn)$/;
function allowTags(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const walk = (parent) => {
    for (const n of [...parent.childNodes]) {
      if (n.nodeType === Node.COMMENT_NODE) { n.remove(); continue; }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = n.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) { n.remove(); continue; }
      walk(n);
      if (!ALLOWED_TAGS.has(tag) || (tag === "input" && n.getAttribute("type") !== "checkbox")) { n.replaceWith(...n.childNodes); continue; }
      for (const a of [...n.attributes]) {
        if (a.name === "class") {
          const keep = a.value.split(/\s+/).filter((c) => ALLOWED_CLASS.test(c));
          if (keep.length) n.setAttribute("class", keep.join(" ")); else n.removeAttribute("class");
        } else if (!ALLOWED_ATTRS.has(a.name) || (a.name.startsWith("data-") && !(tag === "sup" || (tag === "pre" && a.name === "data-title")))) n.removeAttribute(a.name);
      }
      if (tag === "a" && n.hasAttribute("href") && !safeHref(n.getAttribute("href"))) n.removeAttribute("href");
      if (tag === "input") n.setAttribute("disabled", "");
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}
