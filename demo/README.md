# demo

Renders the demo video of ukagai from the real `public/` GUI. This first version covers the shots only; the frame and stage steps come later.

## Prerequisites

- Node >= 22 and `npm install` (the demo runs `src/` through `tsx`).
- Google Chrome at the usual macOS path (`/Applications/Google Chrome.app`), or the path `findChrome` in `demo/lib/cdp.ts` finds.
- Network on the first run: highlight.js is fetched once into `demo/out/cache/` and checked against pinned sha256 sums.

## Commands

```sh
npm run demo -- --shots-only --lang en   # one language
npm run demo -- --shots-only             # en and ja
```

Output goes to `demo/out/<lang>/shots/` (git-ignored): one PNG per shot (2560x1600), the scroll series (`hero@<y>.png`, `plan-src@<y>.png`) and `manifest.json`.

## How it works

- A throwaway `ukagai serve` runs with a temp HOME and data dir on a free port. The real `~/.ukagai` and port 4818 are never touched.
- `demo/seeds.ts` holds the fixed ids and story text, `demo/seeds/` the explanations, pages, plan and source file.
- Plan v1 is sent and answered with an instruction before the GUI opens, so that plan v2 shows the version bar.
- Two runs give identical PNGs.
