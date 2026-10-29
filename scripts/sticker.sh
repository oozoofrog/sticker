#!/usr/bin/env bash
# Stable desktop/CLI access entry. Never sources .env or prints Docker config.
set -euo pipefail
verb=${1:-status}
format=${2:-}
early() {
  local error=$1 kind=$2 code=$3
  if [[ "$format" == --json ]]; then
    printf '{"schemaVersion":1,"state":"%s","containerRunning":null,"appResponse":"not_checked","browserReachability":"unverified","daemon":"unknown","url":null,"urlScope":"docker_host","reason":"%s","action":"failed","lockName":""}\n' "$kind" "$error"
  else printf '스티커 · %s\n' "$error" >&2; fi
  exit "$code"
}
if [[ $# -gt 2 || ( -n "$format" && "$format" != --json ) ]]; then early invalid_invocation unknown 64; fi
case "$verb" in status|open|start|stop) ;; *) early invalid_invocation unknown 64;; esac
script_dir=${BASH_SOURCE[0]%/*}
[[ "$script_dir" != "${BASH_SOURCE[0]}" ]] || script_dir=.
if ! cd "$script_dir/.." 2>/dev/null; then early installation_unavailable unknown 1; fi
# POSIX/older Bash can exit on a missing source special builtin even inside if.
if [[ ! -f scripts/host-tools.sh || ! -r scripts/host-tools.sh ]]; then early installation_unavailable unknown 1; fi
if ! source scripts/host-tools.sh 2>/dev/null; then early installation_unavailable unknown 1; fi
if ! sticker_require_commands access mktemp rm sleep wc cksum mkdir rmdir id cat uname >/dev/null 2>&1; then early host_tools_missing unknown 1; fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/sticker-access.XXXXXX" 2>/dev/null) || early temporary_storage_unavailable unknown 1
lock_owned=false
lock_dir=
cleanup() {
  if [[ "$lock_owned" == true ]]; then rmdir "$lock_dir" 2>/dev/null || true; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Checks only: bounded duration/output. Never kill a partially completed start verifier.
capture() {
  local child watcher result=0
  (trap - EXIT INT TERM; ulimit -f 64; exec "$@") > "$scratch/output" 2>/dev/null & child=$!
  (
    trap - EXIT INT TERM
    sleep "${capture_timeout:-5}" & timer=$!
    trap 'kill "$timer" 2>/dev/null || true; exit 0' TERM
    wait "$timer"
    kill -TERM "$child" 2>/dev/null || true
    sleep 1 & timer=$!
    wait "$timer"
    kill -KILL "$child" 2>/dev/null || true
  ) >/dev/null 2>&1 & watcher=$!
  wait "$child" 2>/dev/null || result=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  (( result == 0 )) || return 1
  [[ $(wc -c < "$scratch/output") -le 16384 ]] || return 1
  captured=$(cat "$scratch/output")
}
state=unknown running=null response=not_checked daemon=unknown url= reason=none action=none endpoint= target= project_name= lock_name=
captured=
snapshot() {
  state=unknown running=null response=not_checked daemon=unknown url= reason=none target= endpoint= project_name=
  if ! command -v docker >/dev/null 2>&1; then state=docker_missing reason=docker_missing; return; fi
  if ! capture docker version --format '{{.Server.Version}}'; then state=daemon_unavailable reason=daemon_unavailable; return; fi
  # Explicit context takes precedence over DOCKER_HOST, matching Docker CLI selection.
  if [[ -n ${DOCKER_CONTEXT:-} ]]; then
    if capture docker context inspect --format '{{.Endpoints.docker.Host}}' "$DOCKER_CONTEXT"; then endpoint=$captured; fi
  elif [[ -n ${DOCKER_HOST:-} ]]; then endpoint=$DOCKER_HOST
  elif capture docker context inspect --format '{{.Endpoints.docker.Host}}'; then endpoint=$captured
  fi
  case "$endpoint" in unix:///*) daemon=local_socket;; ssh://*|tcp://*|http://*|https://*|npipe://*) daemon=remote;; *) daemon=unknown;; esac
  if [[ "$endpoint" == *$'\n'* || "$endpoint" == *$'\r'* ]]; then daemon=unknown; fi
  if ! capture docker compose ps --all --quiet sticker; then reason=compose_unavailable; return; fi
  if [[ -z "$captured" ]]; then state=not_installed running=false reason=not_installed; return; fi
  if [[ ! "$captured" =~ ^[a-f0-9]{64}$ ]]; then reason=metadata_invalid; return; fi
  target=$captured
  if ! capture docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$target"; then reason=metadata_invalid; return; fi
  if [[ ! "$captured" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then reason=metadata_invalid; return; fi
  project_name=$captured
  if ! capture docker inspect --format '{{.State.Status}}' "$target"; then reason=container_state; return; fi
  case "$captured" in
    exited|created|dead) state=stopped running=false reason=stopped; return;;
    running) running=true;;
    restarting) state=starting running=true reason=container_state; return;;
    *) reason=container_state; return;;
  esac
  local origin ports host port origin_port
  if ! capture docker inspect --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "APP_ORIGIN"}}{{println .}}{{end}}{{end}}' "$target"; then reason=metadata_invalid; return; fi
  [[ "$captured" == APP_ORIGIN=* ]] || { reason=metadata_invalid; return; }
  origin=${captured#APP_ORIGIN=}
  # Only exact browser origins on the verified local deployment surface are openable.
  if [[ ! "$origin" =~ ^http://(localhost|127\.0\.0\.1)(:([1-9][0-9]{0,4}))?$ ]]; then reason=metadata_invalid; return; fi
  host=${BASH_REMATCH[1]}; origin_port=${BASH_REMATCH[3]:-80}
  (( origin_port <= 65535 )) || { reason=metadata_invalid; return; }
  if ! capture docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{println $port .HostIp .HostPort}}{{end}}{{end}}' "$target"; then reason=metadata_invalid; return; fi
  ports=$captured
  if [[ ! "$ports" =~ ^8787/tcp\ 127\.0\.0\.1\ ([1-9][0-9]{0,4})$ ]]; then reason=metadata_invalid; return; fi
  port=${BASH_REMATCH[1]}
  if (( port > 65535 || port != origin_port )); then reason=origin_mismatch; return; fi
  url=$origin
  if capture docker exec "$target" node -e 'fetch("http://127.0.0.1:8787/healthz",{signal:AbortSignal.timeout(2000),redirect:"error"}).then(async r=>{if(!r.ok||(await r.json()).status!=="ok")process.exit(1);console.log("ok")}).catch(()=>process.exit(1))' && [[ "$captured" == ok ]]; then
    state=ready response=verified reason=none
  else state=starting response=unavailable reason=health_unavailable
  fi
}
print_result() {
  if [[ "$format" == --json ]]; then
    local json_url=null
    [[ -z "$url" ]] || json_url="\"$url\""
    printf '{"schemaVersion":1,"state":"%s","containerRunning":%s,"appResponse":"%s","browserReachability":"unverified","daemon":"%s","url":%s,"urlScope":"docker_host","reason":"%s","action":"%s","lockName":"%s"}\n' "$state" "$running" "$response" "$daemon" "$json_url" "$reason" "$action" "$lock_name"
  else
    local label
    case "$state" in ready) label='앱 응답 확인';; starting) label='준비 중';; stopped) label='중지됨';; not_installed) label='설치 안 됨';; docker_missing) label='Docker 없음';; daemon_unavailable) label='Docker 연결 불가';; *) label='미확인';; esac
    printf '스티커 · %s\n' "$label"
    [[ -z "$url" ]] || printf '%s (Docker 호스트 주소 · 브라우저 접근 미확인)\n' "$url"
    [[ "$reason" == none ]] || printf '상태 코드: %s\n' "$reason"
    [[ -z "$lock_name" ]] || printf '제어 잠금: %s/%s\n' "/tmp" "$lock_name"
  fi
}
finish() { print_result; exit "$1"; }
# Freeze implicit context selection for this invocation, not the user's global config.
if command -v docker >/dev/null 2>&1 && [[ -z ${DOCKER_CONTEXT:-}${DOCKER_HOST:-} ]]; then
  if capture docker context show && [[ -n "$captured" && "$captured" != *$'\n'* && "$captured" != *$'\r'* ]]; then
    export DOCKER_CONTEXT=$captured
  else reason=context_unavailable; action=failed; finish 1
  fi
fi
snapshot
initial_project=$project_name
# An existing target supplies its actual Compose project name without parsing .env.
[[ -z "$initial_project" ]] || export COMPOSE_PROJECT_NAME=$initial_project
if [[ "$verb" == status ]]; then
  case "$state" in unknown|docker_missing|daemon_unavailable) finish 1;; *) finish 0;; esac
fi
if [[ "$verb" == open ]]; then
  [[ "$state" == ready && -n "$url" ]] || { action=failed; finish 3; }
  if [[ "$daemon" != local_socket ]]; then
    action=failed; reason=remote_daemon
    [[ "$daemon" != unknown ]] || reason=daemon_unknown
    finish 3
  fi
  if [[ ${STICKER_OPEN_BROWSER:-1} == 0 ]]; then action=url_only reason=headless; finish 0; fi
  opener=
  if [[ $(uname -s) == Darwin ]] && command -v open >/dev/null 2>&1; then opener=open
  elif [[ -n ${DISPLAY:-}${WAYLAND_DISPLAY:-} ]] && command -v xdg-open >/dev/null 2>&1; then opener=xdg-open
  fi
  if [[ -z "$opener" ]]; then action=url_only reason=opener_unavailable; finish 0; fi
  # An opener can become the browser process. Do not inherit probe file limits
  # or kill it on a query timeout. "opened" means dispatched, never verified.
  "$opener" "$url" >/dev/null 2>&1 & opener_pid=$!
  sleep 1
  if ! kill -0 "$opener_pid" 2>/dev/null; then
    if ! wait "$opener_pid"; then action=failed reason=opener_failed; finish 1; fi
  fi
  action=opened; finish 0
fi
if [[ "$state" == docker_missing || "$state" == daemon_unavailable || "$reason" == compose_unavailable || "$daemon" == unknown ]]; then action=failed; finish 1; fi
# Serialize this user's mutations on the selected daemon, including first deployment.
# This is deliberately more conservative than per-container locking during creation.
if ! capture docker info --format '{{.ID}}' || [[ ! "$captured" =~ ^[A-Za-z0-9:-]{8,128}$ ]]; then
  state=unknown running=null response=not_checked url= action=failed reason=daemon_identity_unavailable; finish 1
fi
daemon_id=$captured
key=$(printf '%s' "$daemon_id" | cksum); key=${key%% *}
lock_name="sticker-control-$(id -u)-$key"
lock_dir="/tmp/$lock_name"
if ! (umask 077; mkdir "$lock_dir") 2>/dev/null; then action=busy reason=mutation_busy; finish 75; fi
lock_owned=true
old_target=$target
old_endpoint=$endpoint
if ! capture docker info --format '{{.ID}}' || [[ "$captured" != "$daemon_id" ]]; then
  state=unknown running=null response=not_checked url= action=failed reason=daemon_identity_unavailable; finish 1
fi
snapshot
if [[ "$target" != "$old_target" || "$endpoint" != "$old_endpoint" ]]; then action=failed reason=target_changed; finish 1; fi
if [[ "$verb" == stop ]]; then
  if [[ "$state" == not_installed || "$state" == stopped ]]; then action=stopped; finish 0; fi
  [[ -n "$target" ]] || { action=failed reason=mutation_failed; finish 1; }
  # Stop only the ID selected from this project's sticker service; never down/rm/prune.
  if ! capture_timeout=40 capture docker stop --time 30 "$target"; then snapshot; action=failed reason=mutation_failed; finish 1; fi
  snapshot; action=stopped
  [[ "$state" == stopped ]] || { action=failed reason=mutation_failed; finish 1; }
  finish 0
fi
if [[ "$running" == true ]]; then
  [[ "$state" != unknown ]] || { action=failed; finish 1; }
  action=none; finish 0
fi
if [[ "$state" != stopped && "$state" != not_installed ]]; then action=failed reason=mutation_failed; finish 1; fi
# Keep the existing Engine, resolved Compose and post-start publication gates intact.
if ! bash scripts/start.sh >&2; then snapshot; action=failed reason=mutation_failed; finish 1; fi
action=started
# SECONDS is Bash-provided; no host Node/Python/curl requirement.
deadline=$((SECONDS + 30))
while :; do
  snapshot
  if [[ "$endpoint" != "$old_endpoint" || ( -n "$initial_project" && "$project_name" != "$initial_project" ) ]]; then action=failed reason=target_changed; finish 1; fi
  [[ "$state" != ready ]] || finish 0
  if (( SECONDS >= deadline )); then reason=readiness_timeout; finish 1; fi
  sleep 1
done
