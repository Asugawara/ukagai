---
ukagai: 1
question: 古い設定を一括で消してよいですか？
title: Delete the old settings in one pass or one file at a time
reversibility: costly
scope: repo
recommended: 一括で消す
---

## Why this decision is needed now

古い設定が 40 ファイルあり、読み込み処理を遅くしています。消し方で作業量が変わります。

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| 一括で消す | 40 ファイルを 1 コミットで消す。 | コミットを revert すれば戻せます。 |
| 1 つずつ消す | 確認しながら 1 ファイルずつ消す。 | 時間がかかる。各コミットを revert すれば戻せます。 |

No diagram: 順序のある手順ではなく、2 案の比較だけなので図は要らない。

## Recommendation

一括で消すのが良いです。1 コミットなので revert も 1 回で済みます。1 つずつ消す案が合うのは、どれが使われているか分からない場合です。

> [!CAUTION] 消した後に必要になったとき
> 消したファイルは履歴にしか残りません。履歴を書き換える操作（squash など）を後で行うと、元のファイルを取り出せなくなります。そのため、消す前にタグを打っておき、戻す必要が出たらタグから取り出してください。
> 他の人がこのブランチを使っている場合は、先に知らせてください。履歴の書き換えは全員の手元に影響します。知らせずに行うと、他の人の作業が失われることがあります。

## What only you know

- 他の人が古い設定を参照しているかどうか。

## Assumptions

- 古い設定は 3 か月以上使われていない。

## What I checked

- 参照箇所を検索したが、一致は無かった[^1]。

[^1]: `grep -r old_settings src/` の結果は 0 件。
