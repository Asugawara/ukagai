---
ukagai: 1
question: 設定ファイルの置き場所をどちらにしますか？
title: Keep the settings file in the repository or move it to the home directory
reversibility: reversible
scope: repo
recommended: リポジトリ内に置く
---

## Why this decision is needed now

設定ファイルの置き場所が決まらないと、読み込み処理を書けません。置き場所は後からも変えられますが、最初の形をどちらにするかは人が決めます。

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| リポジトリ内に置く | 設定をコミットでき、チームで共有できる。 | 戻し方: 不要（何も変えない）。 |
| ホームに置く | 設定は各自のマシンに残り、リポジトリには入らない。 | あとでマージし直せます。PR はいつでもマージできます。 |
| 外部サービスに置く | 設定を外部サービスから読む。 | `ukagai uninstall` で止められる。別の home は終わったら消す。残るものはない。 |
| 環境変数で渡す | 起動時に環境変数から読む。 | 実行中のプロセスを close すれば消える。 |

## Recommendation

リポジトリ内に置くのが安全です。履歴に残り、間違えても元に戻せます。ホームに置く案が合うのは、秘密の値を含める場合です。

## What only you know

- 設定にチーム外へ出せない値が入るかどうか。

## Assumptions

- 設定は 10 項目ほどで、頻繁には変わらない。

## What I checked

- 関連する箇所を読んで確かめた[^1]。

[^1]: `src/config.ts` を読んだ。
