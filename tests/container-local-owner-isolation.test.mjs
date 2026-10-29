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
test("disposable container verification disables inherited trusted-owner configuration", () => {
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
    printf '%s' "\${LOCAL_OWNER_MODE-}" > "$FIXTURE_ENV_LOG"
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
          LOCAL_OWNER_MODE: "trusted-loopback",
          FIXTURE_ENV_LOG: log,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 73, result.stderr);
    assert.equal(readFileSync(log, "utf8"), "off");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted fixture discovers the published port with the service and private port arguments", () => {
  const script = readFileSync("scripts/verify-container.sh", "utf8");
  assert.match(script, /binding=\$\(compose port sticker 8787\)/);
});

test("trusted lifecycle exercises the default launcher rather than opting in before startup", () => {
  const script = readFileSync("scripts/verify-container.sh", "utf8");
  assert.match(script, /LOCAL_OWNER_MODE=off bash scripts\/start\.sh/);
  assert.match(
    script,
    /export LOCAL_OWNER_MODE=trusted-loopback\n[^\n]*\ncompose up -d --no-recreate --wait --wait-timeout 90 sticker/,
  );
  assert.ok(
    script.indexOf("LOCAL_OWNER_MODE=off bash scripts/start.sh") <
      script.indexOf("export LOCAL_OWNER_MODE=trusted-loopback"),
  );
});
