---
ukagai: 1
question: テストの実行は node:test と vitest のどちらにしますか？
title: Choose node:test or vitest as the test runner
reversibility: reversible
scope: file
recommended: node:test
---

## Why this decision is needed now

Decide the runner before starting to write W3's tests. CLAUDE.md specifies `node:test` + `tsx`.

## Options

- node:test: No new dependency. Fewer mocking features.
- vitest: More features. Adds a dependency and departs from the CLAUDE.md policy.

## Recommendation

I recommend node:test. It follows the CLAUDE.md policy and adds no dependency. vitest becomes the right choice if you want to run tests in parallel.
