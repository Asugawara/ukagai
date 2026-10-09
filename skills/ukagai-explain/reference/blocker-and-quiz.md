# Blocker and quiz explanations

## Blocker

Use it when only a human can unblock you: authentication, login, permissions, 2FA, placing a key, a physical operation. Ask with AskUserQuestion: one question, exactly the 3 fixed options `Done. Continue (Recommended)` / `Skip this step and continue` / `Stop here`. On "Done", retry the same work.

Front matter: `ukagai: 1`, `question` (verbatim), `type: blocker`, `title` (what is needed, one sentence), `recommended: Done. Continue`, `reversibility` / `scope` (usually `reversible` / `machine`).

Required sections (no Recommendation, no Diagram):

| Section | Write |
|---|---|
| Why I stopped | The failed command and an excerpt of the error (a code block of at most 10 lines) |
| What you need to do | Numbered steps and a code block of commands to type as they are (at least one, else `todo`) |
| Options | Table: first column the 3 labels; columns "What happens if chosen" and "Risks and how to undo" |

Example (expired gcloud authentication):

````markdown
---
ukagai: 1
question: Your gcloud authentication has expired. Could you take care of it?
type: blocker
title: gcloud authentication has expired; please run `gcloud auth login`
recommended: Done. Continue
reversibility: reversible
scope: machine
---

## Why I stopped

`gcloud run deploy` failed with an authentication error. A browser login is required, which I cannot do.

```
ERROR: (gcloud.run.deploy) You do not currently have an active account selected.
Please run: $ gcloud auth login
```

## What you need to do

1. Run the following in a terminal and log in in the browser.
2. Also refresh the application default credentials.

```sh
gcloud auth login
gcloud auth application-default login
```

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| Done. Continue | Retry the same deploy and carry on. | If authentication did not succeed, it stops again with the same message. |
| Skip this step and continue | Skip the deploy and do the rest of the work. | The work proceeds without the deploy. Undo by deploying manually later. |
| Stop here | Stop the work here. | Changes made so far stay. Resume to continue. |
````

## Quiz

A comprehension quiz (`type: quiz`) is normally written by a tool (whoknows, via its Stop hook), which also asks the AskUserQuestion. You only present it. If the file exists, do not rewrite it, and never add a recommendation (no `recommended`, no Recommendation section, no hint in the title or sections: it would give the answer away).

- Front matter: `ukagai: 1`, `type: quiz`, `question` (a `question: |` block scalar with the AskUserQuestion text verbatim), `title`, `reversibility`, `scope`. No `recommended`.
- `## Why this question now` (1-600 characters) and `## Premise` (non-empty, at most 600); optional `## How to answer` and `## Terms`.
- No option label of 6+ characters inside those sections (`quiz_leak`). No Options table, Diagram or What I checked.
