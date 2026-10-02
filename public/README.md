# public/

`ukagai serve` が配信する GUI。ビルド無しの静的ファイル。`GET /` が `index.html` を返し(cookie を発行)、他は `/public/*`。

- `index.html` — 骨組み(保留一覧、カード、説明パネル、補助文脈、セッション一覧)
- `app.js` — ES module。API 呼び出し、SSE、描画。ユーザー由来の文字列は `textContent`
- 質問カードは各質問の選択肢の下に「自由記述」(単一選択はラジオ、複数選択はチェックボックス)とテキスト入力を出す。選ばれていれば answers の値はその文字列(複数選択は選んだラベルの後ろに足す)。空文字では送れない
- `app.css` — システムフォント、1 カラム → 3 カラム(1100px 以上)、ダークモードは `prefers-color-scheme`
- `vendor/` — `mermaid.min.js` と `marked.umd.js`(コミット対象。CDN は使わない)

vendor の更新: `npm ci` の後に `npm run vendor`(`node_modules` から `public/vendor/` へ cp)。
