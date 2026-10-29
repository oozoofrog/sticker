import { request as httpRequest } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../server/app.js";
void test("trusted deployment grants owner without password but cannot upgrade invalid or scoped bearer principals", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-owner-"));
  const instance = createApp({
    dataDir: root,
    ownerPassword: "",
    localOwnerMode: "trusted-loopback",
    appOrigin: "http://localhost:8787",
    agents: [
      {
        id: "fixture",
        name: "fixture",
        tokenHash: createHash("sha256")
          .update("fixture-agent-token")
          .digest("hex"),
        canWrite: false,
        projectIds: [],
      },
    ],
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${String(address.port)}`;
  const call = (
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
  ) =>
    new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        `${base}/api${path}`,
        { method, headers: { host: "localhost:8787", ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (Array.isArray(value))
                for (const item of value) responseHeaders.append(name, item);
              else if (value !== undefined) responseHeaders.set(name, value);
            }
            resolve(
              new Response(
                res.statusCode === 204 ? null : Buffer.concat(chunks),
                { status: res.statusCode ?? 500, headers: responseHeaders },
              ),
            );
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    const bootstrap = await call("/bootstrap");
    assert.equal(bootstrap.status, 200, await bootstrap.clone().text());
    const body: unknown = await bootstrap.json();
    assert.ok(body && typeof body === "object" && "actor" in body);
    assert.deepEqual(body.actor, {
      id: "owner",
      name: "나",
      role: "owner",
      canWrite: true,
      projectIds: null,
    });
    // Integration with the owner-only MCP settings surface: deployment owner
    // access does not promote a bearer agent or disclose its credential.
    const settings = await call("/mcp/settings");
    assert.equal(settings.status, 200);
    const settingsText = await settings.text();
    assert.deepEqual(JSON.parse(settingsText), {
      transport: "stdio",
      application: "manual",
      verification: "unknown",
      tokenEnvironmentVariable: "STICKER_AGENT_TOKEN",
      agents: [
        { id: "fixture", name: "fixture", canWrite: false, projectIds: [] },
      ],
    });
    assert.ok(!settingsText.includes("fixture-agent-token"));
    assert.ok(!settingsText.includes("tokenHash"));
    assert.ok(
      !settingsText.includes(
        createHash("sha256").update("fixture-agent-token").digest("hex"),
      ),
    );
    assert.equal(
      (
        await call("/mcp/settings", "GET", {
          authorization: "Bearer fixture-agent-token",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/mcp/settings", "GET", {
          authorization: "",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/mcp/settings", "GET", {
          origin: "http://evil.test",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("/bootstrap", "GET", { authorization: "Bearer invalid" }))
        .status,
      401,
    );
    assert.equal(
      (await call("/bootstrap", "GET", { authorization: "" })).status,
      401,
    );
    assert.equal(
      (
        await call("/session", "GET", {
          host: "127.0.0.1:8787",
          authorization: "Bearer fixture-agent-token",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/session", "GET", {
          host: "127.0.0.1:8787",
          authorization: "Bearer invalid",
          cookie: "sticker_session=forged",
        })
      ).status,
      401,
    );
    const agent: unknown = await (
      await call("/session", "GET", {
        authorization: "Bearer fixture-agent-token",
      })
    ).json();
    assert.ok(agent && typeof agent === "object" && "actor" in agent);
    assert.notDeepEqual(agent.actor, body.actor);
    const maliciousHeaders: Record<string, string>[] = [
      { host: "evil.test" },
      { origin: "http://evil.test" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "x-forwarded-host": "localhost:8787" },
      { "tailscale-user-login": "owner" },
    ];
    for (const headers of maliciousHeaders)
      assert.equal((await call("/bootstrap", "GET", headers)).status, 403);
    assert.equal((await call("/session", "POST")).status, 403);
    const login = await call("/session", "POST", {
      origin: "http://localhost:8787",
      "content-type": "application/json",
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get("set-cookie"), null);
    assert.equal(
      (
        await call("/session", "POST", {
          origin: "http://localhost:8787",
          authorization: "Bearer invalid",
          "content-type": "application/json",
        })
      ).status,
      401,
    );
    assert.equal(
      (await call("/session", "DELETE", { origin: "http://localhost:8787" }))
        .status,
      409,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    instance.close();
    rmSync(root, { recursive: true, force: true });
  }
});
void test("password mode remains default and rejects missing password", () => {
  const root = mkdtempSync(join(tmpdir(), "local-default-"));
  try {
    assert.throws(
      () => createApp({ dataDir: root, ownerPassword: "" }),
      /OWNER_PASSWORD/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
