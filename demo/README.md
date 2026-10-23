# demo

Renders the demo video of ukagai: the real `public/` GUI captured from a throwaway server, and terminals played from a script, on an HTML stage that headless Chrome screenshots frame by frame.

## Prerequisites

- Node >= 22 and `npm install` (the demo runs `src/` through `tsx`).
- Google Chrome at the usual macOS path (`/Applications/Google Chrome.app`), or the path `findChrome` in `demo/lib/cdp.ts` finds.
- `img2webp` (`brew install webp`), `ffmpeg` (MP4 and preview) and `magick` (contact sheet). Without the last two the render warns and skips those outputs.
- Network on the first run: highlight.js is fetched once into `demo/out/cache/` and checked against pinned sha256 sums.

## Commands

```sh
npm run demo -- --shots-only --lang en   # one language
npm run demo -- --shots-only             # en and ja
```

```sh
npm run demo                                  # en and ja: demo.webp, demo.mp4, contact.png, render.json
npm run demo -- --lang en --no-mp4            # one language, no MP4
npm run demo -- --preview --reuse-shots       # 640x360, 12 fps: preview.mp4 and contact.png (scrub this while tuning)
npm run demo -- --reuse-shots --at 6.6,18     # stills at playback seconds: demo/out/<lang>/stills/<t>.png
npm run demo -- --scale 2 --lang en           # 2560x1440 demo-2x.mp4 only (not published)
```

`--reuse-shots` skips the GUI capture when `shots/manifest.json` exists; the render is then marked `reused_shots: true`. A full render takes about 4 minutes for both languages.

Output goes to `demo/out/<lang>/shots/` (git-ignored): one PNG per shot (2560x1600), the scroll series (`hero@<y>.png`, `plan-src@<y>.png`) and `manifest.json`.

## How it works

- A throwaway `ukagai serve` runs with a temp HOME and data dir on a free port. The real `~/.ukagai` and port 4818 are never touched.
- `demo/seeds.ts` holds the fixed ids and story text, `demo/seeds/` the explanations, pages, plan and source file.
- Plan v1 is sent and answered with an instruction before the GUI opens, so that plan v2 shows the version bar.
- Two runs give identical PNGs.

## Tuning the storyboard

Everything the viewer sees is in `demo/timeline.js`: windows, layouts, scenes, captions, terminal scripts and the `story` text the seeds read too. The loop of fixing is: edit `timeline.js`, run `npm run demo -- --preview --reuse-shots --lang en`, look at `contact.png` and `preview.mp4`, repeat.

- **Time units.** Times in `timeline.js` are script seconds (the script is 36 s). Playback seconds = script seconds / `speed`. `--at` and the contact sheet names use playback seconds. The frame count is `round(script length / speed * fps)` and frame `i` shows script time `i * length / N`, so the last frame is one step before frame 0 and the loop joins.
- **Speed.** Change `speed` in `timeline.js` and nothing else. `DURATION_RANGE` in `demo/stage/core.js` (20 to 30 playback seconds, both ends included) allows 1.2 to 1.8 for a 36 s script; `validate` fails the render outside it. Pauses and captions scale with `speed`, so look at the preview to see whether they still read. Key caps, caption fades and the click ripple are fixed in playback seconds and do not shrink.
- **Camera.** A scene's `camera` targets are `"all"`, `{ window }`, `{ anchor: "<shot>.<name>" }` (anchors come from `shots.ts` through the manifest) or `{ rect }`. They are fitted above the caption band; GUI targets stop at the zoom where one screenshot pixel is one output pixel. `dur: 0` is a cut.
- **Size budget.** WebP at most 9,500,000 bytes and MP4 at most 10,000,000 per language; the render warns when over. Trim in this order: 20 fps, make two in-GUI camera moves cuts, `-q 62`, 1152x648 (`demo/lib/encode.ts`).
- **Determinism.** Chrome runs with the render flags in `demo/lib/cdp.ts`; the same input gives the same WebP. A machine with SF Mono installed draws the monospace parts of the GUI with another glyph shape. The terminals use Menlo.
- identical consecutive frames are merged by the WebP encoder, so `webpinfo` lists fewer frames than the 576 rendered; the durations still add up to the playback length.

## Publishing

`npm run demo:publish -- <pr> [--lang en|ja] [--dry-run]` attaches the render to the PR, one comment per language, and points both READMEs at the uploaded WebP.

- The prerequisites come first and are printed as a table (`--dry-run` prints only that table and the `gh pr comment` commands, and uploads nothing). Any failure stops before the first upload.
- Each comment carries the WebP (with the alt text from `demo/lib/attachments.ts`) and the MP4. The script reads the comment back, takes the two URLs from it, downloads both and compares their sha256 with the render. A mismatch stops that language; nothing is written for it.
- Written: `demo/published.json` (one entry per language, with the comment URL, sizes, sha256, the render's HEAD, inputs and Chrome version), the README line, and nothing else. The script never commits. The files to commit are listed at the end.
- **The comments used for publishing are never deleted by this tool.** What GitHub does with an attachment after its comment is deleted has not been tested, and GitHub documents nothing about it.

Findings of the early check (2026-10-22, on a throwaway prototype comment):

- A README image points at `private-user-images.githubusercontent.com` directly, not through camo. A GET returns the same bytes that were uploaded. A HEAD returns 403 (signed S3 URL), so the check uses GET.
- An MP4 attachment renders as a video player in a comment.
- Attachments are tied to the account that uploaded them. `demo:publish` warns when that is not the repository owner.

If an attachment disappears: run `npm run demo` on the same tree (the `inputs` in `demo/published.json` say which tree), then `npm run demo:publish -- <pr>` again. The README line is replaced with the new URL.

Update flow: change `timeline.js` or the GUI, tune with `--preview --reuse-shots`, commit, rebase onto `main` and push, run `npm run demo` (no `--reuse-shots`), look at `contact.png` and both WebPs, then `npm run demo:publish -- <pr>` and commit the three files.

highlight.js is fetched once into `demo/out/cache/`. When the version in `public/index.html` changes, pin the new sha256 sums in `demo/lib/hljs.ts` first; the render stops on an unknown URL.
