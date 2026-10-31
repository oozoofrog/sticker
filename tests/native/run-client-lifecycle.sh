#!/bin/bash
set -euo pipefail
[[ $(uname -s) = Darwin && $# = 1 && "$1" = /Volumes/eyedisk/* ]] || { echo 'macOS and explicit Eyedisk output directory required' >&2; exit 1; }
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
OUT=$1
umask 077
mkdir -p "$OUT/module-cache"
for required in LifecycleTypes.swift ClientProfiles.swift; do
  [[ -f "$ROOT/packaging/macos/client-lifecycle/$required" ]] || { echo "FAIL missing implementation $required" >&2; exit 1; }
done
TASK_FLAGS=(-DTASK1)
if [[ -f "$ROOT/tests/native/client-lifecycle/PlanTests.swift" ]]; then TASK_FLAGS=(-DTASK2); for required in OwnedConnectionStore.swift ConnectionPlanner.swift; do [[ -f "$ROOT/packaging/macos/client-lifecycle/$required" ]] || { echo "FAIL missing implementation $required" >&2; exit 1; }; done; fi
if [[ -f "$ROOT/tests/native/client-lifecycle/WriterGateTests.swift" ]]; then TASK_FLAGS=(-DTASK3 -DTASK2); for required in VersionedWriter.swift CodexAppServerWriter.swift; do [[ -f "$ROOT/packaging/macos/client-lifecycle/$required" ]] || { echo "FAIL missing implementation $required" >&2; exit 1; }; done; fi
if [[ -f "$ROOT/tests/native/client-lifecycle/TransactionTests.swift" ]]; then TASK_FLAGS=(-DTASK4 -DTASK3 -DTASK2); [[ -f "$ROOT/packaging/macos/client-lifecycle/NativeConnectionManager.swift" ]] || { echo "FAIL missing implementation NativeConnectionManager.swift" >&2; exit 1; }; fi
/usr/bin/xcrun swiftc -swift-version 5 -parse-as-library -target "$(uname -m)-apple-macosx11.3" -module-cache-path "$OUT/module-cache" "${TASK_FLAGS[@]}" "$ROOT"/packaging/macos/client-lifecycle/*.swift "$ROOT"/tests/native/client-lifecycle/*.swift -o "$OUT/native-client-lifecycle-tests"
"$OUT/native-client-lifecycle-tests" "$ROOT/tests/fixtures/native-client-lifecycle/wire-cases.json" "$OUT"
