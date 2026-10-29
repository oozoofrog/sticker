#!/usr/bin/env bash
set -eu
[[ $# = 2 && -f "$1" && ! -L "$1" ]] || exit 64
case "$2" in status|open|start|stop) ;; *) exit 64;; esac
{ IFS= read -r version; IFS= read -r root; IFS= read -r docker; IFS= read -r context; IFS= read -r project; } < "$1"
[[ "$version" = sticker-access-v2 && "$root" = /* && "$docker" = /* && -x "$docker" ]] || exit 1
[[ "$context" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 1
[[ -z "$project" || "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || exit 1
[[ "$root" = "$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)" ]] || exit 1
for variable in ${!COMPOSE_@} ${!DOCKER_@}; do unset "$variable"; done
export DOCKER_CONTEXT="$context"
[[ -z "$project" ]] || export COMPOSE_PROJECT_NAME="$project"
wrapper=$(mktemp -d "${TMPDIR:-/tmp}/sticker-access-docker.XXXXXXXX")
trap 'rm -rf -- "$wrapper"' EXIT
trap 'exit 130' INT TERM HUP
printf '#!/bin/bash\nexec %q "$@"\n' "$docker" > "$wrapper/docker"
chmod 700 "$wrapper/docker"
export PATH="$wrapper:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
result=0
bash "$root/scripts/sticker.sh" "$2" || result=$?
if [[ -t 0 ]]; then printf '\nEnter: 창 닫기 (서비스 유지) '; IFS= read -r _ || true; fi
exit "$result"
