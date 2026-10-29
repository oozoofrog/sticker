import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
test("disposable container verification disables inherited GitHub provider configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "sticker-provider-isolation-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "bin"));
    for (const name of ["verify-container.sh", "host-tools.sh"])
      copyFileSync(`scripts/${name}`, join(root, "scripts", name));
    writeFileSync(
      join(root, "bin/docker"),
      `#!/bin/bash
if [[ "$1" == compose ]]; then
  shift
  if [[ "\${1:-}" == --env-file ]]; then shift 2; fi
  if [[ "\${1:-}" == config ]]; then
    printf '%s|%s' "\${GITHUB_READ_ENABLED-}" "\${GITHUB_CREDENTIAL_CONFIG_PATH-}" > "$FIXTURE_ENV_LOG"
    exit 73 # Stop at configuration boundary, before any build/network/data access.
  fi
fi
exit 0
`,
      { mode: 0o755 },
    );
    const log = join(root, "provider-env");
    const result = spawnSync(
      "bash",
      [join(root, "scripts/verify-container.sh")],
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          GITHUB_READ_ENABLED: "true",
          GITHUB_CREDENTIAL_CONFIG_PATH: "/fixture-only/do-not-read",
          FIXTURE_ENV_LOG: log,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 73, result.stderr);
    assert.equal(readFileSync(log, "utf8"), "false|");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
