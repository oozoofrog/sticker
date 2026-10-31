import { z } from "zod";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store } from "../server/domain.js";
import { randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

// Docker is NOT executed. This fixture verifies shell orchestration and runs the exact
// fixed restore command against a temporary directory, standing in for the data volume.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sticker-install-"));
  for (const name of ["scripts", "bin", "data", "source"])
    mkdirSync(join(dir, name));
  for (const name of ["backup.sh", "restore.sh", "host-tools.sh"])
    copyFileSync(
      join(process.cwd(), "scripts", name),
      join(dir, "scripts", name),
    );
  writeFileSync(
    join(dir, "bin", "docker"),
    `#!/usr/bin/env node
const fs=require('node:fs'), cp=require('node:child_process');
const args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n');
if(args[1]==='ps'){if(process.env.FIXTURE_RUNNING==='yes')process.stdout.write('fixture-container\\n');}
else if(args[1]==='run'){
  const ep=args.indexOf('--entrypoint');
  if(args[ep+1]==='tar')process.stdout.write(fs.readFileSync(process.env.FIXTURE_ARCHIVE));
  else if(args[ep+1]==='sh'){
    const command=args[args.indexOf('-c')+1].replaceAll('/app/data',process.env.FIXTURE_DATA).replace('node dist/server/backup-validation.js',process.env.FIXTURE_VALIDATOR).replace('node dist/server/client-grants-restore.js',process.env.FIXTURE_GRANT_INVALIDATOR);
    const result=cp.spawnSync('sh',['-c',command],{input:fs.readFileSync(0),stdio:['pipe','inherit','inherit']});
    process.exitCode=result.status??1;
  }
}
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${join(dir, "bin")}:${String(process.env.PATH)}`,
    FIXTURE_LOG: join(dir, "docker.log"),
    FIXTURE_DATA: join(dir, "data"),
    FIXTURE_ARCHIVE: join(dir, "input.tar.gz"),
    FIXTURE_RUNNING: "yes",
    FIXTURE_GRANT_INVALIDATOR: `node --import ${join(process.cwd(), "node_modules/tsx/dist/loader.mjs")} ${join(process.cwd(), "server/client-grants-restore.ts")}`,
    FIXTURE_VALIDATOR: `node --import ${join(process.cwd(), "node_modules/tsx/dist/loader.mjs")} ${join(process.cwd(), "server/backup-validation.ts")}`,
  };
  return {
    dir,
    env,
    run: (script: string, args: string[] = []) =>
      spawnSync("bash", [join(dir, "scripts", script), ...args], {
        env,
        encoding: "utf8",
      }),
    calls: () =>
      existsSync(env.FIXTURE_LOG)
        ? readFileSync(env.FIXTURE_LOG, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const value: unknown = JSON.parse(line);
              return z.array(z.string()).parse(value);
            })
        : [],
    close: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function archive(dir: string) {
  execFileSync("tar", [
    "-czf",
    join(dir, "input.tar.gz"),
    "-C",
    join(dir, "source"),
    ".",
  ]);
}
const owner = {
  id: "owner",
  name: "나",
  role: "owner" as const,
  canWrite: true,
  projectIds: null,
};
function createDb(path: string, title: string) {
  const store = new Store(dirname(path));
  store.createProject(owner, { name: title, key: "TEST" });
  store.close();
}
function marker(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT name FROM projects LIMIT 1").get();
    assert.ok(row);
    assert.equal(typeof row.name, "string");
    return row.name;
  } finally {
    db.close();
  }
}

void test("backup stops service, writes restrictive archive, restarts only previously running service, and refuses overwrite", () => {
  const f = setup();
  try {
    createDb(join(f.dir, "source", "sticker.sqlite"), "backed up");
    archive(f.dir);
    const target = join(f.dir, "backup.tar.gz");
    const result = f.run("backup.sh", [target]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      readFileSync(target),
      readFileSync(join(f.dir, "input.tar.gz")),
    );
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(
      f.calls().map((c: string[]) => c[1]),
      ["ps", "stop", "run", "start"],
    );
    const before = f.calls().length;
    assert.equal(f.run("backup.sh", [target]).status, 1);
    assert.equal(f.calls().length, before);
    f.env.FIXTURE_RUNNING = "no";
    const second = f.run("backup.sh", [join(f.dir, "backup2.tar.gz")]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(
      f
        .calls()
        .slice(before)
        .map((c: string[]) => c[1]),
      ["ps", "stop", "run"],
    );
  } finally {
    f.close();
  }
});

void test("restore requires confirmation and rejects traversal, links and missing DB before touching service", () => {
  const f = setup();
  try {
    assert.equal(f.run("restore.sh", [join(f.dir, "input.tar.gz")]).status, 2);
    assert.equal(f.calls().length, 0);
    writeFileSync(join(f.dir, "source", "unrecognized.txt"), "bad");
    archive(f.dir);
    assert.equal(
      f.run("restore.sh", [join(f.dir, "input.tar.gz"), "--replace-data"])
        .status,
      1,
    );
    assert.equal(f.calls().length, 0);
    rmSync(join(f.dir, "source", "unrecognized.txt"));
    symlinkSync("/etc/passwd", join(f.dir, "source", "sticker.sqlite"));
    archive(f.dir);
    assert.equal(
      f.run("restore.sh", [join(f.dir, "input.tar.gz"), "--replace-data"])
        .status,
      1,
    );
    assert.equal(f.calls().length, 0);
    rmSync(join(f.dir, "source", "sticker.sqlite"));
    archive(f.dir);
    assert.equal(
      f.run("restore.sh", [join(f.dir, "input.tar.gz"), "--replace-data"])
        .status,
      1,
    );
    assert.equal(f.calls().length, 0);
    writeFileSync(join(f.dir, "source", "sticker.sqlite"), "not a DB");
    // A minimal POSIX ustar fixture avoids GNU-only --transform on macOS BSD tar.
    const header = Buffer.alloc(512);
    header.write("../sticker.sqlite", 0, "ascii");
    header.write("0000600\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write("00000000010\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.fill(32, 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const body = Buffer.alloc(512);
    body.write("not a DB", 0, "ascii");
    writeFileSync(
      join(f.dir, "input.tar.gz"),
      gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)])),
    );
    assert.match(
      execFileSync("tar", ["-tzf", join(f.dir, "input.tar.gz")], {
        encoding: "utf8",
      }),
      /\.\.\/sticker\.sqlite/,
    );
    assert.equal(
      f.run("restore.sh", [join(f.dir, "input.tar.gz"), "--replace-data"])
        .status,
      1,
    );
    assert.equal(f.calls().length, 0);
  } finally {
    f.close();
  }
});

void test("restore stages and integrity-checks before replacing old DB/files, then leaves service stopped", () => {
  const f = setup();
  try {
    createDb(join(f.dir, "data", "sticker.sqlite"), "old");
    mkdirSync(join(f.dir, "data", "uploads"));
    writeFileSync(join(f.dir, "data", "uploads", "old"), "old");
    createDb(join(f.dir, "source", "sticker.sqlite"), "restored");
    mkdirSync(join(f.dir, "source", "uploads"));
    writeFileSync(join(f.dir, "source", "uploads", "abc-123"), "new");
    archive(f.dir);
    const result = f.run("restore.sh", [
      join(f.dir, "input.tar.gz"),
      "--replace-data",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(marker(join(f.dir, "data", "sticker.sqlite")), "restored");
    assert.equal(existsSync(join(f.dir, "data", "uploads", "old")), false);
    assert.equal(
      readFileSync(join(f.dir, "data", "uploads", "abc-123"), "utf8"),
      "new",
    );
    assert.deepEqual(
      f.calls().map((c: string[]) => c[1]),
      ["stop", "run"],
    );
  } finally {
    f.close();
  }
});

void test("invalid SQLite backup never replaces existing data and leaves service stopped", () => {
  const f = setup();
  try {
    createDb(join(f.dir, "data", "sticker.sqlite"), "must survive");
    writeFileSync(join(f.dir, "source", "sticker.sqlite"), "not SQLite");
    archive(f.dir);
    const result = f.run("restore.sh", [
      join(f.dir, "input.tar.gz"),
      "--replace-data",
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(marker(join(f.dir, "data", "sticker.sqlite")), "must survive");
    assert.deepEqual(
      f.calls().map((c: string[]) => c[1]),
      ["stop", "run"],
    );
  } finally {
    f.close();
  }
});

for (const invalid of ["zero-byte", "unrelated", "missing-attachment"] as const)
  void test(`restore rejects ${invalid} backup before replacing live Sticker data`, () => {
    const f = setup();
    try {
      createDb(join(f.dir, "data", "sticker.sqlite"), "must survive");
      const incoming = join(f.dir, "source", "sticker.sqlite");
      if (invalid === "zero-byte") writeFileSync(incoming, "");
      if (invalid === "unrelated") {
        const db = new DatabaseSync(incoming);
        db.exec("CREATE TABLE unrelated(value TEXT); PRAGMA user_version=1;");
        db.close();
      }
      if (invalid === "missing-attachment") {
        const store = new Store(join(f.dir, "source"));
        const p = store.createProject(owner, { name: "incoming", key: "INC" });
        const i = store.createIssue(owner, { projectId: p.id, title: "file" });
        store.addAttachment(owner, i.id, {
          kind: "file",
          name: "missing.txt",
          storageKey: randomUUID(),
          mimeType: "text/plain",
          size: 4,
        });
        store.close();
      }
      archive(f.dir);
      const result = f.run("restore.sh", [
        join(f.dir, "input.tar.gz"),
        "--replace-data",
      ]);
      assert.notEqual(result.status, 0, `accepted ${invalid} backup`);
      assert.equal(
        marker(join(f.dir, "data", "sticker.sqlite")),
        "must survive",
      );
      assert.deepEqual(
        f.calls().map((c: string[]) => c[1]),
        ["stop", "run"],
      );
    } finally {
      f.close();
    }
  });

void test("restore-only managed invalidation failure never replaces old data and never starts service", () => {
  const f = setup();
  try {
    createDb(join(f.dir, "data", "sticker.sqlite"), "original");
    createDb(join(f.dir, "source", "sticker.sqlite"), "staged");
    archive(f.dir);
    f.env.FIXTURE_GRANT_INVALIDATOR = "false";
    const result = f.run("restore.sh", [
      join(f.dir, "input.tar.gz"),
      "--replace-data",
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(marker(join(f.dir, "data", "sticker.sqlite")), "original");
    assert.deepEqual(
      f.calls().map((c) => c[1]),
      ["stop", "run"],
    );
  } finally {
    f.close();
  }
});
