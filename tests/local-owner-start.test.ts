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
    for (const name of ["start-local-owner.sh", "host-tools.sh"])
      copyFileSync(join("scripts", name), join(root, "scripts", name));
    writeFileSync(
      join(root, "bin", "docker"),
      `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='compose'&&args[1]==='ps'){if(process.env.EXISTING==='yes')process.stdout.write('existing-service\\n');else if(fs.existsSync(process.env.STARTED))process.stdout.write('started-fixture\\n');}
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
      const result = spawnSync(
        "bash",
        [join(root, "scripts", "start-local-owner.sh")],
        {
          env: {
            ...process.env,
            PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
            FIXTURE_LOG: log,
            STARTED: join(root, "started"),
            ...flags,
          },
          encoding: "utf8",
        },
      );
      return { result, calls: readFileSync(log, "utf8") };
    };
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
