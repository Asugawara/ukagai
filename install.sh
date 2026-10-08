#!/bin/sh
# ukagai installer: downloads a release tarball, verifies it and links bin/ukagai.
# Usage: curl -fsSL https://raw.githubusercontent.com/Asugawara/ukagai/main/install.sh | sh -s -- [--lang en|ja] [--codex] [--claude]
set -eu

REPO=Asugawara/ukagai
BASE=${UKAGAI_BASE_URL:-https://github.com/$REPO/releases}
HOME_DIR=${UKAGAI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/ukagai}
BIN_DIR=${UKAGAI_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}
DATA_DIR=${UKAGAI_DATA_DIR:-$HOME/.ukagai}

V=${UKAGAI_VERSION:-}
INSTALL_ARGS=""
FORCE=0
NODE_BIN=""
PREV=""
TMP=""

say() { echo "ukagai-install: $*" >&2; }
err() { echo "ukagai-install: error: $*" >&2; }

usage() {
  cat >&2 <<USAGE
usage: install.sh [--version vX.Y.Z] [--lang en|ja] [--codex] [--claude] [--force]
  --version   install this version (default: latest release)
  --lang      GUI language, passed to "ukagai install"
  --codex     also register the Codex CLI hooks ("ukagai install --codex")
  --claude    register the Claude Code hooks ("ukagai install")
  --force     replace an existing non-ukagai file at the bin path
env: UKAGAI_VERSION UKAGAI_NODE UKAGAI_DOWNLOADER=curl|wget UKAGAI_BASE_URL
     UKAGAI_HOME UKAGAI_BIN_DIR UKAGAI_DATA_DIR
USAGE
}

add_arg() { INSTALL_ARGS="$INSTALL_ARGS $1"; }

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        [ $# -ge 2 ] || { usage; exit 2; }
        V=$2; shift 2 ;;
      --version=*) V=${1#--version=}; shift ;;
      --lang)
        [ $# -ge 2 ] || { usage; exit 2; }
        case $2 in en|ja) ;; *) usage; exit 2 ;; esac
        add_arg "--lang $2"; shift 2 ;;
      --codex) add_arg --codex; shift ;;
      --claude) add_arg --claude; shift ;;
      --force) FORCE=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage; exit 2 ;;
    esac
  done
  V=${V#v}
}

need() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || { err "required command not found: $c"; exit 1; }
  done
}

check_node() {
  if [ -n "${UKAGAI_NODE:-}" ]; then
    NODE_BIN=$UKAGAI_NODE
  else
    NODE_BIN=$(command -v node 2>/dev/null || true)
  fi
  major=""
  if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
    ver=$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)
    major=${ver%%.*}
  fi
  case $major in
    ''|*[!0-9]*) major=0 ;;
  esac
  if [ "$major" -lt 22 ]; then
    err "Node.js 22 or newer is required (found: ${ver:-none})."
    cat >&2 <<MSG
Install Node.js first, then re-run this script:
  - https://nodejs.org
  - nvm:   nvm install 22
  - fnm:   fnm install 22
  - volta: volta install node@22
  - macOS: brew install node
(Set UKAGAI_NODE=/path/to/node to use a specific binary.)
MSG
    exit 1
  fi
}

fetch() {
  url=$1 out=$2
  dl=${UKAGAI_DOWNLOADER:-}
  if [ -z "$dl" ]; then
    if command -v curl >/dev/null 2>&1; then dl=curl
    elif command -v wget >/dev/null 2>&1; then dl=wget
    fi
  fi
  case $dl in
    curl) command -v curl >/dev/null 2>&1 || { err "need curl or wget"; exit 1; }
          curl -fsSL --retry 3 -o "$out" "$url" ;;
    wget) command -v wget >/dev/null 2>&1 || { err "need curl or wget"; exit 1; }
          wget -q -O "$out" "$url" ;;
    *) err "need curl or wget"; exit 1 ;;
  esac
}

resolve_version() {
  [ -z "$V" ] || return 0
  t=$(mktemp)
  if ! fetch "$BASE/latest/download/SHA256SUMS" "$t" 2>/dev/null; then
    rm -f "$t"
    err "no published release found at $BASE (or no network)"
    exit 1
  fi
  V=$(sed -n 's/.*ukagai-\([0-9][0-9A-Za-z.+-]*\)\.tar\.gz.*/\1/p' "$t" | head -n 1)
  rm -f "$t"
  [ -n "$V" ] || { err "no published release found at $BASE (or no network)"; exit 1; }
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else
    err "need sha256sum, shasum or openssl to verify the download"
    exit 1
  fi
}

cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }

install_version() {
  if [ -x "$HOME_DIR/versions/$V/bin/ukagai" ]; then
    say "ukagai $V is already installed"
    return 0
  fi
  mkdir -p "$HOME_DIR/versions"
  TMP=$(mktemp -d)
  trap cleanup EXIT INT TERM
  say "downloading ukagai $V"
  fetch "$BASE/download/v$V/ukagai-$V.tar.gz" "$TMP/ukagai-$V.tar.gz" \
    || { err "download failed: $BASE/download/v$V/ukagai-$V.tar.gz"; exit 1; }
  fetch "$BASE/download/v$V/SHA256SUMS" "$TMP/SHA256SUMS" \
    || { err "download failed: $BASE/download/v$V/SHA256SUMS"; exit 1; }
  want=$(awk -v f="ukagai-$V.tar.gz" '$2 == f || $2 == "*" f { print $1; exit }' "$TMP/SHA256SUMS")
  got=$(sha256 "$TMP/ukagai-$V.tar.gz")
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    err "checksum mismatch for ukagai-$V.tar.gz; aborting"
    exit 1
  fi
  rm -rf "$HOME_DIR/versions/$V.tmp"
  mkdir -p "$HOME_DIR/versions/$V.tmp"
  tar -xzf "$TMP/ukagai-$V.tar.gz" -C "$HOME_DIR/versions/$V.tmp"
  rm -rf "$HOME_DIR/versions/$V"
  mv "$HOME_DIR/versions/$V.tmp/ukagai-$V" "$HOME_DIR/versions/$V"
  rm -rf "$HOME_DIR/versions/$V.tmp"
  got_v=$(UKAGAI_NODE="$NODE_BIN" "$HOME_DIR/versions/$V/bin/ukagai" --version 2>/dev/null || true)
  if [ "$got_v" != "$V" ]; then
    rm -rf "$HOME_DIR/versions/$V"
    err "smoke test failed: bin/ukagai --version printed '$got_v', expected '$V'"
    exit 1
  fi
}

record_node() {
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR" 2>/dev/null || true
  printf '%s\n' "$NODE_BIN" > "$DATA_DIR/node-path"
}

link_bin() {
  target=$HOME_DIR/versions/$V/bin/ukagai
  link=$BIN_DIR/ukagai
  mkdir -p "$BIN_DIR"
  if [ -L "$link" ]; then
    cur=$(readlink "$link" 2>/dev/null || true)
    case $cur in
      "$HOME_DIR"/versions/*) PREV=${cur#"$HOME_DIR"/versions/}; PREV=${PREV%%/*} ;;
      *) [ "$FORCE" = 1 ] || { err "$link exists and is not ours (use --force)"; exit 1; } ;;
    esac
  elif [ -e "$link" ]; then
    [ "$FORCE" = 1 ] || { err "$link exists and is not ours (use --force)"; exit 1; }
  fi
  rm -f "$BIN_DIR/.ukagai.$$"
  ln -s "$target" "$BIN_DIR/.ukagai.$$"
  mv -f "$BIN_DIR/.ukagai.$$" "$link"
}

prune() {
  running=""
  if command -v curl >/dev/null 2>&1; then
    hz=$(curl -fsS --max-time 2 http://127.0.0.1:4818/healthz 2>/dev/null || true)
    running=$(printf '%s' "$hz" | sed -n 's|.*versions/\([^/"]*\)/.*|\1|p' | head -n 1)
  fi
  for d in "$HOME_DIR"/versions/*; do
    [ -e "$d" ] || continue
    n=${d##*/}
    case $n in
      "$V"|"$PREV"|"$running") continue ;;
    esac
    rm -rf "$d"
  done
}

path_hint() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
  esac
  say "$BIN_DIR is not on your PATH. Add it:"
  echo "  bash/zsh: export PATH=\"$BIN_DIR:\$PATH\"" >&2
  echo "  fish:     fish_add_path $BIN_DIR" >&2
}

post() {
  if [ -n "$INSTALL_ARGS" ]; then
    # shellcheck disable=SC2086
    if [ -t 0 ]; then
      "$BIN_DIR/ukagai" install $INSTALL_ARGS
    else
      "$BIN_DIR/ukagai" install $INSTALL_ARGS </dev/null
    fi
  else
    say "ukagai $V installed: $BIN_DIR/ukagai"
    echo "Next: ukagai install --lang ja   (Claude Code)" >&2
    echo "      ukagai install --codex   (Codex CLI)" >&2
  fi
  if [ -n "$PREV" ] && [ "$PREV" != "$V" ]; then
    say "upgraded $PREV -> $V. If a ukagai server is running it restarts at the next session start; or: pkill -f \"cli.js serve\""
  fi
}

main() {
  parse_args "$@"
  need tar mkdir ln mv rm
  check_node
  resolve_version
  install_version
  record_node
  link_bin
  prune
  path_hint
  post
}

main "$@"
