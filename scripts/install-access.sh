#!/usr/bin/env bash
# Explicit, user-scoped launcher installation. Never starts the service.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
fail() { printf '%s\n' "$1" >&2; exit 1; }
safe_path() { case "$1" in *$'\n'*|*$'\r'*|*$'\t'*) return 1;; esac; [[ "$1" = /* ]]; }
safe_path "$ROOT" || fail '설치 경로의 제어 문자를 지원하지 않습니다.'
[[ -f "$ROOT/scripts/sticker.sh" ]] || fail '스티커 설치 경로를 확인하세요.'
mode=${1:-}
case "$mode" in
  --headless|--wsl)
    [[ $# = 1 ]] || fail '지원하지 않는 인자입니다.'
    [[ "$mode" != --wsl ]] || printf '%s\n' 'WSL 터미널 명령 · Windows 바로가기 실행 미검증'
    printf '%s\n' '스티커 · URL/상태 확인 및 재접속'
    for verb in status open start stop; do printf 'bash %q %s\n' "$ROOT/scripts/sticker.sh" "$verb"; done
    printf '%s\n' 'URL은 status 결과에서 확인하세요. 원격 Docker 주소는 현재 PC 주소가 아닙니다.'
    bash "$ROOT/scripts/sticker.sh" status || true
    exit 0;;
  --linux|--mac) [[ $# = 2 ]] || fail '설치할 절대 경로를 지정하세요.';;
  *) fail '사용법: install-access.sh --mac /경로/Sticker.app | --linux /경로/sticker.desktop | --headless | --wsl';;
esac
# Freeze the selected named context; do not silently inherit GUI/login overrides.
for variable in DOCKER_HOST DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES COMPOSE_PROJECT_DIRECTORY; do
  [[ -z "${!variable:-}" ]] || fail "지원하지 않는 환경 override: $variable"
done
docker_executable=$(command -v docker) || fail 'Docker 실행파일을 찾을 수 없습니다.'
safe_path "$docker_executable" && [[ -x "$docker_executable" ]] || fail 'Docker 절대 실행파일을 확인하세요.'
context=$("$docker_executable" context show) || fail '선택된 Docker context를 확인할 수 없습니다.'
[[ "$context" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || fail '지원하지 않는 Docker context 이름입니다.'
project=${COMPOSE_PROJECT_NAME:-}
[[ -z "$project" || "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Compose 프로젝트 이름을 확인하세요.'
# Empty keeps compose.yaml/.env's existing project-name rules; never infer basename.
manifest() { printf 'sticker-access-v2\n%s\n%s\n%s\n%s\n' "$ROOT" "$docker_executable" "$context" "$project"; }
target=$2
safe_path "$target" || fail '절대 경로를 사용하고 제어 문자를 제거하세요.'
[[ ! -L "$target" ]] || fail '심볼릭 링크 대상은 변경하지 않습니다.'
parent=$(dirname -- "$target")
[[ -d "$parent" && -w "$parent" ]] || fail '설치 대상의 상위 폴더가 없거나 쓸 수 없습니다.'
parent=$(CDPATH='' cd -- "$parent" && pwd -P)
target="$parent/$(basename -- "$target")"
lock="$target.install-lock"
mkdir -- "$lock" 2>/dev/null || fail '다른 설치 작업 또는 잠금이 있습니다.'
stage=''; old=''
cleanup() {
  if [[ -n "$old" && -e "$old" ]]; then
    if [[ ! -e "$target" ]]; then mv -- "$old" "$target"; else rm -rf -- "$old"; fi
  fi
  [[ -z "$stage" ]] || rm -rf -- "$stage"
  rmdir -- "$lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
stage=$(mktemp -d "$parent/.sticker-access.XXXXXXXX")
chmod 700 "$stage"
if [[ "$mode" = --linux ]]; then
  [[ "$target" = *.desktop ]] || fail '.desktop 경로를 지정하세요.'
  digest() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d ' ' -f1; else shasum -a 256 "$1" | cut -d ' ' -f1; fi; }
  metadata="$target.sticker-manifest"
  if [[ -e "$target" ]]; then
    [[ -f "$target" && -f "$metadata" && ! -L "$metadata" ]] || fail '다른 바로가기를 덮어쓰지 않습니다.'
    { manifest; printf '%s\n' "$(digest "$target")"; } > "$stage/expected"
    cmp -s "$metadata" "$stage/expected" || fail '다른 설치 또는 수정된 바로가기입니다.'
  elif [[ -e "$metadata" || -L "$metadata" ]]; then fail '기존 manifest 충돌입니다.'; fi
  # Exec escaping has TWO layers: desktop string escapes, then Exec token escapes.
  desktop_arg() {
    local value=$1
    value=${value//\\/\\\\}; value=${value//\"/\\\"}; value=${value//\$/\\\$}; value=${value//\`/\\\`}
    value=${value//\\/\\\\}; value=${value//%/%%}
    printf '"%s"' "$value"
  }
  {
    printf '[Desktop Entry]\nType=Application\nName=스티커\nTerminal=true\nCategories=Development;\nActions=Open;Status;Start;Stop;\nExec=/bin/bash '
    desktop_arg "$ROOT/packaging/linux/control.sh"; printf ' '; desktop_arg "$metadata"; printf ' open\n'
    for pair in 'Open:열기:open' 'Status:상태:status' 'Start:시작:start' 'Stop:중지:stop'; do
      IFS=: read -r key label verb <<< "$pair"
      printf '\n[Desktop Action %s]\nName=%s\nExec=/bin/bash ' "$key" "$label"
      desktop_arg "$ROOT/packaging/linux/control.sh"; printf ' '; desktop_arg "$metadata"; printf ' %s\n' "$verb"
    done
  } > "$stage/entry"
  { manifest; printf '%s\n' "$(digest "$stage/entry")"; } > "$stage/manifest"
  chmod 644 "$stage/entry"; chmod 600 "$stage/manifest"
  # If interrupted between files, manifest mismatch fails closed on the next run.
  mv -- "$stage/entry" "$target"
  mv -- "$stage/manifest" "$metadata"
  printf '%s\n' "바로가기 파일 설치: $target" 'GUI 실행은 미확인입니다.'
else
  [[ "$(uname -s)" = Darwin ]] || fail 'macOS에서만 앱을 컴파일할 수 있습니다.'
  [[ "$target" = *.app ]] || fail '.app 경로를 지정하세요.'
  [[ -x /usr/bin/osacompile && -x /usr/bin/plutil ]] || fail 'macOS 기본 컴파일 도구가 없습니다.'
  if [[ -e "$target" ]]; then
    [[ -d "$target" && ! -L "$target/Contents" && ! -L "$target/Contents/Resources" ]] || fail '다른 앱은 변경하지 않습니다.'
    manifest="$target/Contents/Resources/sticker-source"
    [[ -f "$manifest" && ! -L "$manifest" ]] || fail '앱 소유 정보를 확인할 수 없습니다.'
    manifest > "$stage/expected"
    cmp -s "$manifest" "$stage/expected" || fail '다른 설치의 앱입니다.'
    [[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$target/Contents/Info.plist")" = org.oozoofrog.sticker.access ]] || fail '다른 앱 식별자입니다.'
    [[ "$(/usr/bin/osascript -l JavaScript "$ROOT/packaging/macos/is-running.jxa" "$target")" = stopped ]] || fail '기존 스티커 접근 앱을 종료한 뒤 설치하세요.'
  fi
  cat "$ROOT/packaging/macos/contract.js" "$ROOT/packaging/macos/Sticker.jxa" > "$stage/Sticker.js"
  /usr/bin/osacompile -l JavaScript -o "$stage/Sticker.app" "$stage/Sticker.js" >/dev/null
  /usr/bin/plutil -replace CFBundleIdentifier -string org.oozoofrog.sticker.access "$stage/Sticker.app/Contents/Info.plist"
  manifest > "$stage/Sticker.app/Contents/Resources/sticker-source"
  mkdir "$stage/Sticker.app/Contents/Resources/bin"
  printf '#!/bin/bash\nexec %q "$@"\n' "$docker_executable" > "$stage/Sticker.app/Contents/Resources/bin/docker"
  chmod 700 "$stage/Sticker.app/Contents/Resources/bin/docker"
  chmod 600 "$stage/Sticker.app/Contents/Resources/sticker-source"
  if [[ -e "$target" ]]; then old="$stage/previous.app"; mv -- "$target" "$old"; fi
  mv -- "$stage/Sticker.app" "$target"
  printf '%s\n' "접근 앱 설치: $target" '자동 실행하지 않았습니다. 앱 종료는 서비스 중지가 아닙니다.'
fi
