import test from "node:test";
import assert from "node:assert/strict";
import {
  mcpSettingsFixture,
  mcpSettingsPassword,
} from "./mcp-settings-fixture.js";
import { agentInstallCatalogSchema } from "../server/contracts/agent-install.js";
void test("agent installer catalog is owner-only and projects grants without credentials or local installation claims", async () => {
  const f = await mcpSettingsFixture();
  const post = (who: "owner" | "read", body: unknown) =>
    fetch(`${f.base}/api/agent-install/bundle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(who === "owner"
          ? { cookie: f.cookie, origin: "http://localhost:8787" }
          : { authorization: `Bearer ${f.tokens.read}` }),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await f.request("/agent-install", "anonymous")).status, 401);
    for (const who of ["read", "write", "all", "none", "missing"] as const)
      assert.equal((await f.request("/agent-install", who)).status, 403);
    const result = await f.request("/agent-install");
    assert.equal(result.status, 200);
    const text = await result.text(),
      catalog = agentInstallCatalogSchema.parse(JSON.parse(text));
    assert.equal(catalog.scope, "user");
    assert.equal(catalog.verification, "local_execution_required");
    assert.ok(catalog.skill.content.includes("explicit invocation"));
    assert.ok(!text.includes(mcpSettingsPassword));
    for (const token of Object.values(f.tokens))
      assert.ok(!text.includes(token));
    for (const grant of f.agents) assert.ok(!text.includes(grant.tokenHash));
    assert.ok(!text.includes("tokenHash"));
    assert.equal(catalog.agents.length, 5);
    const prepared = await post("owner", {
      previewHash: catalog.previewHash,
      mcp: true,
      skill: true,
      agentId: "read",
    });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.headers.get("content-type"), "application/zip");
    const archive = Buffer.from(await prepared.arrayBuffer());
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    const contents = archive.toString("utf8");
    assert.ok(contents.includes("Installer verification failed"));
    assert.ok(contents.includes("config/batchWrite"));
    assert.ok(!contents.includes(mcpSettingsPassword));
    for (const token of Object.values(f.tokens))
      assert.ok(!contents.includes(token));
    assert.equal(
      (
        await post("read", {
          previewHash: catalog.previewHash,
          mcp: true,
          skill: true,
          agentId: "read",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post("owner", {
          previewHash: "0".repeat(64),
          mcp: true,
          skill: true,
          agentId: "read",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post("owner", {
          previewHash: catalog.previewHash,
          mcp: true,
          skill: true,
          agentId: "not-authorized",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("owner", {
          previewHash: catalog.previewHash,
          mcp: true,
          skill: true,
          agentId: "read",
          command: "injection",
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
