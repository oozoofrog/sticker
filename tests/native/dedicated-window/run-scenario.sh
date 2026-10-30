#!/bin/bash
# Synthetic, bounded product-controller regression. Never uses Docker or a browser.
set -euo pipefail
[[ $(uname -s) = Darwin && $# = 1 ]] || exit 2
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd -P)
OUT=$1
[[ "$OUT" = /* && -d "$OUT" ]] || exit 2
fixture=$(mktemp -d /private/tmp/sticker-product-XXXXXXXX)
umask 077
chmod 700 "$fixture"
printf '%s\n' "$fixture" > "$OUT/fixture-path"
mkdir "$fixture/scripts" "$fixture/bin"
printf 'yes' > "$fixture/online"
cat > "$fixture/scripts/sticker.sh" <<'MOCK'
#!/bin/bash
set -euo pipefail
[[ "$1" = status || "$1" = start || "$1" = stop ]] || exit 91
printf '%s\n' "$1" >> operations
[[ ! -f busy ]] || /bin/sleep 2
cat status.json
MOCK
printf '#!/bin/sh\nexit 92\n' > "$fixture/bin/docker"
chmod 700 "$fixture/bin/docker"
node "$ROOT/tests/native/dedicated-window/server.mjs" "$fixture" > "$OUT/server.log" 2>&1 &
server_pid=$!
cleanup() { kill -TERM "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT
for ((i=0;i<50;i++)); do [[ ! -f "$fixture/origin" ]] || break; sleep 0.1; done
[[ -f "$fixture/origin" ]] || exit 3
node --input-type=module - "$fixture" <<'JS'
import{readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';const r=process.argv[2];writeFileSync(join(r,'status.json'),JSON.stringify({schemaVersion:1,state:'stopped',containerRunning:false,appResponse:'not_checked',browserReachability:'unverified',daemon:'local_socket',url:readFileSync(join(r,'origin'),'utf8'),urlScope:'docker_host',reason:'stopped',action:'none',lockName:''}));
JS
app="$fixture/StickerProductFixture.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$OUT/module-cache"
/usr/bin/xcrun swiftc -D STICKER_NATIVE_TRACE -parse-as-library -swift-version 5 -target "$(uname -m)-apple-macosx11.3" -module-cache-path "$OUT/module-cache" -framework AppKit -framework WebKit "$ROOT/packaging/macos/AccessCore.swift" "$ROOT/packaging/macos/StickerApp.swift" "$ROOT/tests/native/dedicated-window/Scenario.swift" -o "$app/Contents/MacOS/Scenario" > "$OUT/compile.log" 2>&1
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Scenario</string><key>CFBundleIdentifier</key><string>org.oozoofrog.sticker.productfixture</string><key>CFBundleName</key><string>Sticker Product Fixture</string><key>NSPrincipalClass</key><string>StickerApplication</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>11.3</string></dict></plist>
PLIST
printf '%s' "$fixture" > "$app/Contents/Resources/fixture-root"
/usr/bin/codesign --force --sign - --timestamp=none "$app"
/usr/bin/codesign --verify --deep --strict "$app"
"$app/Contents/MacOS/Scenario" > "$OUT/result.log" 2>&1 &
app_pid=$!
# External supervision remains live even if AppKit enters a modal loop.
(
  deadline=110
  [[ ${STICKER_FIXTURE_MODE:-normal} != download ]] || deadline=210
  sleep "$deadline"
  if kill -0 "$app_pid" 2>/dev/null; then
    printf 'FAIL external deadline; TERM own app %s\n' "$app_pid" >> "$OUT/result.log"
    kill -TERM "$app_pid"
  fi
) &
watchdog=$!
set +e
wait "$app_pid"
result=$?
set -e
kill -TERM "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
exit "$result"
