// Pure helpers of demo:publish: the alt texts, reading the two attachment URLs back from a comment, and the README line.
import type { Lang } from "../seeds.js";
import { MP4_MAX_BYTES, WEBP_MAX_BYTES } from "./encode.js";

/** The alt text of the demo image. Used for the attachment and for the README line, so it must not contain `#` (the `--attach` separator). */
export const ALT: Record<Lang, string> = {
  en: "Demo: two Claude Code sessions and a Codex session send their questions and a plan to one ukagai inbox; the agent's explanation shows a sequence diagram and a recommendation; the human answers with the keyboard and the answer reaches the agent as a message; two HTML mockups are compared side by side; a revised plan shows what changed, a diff and the code behind a file reference, and is approved; every agent keeps going",
  ja: "デモ: 2 つの Claude Code と 1 つの Codex のセッションが、質問とプランを ukagai の 1 つの受信箱に送る。エージェントの説明はシーケンス図と推奨つき。人がキーボードで答えると、答えはメッセージとしてエージェントに届く。HTML の 2 案を並べて比べ、直したプランの変更点・diff・ファイル参照の先のコードを見て承認する。どのエージェントも先へ進む",
};

/** The start of the logo line of both READMEs; the demo image goes after the blank line that follows it. */
export const LOGO = '<p align="center"><img src="docs/images/logo.png"';

export const README: Record<Lang, string> = { en: "README.md", ja: "README.ja.md" };

const ASSET = /https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{36}/g;

export interface Attachments {
  webp: string;
  mp4: string;
}

/**
 * The two attachment URLs of a PR comment body: the WebP is the one inside an image reference `![…](…)`,
 * the MP4 the one alone on its line (the shape of test/demo/fixtures/attach-comment.md). Anything else throws.
 */
export function parseAttachments(body: string): Attachments {
  const urls = [...new Set(body.match(ASSET) ?? [])];
  if (urls.length !== 2) throw new Error(`expected 2 attachment URLs in the comment, found ${urls.length}`);
  const image = [...body.matchAll(/!\[[^\]]*\]\((https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{36})\)/g)].map((m) => m[1]);
  const webp = image.find((u) => urls.includes(u!));
  if (!webp) throw new Error("the WebP URL is not in an image reference ![…](…)");
  const mp4 = urls.find((u) => u !== webp);
  const alone = body.split("\n").some((line) => line.trim() === mp4);
  if (!alone) throw new Error("the MP4 URL is not alone on its line");
  return { webp, mp4: mp4! };
}

/**
 * The README with the demo image line at its place under the logo. If the line is there, only its URL changes;
 * everything else stays byte for byte. Running it twice with the same URL changes nothing.
 */
export function rewriteReadme(text: string, lang: Lang, url: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(LOGO));
  if (at < 0) throw new Error(`${README[lang]}: the logo line is missing`);
  const line = `![${ALT[lang]}](${url})`;
  const blank = at + 1;
  if (lines[blank] !== "") throw new Error(`${README[lang]}: expected a blank line after the logo`);
  const next = blank + 1;
  if (lines[next]?.startsWith(`![${ALT[lang]}](`)) {
    lines[next] = line;
    return lines.join("\n");
  }
  lines.splice(next, 0, line, "");
  return lines.join("\n");
}

/** The size limits of the attachments: GitHub's upload and what the README can show comfortably. */
export function sizeProblems(bytes: { webp: number; mp4: number }): string[] {
  const out: string[] = [];
  if (bytes.webp > WEBP_MAX_BYTES) out.push(`WebP is ${bytes.webp} bytes, over ${WEBP_MAX_BYTES}`);
  if (bytes.mp4 > MP4_MAX_BYTES) out.push(`MP4 is ${bytes.mp4} bytes, over ${MP4_MAX_BYTES}`);
  return out;
}
