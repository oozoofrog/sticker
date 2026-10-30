#!/bin/bash
# Fresh synthetic fixture only; no launch, install, dependency or permission changes.
set -euo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $(uname -s) = Darwin && $# = 1 ]] || fail 'Use an existing macOS Swift toolchain: build-swift.sh /private/tmp/sticker-window-XXXXXXXX'
[[ -x /usr/bin/xcrun ]] || fail 'macOS developer tools unavailable; stop and report. Nothing installed.'
compiler=$(/usr/bin/xcrun --find swiftc 2>/dev/null) || fail 'Swift compiler unavailable; stop and report. Nothing installed.'
sdk=$(/usr/bin/xcrun --sdk macosx --show-sdk-path 2>/dev/null) || fail 'macOS SDK unavailable; stop and report. Nothing installed.'
sdk_version=$(/usr/bin/xcrun --sdk macosx --show-sdk-version 2>/dev/null) || fail 'macOS SDK version unverified.'
[[ "$sdk_version" =~ ^([0-9]+)\.([0-9]+) ]] || fail 'macOS SDK version unverified.'
(( BASH_REMATCH[1] > 11 || (BASH_REMATCH[1] == 11 && BASH_REMATCH[2] >= 3) )) || fail 'macOS SDK 11.3 or newer required; nothing installed.'
compiler_version=$("$compiler" --version) || fail 'Swift version unverified.'
[[ "$compiler_version" =~ Swift[[:space:]]version[[:space:]]([0-9]+)\.([0-9]+) ]] || fail 'Swift version unverified.'
(( BASH_REMATCH[1] > 5 || (BASH_REMATCH[1] == 5 && BASH_REMATCH[2] >= 7) )) || fail 'Swift 5.7 or newer required; nothing installed.'
printf '%s\n' "$compiler_version"
architecture=$(uname -m)
[[ "$architecture" = arm64 || "$architecture" = x86_64 ]] || fail 'Unsupported fixture architecture.'
printf 'SDK %s; Swift 5 language mode; macOS 11.3 minimum\n' "$sdk_version"
directory=$1
[[ "$directory" =~ ^/(private/)?tmp/sticker-window-[A-Za-z0-9_-]+$ && -d "$directory" && ! -L "$directory" && -f "$directory/fixture.json" && ! -L "$directory/fixture.json" ]] || fail 'Fresh fixture configuration required.'
app="$directory/StickerSwiftWindowFixture.app"
[[ ! -e "$app" ]] || fail 'Existing evidence retained; use a fresh fixture.'
source=$(cd -- "$(dirname -- "$0")" && pwd -P)
umask 077
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$directory/swift-module-cache"
MACOSX_DEPLOYMENT_TARGET=11.3 "$compiler" -parse-as-library -swift-version 5 -target "$architecture-apple-macosx11.3" -sdk "$sdk" -module-cache-path "$directory/swift-module-cache" -framework AppKit -framework WebKit "$source/SwiftProbe.swift" -o "$app/Contents/MacOS/StickerSwiftWindowFixture"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>StickerSwiftWindowFixture</string><key>CFBundleIdentifier</key><string>org.oozoofrog.sticker.swiftwindowfixture</string><key>CFBundleName</key><string>Sticker Swift Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>11.3</string><key>NSHighResolutionCapable</key><true/></dict></plist>
PLIST
cp "$directory/fixture.json" "$app/Contents/Resources/fixture.json"
/usr/bin/codesign --force --sign - --timestamp=none "$app"
/usr/bin/codesign --verify --deep --strict "$app"
printf 'Compiled and signed only, not launched: %s\n' "$app"
