import test from "node:test";
import assert from "node:assert/strict";
import { TransferManager } from "../server/mcp/transfer-manager.js";
import { ApiError, createStickerTransport } from "../server/mcp/transport.js";

void test("operation recovery rejects inconsistent receipts without retrying the write", async (t) => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  const input = {
    projectId: "requested-project",
    issueId: "requested-issue",
    operationId,
    name: "original.bin",
    size: 3,
    checksum: "a".repeat(64),
  };
  const good = {
    recorded: true,
    operationId,
    payload: {
      contractVersion: 1,
      kind: "issue_file_create",
      issueId: input.issueId,
      file: {
        fileName: input.name,
        mimeType: "application/octet-stream",
        size: input.size,
        checksum: input.checksum,
      },
    },
    receipt: {
      kind: "attachment",
      operationId,
      projectId: input.projectId,
      issueId: input.issueId,
      attachmentId: otherId,
      name: input.name,
      mimeType: "application/octet-stream",
      size: input.size,
      checksum: input.checksum,
      historicalCommitted: true,
      currentPresent: true,
    },
  };
  let response: unknown = good;
  let gets = 0;
  t.mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
    assert.equal(
      url,
      `http://127.0.0.1:9/api/projects/requested-project/attachment-operations/${operationId}`,
    );
    assert.equal(init?.method, "GET");
    gets++;
    return Promise.resolve(Response.json(response));
  });
  const manager = new TransferManager(
    createStickerTransport({
      apiUrl: "http://127.0.0.1:9",
      auth: { mode: "agent", token: "synthetic-never-sent" },
    }),
  );
  try {
    const mutations: Array<[string, (value: typeof good) => void]> = [
      [
        "envelope operation",
        (value) => {
          value.operationId = otherId;
        },
      ],
      [
        "receipt operation",
        (value) => {
          value.receipt.operationId = otherId;
        },
      ],
      [
        "receipt project",
        (value) => {
          value.receipt.projectId = "another-project";
        },
      ],
      [
        "receipt issue",
        (value) => {
          value.receipt.issueId = "another-issue";
        },
      ],
      [
        "receipt checksum",
        (value) => {
          value.receipt.checksum = "b".repeat(64);
        },
      ],
      [
        "receipt size",
        (value) => {
          value.receipt.size = 4;
        },
      ],
      [
        "receipt name",
        (value) => {
          value.receipt.name = "another.bin";
        },
      ],
      [
        "receipt MIME",
        (value) => {
          value.receipt.mimeType = "text/plain";
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      await t.test(name, async () => {
        const changed = structuredClone(good);
        mutate(changed);
        response = changed;
        await assert.rejects(
          manager.operation(input),
          (error) =>
            error instanceof ApiError &&
            error.status === 502 &&
            error.code === "api_response_invalid",
        );
      });
    }
    response = good;
    assert.deepEqual(await manager.operation(input), good);
    response = { ...good, receipt: { ...good.receipt, currentPresent: false } };
    assert.deepEqual(await manager.operation(input), response);
    response = { recorded: false };
    assert.deepEqual(await manager.operation(input), response);
    response = {
      ...good,
      payload: { ...good.payload, issueId: "another-issue" },
    };
    await assert.rejects(manager.operation(input), {
      code: "OPERATION_CONFLICT",
    });
    assert.equal(gets, 12);
  } finally {
    await manager.dispose();
  }
});
