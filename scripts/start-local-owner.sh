#!/usr/bin/env bash
# Explicit operator action only. Does not enable the mode or change .env itself.
set -euo pipefail
script_dir=${BASH_SOURCE[0]%/*}
[[ "$script_dir" != "${BASH_SOURCE[0]}" ]] || script_dir=.
source "$script_dir/host-tools.sh"
sticker_require_commands local-owner docker
cd "$script_dir/.."
# Check the daemon, not the client. Older Engine releases can expose loopback
# publications on the LAN. Unknown, prerelease and vendor-suffixed versions fail closed.
engine_version=$(docker version --format '{{.Server.Version}}') || {
  echo 'Cannot verify Docker Server Engine version; local owner startup refused.' >&2; exit 1;
}
if [[ ! "$engine_version" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]]; then
  echo 'Docker Server Engine must report a stable numeric version >= 28.3.3; startup refused.' >&2; exit 1
fi
major=$((10#${BASH_REMATCH[1]}))
minor=$((10#${BASH_REMATCH[2]}))
patch=$((10#${BASH_REMATCH[3]}))
if (( major < 28 || (major == 28 && (minor < 3 || (minor == 3 && patch < 3))) )); then
  echo 'Docker Server Engine >= 28.3.3 is required for verified local owner startup.' >&2; exit 1
fi
# Never stop/reconfigure an already running service on a failed preflight.
existing=$(docker compose ps -q sticker)
[[ -z "$existing" ]] || { echo 'Sticker is already running; stop it explicitly before this verified start.' >&2; exit 1; }
docker compose build sticker >&2
port=$(docker compose config --format json | docker compose run --rm --no-deps -T --entrypoint node sticker dist/server/check-local-deployment.js compose)
[[ "$port" =~ ^[0-9]+$ ]] || { echo 'No validated local publication.' >&2; exit 1; }
docker compose up -d sticker >&2
started=$(docker compose ps -q sticker)
[[ -n "$started" && "$started" != *$'\n'* ]] || { echo 'Cannot identify started target; no automatic stop attempted.' >&2; exit 1; }
# Only this explicitly started target is stopped on a failed post-start inspection.
if ! docker inspect --format '{"ports":{{json .NetworkSettings.Ports}},"networkMode":{{json .HostConfig.NetworkMode}}}' "$started" |
  docker compose run --rm --no-deps -T --entrypoint node sticker dist/server/check-local-deployment.js inspect "$port"; then
  docker stop "$started" >&2
  echo 'Started target stopped: actual publication did not match the validated loopback configuration.' >&2
  exit 1
fi
printf 'Verified loopback publication on 127.0.0.1:%s. Local OS users/processes remain trusted owners.\n' "$port"
