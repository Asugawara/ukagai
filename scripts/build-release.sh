#!/bin/sh
# Stage a release tree and pack ukagai-<version>.tar.gz + SHA256SUMS into <outdir>.
# Usage: sh scripts/build-release.sh <version> <outdir>
set -eu

usage() {
  echo "usage: sh scripts/build-release.sh <version> <outdir>" >&2
  exit 2
}

sha256_to() {
  # sha256_to FILE... > writes checksum lines to stdout
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

main() {
  [ $# -eq 2 ] || usage
  V=${1#v}
  mkdir -p "$2"
  OUT=$(cd "$2" && pwd)
  ROOT=$(cd "$(dirname "$0")/.." && pwd)
  cd "$ROOT"

  [ -f bin/ukagai ] || { echo "build-release: bin/ukagai is missing (the launcher must exist at staging time)" >&2; exit 1; }

  # UKAGAI_BUILD_SKIP_NPM_CI=1 reuses an existing node_modules (local testing only; CI never sets it)
  [ -n "${UKAGAI_BUILD_SKIP_NPM_CI:-}" ] || npm ci
  npm run build

  stage=$OUT/stage/ukagai-$V
  rm -rf "$OUT/stage"
  mkdir -p "$stage/docs/spec"
  cp -R bin dist public skills "$stage/"
  cp README.md LICENSE package.json package-lock.json "$stage/"
  cp docs/spec/markdown.md "$stage/docs/spec/markdown.md"
  chmod 755 "$stage/bin/ukagai"

  # Make `bin/ukagai --version` match the release version.
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    p.version = process.argv[2];
    fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
  ' "$stage/package.json" "$V"

  (cd "$stage" && npm ci --omit=dev --ignore-scripts)
  rm -f "$stage/package-lock.json" "$stage/node_modules/.package-lock.json"

  if [ -f scripts/write-plugin-files.mjs ]; then
    node scripts/write-plugin-files.mjs "$stage" "$V"
  fi

  tarball=$OUT/ukagai-$V.tar.gz
  rm -f "$tarball"
  if tar --version 2>/dev/null | grep -qi 'bsdtar'; then
    (cd "$OUT/stage" && COPYFILE_DISABLE=1 tar --uid 0 --gid 0 --no-mac-metadata -czf "$tarball" "ukagai-$V")
  else
    # GET /api/config `build` is the mtime of public/app.js: it must differ between releases
    epoch=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || true)}
    [ -n "$epoch" ] || { echo "build-release: set SOURCE_DATE_EPOCH (no git commit time available for the tar mtime)" >&2; exit 1; }
    mtime=@$epoch
    (cd "$OUT/stage" && tar --owner=0 --group=0 --numeric-owner --sort=name --mtime="$mtime" -czf "$tarball" "ukagai-$V")
  fi

  (cd "$OUT" && sha256_to "ukagai-$V.tar.gz" > SHA256SUMS)
  echo "$tarball"
  echo "$OUT/SHA256SUMS"
}

main "$@"
