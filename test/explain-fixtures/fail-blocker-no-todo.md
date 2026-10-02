---
ukagai: 1
question: gcloud の認証が切れています。対応できましたか？
type: blocker
title: gcloud authentication has expired; please run `gcloud auth login`
recommended: Done. Continue
reversibility: reversible
scope: machine
---

## Why I stopped

`gcloud run deploy` failed with an authentication error.

```
ERROR: (gcloud.run.deploy) You do not currently have an active account selected.
```

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| Done. Continue | Retry the same deploy and carry on. | If authentication did not succeed, it stops again. |
| Skip this step and continue | Skip the deploy and proceed. | Undo by deploying manually later. |
| Stop here | Stop the work here. | Resume to continue. |
