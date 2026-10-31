import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Store } from "../server/domain.js";
import { createApp } from "../server/app.js";
import { TransferManager } from "../server/mcp/transfer-manager.js";
import { TransferArena } from "../server/mcp/transfer-arena.js";
import { createStickerTransport, ApiError } from "../server/mcp/transport.js";
import { ordinaryMcpFixture } from "./mcp-product-fixture.js";
import { sessionOwner as owner } from "./session-fixture.js";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function switchable() {
  const dir = mkdtempSync(join(tmpdir(), "sticker-transfer-auth-")),
    seed = new Store(dir),
    project = seed.createProject(owner, { key: "TA", name: "transfer auth" }),
    issue = seed.createIssue(owner, { projectId: project.id, title: "scope" });
  seed.close();
  let instance: ReturnType<typeof createApp>;
  const server = createServer((req, res) => {
    instance.app(req, res);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${String(address.port)}`,
    token = "synthetic-transfer-current-authority-token";
  const make = (
    canWrite: boolean,
    projectIds: string[],
    present = true,
    trusted = false,
  ) =>
    createApp({
      dataDir: dir,
      ownerPassword: "synthetic-transfer-auth-password",
      appOrigin: base,
      localOwnerMode: trusted ? "trusted-loopback" : undefined,
      agents: present
        ? [
            {
              id: "agent",
              name: "agent",
              canWrite,
              projectIds,
              tokenHash: createHash("sha256").update(token).digest("hex"),
            },
          ]
        : [],
    });
  instance = make(true, [project.id]);
  const arena = new TransferArena(),
    manager = new TransferManager(
      createStickerTransport({ apiUrl: base, auth: { mode: "agent", token } }),
      { arena },
    );
  return {
    project,
    issue,
    arena,
    manager,
    swap(
      canWrite: boolean,
      projectIds: string[],
      present = true,
      trusted = false,
    ) {
      const prior = instance;
      instance = make(canWrite, projectIds, present, trusted);
      prior.close();
    },
    async close() {
      await manager.dispose();
      server.closeAllConnections();
      await new Promise<void>((r) =>
        server.close(() => {
          r();
        }),
      );
      instance.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
void test("current real scope/write revocation stops a started upload and an invalid bearer never inherits trusted owner", async () => {
  for (const change of ["scope", "write", "identity"] as const) {
    const f = await switchable();
    try {
      const bytes = Buffer.from("not admitted"),
        operationId = randomUUID(),
        h = await f.manager.beginUpload({
          target: { kind: "issue_attachment", issueId: f.issue.id },
          operationId,
          name: "scope.bin",
          size: bytes.length,
          checksum: sha(bytes),
        });
      f.swap(
        change !== "write",
        change === "scope" ? [] : [f.project.id],
        change !== "identity",
        change === "identity",
      );
      await assert.rejects(
        f.manager.writeChunk({
          handle: h.handle,
          offset: 0,
          base64: bytes.toString("base64"),
          checksum: sha(bytes),
        }),
        (error) =>
          error instanceof ApiError &&
          error.status === (change === "identity" ? 401 : 403),
      );
      assert.equal(f.arena.stats().liveHandles, 0);
      assert.equal(f.arena.stats().reservedRawBytes, 0);
    } finally {
      await f.close();
    }
  }
});
void test("expired actual owner session after begin cannot write another chunk or fall back", async () => {
  const f = await ordinaryMcpFixture(),
    realNow = Date.now;
  try {
    const bytes = Buffer.from("owner session"),
      h = await f.ok(
        "owner",
        "sticker_begin_upload",
        {
          target: { kind: "issue_attachment", issueId: f.issue.id },
          operationId: randomUUID(),
          name: "owner.bin",
          size: bytes.length,
          checksum: sha(bytes),
        },
        z.object({ handle: z.uuid() }),
      );
    Date.now = () => realNow() + 13 * 60 * 60 * 1000;
    await f.denied(
      "owner",
      "sticker_write_upload_chunk",
      {
        handle: h.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum: sha(bytes),
      },
      401,
    );
  } finally {
    Date.now = realNow;
    await f.close();
  }
});
void test("resource replacement retains original CAS and rechecks guidance/closed/maintenance at each operation", async () => {
  const f = await ordinaryMcpFixture();
  try {
    const bytes = Buffer.from("file version"),
      checksum = sha(bytes),
      begin = {
        target: {
          kind: "resource_file",
          projectId: f.project.id,
          title: "file",
        },
        operationId: randomUUID(),
        name: "file.bin",
        size: bytes.length,
        checksum,
      };
    const first = await f.ok(
      "agent",
      "sticker_begin_upload",
      begin,
      z.object({ handle: z.uuid() }),
    );
    await f.ok(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: first.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum,
      },
      z.unknown(),
    );
    const original = await f.ok(
      "agent",
      "sticker_finish_upload",
      { handle: first.handle, operationId: begin.operationId, checksum },
      z.object({ resourceId: z.uuid(), revision: z.number() }),
    );
    const input = {
        ...begin,
        target: {
          kind: "resource_file_replacement",
          resourceId: original.resourceId,
          revision: original.revision,
        },
        operationId: randomUUID(),
      },
      second = await f.ok(
        "agent",
        "sticker_begin_upload",
        input,
        z.object({ handle: z.uuid() }),
      );
    await f.ok(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: second.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum,
      },
      z.unknown(),
    );
    f.instance.store.resources.update(owner, original.resourceId, {
      revision: original.revision,
      operationId: randomUUID(),
      title: "changed",
    });
    await f.denied(
      "agent",
      "sticker_finish_upload",
      { handle: second.handle, operationId: input.operationId, checksum },
      409,
    );
    await f.ok(
      "agent",
      "sticker_cancel_upload",
      { handle: second.handle },
      z.unknown(),
    );
    const current = f.instance.store.resources.get(
        owner,
        original.resourceId,
      ).resource,
      third = await f.ok(
        "agent",
        "sticker_begin_upload",
        {
          ...input,
          target: { ...input.target, revision: current.revision },
          operationId: randomUUID(),
        },
        z.object({ handle: z.uuid() }),
      );
    f.instance.store.resources.guidance(owner, original.resourceId, {
      revision: current.revision,
      operationId: randomUUID(),
      isGuidance: true,
    });
    await f.denied(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: third.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum,
      },
      403,
    );
    const issueInput = {
        ...begin,
        target: { kind: "issue_attachment", issueId: f.issue.id },
        operationId: randomUUID(),
      },
      fourth = await f.ok(
        "agent",
        "sticker_begin_upload",
        issueInput,
        z.object({ handle: z.uuid() }),
      );
    await f.ok(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: fourth.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum,
      },
      z.unknown(),
    );
    const state = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("begin", {
      instanceId: state.instanceId,
      revision: state.revision,
      confirm: true,
    });
    await f.denied(
      "agent",
      "sticker_finish_upload",
      { handle: fourth.handle, operationId: issueInput.operationId, checksum },
      503,
    );
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).attachments.length,
      0,
    );
  } finally {
    const state = f.instance.maintenance.snapshot();
    if (state.state !== "serving")
      f.instance.maintenance.change("resume", {
        instanceId: state.instanceId,
        revision: state.revision,
        confirm: true,
      });
    await f.close();
  }
});
