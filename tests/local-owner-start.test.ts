import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
void test("verified start never stops pre-existing service or failed preflight; only its started target is stopped on mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "local-start-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "bin"));
    for (const name of ["start.sh", "start-local-owner.sh", "host-tools.sh"])
      copyFileSync(join("scripts", name), join(root, "scripts", name));
    writeFileSync(
      join(root, "bin", "docker"),
      `#!/usr/bin/env node
if(process.env.LOCAL_OWNER_MODE!=='trusted-loopback')process.exit(76);if(process.env.COMPOSE_FILE!=='compose.yaml:compose.agents.yaml')process.exit(77);const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='version'){if(process.env.ENGINE_FAIL==='yes')process.exitCode=1;else process.stdout.write(process.env.ENGINE_VERSION??'28.3.3');}
else if(args[0]==='compose'&&args[1]==='ps'){if(process.env.EXISTING==='yes')process.stdout.write('existing-service\\n');else if(fs.existsSync(process.env.STARTED))process.stdout.write('started-fixture\\n');}
else if(args[0]==='compose'&&args[1]==='config')process.stdout.write('{}');
else if(args[0]==='compose'&&args[1]==='run'){fs.readFileSync(0);if(args.at(-1)==='compose'){if(process.env.BAD_CONFIG==='yes')process.exitCode=1;else process.stdout.write('9876\\n');}else if(process.env.BAD_INSPECTION==='yes')process.exitCode=1;}
else if(args[0]==='compose'&&args[1]==='up')fs.writeFileSync(process.env.STARTED,'yes');
else if(args[0]==='inspect')process.stdout.write('{}');
`,
      { mode: 0o755 },
    );
    const run = (flags: Record<string, string>) => {
      const log = join(root, "calls");
      writeFileSync(log, "");
      rmSync(join(root, "started"), { force: true });
      const result = spawnSync("bash", [join(root, "scripts", "start.sh")], {
        env: {
          ...process.env,
          LOCAL_OWNER_MODE: "off",
          COMPOSE_FILE: "compose.yaml:compose.agents.yaml",
          OWNER_PASSWORD: "",
          PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
          FIXTURE_LOG: log,
          STARTED: join(root, "started"),
          ...flags,
        },
        encoding: "utf8",
      });
      return { result, calls: readFileSync(log, "utf8") };
    };
    for (const version of [
      "27.5.1",
      "28.0.0",
      "28.3.2",
      "28.3.3-rc.1",
      "28.3.3+vendor",
      "unknown",
      "",
      "028.3.3",
      "999999999999999999.0.0",
    ]) {
      const denied = run({ ENGINE_VERSION: version });
      assert.notEqual(denied.result.status, 0, version);
      assert.ok(!denied.calls.includes('"build"'), version);
      assert.ok(!denied.calls.includes('"up"'), version);
      assert.ok(!denied.calls.includes('"stop"'), version);
    }
    const unavailable = run({ ENGINE_FAIL: "yes" });
    assert.notEqual(unavailable.result.status, 0);
    assert.ok(!unavailable.calls.includes('"build"'));
    for (const version of ["28.3.3", "28.4.0", "29.0.0"]) {
      const supported = run({ ENGINE_VERSION: version });
      assert.equal(supported.result.status, 0, supported.result.stderr);
      assert.ok(
        supported.calls.includes(
          '["version","--format","{{.Server.Version}}"]',
        ),
      );
    }
    const existing = run({ EXISTING: "yes" });
    assert.notEqual(existing.result.status, 0);
    assert.ok(!existing.calls.includes('"stop"'));
    assert.ok(!existing.calls.includes('"build"'));
    const bad = run({ BAD_CONFIG: "yes" });
    assert.notEqual(bad.result.status, 0);
    assert.ok(!bad.calls.includes('"up"'));
    assert.ok(!bad.calls.includes('"stop"'));
    const mismatch = run({ BAD_INSPECTION: "yes" });
    assert.notEqual(mismatch.result.status, 0);
    assert.ok(mismatch.calls.includes('["stop","started-fixture"]'));
    assert.ok(!mismatch.calls.includes("existing-service"));
    const success = run({});
    assert.equal(success.result.status, 0, success.result.stderr);
    assert.ok(!success.calls.includes('"stop"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
