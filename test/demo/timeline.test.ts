// Checks of the demo storyboard (demo/timeline.js) against the product's own texts and the seeds. No browser, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SHOT_NAMES } from "../../demo/shots.js";
import { checkoutSource, compareExplanation, compareHtml, heroExplanation, planTemplate, STORY, HERO_OPTIONS, COMPARE_OPTIONS } from "../../demo/seeds.js";
import timeline from "../../demo/timeline.js";
import { compile, DURATION_RANGE, frameCount, stateAt, validate } from "../../demo/stage/core.js";
import { asyncDeny } from "../../src/hook/explain.js";
import { codexAnswerReason } from "../../src/hook/codex.js";
import { planInstructReason } from "../../src/hook/decision.js";
import { isAllowedExplanationPath } from "../../src/contract.js";
import { deliveryText } from "../../src/serve/delivery-text.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "manifest.json");
const manifest = JSON.parse(readFileSync(FIXTURE, "utf8"));
const LANGS = ["en", "ja"] as const;
type Lang = (typeof LANGS)[number];

const withSpeed = (speed: number) => ({ ...timeline, speed });
const pick = (text: unknown, lang: Lang): string => (typeof text === "string" ? text : (text as { en: string; ja: string })[lang]);
const recommendedLabel = (opts: { label: string }[]) => opts.find((o) => o.label.includes("(Recommended)") || o.label.includes("(推奨)"))!.label;
const bare = (label: string) => label.replace(/ ?\((Recommended|推奨)\)$/, "");
const frontField = (md: string, key: string) => new RegExp(`\\n${key}: (.*)`).exec(md)?.[1];

// stateAt takes script seconds. Frame i shows script time i * (script length / N), so the frames are even in playback time.
function frames(tl: typeof timeline) {
  const c = compile(tl, manifest);
  const n = frameCount(tl);
  const story = tl.scenes.reduce((a, s) => a + s.dur, 0);
  return { c, n, at: (i: number) => stateAt(c, (i * story) / n, "en", manifest) };
}

describe("storyboard", () => {
  it("validates against the manifest with no problems", () => {
    assert.deepEqual(validate(timeline, manifest), []);
  });

  it("has a playback length inside DURATION_RANGE", () => {
    const play = (timeline.scenes.reduce((a, s) => a + s.dur, 0)) / timeline.speed;
    assert.ok(play >= DURATION_RANGE[0] && play <= DURATION_RANGE[1], `playback ${play}`);
  });

  it("uses the frame count round(script length / speed * fps)", () => {
    assert.equal(frameCount(timeline), Math.round((36 / 1.5) * 24));
    assert.equal(frameCount(timeline), 576);
  });

  it("keeps the playback length valid for speed 1.2 and 1.8 and rejects 1.0", () => {
    assert.deepEqual(validate(withSpeed(1.2), manifest), []);
    assert.deepEqual(validate(withSpeed(1.8), manifest), []);
    assert.equal(validate(withSpeed(1.0), manifest).length, 1);
  });

  it("spreads frames over the whole script for every speed", () => {
    for (const speed of [1.2, 1.5, 1.8]) {
      const tl = withSpeed(speed);
      const n = frameCount(tl);
      const last = (n - 1) * (36 / n);
      assert.ok(Math.abs(36 - (last + 36 / n)) < 1e-9, `speed ${speed}`);
    }
  });

  it("shows the j keycap for about 0.7 s of playback at every speed", () => {
    for (const speed of [1.2, 1.5, 1.8]) {
      const { n, at } = frames(withSpeed(speed));
      let visible = 0;
      for (let i = 0; i < n; i++) {
        const s = at(i) as { keys?: { key?: string }[] };
        if ((s.keys ?? []).some((k) => k.key === "j")) visible++;
      }
      const seconds = visible / timeline.fps;
      assert.ok(Math.abs(seconds - 0.7) <= 1 / timeline.fps + 1e-9, `speed ${speed}: ${seconds}`);
    }
  });

  it("joins the loop: at the last frame caption 1 and caption 10 mix as in loopDissolve", () => {
    const { n, at } = frames(timeline);
    const caps = (at(n - 1) as { caps: { n: string; opacity: number }[] }).caps;
    const one = caps.find((c) => c.n === "1")!.opacity;
    const ten = caps.find((c) => c.n === "10")!.opacity;
    assert.ok(Math.abs(one - 0.896) < 0.01, `caption 1 ${one}`);
    assert.ok(Math.abs(ten - 0.104) < 0.01, `caption 10 ${ten}`);
  });

  it("has a non-empty en and ja for every text", () => {
    for (const [key, t] of Object.entries(timeline.captions)) {
      for (const lang of LANGS) assert.ok(pick(t, lang).length > 0, `caption ${key} ${lang}`);
    }
    for (const scene of timeline.scenes) {
      for (const lines of Object.values(scene.term ?? {})) {
        for (const line of lines ?? []) for (const lang of LANGS) assert.ok(pick(line.text, lang).length > 0, `${scene.name} ${lang}`);
      }
    }
  });

  it("uses the ukagai delivery texts for the answer and the plan decisions", () => {
    const { c } = frames(timeline);
    for (const lang of LANGS) {
      const cc = c.term.cc.filter((l: { kind: string }) => l.kind === "message");
      const cc2 = c.term.cc2.filter((l: { kind: string }) => l.kind === "message");
      const answer = deliveryText({
        id: "3f2a9c1e-0000-4000-8000-000000000000",
        kind: "answer_question",
        response: { via: "gui", answers: { [STORY[lang].cc.question]: recommendedLabel(HERO_OPTIONS[lang]) }, decided_at: "2026-10-22T09:00:00.000Z" },
      } as never);
      assert.equal(pick(cc[0].text, lang), answer, `answer ${lang}`);
      const instruct = deliveryText({
        id: "7d41c0aa-0000-4000-8000-000000000000",
        kind: "approve_plan",
        response: { via: "gui", instruct: true, text: STORY[lang].cc2.instruction, decided_at: "2026-10-22T09:00:00.000Z" },
      } as never);
      assert.equal(pick(cc2[0].text, lang), instruct, `instruct ${lang}`);
      const approve = deliveryText({
        id: "9b0d6e2f-0000-4000-8000-000000000000",
        kind: "approve_plan",
        response: { via: "gui", approve: true, set_mode_auto: true, decided_at: "2026-10-22T09:00:00.000Z" },
      } as never);
      assert.equal(pick(cc2[cc2.length - 1].text, lang), approve, `approve ${lang}`);
    }
  });

  it("uses the hook's own deny lines for the error lines", () => {
    const { c } = frames(timeline);
    const ccErr = c.term.cc.find((l: { kind: string }) => l.kind === "error");
    const cc2Err = c.term.cc2.find((l: { kind: string }) => l.kind === "error");
    assert.equal(pick(ccErr.text, "en"), "PreToolUse:AskUserQuestion hook error: " + asyncDeny("answer_question").line);
    assert.equal(pick(cc2Err.text, "en"), "PreToolUse:ExitPlanMode hook error: " + asyncDeny("approve_plan").line);
  });

  it("uses the Codex reason for the blocked line", () => {
    const { c } = frames(timeline);
    for (const lang of LANGS) {
      const line = c.term.codex.find((l: { kind: string }) => l.kind === "error");
      const q = STORY[lang].codex.question;
      // The answer is the option label as the human picked it, "(Recommended)" included
      const expected = "Blocked by hook: " + codexAnswerReason({ questions: [{ question: q }] }, { [q]: recommendedLabel(COMPARE_OPTIONS[lang]) });
      assert.equal(pick(line.text, lang), expected, `codex ${lang}`);
    }
  });

  it("keeps the plan instruct reason of the product", () => {
    assert.ok(planInstructReason(STORY.en.cc2.instruction).includes(STORY.en.cc2.instruction));
  });
});

describe("seeds", () => {
  it("hero and compare explanations match the story and the recommended labels", () => {
    for (const lang of LANGS) {
      const hero = heroExplanation(lang);
      assert.equal(frontField(hero, "question"), STORY[lang].cc.question);
      assert.equal(frontField(hero, "recommended"), bare(recommendedLabel(HERO_OPTIONS[lang])));
      const compare = compareExplanation(lang);
      assert.equal(frontField(compare, "question"), STORY[lang].codex.question);
      assert.equal(frontField(compare, "recommended"), bare(recommendedLabel(COMPARE_OPTIONS[lang])));
    }
  });

  it("the hero explanation path is accepted and the compare page makes no external request", () => {
    const home = "/tmp/demo-home";
    const heroPath = join(home, ".claude", "plans", "retry-exports.md#ukagai-explain");
    assert.ok(heroPath.endsWith("#ukagai-explain"));
    assert.ok(isAllowedExplanationPath(heroPath, undefined, home));
    const dataDir = join(home, ".ukagai");
    assert.ok(isAllowedExplanationPath(join(dataDir, "explain", "x", "explain.md"), undefined, home, dataDir));
    for (const lang of LANGS) {
      for (const which of ["a", "b"] as const) {
        const html = compareHtml(lang, which);
        assert.ok(!/(src|href)=["']?http/i.test(html), `${which} ${lang} has an external reference`);
        assert.ok(!/font-family[^;]*\bInter\b/.test(html), `${which} ${lang} uses Inter`);
      }
    }
  });

  it("the plan v1 and v2 differ by one line, a struck-through item", () => {
    for (const lang of LANGS) {
      const v1 = planTemplate(lang, 1).split("\n");
      const v2 = planTemplate(lang, 2).split("\n");
      assert.equal(v1.length, v2.length);
      const diff = v1.map((l, i) => i).filter((i) => v1[i] !== v2[i]);
      assert.equal(diff.length, 1, `${lang} differing lines: ${diff.length}`);
      assert.ok(v1[diff[0]!]!.startsWith("   - "), `${lang} line: ${v1[diff[0]!]}`);
      // Long enough to be folded: app.js PLAN_SHORT_H2 = 2 and PLAN_SHORT_LINES = 40
      for (const v of [v1, v2]) {
        assert.ok(v.filter((l) => l.startsWith("## ")).length > 2, `${lang} H2`);
        assert.ok(v.length > 40, `${lang} lines`);
      }
    }
  });

  it("the checkout source has 62 lines and line 57 is the one the plan cites", () => {
    const lines = checkoutSource().split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    assert.equal(lines.length, 62);
    assert.equal(lines[56], "  const unit = order.price_unit.trim();");
    for (const lang of LANGS) assert.ok(planTemplate(lang, 1).includes("src/orders/checkout.ts:57"));
  });

  it("the fixture manifest only names shots that shots.ts declares", () => {
    for (const name of Object.keys(manifest.shots)) assert.ok((SHOT_NAMES as readonly string[]).includes(name), name);
  });

  it("the state at a time does not depend on the call order", () => {
    const { c } = frames(timeline);
    const a = stateAt(c, 3.3, "en", manifest);
    stateAt(c, 9.1, "en", manifest);
    assert.deepEqual(stateAt(c, 3.3, "en", manifest), a);
  });
});
