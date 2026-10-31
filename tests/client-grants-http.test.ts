import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sessionHttpFixture } from "./session-fixture.js";
import { createApp } from "../server/app.js";
import { routeCoverage } from "../server/mcp/route-coverage.js";
const fakeToken = "synthetic-managed-bearer-canary-only";
const hash = createHash("sha256").update(fakeToken).digest("hex");
async function fixture(t: test.TestContext) {
  const f = await sessionHttpFixture();
  t.after(async () => {
    await f.close();
  });
  const login = await fetch(f.base + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "disposable-session-owner-password" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const provision = {
    clientId: "codex-local",
    installationId: randomUUID(),
    connectionId: randomUUID(),
    projectId: f.project.id,
    requestedCanWrite: true,
    tokenHash: hash,
    operationId: randomUUID(),
    approvalDigest: "b".repeat(64),
    planExpiresAt: new Date(Date.now() + 240_000).toISOString(),
    confirm: true,
  };
  const owner = {
    cookie: cookie,
    origin: "http://localhost:8787",
    "content-type": "application/json",
  };
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = owner,
  ) =>
    fetch(f.base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const grant = await call("/api/client-grants", "POST", provision);
  assert.equal(grant.status, 201);
  const result = (await grant.json()) as {
    current: { grantId: string; agentId: string; revision: number };
  };
  const phase = {
    clientId: provision.clientId,
    installationId: provision.installationId,
    connectionId: provision.connectionId,
    approvalDigest: provision.approvalDigest,
    operationId: provision.operationId,
    revision: 1,
    confirm: true,
  };
  return {
    f,
    cookie,
    provision,
    owner,
    call,
    grantId: result.current.grantId,
    agentId: result.current.agentId,
    phase,
    bearer: { authorization: `Bearer ${fakeToken}` },
  };
}
void test("provisional HTTP exact two GET routes only; deny domain/multipart/HEAD/options before handlers", async (t) => {
  const x = await fixture(t);
  for (const path of ["/api/session", "/api/client-grants/self/verify"]) {
    const r = await x.call(path, "GET", undefined, x.bearer);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(!text.includes(hash));
    assert.ok(!text.includes(fakeToken));
    assert.match(text, /provisional/);
  }
  for (const [path, method] of [
    ["/api/bootstrap", "GET"],
    ["/api/projects", "POST"],
    ["/api/issues", "GET"],
    ["/api/maintenance", "GET"],
    ["/api/access-mode", "GET"],
    ["/api/mcp/settings", "GET"],
    ["/api/session", "HEAD"],
    ["/api/session", "OPTIONS"],
    ["/api/session?target=other", "GET"],
    ["/api/client-grants/self/verify/", "GET"],
    ["/api/client-grants", "POST"],
  ]) {
    const r = await x.call(path, method, undefined, x.bearer);
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  const upload = await fetch(
    x.f.base + `/api/issues/${x.f.issue.id}/attachments/file`,
    {
      method: "POST",
      headers: {
        ...x.bearer,
        "content-type": "multipart/form-data; boundary=bad",
      },
      body: "broken multipart",
    },
  );
  assert.equal(upload.status, 403);
});
void test("active live auth scope, directory and revoke no cache; invalid bearer never falls back cookie", async (t) => {
  const x = await fixture(t);
  assert.ok(
    !(await (await x.call("/api/mcp/settings")).text()).includes(x.agentId),
  );
  assert.equal(
    (await x.call(`/api/client-grants/${x.grantId}/activate`, "POST", x.phase))
      .status,
    200,
  );
  assert.ok(
    (await (await x.call("/api/mcp/settings")).text()).includes(x.agentId),
  );
  assert.equal(
    (await x.call(`/api/issues/${x.f.issue.id}`, "GET", undefined, x.bearer))
      .status,
    200,
  );
  assert.equal(
    (await x.call(`/api/issues/${x.f.foreign.id}`, "GET", undefined, x.bearer))
      .status,
    403,
  );
  assert.equal(
    (
      await x.call(
        `/api/issues/${x.f.issue.id}`,
        "PATCH",
        { revision: 1, title: "managed" },
        { ...x.bearer, "content-type": "application/json" },
      )
    ).status,
    200,
  );
  for (const authorization of ["", "Basic invalid", "Bearer invalid"])
    assert.equal(
      (
        await x.call("/api/session", "GET", undefined, {
          cookie: x.cookie,
          authorization,
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await x.call(
        "/api/client-grants",
        "POST",
        { ...x.provision, operationId: randomUUID() },
        { ...x.bearer, "content-type": "application/json" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await x.call(`/api/client-grants/${x.grantId}/revoke`, "POST", {
        ...x.phase,
        operationId: randomUUID(),
        revision: 2,
      })
    ).status,
    200,
  );
  assert.equal(
    (await x.call("/api/session", "GET", undefined, x.bearer)).status,
    401,
  );
  assert.ok(
    !(await (await x.call("/api/mcp/settings")).text()).includes(x.agentId),
  );
  const replay = await x.call(
    `/api/client-grants/${x.grantId}/activate`,
    "POST",
    x.phase,
  );
  assert.equal(replay.status, 200);
  assert.match(await replay.text(), /revoked/);
});
void test("owner, origin, JSON, strict unknown/duplicate fields and immutable native binding", async (t) => {
  const x = await fixture(t);
  assert.equal(
    (
      await x.call(`/api/client-grants/${x.grantId}/activate`, "POST", {
        ...x.phase,
        connectionId: randomUUID(),
      })
    ).status,
    409,
  );
  for (const headers of [
    { ...x.owner, origin: "https://foreign.invalid" },
    { ...x.owner, origin: "" },
    { ...x.owner, "content-type": "text/plain" },
  ])
    assert.ok(
      [403, 415].includes(
        (
          await x.call(
            `/api/client-grants/${x.grantId}/activate`,
            "POST",
            x.phase,
            headers,
          )
        ).status,
      ),
    );
  const bad = await x.call("/api/client-grants", "POST", {
    ...x.provision,
    rawToken: fakeToken,
  });
  assert.equal(bad.status, 400);
  const text = await bad.text();
  assert.ok(!text.includes(fakeToken));
  assert.ok(!text.includes(hash));
  const duplicate = await fetch(x.f.base + "/api/client-grants", {
    method: "POST",
    headers: x.owner,
    body: JSON.stringify({ ...x.provision, operationId: randomUUID() }).replace(
      '"confirm":true',
      '"confirm":false,"conf\\u0069rm":true',
    ),
  });
  assert.equal(duplicate.status, 400);
  assert.equal((await x.call("/api/client-grants/self/verify")).status, 403);
});
void test("maintenance does not exempt private grants or self verify", async (t) => {
  const x = await fixture(t),
    snap = x.f.instance.maintenance.snapshot();
  x.f.instance.maintenance.change("begin", {
    instanceId: snap.instanceId,
    revision: snap.revision,
    confirm: true,
  });
  assert.equal(
    (await x.call("/api/session", "GET", undefined, x.bearer)).status,
    200,
  );
  assert.equal(
    (await x.call("/api/client-grants/self/verify", "GET", undefined, x.bearer))
      .status,
    503,
  );
  for (const path of [
    `/api/client-grants/${x.grantId}/activate`,
    `/api/client-grants/${x.grantId}/revoke`,
  ])
    assert.equal((await x.call(path, "POST", x.phase)).status, 503);
});
void test("all five grant routes truthfully pending host bootstrap transport, no fake MCP tool", () => {
  for (const route of [
    "POST /api/client-grants",
    "POST /api/client-grants/:id/activate",
    "POST /api/client-grants/:id/revoke",
    "GET /api/client-grants/operations/:operationId",
    "GET /api/client-grants/self/verify",
  ]) {
    const c = routeCoverage(route);
    assert.equal(c.tools.length, 0);
    assert.match(c.exception?.reason ?? "", /pending.*host/i);
  }
  assert.equal(
    routeCoverage("GET /api/client-grants/anything").exception,
    undefined,
  );
  assert.equal(typeof createApp, "function");
});
void test("provisional MCP help is truthful and has no callable secret-provision tool", async (t) => {
  const x = await fixture(t);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createStickerMcp } = await import("../server/mcp.js");
  const server = createStickerMcp(x.f.base, fakeToken),
    client = new Client({ name: "synthetic-grant-proof", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 109);
  assert.ok(
    !tools.tools.some((tool) => /client_apply|grant|token/i.test(tool.name)),
  );
  const help = await client.callTool({
    name: "sticker_get_help",
    arguments: { visibleTools: tools.tools.map((tool) => tool.name) },
  });
  assert.equal(!!help.isError, false);
  const text = JSON.stringify(help);
  assert.equal(text.includes("activation_required"), true);
  assert.ok(!text.includes(fakeToken));
  assert.ok(!text.includes(hash));
  const capabilities = await client.callTool({
    name: "sticker_get_capabilities",
    arguments: {},
  });
  assert.equal(capabilities.isError, true);
  assert.equal(
    (await x.call(`/api/client-grants/${x.grantId}/activate`, "POST", x.phase))
      .status,
    200,
  );
  const githubHelp = await client.callTool({
    name: "sticker_get_help",
    arguments: { tool: "sticker_get_github_connection" },
  });
  assert.equal(!!githubHelp.isError, false);
  assert.match(JSON.stringify(githubHelp), /owner_required/);
  const github = await client.callTool({
    name: "sticker_get_github_connection",
    arguments: { projectId: x.f.project.id },
  });
  assert.equal(github.isError, true);
});
void test("live template directory, two simultaneous activation CAS decisions and operation readback", async (t) => {
  const x = await fixture(t);
  const assignees = () =>
    x.f.instance.store.templates.assignees(
      {
        id: "owner",
        name: "Owner",
        role: "owner",
        canWrite: true,
        projectIds: null,
      },
      x.f.project.id,
    );
  assert.ok(!assignees().some((a) => a.id === x.agentId));
  const replies = await Promise.all([
    x.call(`/api/client-grants/${x.grantId}/activate`, "POST", x.phase),
    x.call(`/api/client-grants/${x.grantId}/activate`, "POST", {
      ...x.phase,
      revision: 2,
    }),
  ]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  assert.ok(assignees().some((a) => a.id === x.agentId));
  const read = await x.call(
    `/api/client-grants/operations/${x.provision.operationId}`,
  );
  assert.equal(read.status, 200);
  const text = await read.text();
  assert.ok(text.includes("active"));
  assert.ok(!text.includes(hash));
  const replay = await x.call("/api/client-grants", "POST", x.provision);
  assert.equal(replay.status, 201);
  assert.ok((await replay.text()).includes("active"));
});
void test("expired live managed bearer cannot fall back to owner; owner readback remains expired", async (t) => {
  const x = await fixture(t),
    { DatabaseSync } = await import("node:sqlite"),
    { join } = await import("node:path");
  const db = new DatabaseSync(join(x.f.dir, "sticker.sqlite")),
    created = new Date(Date.now() - 300_000).toISOString(),
    expired = new Date(Date.now() - 60_000).toISOString();
  db.prepare(
    "UPDATE managed_client_grants SET createdAt=?,updatedAt=?,planExpiresAt=?,provisionalUntil=? WHERE grantId=?",
  ).run(created, created, expired, expired, x.grantId);
  db.close();
  assert.equal(
    (
      await x.call("/api/session", "GET", undefined, {
        ...x.bearer,
        cookie: x.cookie,
      })
    ).status,
    401,
  );
  const op = await x.call(
    `/api/client-grants/operations/${x.provision.operationId}`,
  );
  assert.equal(op.status, 200);
  assert.ok((await op.text()).includes("expired"));
  assert.equal(
    (await x.call(`/api/client-grants/${x.grantId}/activate`, "POST", x.phase))
      .status,
    409,
  );
});
void test("private mutation aliases cannot bypass strict duplicate confirmation parsing", async (t) => {
  const x = await fixture(t);
  for (const path of [
    "/api/client-grants?ignored=1",
    "/api/client-grants/",
    "/api/CLIENT-GRANTS",
  ]) {
    const input = {
      ...x.provision,
      operationId: randomUUID(),
      tokenHash: "d".repeat(64),
    };
    const r = await fetch(x.f.base + path, {
      method: "POST",
      headers: x.owner,
      body: JSON.stringify(input).replace(
        '"confirm":true',
        '"confirm":false,"confirm":true',
      ),
    });
    assert.equal(r.status, 400, path);
  }
});
void test("raw provisional POST session never enters password login; existing owner/static login and agent mode remain intact", async (t) => {
  const x = await fixture(t),
    body = { password: "disposable-session-owner-password" };
  for (const password of [body.password, "wrong-fixture-password"]) {
    const blocked = await x.call(
      "/api/session",
      "POST",
      { password },
      { ...x.bearer, "content-type": "application/json" },
    );
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("set-cookie"), null);
  }
  const controls: Record<string, string>[] = [
    { "content-type": "application/json" },
    {
      "content-type": "application/json",
      authorization: `Bearer ${x.f.tokens.agent}`,
    },
    { "content-type": "application/json", authorization: "Bearer invalid" },
  ];
  for (const headers of controls) {
    const r = await x.call("/api/session", "POST", body, headers);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("set-cookie"));
  }
  assert.equal(
    (
      await x.call("/api/session", "POST", body, {
        ...x.bearer,
        "content-type": "application/json",
        "x-sticker-auth-mode": "agent",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await x.call("/api/session", "GET", undefined, {
        cookie: x.cookie,
        authorization: "Bearer invalid",
      })
    ).status,
    401,
  );
});
