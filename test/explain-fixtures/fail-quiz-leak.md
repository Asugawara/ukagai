---
ukagai: 1
type: quiz
question: Which value does parse_retry_after return for "120"?
title: Comprehension quiz on parse_retry_after
reversibility: reversible
scope: file
---

## Why this question now

The agent edited this function 12 times.

## Premise

src/http/retry.rs reads the Retry-After header. A bare number is read as `Some(Duration::from_secs(120))`, so the wait is two minutes.
