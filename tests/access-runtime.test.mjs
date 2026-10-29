import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const id = "a".repeat(64);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sticker access '한$`-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  for (const file of ["sticker.sh", "host-tools.sh"])
    cpSync(resolve("scripts", file), join(root, "scripts", file));
  const log = join(root, "calls");
  const state = join(root, "state");
  writeFileSync(state, "running");
  writeFileSync(
    join(root, "scripts/start.sh"),
    `#!/bin/bash\nprintf running > "$FIXTURE_STATE"\nprintf 'start\\n' >> "$FIXTURE_LOG"\n`,
  );
  writeFileSync(
    join(root, "bin/docker"),
    `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),e=process.env;fs.appendFileSync(e.FIXTURE_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='version'){if(e.HANG){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}if(e.DAEMON_FAIL)process.exit(1);console.log('29.9.2');}
else if(a[0]==='info'){if(e.IDENTITY_FAIL)process.exit(1);console.log(e.DAEMON_ID||e.FIXTURE_STATE.replace(/[^a-zA-Z0-9]/g,''));}
else if(a[0]==='context'){if(a[1]==='show')console.log('fixture-context');else console.log(e.ENDPOINT||('unix://'+e.FIXTURE_STATE));}
else if(a[0]==='compose'&&a[1]==='ps'){if(!e.MISSING)console.log('${id}');}
else if(a[0]==='inspect'){const f=a[2];if(f.includes('.Config.Labels'))console.log('fixture-project');else if(f.includes('.State.Status'))console.log(fs.readFileSync(e.FIXTURE_STATE,'utf8'));else if(f.includes('.Config.Env'))console.log(e.ORIGIN||'APP_ORIGIN=http://localhost:9876');else if(f.includes('.NetworkSettings.Ports'))console.log(e.PORTS||'8787/tcp 127.0.0.1 9876');}
else if(a[0]==='exec'){if(e.HEALTH_FAIL)process.exit(1);console.log('ok');}
else if(a[0]==='stop'){fs.writeFileSync(e.FIXTURE_STATE,'exited');if(e.STOP_FAIL)process.exit(1);}
else process.exit(1);
`,
    { mode: 0o755 },
  );
  const run = (verb, env = {}) => {
    const result = spawnSync(
      "bash",
      [join(root, "scripts/sticker.sh"), verb, "--json"],
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          PATH: join(root, "bin") + ":" + process.env.PATH,
          TMPDIR: root,
          DOCKER_HOST: "",
          DOCKER_CONTEXT: "",
          FIXTURE_LOG: log,
          FIXTURE_STATE: state,
          STICKER_OPEN_BROWSER: "0",
          ...env,
        },
        encoding: "utf8",
      },
    );
    return { ...result, value: JSON.parse(result.stdout) };
  };
  return {
    root,
    run,
    log,
    state,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("status verifies internal health and exact publication without service mutation; open is headless only", () => {
  const f = fixture();
  try {
    const s = f.run("status");
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.value.state, "ready");
    assert.equal(s.value.url, "http://localhost:9876");
    assert.equal(s.value.browserReachability, "unverified");
    assert.equal(f.run("open").value.action, "url_only");
    assert.ok(!readFileSync(f.log, "utf8").includes('"stop"'));
    assert.ok(!readFileSync(f.log, "utf8").includes("start\n"));
  } finally {
    f.close();
  }
});
test("HTTP failure, remote transport, invalid metadata and stopped state never open or invent readiness", () => {
  const f = fixture();
  try {
    assert.equal(f.run("status", { HEALTH_FAIL: "1" }).value.state, "starting");
    const remote = f.run("open", { ENDPOINT: "ssh://remote" });
    assert.equal(remote.status, 3);
    assert.equal(remote.value.reason, "remote_daemon");
    for (const env of [
      { ORIGIN: "APP_ORIGIN=http://evil.test:9876" },
      { PORTS: "8787/tcp 0.0.0.0 9876" },
      { ORIGIN: "APP_ORIGIN=http://localhost:9877" },
    ]) {
      const s = f.run("status", env);
      assert.equal(s.value.state, "unknown");
      assert.equal(s.value.url, null);
    }
    writeFileSync(f.state, "exited");
    assert.equal(f.run("open").value.state, "stopped");
    assert.equal(
      f.run("status", { MISSING: "1" }).value.state,
      "not_installed",
    );
    assert.equal(
      f.run("status", { DAEMON_FAIL: "1" }).value.state,
      "daemon_unavailable",
    );
  } finally {
    f.close();
  }
});
test("explicit stop affects only inspected target, running start is no-op and stopped start delegates verified launcher", () => {
  const f = fixture();
  try {
    assert.equal(f.run("start").value.state, "ready");
    assert.ok(!readFileSync(f.log, "utf8").includes("start\n"));
    const stopped = f.run("stop");
    assert.equal(stopped.value.state, "stopped");
    assert.ok(
      readFileSync(f.log, "utf8").includes(
        '["stop","--time","30","' + id + '"]',
      ),
    );
    const started = f.run("start");
    assert.equal(started.value.action, "started");
    assert.equal(started.value.state, "ready");
    assert.ok(readFileSync(f.log, "utf8").includes("start\n"));
  } finally {
    f.close();
  }
});

test("stale mutation lock is reported without stealing it and explicit stop still works with invalid URL metadata", () => {
  const f = fixture();
  try {
    const stopped = f.run("stop", { ORIGIN: "APP_ORIGIN=http://evil.test" });
    assert.equal(stopped.value.state, "stopped");
    assert.match(stopped.value.lockName, /^sticker-control-[0-9]+-[0-9]+$/);
    const lock = join("/tmp", stopped.value.lockName);
    mkdirSync(lock);
    const busy = f.run("start");
    assert.equal(busy.status, 75);
    assert.equal(busy.value.action, "busy");
    assert.ok(existsSync(lock));
    assert.equal(readFileSync(f.state, "utf8"), "exited");
    rmSync(lock, { recursive: true });
  } finally {
    f.close();
  }
});
test("opening uses a validated argv URL only, never sources .env, and respects explicit remote context", () => {
  const f = fixture();
  try {
    const marker = join(f.root, "executed");
    writeFileSync(join(f.root, ".env"), 'touch "' + marker + '"\n');
    writeFileSync(
      join(f.root, "bin/xdg-open"),
      '#!/bin/bash\nprintf "%s" "$1" > "$FIXTURE_OPEN"\n',
      { mode: 0o755 },
    );
    const opened = f.run("open", {
      DISPLAY: ":fixture",
      STICKER_OPEN_BROWSER: "1",
      FIXTURE_OPEN: marker,
    });
    assert.equal(opened.value.action, "opened");
    assert.equal(readFileSync(marker, "utf8"), "http://localhost:9876");
    rmSync(marker);
    const bad = f.run("open", {
      ORIGIN: "APP_ORIGIN=http://localhost:9876/$(touch owned)",
      DISPLAY: ":fixture",
      STICKER_OPEN_BROWSER: "1",
      FIXTURE_OPEN: marker,
    });
    assert.equal(bad.status, 3);
    assert.ok(!existsSync(marker));
    const remote = f.run("open", {
      DOCKER_CONTEXT: "remote-choice",
      DOCKER_HOST: "unix:///ignored",
      ENDPOINT: "ssh://chosen",
      DISPLAY: ":fixture",
      STICKER_OPEN_BROWSER: "1",
      FIXTURE_OPEN: marker,
    });
    assert.equal(remote.value.daemon, "remote");
    assert.equal(remote.value.reason, "remote_daemon");
    assert.ok(!existsSync(marker));
  } finally {
    f.close();
  }
});
test("a Docker query that ignores TERM is bounded and never produces ready", () => {
  const f = fixture();
  try {
    const before = Date.now();
    const result = f.run("status", { HANG: "1" });
    assert.equal(result.status, 1);
    assert.equal(result.value.state, "daemon_unavailable");
    assert.ok(Date.now() - before < 9000);
  } finally {
    f.close();
  }
});

test("invalid JSON invocation returns the stable error envelope without touching Docker", () => {
  const f = fixture();
  try {
    const r = f.run("destroy");
    assert.equal(r.status, 64);
    assert.equal(r.value.reason, "invalid_invocation");
    assert.ok(!existsSync(f.log));
  } finally {
    f.close();
  }
});
test("OS opener does not inherit Docker probe file limits or browser-killing watchdog", () => {
  const f = fixture();
  try {
    const profile = join(f.root, "opener-output");
    writeFileSync(
      join(f.root, "bin/xdg-open"),
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.FIXTURE_OPEN,Buffer.alloc(70000,1));\n',
      { mode: 0o755 },
    );
    const result = f.run("open", {
      DISPLAY: ":fixture",
      STICKER_OPEN_BROWSER: "1",
      FIXTURE_OPEN: profile,
    });
    assert.equal(result.value.action, "opened");
    assert.equal(readFileSync(profile).length, 70000);
  } finally {
    f.close();
  }
});

test("ambiguous failed stop never returns the old verified-ready snapshot", () => {
  const f = fixture();
  try {
    const result = f.run("stop", { STOP_FAIL: "1" });
    assert.equal(result.status, 1);
    assert.equal(result.value.action, "failed");
    assert.equal(result.value.state, "stopped");
    assert.equal(result.value.containerRunning, false);
    assert.equal(result.value.appResponse, "not_checked");
  } finally {
    f.close();
  }
});
test("temporary storage failure still emits a sanitized JSON error", () => {
  const f = fixture();
  try {
    const result = f.run("status", { TMPDIR: join(f.root, "absent") });
    assert.equal(result.status, 1);
    assert.equal(result.value.reason, "temporary_storage_unavailable");
    assert.equal(result.value.state, "unknown");
    assert.ok(!result.stderr.includes(f.root));
  } finally {
    f.close();
  }
});
test("aliases of one reported Docker daemon share mutation locks and unknown daemon identity fails closed", () => {
  const f = fixture();
  let lock;
  try {
    const stopped = f.run("stop", {
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
    lock = join("/tmp", stopped.value.lockName);
    mkdirSync(lock);
    const other = f.run("start", { DOCKER_HOST: "unix:///run/docker.sock" });
    assert.equal(other.status, 75);
    assert.equal(other.value.lockName, stopped.value.lockName);
    assert.equal(readFileSync(f.state, "utf8"), "exited");
    const unknown = f.run("start", { IDENTITY_FAIL: "1" });
    assert.equal(unknown.status, 1);
    assert.equal(unknown.value.reason, "daemon_identity_unavailable");
    assert.equal(readFileSync(f.state, "utf8"), "exited");
  } finally {
    if (lock) rmSync(lock, { recursive: true, force: true });
    f.close();
  }
});

test("missing installation helper returns JSON without exposing its path", () => {
  const f = fixture();
  try {
    rmSync(join(f.root, "scripts/host-tools.sh"));
    const result = f.run("status");
    assert.equal(result.status, 1);
    assert.equal(result.value.reason, "installation_unavailable");
    assert.ok(!result.stderr.includes(f.root));
  } finally {
    f.close();
  }
});

test("POSIX Bash missing helper emits JSON before the special builtin can terminate the shell", () => {
  const f = fixture();
  try {
    rmSync(join(f.root, "scripts/host-tools.sh"));
    const result = spawnSync(
      "bash",
      ["--posix", join(f.root, "scripts/sticker.sh"), "status", "--json"],
      { encoding: "utf8", env: process.env },
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^\{"schemaVersion":1,/);
    const value = JSON.parse(result.stdout);
    assert.equal(value.reason, "installation_unavailable");
    assert.equal(value.state, "unknown");
    assert.equal(value.action, "failed");
    assert.ok(!result.stderr.includes(f.root));
    assert.equal(existsSync(f.log), false);
  } finally {
    f.close();
  }
});
