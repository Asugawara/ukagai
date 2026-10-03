---
ukagai: 1
question: __QUESTION__
title: P-GH: __TITLE__
recommended: Publish
reversibility: costly
scope: repo
---

## Why this decision is needed now

The release waits on W-T2 and FT4. G-T2 only runs after TM28 is green, and P-GH covers the rest. The image goes to GHCR either way.

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| Publish (Recommended) | The image is pushed to the registry today | A bad tag can be deleted from the registry |
| Hold | Nothing is pushed until the checks pass | None |
| Skip | The image is built locally only | None |

## Recommendation

Publish the image now, because the checks are already green.

## Terms

- **P-GH** — the gate
- **GHCR** — the GitHub Container Registry, where the image is stored
