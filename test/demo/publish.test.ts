// Checks of the publish helpers: the attachment reading, the README line and the size limits. No network, no gh.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ALT, LOGO, parseAttachments, rewriteReadme, sizeProblems } from "../../demo/lib/attachments.js";
import { MP4_MAX_BYTES, WEBP_MAX_BYTES } from "../../demo/lib/encode.js";

const COMMENT = readFileSync(join(import.meta.dirname, "fixtures", "attach-comment.md"), "utf8");
const WEBP = "https://github.com/user-attachments/assets/cd4c1a46-b76d-4021-9afc-2534aca8d25e";
const MP4 = "https://github.com/user-attachments/assets/d4c82cf0-30a3-4df1-99f7-abfbf87a6794";
const NEW = "https://github.com/user-attachments/assets/11111111-2222-4333-8444-555555555555";

const HEAD12 = [
  `${LOGO} width="140" alt="ukagai logo"></p>`,
  "",
  '<h1 align="center">ukagai</h1>',
];

describe("parseAttachments", () => {
  it("reads the WebP from the image reference and the MP4 from its own line", () => {
    assert.deepEqual(parseAttachments(COMMENT), { webp: WEBP, mp4: MP4 });
  });

  it("throws when there are not exactly two URLs", () => {
    assert.throws(() => parseAttachments("no attachments here"), /found 0/);
    assert.throws(() => parseAttachments(`${COMMENT}\n${NEW}`), /found 3/);
    assert.throws(() => parseAttachments(`![x](${WEBP})`), /found 1/);
  });

  it("throws when the WebP is not in an image reference", () => {
    const body = `${WEBP}\n\n${MP4}\n`;
    assert.throws(() => parseAttachments(body), /image reference/);
  });

  it("throws when the MP4 is not alone on its line", () => {
    const body = `![x](${WEBP})\n\nsee ${MP4}\n`;
    assert.throws(() => parseAttachments(body), /alone on its line/);
  });
});

describe("rewriteReadme", () => {
  it("inserts the image after the logo line and its blank line, once", () => {
    for (const lang of ["en", "ja"] as const) {
      const once = rewriteReadme(HEAD12.join("\n"), lang, WEBP);
      const lines = once.split("\n");
      assert.equal(lines[2], `![${ALT[lang]}](${WEBP})`);
      assert.equal(lines[3], "");
      assert.equal(lines[4], '<h1 align="center">ukagai</h1>');
      // Same bytes when run again with the same URL
      assert.equal(rewriteReadme(once, lang, WEBP), once);
    }
  });

  it("replaces only the URL when the line is there", () => {
    const once = rewriteReadme(HEAD12.join("\n"), "en", WEBP);
    const again = rewriteReadme(once, "en", NEW);
    assert.equal(again, once.replace(WEBP, NEW));
  });

  it("leaves every other byte as it is", () => {
    const text = `${HEAD12.join("\n")}\n`;
    const out = rewriteReadme(text, "en", WEBP);
    assert.equal(out.replace(`![${ALT.en}](${WEBP})\n\n`, ""), text);
  });

  it("throws when the logo line or the blank line after it is missing", () => {
    assert.throws(() => rewriteReadme("# x\n", "en", WEBP), /logo line is missing/);
    assert.throws(() => rewriteReadme(`${HEAD12[0]}\nno blank\n`, "en", WEBP), /blank line/);
  });
});

describe("constants", () => {
  it("the alt texts have no # (the --attach separator)", () => {
    assert.ok(!ALT.en.includes("#"));
    assert.ok(!ALT.ja.includes("#"));
  });

  it("judges the size limits at the boundary", () => {
    assert.deepEqual(sizeProblems({ webp: WEBP_MAX_BYTES, mp4: MP4_MAX_BYTES }), []);
    assert.equal(sizeProblems({ webp: WEBP_MAX_BYTES + 1, mp4: 1 }).length, 1);
    assert.equal(sizeProblems({ webp: 1, mp4: MP4_MAX_BYTES + 1 }).length, 1);
  });
});
