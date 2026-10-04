---
ukagai: 1
type: quiz
question: |
  Subject: parse_retry_after in src/http/retry.rs
  Why now: the agent edited this function 12 times and the quiz has no correct answer yet.

  What does parse_retry_after return for the header value "120"?
title: Comprehension quiz on parse_retry_after
reversibility: reversible
scope: file
---

## Why this question now

The agent edited this function 12 times and no quiz answer exists for it yet.

## Premise

src/http/retry.rs reads the Retry-After response header to decide how long the client waits before the next attempt. The header carries either a number of seconds or an HTTP date.

## How to answer

Pick with the arrow keys and press Enter. Type "I don't know" in Other when unsure. The answer and its reasons are shown after you reply.
