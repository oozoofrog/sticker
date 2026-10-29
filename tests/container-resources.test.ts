import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { Store } from "../server/domain.js";
import { FileStorage } from "../server/file-storage.js";
import { validateBackup } from "../server/backup-validation.js";
import { sessionOwner as owner } from "./session-fixture.js";
async function start(root: string, password: string) {
  const instance = createApp({
      dataDir: root,
      ownerPassword: password,
      agents: [],
      appOrigin: "http://localhost:8787",
    }),
    server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    instance,
    base: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
      instance.close();
    },
  };
}
async function fixture(
  base: string,
  password: string,
  phase: "initialize" | "verify",
) {
  const source = readFileSync(
      new URL("./container-resources-smoke.mjs", import.meta.url),
      "utf8",
    ),
    child = spawn(process.execPath, ["--input-type=module", "-", phase], {
      env: {
        ...process.env,
        OWNER_PASSWORD: password,
        APP_ORIGIN: "http://localhost:8787",
        STICKER_SMOKE_API_URL: base,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stdin.end(source);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Resource smoke fixture timed out"));
    }, 30000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(output));
      else resolve();
    });
  });
}
void test("resource container fixture verifies real HTTP initialize, recreate and backup restore with exact issue counts and shared historical bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sticker-resource-lifecycle-")),
    snapshot = mkdtempSync(join(tmpdir(), "sticker-resource-snapshot-")),
    password = `fixture-${randomUUID()}`;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(snapshot, { recursive: true, force: true });
  });
  const seed = new Store(root),
    project = seed.createProject(owner, {
      key: "PORT",
      name: "Portable fixture",
    }),
    issue = seed.createIssue(owner, {
      projectId: project.id,
      title: "Persisted container issue",
    });
  seed.createVersion(owner, {
    projectId: project.id,
    name: "Container next fixture",
  });
  const foreign = seed.createProject(owner, {
      key: "TPL",
      name: "Container template fixture",
    }),
    template = seed.templates.create(owner, {
      projectId: foreign.id,
      name: "fixture",
      body: "Template provenance",
      requiredFields: [],
      defaults: {},
      operationId: randomUUID(),
    });
  seed.createIssue(owner, {
    projectId: foreign.id,
    title: "Container template provenance fixture",
    templateId: template.template.id,
    templateVersion: 1,
    templateValues: {},
    operationId: randomUUID(),
  });
  const stored = new FileStorage(root).write(
    Buffer.from("legacy core bytes"),
    "legacy.bin",
  );
  seed.addAttachment(owner, issue.id, {
    kind: "file",
    name: stored.fileName,
    storageKey: stored.storageKey,
    mimeType: stored.mimeType,
    size: stored.size,
  });
  seed.close();
  let app = await start(root, password);
  try {
    await fixture(app.base, password, "initialize");
    assert.deepEqual(
      app.instance.store
        .bootstrap(owner)
        .issues.map((row) => row.title)
        .sort(),
      [
        "Container shared resource reference",
        "Container template provenance fixture",
        "Persisted container issue",
      ],
    );
  } finally {
    await app.close();
  }
  const before = readFileSync(join(root, "sticker.sqlite"));
  assert.deepEqual(validateBackup(root), { schemaVersion: 9, fileCount: 3 });
  assert.deepEqual(readFileSync(join(root, "sticker.sqlite")), before);
  assert.equal(
    readdirSync(join(root, "uploads")).length,
    3,
    "Duplicate upload retries leave no extra files",
  );
  cpSync(root, snapshot, { recursive: true });
  app = await start(root, password);
  try {
    await fixture(app.base, password, "verify");
    app.instance.store.createIssue(owner, {
      projectId: project.id,
      title: "Must disappear on restore",
    });
    assert.equal(app.instance.store.bootstrap(owner).issues.length, 4);
  } finally {
    await app.close();
  }
  rmSync(root, { recursive: true, force: true });
  cpSync(snapshot, root, { recursive: true });
  app = await start(root, password);
  try {
    await fixture(app.base, password, "verify");
    assert.deepEqual(
      app.instance.store
        .bootstrap(owner)
        .issues.map((row) => row.title)
        .sort(),
      [
        "Container shared resource reference",
        "Container template provenance fixture",
        "Persisted container issue",
      ],
    );
    assert.equal(
      app.instance.store.getIssue(owner, issue.id).attachments.length,
      1,
    );
  } finally {
    await app.close();
  }
});
