# ukagai

Agents ask. Humans decide. One place for every coding agent's questions, with the context to answer them.

コーディングエージェントが人に求める「判断」(AskUserQuestion / 計画承認)を Claude Code の hook で横取りし、localhost の GUI に集め、エージェント自身が書いた説明(なぜ・推奨・選択肢の表・Mermaid 図・差分)と一緒に答えられるようにするツール。MCP は使わない。

## 使い方(開発中)

```
npm ci
npm run build
npm run vendor                      # marked / mermaid を public/vendor/ に同梱
node dist/cli.js serve              # 127.0.0.1:4818
node dist/cli.js install --dry-run  # ~/.claude/settings.json への登録内容を確認
node dist/cli.js install            # 登録(バックアップを取る)。uninstall で元に戻す
node dist/cli.js doctor             # 登録と server の診断
node dist/cli.js tui                # ターミナルで同じ判断画面(j/k 移動、Enter 送信、i 自由記述、h/l 切替、b 一覧、q 終了)
node dist/cli.js tui --server http://127.0.0.1:4832 --data-dir /tmp/ukagai-x   # 別の server に接続
```

`install` 後は `claude` を起動するだけで server が立ち、その日最初のセッションでブラウザが開く。手動で `serve` を打つ必要はない。止めるときは `pkill -f "cli.js serve"`、自動起動を止めるには `install --no-autostart`。

開発中のセッションに hook をかけないときは `install --settings <file>` で別ファイルに書き、テスト用セッションを `claude --settings <file>` で起動する。

## ドキュメント

| パス | 内容 |
|---|---|
| `docs/strategy/00-overview.md` | 戦略の要約。何を作るか、なぜか、名前の決定 |
| `docs/strategy/02-mvp-plan.md` | 旧 MVP 計画(指標と打ち切り条件は有効。技術決定は 03 に置き換え) |
| `docs/strategy/03-mvp-implementation-plan.md` | 現行の MVP 実装計画(hook + GUI 方式、分割と担当、日程、リスク) |
| `docs/spec/api.md` | server の API、状態遷移、認可 |
| `docs/spec/explain.md` | エージェントが書く説明ファイル(v2: title / recommended / 推奨 / 選択肢の表)の仕様と hook の判定規則 |
| `skills/ukagai-explain/SKILL.md` | 説明の書き方を Claude に教える skill(install が配置する) |
| `docs/verification/01-askuserquestion-injection.md` | PreToolUse hook で AskUserQuestion / ExitPlanMode に回答を注入できることの実機検証 |
| `docs/verification/02-hook-limits.md` | hook の timeout 上限、answers の変種、deny で説明を書かせる往復などの実機検証 |
| `docs/verification/03-e2e.md` | serve + hook + GUI + install を Claude Code 本体で通した E2E 検証 |
| (removed before publication) |
| (removed before publication) |

## 状態

2026-10-02: MVP の実装(server / hook / GUI / install / 説明の仕様と skill)が main に入り、Claude Code 本体での E2E が通った。次は dogfood と指標の計測(03 の 6 節)。
