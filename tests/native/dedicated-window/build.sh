#!/bin/bash
# Builds a NEW synthetic app only. Does not launch/install or touch the real Sticker app.
set -euo pipefail
[[ $(uname -s) = Darwin && $# = 1 ]] || { echo 'macOS only: build.sh /private/tmp/sticker-window-XXXXXXXX' >&2; exit 1; }
directory=$1
[[ "$directory" =~ ^/(private/)?tmp/sticker-window-[A-Za-z0-9_-]+$ && -d "$directory" && ! -L "$directory" && -f "$directory/fixture.json" && ! -L "$directory/fixture.json" ]] || exit 1
[[ ! -e "$directory/StickerWindowFixture.app" && ! -e "$directory/Probe.js" ]] || { echo 'New fixture build only; existing evidence retained.' >&2; exit 1; }
source=$(cd -- "$(dirname -- "$0")" && pwd -P)
umask 077
cat "$source/policy.js" "$source/Probe.jxa" > "$directory/Probe.js"
/usr/bin/osacompile -s -l JavaScript -o "$directory/StickerWindowFixture.app" "$directory/Probe.js"
/usr/bin/plutil -replace CFBundleIdentifier -string org.oozoofrog.sticker.windowfixture "$directory/StickerWindowFixture.app/Contents/Info.plist"
cp "$directory/fixture.json" "$directory/StickerWindowFixture.app/Contents/Resources/fixture.json"
/usr/bin/codesign --force --sign - --timestamp=none "$directory/StickerWindowFixture.app"
/usr/bin/codesign --verify --deep --strict "$directory/StickerWindowFixture.app"
printf 'Compiled only, not launched: %s\n' "$directory/StickerWindowFixture.app"
