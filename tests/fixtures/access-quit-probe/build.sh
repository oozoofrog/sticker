#!/bin/bash
# Test fixture generator only; no launch, Docker, credentials or production files.
set -euo pipefail
[[ $# = 1 && "$1" = /* && ! -e "$1" ]] || { echo 'Use a new absolute temporary directory.' >&2; exit 64; }
case "$1" in *$'\n'*|*$'\r'*|*$'\t'*) exit 64;; esac
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd -P)
FIXTURE="$ROOT/tests/fixtures/access-quit-probe"
mkdir -m 700 "$1"
BASE=$(CDPATH='' cd -- "$1" && pwd -P)
for kind in A B C; do
  directory="$BASE/$kind"; mkdir -m 700 "$directory"; : > "$directory/trace.log"; chmod 600 "$directory/trace.log"
  mkdir "$directory/scripts"
  cat > "$directory/dummy.sh" <<'SCRIPT'
#!/bin/bash
set -eu
directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
printf '%s\n' task-started > "$directory/task-started"
while [[ ! -e "$directory/release-gate" ]]; do sleep 0.1; done
printf '%s\n' task-completed > "$directory/task-completed"
SCRIPT
  cat > "$directory/scripts/sticker.sh" <<'SCRIPT'
#!/bin/bash
set -eu
directory=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
if [[ "${1:-}" = start ]]; then bash "$directory/dummy.sh"; fi
printf '%s\n' '{"schemaVersion":1,"state":"ready","containerRunning":true,"appResponse":"verified","browserReachability":"unverified","daemon":"local_socket","url":null,"urlScope":"docker_host","reason":"none","action":"none","lockName":""}'
SCRIPT
  cat "$FIXTURE/trace.jxa" > "$directory/probe.js"
  if [[ "$kind" = A ]]; then
    cat "$ROOT/packaging/macos/contract.js" >> "$directory/probe.js"
    sed -e "s/function quit() {/function quit() { trace('quit-enter');/" -e "s/function run() {/function run() { trace('run-enter');/" "$ROOT/packaging/macos/Sticker.jxa" >> "$directory/probe.js"
  elif [[ "$kind" = B ]]; then cat "$FIXTURE/nonmodal.jxa" >> "$directory/probe.js"
  else
    sed -e "s/Sticker quit probe B/Sticker quit probe C/" -e 's/pending = null; quit();/pending = null; requestQuit();/' "$FIXTURE/nonmodal.jxa" >> "$directory/probe.js"
    cat "$FIXTURE/cancel.jxa" >> "$directory/probe.js"
  fi
  # Confirm -s means stay-open with this machine's osacompile -h before running.
  /usr/bin/osacompile -s -l JavaScript -o "$directory/Probe.app" "$directory/probe.js"
  resources="$directory/Probe.app/Contents/Resources"
  printf '%s\n' "$directory" > "$resources/probe-directory"
  printf 'sticker-access-v2\n%s\n/bin/true\ndefault\n\n' "$directory" > "$resources/sticker-source"
  mkdir "$resources/bin"
  /usr/bin/codesign --force --sign - --timestamp=none "$directory/Probe.app"
  /usr/bin/codesign --verify --deep --strict "$directory/Probe.app"
done
printf 'Fixtures only; not launched: %s\n' "$BASE"
