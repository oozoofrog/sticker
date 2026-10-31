#!/usr/bin/env bash
# Restore only an archive made by backup.sh. Service remains stopped on any failure.
set -euo pipefail
script_dir=${BASH_SOURCE[0]%/*}
[[ "$script_dir" != "${BASH_SOURCE[0]}" ]] || script_dir=.
source "$script_dir/host-tools.sh"
sticker_require_commands restore docker tar grep awk
cd "$script_dir/.."
if [[ $# -ne 2 || "$2" != "--replace-data" ]]; then
  echo "Usage: bash scripts/restore.sh <trusted-backup.tar.gz> --replace-data" >&2
  echo "This replaces every issue and attachment. Back up existing data first." >&2
  exit 2
fi
archive=$1
[[ -f "$archive" ]] || { echo "Backup not found: $archive" >&2; exit 1; }
# Restrict to SQLite files and opaque attachment names; reject traversal and links.
# No original user filename is used as a storage path.
listing=$(tar -tzf "$archive")
while IFS= read -r entry; do
  if [[ ! "$entry" =~ ^\./$ && ! "$entry" =~ ^\./sticker\.sqlite(-wal|-shm)?$ && ! "$entry" =~ ^\./uploads/$ && ! "$entry" =~ ^\./uploads/[a-zA-Z0-9_-]+$ ]]; then
    echo "Unsafe or unrecognized archive member: $entry" >&2; exit 1
  fi
done <<< "$listing"
printf '%s\n' "$listing" | grep -qx './sticker.sqlite' || { echo 'Archive has no sticker.sqlite' >&2; exit 1; }
tar -tvzf "$archive" | awk 'substr($1,1,1)!="-" && substr($1,1,1)!="d" {bad=1} END {exit bad}' || { echo 'Archive contains unsupported links/devices' >&2; exit 1; }
# Explicit --replace-data is the required confirmation. Never restore into a live DB.
docker compose stop -t 30 sticker >&2
# The trusted in-container command is fixed; no archive-controlled text becomes shell code.
docker compose run --rm --no-deps -T --entrypoint sh sticker -c '
  set -eu
  stage=$(mktemp -d /app/data/.restore.XXXXXX)
  trap "rm -rf -- \"$stage\"" EXIT
  tar --no-same-owner --no-same-permissions -xzf - -C "$stage"
  node dist/server/backup-validation.js "$stage"
  # Separate restore-only transaction: never revive restored managed authority.
  node dist/server/client-grants-restore.js "$stage"
  find /app/data -mindepth 1 -maxdepth 1 ! -path "$stage" -exec rm -rf -- {} +
  find "$stage" -mindepth 1 -maxdepth 1 -exec mv -- {} /app/data/ \;
' < "$archive"
echo 'Restore finished. Service is stopped; inspect the result, then run: docker compose up -d'
