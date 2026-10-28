#!/usr/bin/env bash
# Disposable end-to-end verification: never use an operator's Compose project/data.
set -euo pipefail
script_dir=${BASH_SOURCE[0]%/*}
[[ "$script_dir" != "${BASH_SOURCE[0]}" ]] || script_dir=.
source "$script_dir/host-tools.sh"
sticker_require_commands verification docker bash dirname tar date mkdir mv rm grep awk mktemp chmod mkfifo
cd "$script_dir/.."
root=$PWD
docker compose version >/dev/null
docker buildx version >/dev/null || { echo 'Container verification requires the Docker Buildx plugin; see docs/REPRODUCIBILITY.md.' >&2; exit 2; }
project="sticker-portability-$$-$RANDOM"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/sticker-container.XXXXXX")
export COMPOSE_PROJECT_NAME=$project COMPOSE_FILE="$root/compose.yaml" COMPOSE_PATH_SEPARATOR=:
unset COMPOSE_ENV_FILES
export COMPOSE_PROFILES= COMPOSE_DISABLE_ENV_FILE=1
export STICKER_IMAGE="$project:fixture" STICKER_PORT=0
export OWNER_PASSWORD="fixture-only-$RANDOM-$RANDOM-$RANDOM-$RANDOM"
export APP_ORIGIN=http://localhost:8787 SECURE_COOKIES=false AGENT_CONFIG_PATH=
export STICKER_AGENT_TOKEN= STICKER_AGENT_CONFIG=
export LOCAL_OWNER_MODE=off
mcp_pid=
compose() { docker compose --env-file /dev/null "$@"; }
cleanup() {
  status=$?
  trap - EXIT
  if [[ -n "$mcp_pid" ]]; then
    docker rm -f "$project-mcp" >/dev/null 2>&1 || true
    kill "$mcp_pid" 2>/dev/null || true
    wait "$mcp_pid" 2>/dev/null || true
  fi
  if (( status != 0 )); then compose logs --no-color --tail=80 sticker >&2 || true; fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$STICKER_IMAGE" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
compose config --quiet
toolchain=$(bash scripts/container-toolchain.sh)
printf '%s\n' "$toolchain"
expected_node= expected_image=
while IFS='=' read -r key value; do
  if [[ "$key" == node_version ]]; then expected_node=$value; fi
  if [[ "$key" == node_image ]]; then expected_image=$value; fi
done <<< "$toolchain"
compose build --pull sticker
docker run --rm --network none --entrypoint node -e STICKER_EXPECTED_NODE_VERSION="$expected_node" \
  "$STICKER_IMAGE" -e 'if(process.versions.node!==process.env.STICKER_EXPECTED_NODE_VERSION)throw new Error("Container Node version differs from pinned toolchain"); console.log(JSON.stringify({node:process.versions.node,platform:process.platform,architecture:process.arch}))'
docker image inspect "$STICKER_IMAGE" --format 'Built application image: {{.Id}}'
# Query by immutable index digest, never by a floating tag. Do not collapse to amd64.
docker buildx imagetools inspect --raw "$expected_image" | \
  docker run --rm -i --network none --entrypoint node "$STICKER_IMAGE" -e 'const assert=require("node:assert/strict"),fs=require("node:fs");const index=JSON.parse(fs.readFileSync(0,"utf8"));assert.ok(["application/vnd.oci.image.index.v1+json","application/vnd.docker.distribution.manifest.list.v2+json"].includes(index.mediaType),"Base must be a multi-architecture index");const platforms=index.manifests.map(m=>m.platform).filter(p=>p.os==="linux").map(p=>p.architecture);for(const required of ["amd64","arm64","ppc64le"])assert.ok(platforms.includes(required),"Missing base architecture: "+required);console.log("Pinned base index platforms: "+platforms.join(","))'

# Launcher boundary tests use only built-in Node APIs and Bash in the image.
docker run --rm --network none --entrypoint node \
  --mount "type=bind,source=$root,target=/verification,readonly" --workdir /verification \
  "$STICKER_IMAGE" --test tests/container.test.mjs tests/host-tools.test.mjs tests/container-readiness.test.mjs tests/container-toolchain.test.mjs tests/container-local-owner-isolation.test.mjs
# Generated only in this disposable test; never persisted in the checkout/logs.
OWNER_PASSWORD=$(docker run --rm --network none --entrypoint node "$STICKER_IMAGE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
export OWNER_PASSWORD
compose up -d --wait --wait-timeout 90 sticker
compose exec -T sticker node --input-type=module - initialize < tests/container-smoke.mjs
compose exec -T sticker node --input-type=module - initialize < tests/container-release-smoke.mjs
compose exec -T sticker node --input-type=module - initialize < tests/container-views-smoke.mjs
compose exec -T sticker node --input-type=module - initialize < tests/container-templates-smoke.mjs
compose exec -T sticker node --input-type=module - initialize < tests/container-resources-smoke.mjs
compose up -d --force-recreate --wait --wait-timeout 90 sticker
compose exec -T sticker node --input-type=module - verify < tests/container-smoke.mjs
compose exec -T sticker node --input-type=module - verify < tests/container-release-smoke.mjs
compose exec -T sticker node --input-type=module - verify < tests/container-views-smoke.mjs
compose exec -T sticker node --input-type=module - verify < tests/container-templates-smoke.mjs
compose exec -T sticker node --input-type=module - verify < tests/container-resources-smoke.mjs
bash scripts/backup.sh "$temporary/fixture.tar.gz"
# backup restarts an originally running service, but `start` is not health readiness.
compose up -d --wait --wait-timeout 90 sticker
compose exec -T sticker node --input-type=module - mutate < tests/container-smoke.mjs
bash scripts/restore.sh "$temporary/fixture.tar.gz" --replace-data
compose up -d --wait --wait-timeout 90 sticker
compose exec -T sticker node --input-type=module - verify < tests/container-smoke.mjs
compose exec -T sticker node --input-type=module - verify < tests/container-release-smoke.mjs
compose exec -T sticker node --input-type=module - verify < tests/container-views-smoke.mjs
compose exec -T sticker node --input-type=module - verify < tests/container-templates-smoke.mjs
compose exec -T sticker node --input-type=module - verify < tests/container-resources-smoke.mjs

# Agent access is optional. Add a generated read-only grant only after core tests.
STICKER_AGENT_TOKEN=$(docker run --rm --network none --entrypoint node "$STICKER_IMAGE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
export STICKER_AGENT_TOKEN STICKER_AGENT_CONFIG="$temporary/agents.json"
docker run --rm --network none -e STICKER_AGENT_TOKEN --entrypoint node "$STICKER_IMAGE" -e 'const crypto=require("node:crypto"); process.stdout.write(JSON.stringify([{id:"container-fixture",name:"Container fixture",tokenHash:crypto.createHash("sha256").update(process.env.STICKER_AGENT_TOKEN).digest("hex"),projectIds:null,canWrite:false}]))' > "$STICKER_AGENT_CONFIG"
chmod 644 "$STICKER_AGENT_CONFIG" # Contains only the disposable fixture hash.
export COMPOSE_FILE="$root/compose.yaml:$root/compose.agents.yaml"
compose up -d --force-recreate --wait --wait-timeout 90 sticker
verify_mcp() {
# Open both FIFOs read/write first so neither container blocks while opening stdin.
[[ -p "$temporary/to-mcp" ]] || mkfifo "$temporary/to-mcp" "$temporary/from-mcp"
exec 3<>"$temporary/to-mcp" 4<>"$temporary/from-mcp"
compose run --name "$project-mcp" --rm --no-deps -T -e STICKER_AGENT_TOKEN mcp <&3 >&4 &
mcp_pid=$!
# The client itself needs no Docker socket, credentials, host Node or network.
docker run --rm -i --network none --entrypoint node \
  --mount "type=bind,source=$root/tests/container-mcp.mjs,target=/app/container-mcp.mjs,readonly" \
  "$STICKER_IMAGE" /app/container-mcp.mjs <&4 >&3
docker rm -f "$project-mcp" >/dev/null
wait "$mcp_pid" 2>/dev/null || true
mcp_pid=
exec 3>&- 4>&-
}
verify_mcp
# Switch only this disposable project to an explicitly trusted deployment.
# Reuse its discovered nondefault ephemeral port so APP_ORIGIN and publication agree.
binding=$(compose port 8787)
local_port=${binding##*:}
[[ "$local_port" =~ ^[0-9]+$ && "$local_port" != 8787 ]] || { echo 'Expected nondefault fixture port.' >&2; exit 1; }
compose stop sticker
export STICKER_PORT=$local_port APP_ORIGIN="http://127.0.0.1:$local_port" LOCAL_OWNER_MODE=trusted-loopback OWNER_PASSWORD=
compose config --format json | compose run --rm --no-deps -T --entrypoint node sticker dist/server/check-local-deployment.js compose >/dev/null
compose up -d --force-recreate --wait --wait-timeout 90 sticker
started=$(compose ps -q sticker)
docker inspect --format '{"ports":{{json .NetworkSettings.Ports}},"networkMode":{{json .HostConfig.NetworkMode}}}' "$started" |
  compose run --rm --no-deps -T --entrypoint node sticker dist/server/check-local-deployment.js inspect "$local_port"
compose exec -T -e STICKER_AGENT_TOKEN sticker node --input-type=module - < tests/container-local-owner-smoke.mjs
# Same real STDIO client and scoped token must remain an agent after mode switching.
verify_mcp
printf 'Container verification passed: clean build, private API, persisted SQLite/uploads, backup/restore, trusted loopback owner and optional STDIO MCP.\n'
