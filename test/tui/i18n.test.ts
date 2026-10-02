import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGES, t } from "../../src/tui/i18n.js";
import { readConfig } from "../../src/settings/config.js";

test("en and ja define the same keys", () => {
  assert.deepEqual(Object.keys(MESSAGES.ja).sort(), Object.keys(MESSAGES.en).sort());
});

test("placeholders match between en and ja", () => {
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
    assert.deepEqual(vars(MESSAGES.ja[k]), vars(MESSAGES.en[k]), k);
  }
});

test("t fills placeholders and leaves unknown ones alone", () => {
  assert.equal(t("en", "pending_n", { n: 3 }), "Pending 3");
  assert.equal(t("ja", "pending_n", { n: 3 }), "保留 3");
  assert.equal(t("en", "cannot_connect", { server: "http://x" }), "Cannot connect (http://x). Reconnecting…");
  assert.equal(t("en", "send_failed"), "Failed to send: {message}");
});

test("--lang wins over config.json; without --lang the config decides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ukagai-tui-lang-"));
  await writeFile(join(dir, "config.json"), JSON.stringify({ lang: "ja" }));
  assert.equal((await readConfig(dir)).lang, "ja");
  const { parseArgs, resolveLang } = await import("../../src/tui/index.js");
  assert.equal(await resolveLang({ dataDir: dir }), "ja");
  assert.equal(await resolveLang({ dataDir: dir, lang: "en" }), "en");
  assert.equal(await resolveLang({ dataDir: join(dir, "missing") }), "en");
  assert.equal(await resolveLang({ dataDir: join(dir, "missing"), lang: "ja" }), "ja");
  assert.equal(parseArgs(["--lang", "ja"]).lang, "ja");
  assert.equal(parseArgs(["--lang", "xx"]).lang, undefined);
  assert.equal(parseArgs([]).lang, undefined);
});
