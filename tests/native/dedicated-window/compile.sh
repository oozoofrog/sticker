#!/bin/bash
set -euo pipefail
[[ $(uname -s) = Darwin && $# = 1 ]] || exit 1
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd -P)
OUT=$1
umask 077
mkdir -p "$OUT/module-cache"
/usr/bin/xcrun swiftc -parse-as-library -swift-version 5 -target "$(uname -m)-apple-macosx11.3" -module-cache-path "$OUT/module-cache" -framework AppKit -framework WebKit "$ROOT/packaging/macos/AccessCore.swift" "$ROOT/packaging/macos/StickerApp.swift" "$ROOT/packaging/macos/Main.swift" -o "$OUT/Sticker"
