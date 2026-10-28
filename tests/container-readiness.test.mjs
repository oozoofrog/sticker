import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("verification waits for healthy service after backup restarts before its next HTTP mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "sticker-readiness-"));
  try {
    for (const directory of ["scripts", "tests", "bin", "source"])
      mkdirSync(join(root, directory));
    for (const name of [
      "verify-container.sh",
      "backup.sh",
      "host-tools.sh",
      "container-toolchain.sh",
    ])
      copyFileSync(`scripts/${name}`, join(root, "scripts", name));
    copyFileSync("Dockerfile", join(root, "Dockerfile"));
    copyFileSync(
      "tests/container-smoke.mjs",
      join(root, "tests/container-smoke.mjs"),
    );
    copyFileSync(
      "tests/container-release-smoke.mjs",
      join(root, "tests/container-release-smoke.mjs"),
    );
    copyFileSync(
      "tests/container-views-smoke.mjs",
      join(root, "tests/container-views-smoke.mjs"),
    );
    copyFileSync(
      "tests/container-templates-smoke.mjs",
      join(root, "tests/container-templates-smoke.mjs"),
    );
    copyFileSync(
      "tests/container-github-smoke.mjs",
      join(root, "tests/container-github-smoke.mjs"),
    );
    copyFileSync(
      "tests/container-resources-smoke.mjs",
      join(root, "tests/container-resources-smoke.mjs"),
    );
    copyFileSync(
      "tests/container-history-smoke.mjs",
      join(root, "tests/container-history-smoke.mjs"),
    );
    writeFileSync(
      join(root, "source/sticker.sqlite"),
      "Fixture archive; not restored in this test",
    );
    execFileSync("tar", [
      "-czf",
      join(root, "fixture.tar.gz"),
      "-C",
      join(root, "source"),
      ".",
    ]);
    writeFileSync(
      join(root, "bin/docker"),
      `#!/bin/bash
set -eu
if [[ "$1" == compose ]]; then
  shift
  if [[ "\${1:-}" == --env-file ]]; then shift 2; fi
  action=$1; shift
  case "$action" in
    ps) printf 'fixture-container\\n';;
    stop) printf stopped > "$FIXTURE_STATE";;
    start) printf starting > "$FIXTURE_STATE";;
    up) for argument in "$@"; do if [[ "$argument" == --wait ]]; then printf healthy > "$FIXTURE_STATE"; fi; done;;
    run) cat "$FIXTURE_ARCHIVE";;
    exec)
      if [[ "\${!#}" == mutate ]]; then
        state=$(cat "$FIXTURE_STATE")
        printf '%s' "$state" > "$FIXTURE_MUTATION_STATE"
        if [[ "$state" != healthy ]]; then echo 'HTTP attempted before health readiness' >&2; exit 42; fi
        exit 73 # Intentional boundary: test stops before restore/MCP, not an integration pass.
      fi;;
  esac
elif [[ "$1" == run ]]; then
  for argument in "$@"; do if [[ "$argument" == --test ]]; then exit 0; fi; done
  printf 'fixture-only-disposable-generated-password'
fi
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      "bash",
      [join(root, "scripts/verify-container.sh")],
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          TMPDIR: root,
          FIXTURE_STATE: join(root, "state"),
          FIXTURE_MUTATION_STATE: join(root, "mutation-state"),
          FIXTURE_ARCHIVE: join(root, "fixture.tar.gz"),
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 73, result.stderr);
    assert.equal(readFileSync(join(root, "mutation-state"), "utf8"), "healthy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
