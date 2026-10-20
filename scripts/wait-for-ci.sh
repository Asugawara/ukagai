#!/bin/sh
# Wait for the `ci` workflow run of a main commit and succeed only when it succeeded.
# Env: GITHUB_SHA (commit, required), GH_TOKEN / GH_REPO (for gh),
#      WAIT_TIMEOUT (seconds, default 1800), POLL_INTERVAL (seconds, default 20).
set -eu

sha="${GITHUB_SHA:?GITHUB_SHA is required}"
timeout="${WAIT_TIMEOUT:-1800}"
interval="${POLL_INTERVAL:-20}"
waited=0

while :; do
  # newest run first, so a rerun of the same commit wins over the earlier attempt
  run="$(gh run list --workflow ci.yml --event push --branch main --commit "$sha" --limit 1 \
    --json databaseId,status,conclusion --jq '.[0] | select(. != null) | "\(.databaseId) \(.status) \(.conclusion)"')"
  if [ -z "$run" ]; then
    echo "no ci run for $sha yet (waited ${waited}s)"
  else
    # shellcheck disable=SC2086
    set -- $run
    id="$1"
    status="$2"
    conclusion="${3:-}"
    if [ "$status" = completed ]; then
      if [ "$conclusion" = success ]; then
        echo "ci run $id succeeded for $sha"
        exit 0
      fi
      echo "ci run $id for $sha ended with '$conclusion'; refusing to publish" >&2
      exit 1
    fi
    echo "ci run $id is $status (waited ${waited}s)"
  fi
  if [ "$waited" -ge "$timeout" ]; then
    echo "timed out after ${waited}s waiting for the ci run of $sha" >&2
    exit 1
  fi
  sleep "$interval"
  waited=$((waited + interval))
done
