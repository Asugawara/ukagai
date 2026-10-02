---
ukagai: 1
question: 検証用の hook ログは ~/.ukagai/log に置いてよいですか？
title: Put the verification hook log in ~/.ukagai/log or inside the repository
reversibility: reversible
scope: machine
recommended: ~/.ukagai/log
---

## Why this decision is needed now

`hook --observe` needs a place to write timestamps. `~/.ukagai/` is outside the repository, so this changes the filesystem of this machine. Whether to write outside the repository is for a human to decide.

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| `~/.ukagai/log` | Gathered in the same place as the other state. | Not visible from the repository. Undo by deleting the directory. |
| `verification/log` | Visible inside the repository. | Might be committed by mistake. Undo by removing the file from the index and adding it to `.gitignore`. |

## Recommendation

I recommend `~/.ukagai/log`. It is gathered with the other state, and there is no risk of an accidental commit. `verification/log` becomes the right choice if you want to attach the log to a PR.

## What I checked

- `~/.ukagai/` is not tracked by git (checked with `git status`).
