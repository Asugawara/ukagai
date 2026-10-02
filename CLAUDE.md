# ukagai

Claude Code の判断(AskUserQuestion / ExitPlanMode)を hook で横取りし、GUI でまとめて答えさせるツール。

## 方針

MCP を使わず hooks + skill + GUI で作る。

## スタック

TypeScript(ESM、NodeNext)、Node >= 22、npm、Hono + `@hono/node-server`、zod、`node:test` + `tsx`。UI はビルド無しの静的 HTML / JS(`public/`)。

## コマンド

- `npm run build` — `tsc` で `dist/` に出力
- `npm run typecheck` — 型検査のみ
- `npm test` — `test/**/*.test.ts` を実行
- `npm run dev:serve` — `tsx src/cli.ts serve`

## ドキュメント

- `docs/strategy/03-*` — 現行の実装計画(02 は置き換え済み)
- `docs/spec/` — 契約(API、説明ファイル)
- `docs/verification/` — 実機検証の記録

## 禁止事項

- `.claude/settings.json` に hook を直接書かない。開発中は `--settings <file>` で別ファイルを使う。
- `hook` サブコマンドはフェイルオープン(失敗時は何も出力せず exit 0)を保つ。
