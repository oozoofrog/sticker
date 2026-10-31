import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStickerMcp } from "../server/mcp.js";
import { sessionHttpFixture, sessionOwner } from "./session-fixture.js";
import {
  attach,
  FixtureClock,
  MemoryTransport,
} from "./fixtures/icloud/outbox-fixture.js";
const fakeToken = "synthetic-managed-outbox-bearer-only";
async function fixture(t: test.TestContext) {
  const f = await sessionHttpFixture(),
    clock = new FixtureClock(),
    transport = new MemoryTransport(),
    cloud = attach(f.instance.store, clock, transport);
  t.after(async () => {
    cloud.stop();
    await f.close();
  });
  const login = await fetch(f.base + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "disposable-session-owner-password" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const ownerHeaders = {
      cookie,
      origin: "http://localhost:8787",
      "content-type": "application/json",
    },
    managedHeaders = {
      authorization: `Bearer ${fakeToken}`,
      "content-type": "application/json",
    };
  const call = (path: string, body: unknown, headers = ownerHeaders) =>
    fetch(f.base + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const input = {
    clientId: "codex-local",
    installationId: randomUUID(),
    connectionId: randomUUID(),
    projectId: f.project.id,
    requestedCanWrite: true,
    tokenHash: createHash("sha256").update(fakeToken).digest("hex"),
    operationId: randomUUID(),
    approvalDigest: "b".repeat(64),
    planExpiresAt: new Date(Date.now() + 240_000).toISOString(),
    confirm: true,
  };
  const provision = await call("/api/client-grants", input);
  assert.equal(provision.status, 201);
  const grant = (await provision.json()) as { current: { grantId: string } };
  const phase = {
    clientId: input.clientId,
    installationId: input.installationId,
    connectionId: input.connectionId,
    approvalDigest: input.approvalDigest,
    operationId: input.operationId,
    revision: 1,
    confirm: true,
  };
  const edit = (title: string, revision = 1) =>
    fetch(f.base + `/api/issues/${f.issue.id}`, {
      method: "PATCH",
      headers: managedHeaders,
      body: JSON.stringify({ revision, title }),
    });
  return {
    f,
    clock,
    transport,
    cloud,
    input,
    grantId: grant.current.grantId,
    phase,
    call,
    edit,
  };
}
void test("managed-grant admission and HTTP/MCP issue observer share scope, revocation and secret-free outbox", async (t) => {
  const x = await fixture(t);
  assert.equal((await x.edit("provisional denied")).status, 403);
  await x.clock.settle();
  assert.equal(x.transport.sends, 0);
  assert.equal(
    (await x.call(`/api/client-grants/${x.grantId}/activate`, x.phase)).status,
    200,
  );
  await x.clock.settle();
  assert.equal(x.transport.sends, 0);
  assert.equal((await x.edit("managed HTTP title")).status, 200);
  await x.clock.settle();
  assert.equal(x.cloud.outbox.status().acknowledged, 1);
  const server = createStickerMcp(x.f.base, fakeToken),
    client = new Client({ name: "managed-outbox-fixture", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const mcp = await client.callTool({
      name: "sticker_update_issue",
      arguments: {
        issueId: x.f.issue.id,
        revision: 2,
        description: "managed MCP body",
      },
    });
    assert.notEqual(mcp.isError, true);
    await x.clock.settle();
    assert.equal(x.cloud.outbox.status().acknowledged, 2);
    const foreign = await client.callTool({
      name: "sticker_update_issue",
      arguments: {
        issueId: x.f.foreign.id,
        revision: 1,
        title: "foreign denied",
      },
    });
    assert.equal(foreign.isError, true);
    assert.equal(
      (
        await x.call(`/api/client-grants/${x.grantId}/revoke`, {
          ...x.phase,
          operationId: randomUUID(),
          revision: 2,
        })
      ).status,
      200,
    );
    assert.equal((await x.edit("revoked denied", 3)).status, 401);
    await x.clock.settle();
    assert.equal(x.cloud.outbox.status().acknowledged, 2);
    const records = [...x.transport.records.values()].map((r) => r.envelope);
    assert.deepEqual(
      records.map((r) => r.content),
      [
        { title: "managed HTTP title", description: "" },
        { title: "managed HTTP title", description: "managed MCP body" },
      ],
    );
    const serialized = JSON.stringify(records);
    for (const secret of [
      fakeToken,
      x.input.tokenHash,
      x.input.approvalDigest,
      x.grantId,
      ...Object.values(x.f.tokens),
    ])
      assert.equal(serialized.includes(secret), false);
    assert.equal(
      x.f.instance.store.history.list(sessionOwner, x.f.issue.id).length,
      3,
    );
  } finally {
    await client.close();
    await server.close();
  }
});
void test("outbox capture failure rolls back managed issue mutation without changing its grant; later retry captures once", async (t) => {
  const x = await fixture(t);
  assert.equal(
    (await x.call(`/api/client-grants/${x.grantId}/activate`, x.phase)).status,
    200,
  );
  const before = x.f.instance.store.getIssue(sessionOwner, x.f.issue.id),
    grantBefore = x.f.instance.store.clientGrants.operation(
      sessionOwner,
      x.input.operationId,
    );
  x.cloud.db.exec(
    "CREATE TRIGGER refuse_managed_outbox BEFORE INSERT ON fixture_cloud_outbox BEGIN SELECT RAISE(ABORT,'synthetic capture failure'); END",
  );
  assert.equal((await x.edit("must roll back")).status, 500);
  await x.clock.settle();
  assert.equal(x.transport.sends, 0);
  assert.deepEqual(
    x.f.instance.store.getIssue(sessionOwner, x.f.issue.id),
    before,
  );
  assert.deepEqual(
    x.f.instance.store.clientGrants.operation(
      sessionOwner,
      x.input.operationId,
    ),
    grantBefore,
  );
  x.cloud.db.exec("DROP TRIGGER refuse_managed_outbox");
  assert.equal((await x.edit("after rollback")).status, 200);
  await x.clock.settle();
  assert.equal(x.cloud.outbox.status().acknowledged, 1);
  assert.equal(x.transport.sends, 1);
});
