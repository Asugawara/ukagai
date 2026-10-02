# public/

`ukagai serve` が配信する GUI。ビルド無しの静的ファイル。`GET /` が `index.html` を返し(cookie を発行)、他は `/public/*`。

- `index.html` — 骨組み(保留一覧、カード、説明パネル、補助文脈、セッション一覧)
- `app.js` — ES module。API 呼び出し、SSE、描画。ユーザー由来の文字列は `textContent`
- `app.css` — システムフォント、1 カラム → 3 カラム(1100px 以上)、ダークモードは `prefers-color-scheme`
- `vendor/` — `mermaid.min.js` と `marked.umd.js`(コミット対象。CDN は使わない)

vendor の更新: `npm ci` の後に `npm run vendor`(`node_modules` から `public/vendor/` へ cp)。
