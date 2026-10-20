---
ukagai: 1
question: トークンの署名方式を変えてよいですか？
title: Change the token signing algorithm or keep the current one
reversibility: reversible
scope: repo
recommended: RS256 に変える
---

## Why this decision is needed now

トークンの署名方式で、鍵の配り方が変わります。ステップ 56 件の検証で、`reports/x/y/S9-integration.md` に記録した結果は stage 52 passed でした。`VR-DEV.md` にも同じ結果があります。

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| RS256 に変える | 公開鍵で検証できる。PG15 のテーブルに鍵を置く。 | 戻し方: 設定を HS256 に戻すだけ。 |
| HS256 のままにする | 共有の秘密鍵で署名する。 | 何も変わらない。いつでも RS256 に変えられます。 |

## Recommendation

RS256 に変えるのが良いです。公開鍵だけを配れば検証でき、設定で戻せます。HS256 のままにする案が合うのは、検証する側が自分のサービスだけの場合です。ログに出る V023__add_keys.sql と L116-125 の箇所にも変更が入ります。

## What only you know

- 検証する側に外部のサービスが含まれるかどうか。

## Assumptions

- 鍵の更新は年に 1 回で足りる。

## What I checked

- 関連する箇所を読んで確かめた[^1]。

[^1]: `src/config.ts` を読んだ。
