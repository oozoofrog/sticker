#!/usr/bin/env bash
# Standard local install: deliberately chooses passwordless local-owner access.
# This overrides LOCAL_OWNER_MODE from the shell/.env for this invocation only.
# Raw server/Compose startup remains password-authenticated by default.
set -euo pipefail
script_dir=${BASH_SOURCE[0]%/*}
[[ "$script_dir" != "${BASH_SOURCE[0]}" ]] || script_dir=.
export LOCAL_OWNER_MODE=trusted-loopback
exec bash "$script_dir/start-local-owner.sh"
