---
ukagai: 1
question: テストの実行は node:test と vitest のどちらにしますか？
title: テストランナー
reversibility: reversible
scope: file
---

## なぜ今この判断が要るか

W3 のテストを書き始める前に、ランナーを決めます。CLAUDE.md は `node:test` + `tsx` と定めています。

## 選択肢の比較

- node:test: 依存が増えない。モックの機能は少ない。
- vitest: 機能は多い。依存が増え、CLAUDE.md の方針から外れる。
