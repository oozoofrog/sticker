#!/bin/bash
set -euo pipefail
[[ $# = 1 && "$1" = /* && ! -e "$1" ]] || { echo 'Choose a new absolute temporary fixture directory.' >&2; exit 64; }
case "$1" in *$'\n'*|*$'\r'*|*$'\t'*) exit 64;; esac
SOURCE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
mkdir -m 700 "$1"
ROOT=$(CDPATH='' cd -- "$1" && pwd -P)
mkdir "$ROOT/ascii" "$ROOT/한글"
ln -s "$ROOT/한글" "$ROOT/alias"
: > "$ROOT/trace.jsonl"; chmod 600 "$ROOT/trace.jsonl"
/usr/bin/osacompile -s -l JavaScript -o "$ROOT/CwdProbe.app" "$SOURCE/probe.jxa"
printf '%s\n' "$ROOT" > "$ROOT/CwdProbe.app/Contents/Resources/fixture-directory"
/usr/bin/codesign --force --sign - --timestamp=none "$ROOT/CwdProbe.app"
/usr/bin/codesign --verify --deep --strict "$ROOT/CwdProbe.app"
printf 'Fixture compiled only, not launched: %s\n' "$ROOT"
