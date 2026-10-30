#!/bin/bash
set -euo pipefail
[[ $(uname -s) = Darwin && $# = 1 ]] || { echo 'macOS and an explicit test output directory required' >&2; exit 1; }
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
OUT=$1
umask 077
mkdir -p "$OUT/module-cache"
/usr/bin/xcrun swiftc -swift-version 5 -parse-as-library -module-cache-path "$OUT/module-cache" "$ROOT/packaging/macos/AccessCore.swift" "$ROOT/tests/native/access-core.swift" -o "$OUT/access-core-tests"
"$OUT/access-core-tests"
