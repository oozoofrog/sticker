import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { createApp } from "../server/app.js";
import * as mcp from "../server/mcp.js";

const token = "synthetic-parity-agent-token-only";
const password = "synthetic-parity-owner-password-only";
const resultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

void test("concurrent owner requests scrub each request's credential after a private provider rotates", async () => {
  const f = await fixture();
  const login = await fetch(`${f.apiUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const second = login.headers.get("set-cookie")?.split(";")[0].slice(16);
  assert.ok(second);
  let reads = 0,
    release: (() => void) | undefined;
  f.setHandler((req, res) => {
    if (req.url !== "/api/bootstrap") {
      f.instances[0].app(req, res);
      return;
    }
    const own = req.headers.cookie?.slice(16);
    const respond = () => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: own,
          code: "REMOTE_ERROR",
          fields: { credential: own },
        }),
      );
    };
    if (!release) release = respond;
    else {
      respond();
      release();
    }
  });
  const pair = await linked(
    mcp.createStickerMcp({
      apiUrl: f.apiUrl,
      auth: {
        mode: "owner-session",
        sessionProvider: () => (reads++ === 0 ? f.session : second),
      },
    }),
  );
  try {
    const responses = await Promise.all([
      pair.client.callTool({ name: "sticker_list_projects", arguments: {} }),
      pair.client.callTool({ name: "sticker_list_projects", arguments: {} }),
    ]);
    for (const response of responses) {
      assert.equal(resultSchema.parse(response).isError, true);
      assert.ok(!JSON.stringify(response).includes(f.session));
      assert.ok(!JSON.stringify(response).includes(second));
    }
  } finally {
    await pair.close();
    await f.close();
  }
});
function payload(value: unknown): unknown {
  return JSON.parse(resultSchema.parse(value).content[0].text);
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sticker-mcp-parity-"));
  let handler: RequestListener = (_req, res) => {
    res.writeHead(503).end();
  };
  const http = createServer((req, res) => {
    handler(req, res);
  });
  http.listen(0, "127.0.0.1");
  await new Promise<void>((r) => http.once("listening", r));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${String(address.port)}`;
  const instances = ["password", "trusted-loopback"].map((mode) =>
    createApp({
      dataDir: join(dir, mode),
      appOrigin: apiUrl,
      ownerPassword: password,
      localOwnerMode: mode === "password" ? undefined : "trusted-loopback",
      agents: [
        {
          id: "scoped",
          name: "Scoped",
          tokenHash: createHash("sha256").update(token).digest("hex"),
          projectIds: [],
          canWrite: true,
        },
        {
          id: "reader",
          name: "Reader",
          tokenHash: createHash("sha256").update(`${token}-read`).digest("hex"),
          projectIds: [],
          canWrite: false,
        },
      ],
    }),
  );
  handler = instances[0].app;
  const login = await fetch(`${apiUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const session = login.headers
    .get("set-cookie")
    ?.split(";")[0]
    .slice("sticker_session=".length);
  assert.ok(session);
  return {
    dir,
    apiUrl,
    session,
    instances,
    setHandler(next: RequestListener) {
      handler = next;
    },
    async close() {
      http.closeAllConnections();
      await new Promise<void>((r) =>
        http.close(() => {
          r();
        }),
      );
      for (const instance of instances) instance.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function linked(server: ReturnType<typeof mcp.createStickerMcp>) {
  const client = new Client({ name: "parity-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

void test("expected auth mode cannot turn an invalid cookie or missing bearer into a local owner mutation", async () => {
  const f = await fixture();
  f.setHandler(f.instances[1].app);
  try {
    for (const mode of ["owner-session", "agent", "invalid"]) {
      const response = await fetch(`${f.apiUrl}/api/projects`, {
        method: "POST",
        headers: {
          origin: f.apiUrl,
          "content-type": "application/json",
          "x-sticker-auth-mode": mode,
          cookie: "sticker_session=invalid",
        },
        body: JSON.stringify({ key: "NO", name: "Denied" }),
      });
      assert.equal(response.status, 401, `unexpected authority for ${mode}`);
    }
    assert.equal(
      f.instances[1].store.bootstrap({
        id: "owner",
        name: "Owner",
        role: "owner",
        canWrite: true,
        projectIds: null,
      }).projects.length,
      0,
    );
    const legacy = await fetch(`${f.apiUrl}/api/session`);
    assert.equal(legacy.status, 200);
    const invalid = await fetch(`${f.apiUrl}/api/session`, {
      headers: {
        authorization: "Bearer invalid",
        "x-sticker-auth-mode": "agent",
      },
    });
    assert.equal(invalid.status, 401);
  } finally {
    await f.close();
  }
});

void test("default agent discovers real names and authority without gaining newly created project scope", async () => {
  const f = await fixture(),
    pair = await linked(mcp.createStickerMcp(f.apiUrl, token));
  try {
    const names = (await pair.client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("sticker_get_capabilities"));
    assert.ok(names.includes("sticker_create_project"));
    const caps = z
      .object({
        actor: z.object({
          role: z.literal("agent"),
          projectIds: z.array(z.string()),
          canWrite: z.literal(true),
        }),
        actions: z.array(
          z.object({
            tool: z.string(),
            availability: z.string(),
            reason: z.string().optional(),
          }),
        ),
        clientVisibility: z.object({ status: z.literal("unknown") }),
      })
      .parse(
        payload(
          await pair.client.callTool({
            name: "sticker_get_capabilities",
            arguments: {},
          }),
        ),
      );
    assert.deepEqual(caps.actor.projectIds, []);
    assert.equal(
      caps.actions.find((a) => a.tool === "sticker_create_project")?.reason,
      "owner_required",
    );
    const denied = resultSchema.parse(
      await pair.client.callTool({
        name: "sticker_create_project",
        arguments: { key: "NO", name: "Denied" },
      }),
    );
    assert.equal(denied.isError, true);
    assert.equal(
      z.object({ code: z.string() }).parse(payload(denied)).code,
      "owner_required",
    );
    const owner = await linked(
      mcp.createStickerMcp({
        apiUrl: f.apiUrl,
        auth: { mode: "owner-session", sessionProvider: () => f.session },
      }),
    );
    try {
      await owner.client.callTool({
        name: "sticker_create_project",
        arguments: { key: "OK", name: "Owner project" },
      });
    } finally {
      await owner.close();
    }
    assert.deepEqual(
      payload(
        await pair.client.callTool({
          name: "sticker_list_projects",
          arguments: {},
        }),
      ),
      [],
    );
    const help = z
      .object({
        actions: z.array(z.object({ tool: z.string() })),
        clientVisibility: z.object({
          status: z.literal("reported"),
          missingTools: z.array(z.string()),
        }),
      })
      .parse(
        payload(
          await pair.client.callTool({
            name: "sticker_get_help",
            arguments: { visibleTools: ["sticker_get_help"] },
          }),
        ),
      );
    assert.deepEqual(help.actions.map((a) => a.tool).sort(), names.sort());
    assert.ok(
      help.clientVisibility.missingTools.includes("sticker_create_project"),
    );
  } finally {
    await pair.close();
    await f.close();
  }
});

void test("explicit trusted owner rejects remote origins and password deployments without exposing provider errors", async () => {
  assert.throws(
    () =>
      mcp.createStickerMcp({
        apiUrl: "https://example.invalid",
        auth: { mode: "trusted-local-owner" },
      }),
    /loopback/i,
  );
  const f = await fixture();
  try {
    for (const auth of [
      { mode: "trusted-local-owner" as const },
      {
        mode: "owner-session" as const,
        sessionProvider: () => {
          throw new Error(`${f.session} ${f.dir}`);
        },
      },
    ]) {
      const pair = await linked(
        mcp.createStickerMcp({ apiUrl: f.apiUrl, auth }),
      );
      try {
        const response = resultSchema.parse(
          await pair.client.callTool({
            name: "sticker_get_capabilities",
            arguments: {},
          }),
        );
        assert.equal(response.isError, true);
        assert.ok(!JSON.stringify(response).includes(f.session));
        assert.ok(!JSON.stringify(response).includes(f.dir));
      } finally {
        await pair.close();
      }
    }
  } finally {
    await f.close();
  }
});

void test("owner session is revalidated after revocation and cannot inherit trusted-loopback fallback", async () => {
  const f = await fixture(),
    pair = await linked(
      mcp.createStickerMcp({
        apiUrl: f.apiUrl,
        auth: { mode: "owner-session", sessionProvider: () => f.session },
      }),
    );
  try {
    assert.equal(
      resultSchema.parse(
        await pair.client.callTool({
          name: "sticker_get_capabilities",
          arguments: {},
        }),
      ).isError,
      undefined,
    );
    await fetch(`${f.apiUrl}/api/session`, {
      method: "DELETE",
      headers: { cookie: `sticker_session=${f.session}`, origin: f.apiUrl },
    });
    const expired = resultSchema.parse(
      await pair.client.callTool({
        name: "sticker_create_project",
        arguments: { key: "NO", name: "Expired" },
      }),
    );
    assert.equal(expired.isError, true);
    f.setHandler(f.instances[1].app);
    const switched = resultSchema.parse(
      await pair.client.callTool({
        name: "sticker_create_project",
        arguments: { key: "NO", name: "Switched" },
      }),
    );
    assert.equal(switched.isError, true);
    assert.ok(!JSON.stringify(switched).includes(f.session));
  } finally {
    await pair.close();
    await f.close();
  }
});

void test("a deployment switch after session preflight rejects the actual owner-session POST without writing", async () => {
  const f = await fixture();
  let switched = false,
    posts = 0;
  f.setHandler((req, res) => {
    if (req.method === "POST" && req.url === "/api/projects") {
      posts++;
      assert.equal(req.headers["x-sticker-auth-mode"], "owner-session");
    }
    if (switched) f.instances[1].app(req, res);
    else {
      if (req.method === "GET" && req.url === "/api/session")
        res.once("finish", () => {
          switched = true;
        });
      f.instances[0].app(req, res);
    }
  });
  const pair = await linked(
    mcp.createStickerMcp({
      apiUrl: f.apiUrl,
      auth: { mode: "owner-session", sessionProvider: () => f.session },
    }),
  );
  try {
    // Use an existing write tool: this forces preflight immediately before POST.
    const response = resultSchema.parse(
      await pair.client.callTool({
        name: "sticker_create_version",
        arguments: { projectId: "absent", name: "No write" },
      }),
    );
    assert.equal(response.isError, true);
    assert.equal(
      z.object({ status: z.number() }).parse(payload(response)).status,
      401,
    );
    // Re-arm and exercise the new non-idempotent create as well.
    switched = false;
    const create = resultSchema.parse(
      await pair.client.callTool({
        name: "sticker_create_project",
        arguments: { key: "NO", name: "No write" },
      }),
    );
    assert.equal(create.isError, true);
    assert.equal(posts, 1);
    assert.equal(
      f.instances[1].store.bootstrap({
        id: "owner",
        name: "Owner",
        role: "owner",
        canWrite: true,
        projectIds: null,
      }).projects.length,
      0,
    );
  } finally {
    await pair.close();
    await f.close();
  }
});

void test("fresh official STDIO owner starts empty, creates project and keyed issue, and reads both without a browser", async () => {
  const f = await fixture();
  f.setHandler(f.instances[1].app);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "server/mcp.ts"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      STICKER_API_URL: f.apiUrl,
      STICKER_MCP_AUTH_MODE: "trusted-local-owner",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "fresh-owner", version: "1" });
  try {
    await client.connect(transport);
    assert.equal(
      z.object({ actor: z.object({ role: z.string() }) }).parse(
        payload(
          await client.callTool({
            name: "sticker_get_capabilities",
            arguments: {},
          }),
        ),
      ).actor.role,
      "owner",
    );
    assert.deepEqual(
      z.object({ projects: z.array(z.unknown()) }).parse(
        payload(
          await client.callTool({
            name: "sticker_get_bootstrap",
            arguments: {},
          }),
        ),
      ).projects,
      [],
    );
    const project = z.object({ id: z.string(), key: z.literal("NEW") }).parse(
      payload(
        await client.callTool({
          name: "sticker_create_project",
          arguments: { key: "NEW", name: "Fresh project" },
        }),
      ),
    );
    const projects = z.array(z.object({ id: z.string() })).parse(
      payload(
        await client.callTool({
          name: "sticker_list_projects",
          arguments: {},
        }),
      ),
    );
    assert.deepEqual(
      projects.map((p) => p.id),
      [project.id],
    );
    const issue = z.object({ id: z.string(), key: z.literal("NEW-1") }).parse(
      payload(
        await client.callTool({
          name: "sticker_create_issue",
          arguments: {
            projectId: project.id,
            title: "Fresh task",
            operationId: randomUUID(),
          },
        }),
      ),
    );
    const detail = z.object({ issue: z.object({ title: z.string() }) }).parse(
      payload(
        await client.callTool({
          name: "sticker_get_issue",
          arguments: { issueId: issue.id },
        }),
      ),
    );
    assert.equal(detail.issue.title, "Fresh task");
  } finally {
    await client.close();
    await f.close();
  }
});

void test("lost create response is uncertain and nonretryable; independent readback finds exactly one project", async () => {
  const f = await fixture();
  let creates = 0;
  f.setHandler((req, res) => {
    if (req.method === "POST" && req.url === "/api/projects") {
      creates++;
      res.end = (() => {
        res.destroy();
        return res;
      }) as typeof res.end;
    }
    f.instances[0].app(req, res);
  });
  const pair = await linked(
    mcp.createStickerMcp({
      apiUrl: f.apiUrl,
      auth: { mode: "owner-session", sessionProvider: () => f.session },
    }),
  );
  try {
    const response = resultSchema.parse(
      await pair.client.callTool({
        name: "sticker_create_project",
        arguments: { key: "ONCE", name: "Lost response" },
      }),
    );
    assert.equal(response.isError, true);
    const failure = z
      .object({
        outcome: z.literal("uncertain"),
        retryable: z.literal(false),
        readback: z.string(),
      })
      .parse(payload(response));
    assert.equal(failure.readback, "sticker_list_projects");
    assert.equal(creates, 1);
    assert.equal(
      z.array(z.unknown()).parse(
        payload(
          await pair.client.callTool({
            name: "sticker_list_projects",
            arguments: {},
          }),
        ),
      ).length,
      1,
    );
  } finally {
    await pair.close();
    await f.close();
  }
});

void test("owner credential file is explicit, private, bounded, nonsymlink and never exposed by startup errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-mcp-private-")),
    file = join(dir, "session.json"),
    secret = "A".repeat(43);
  try {
    writeFileSync(file, JSON.stringify({ session: secret }), { mode: 0o600 });
    const env = {
      STICKER_API_URL: "http://127.0.0.1:9999",
      STICKER_MCP_AUTH_MODE: "owner-session",
      STICKER_OWNER_SESSION_FILE: file,
    };
    assert.ok(mcp.mcpOptionsFromEnvironment(env));
    for (const mutate of [
      () => {
        chmodSync(file, 0o644);
      },
      () => {
        chmodSync(file, 0o600);
        writeFileSync(
          file,
          JSON.stringify({ session: secret, password: "not-accepted" }),
        );
      },
      () => {
        writeFileSync(file, "x".repeat(2048));
      },
      () => {
        rmSync(file);
        symlinkSync("missing", file);
      },
    ]) {
      mutate();
      assert.throws(
        () => mcp.mcpOptionsFromEnvironment(env),
        (error: unknown) =>
          error instanceof Error &&
          !error.message.includes(file) &&
          !error.message.includes(secret),
      );
    }
    assert.throws(() =>
      mcp.mcpOptionsFromEnvironment({
        ...env,
        STICKER_MCP_AUTH_MODE: "automatic-owner",
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("an explicit trusted-owner request cannot authenticate as a bearer agent", async () => {
  const f = await fixture();
  f.setHandler(f.instances[1].app);
  try {
    const response = await fetch(`${f.apiUrl}/api/session`, {
      headers: {
        "x-sticker-auth-mode": "trusted-local-owner",
        authorization: `Bearer ${token}`,
      },
    });
    assert.equal(response.status, 401);
  } finally {
    await f.close();
  }
});

void test("the new auth-mode contract cannot use the browser login route to change its credential mechanism", async () => {
  const f = await fixture();
  try {
    for (const mode of [
      "agent",
      "owner-session",
      "trusted-local-owner",
      "invalid",
    ]) {
      const response = await fetch(`${f.apiUrl}/api/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sticker-auth-mode": mode,
        },
        body: JSON.stringify({ password }),
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), null);
    }
  } finally {
    await f.close();
  }
});

void test("read-only and invalid agents keep their authority while discovery reports conditional target checks", async () => {
  const f = await fixture();
  f.setHandler(f.instances[1].app);
  try {
    for (const suppliedToken of [`${token}-read`, `${token}-invalid`]) {
      const pair = await linked(mcp.createStickerMcp(f.apiUrl, suppliedToken));
      try {
        const response = resultSchema.parse(
          await pair.client.callTool({
            name: "sticker_get_capabilities",
            arguments: {},
          }),
        );
        if (suppliedToken.endsWith("invalid")) {
          assert.equal(response.isError, true);
          assert.equal(
            z.object({ status: z.number() }).parse(payload(response)).status,
            401,
          );
        } else {
          const caps = z
            .object({
              actor: z.object({ canWrite: z.literal(false) }),
              actions: z.array(
                z.object({
                  tool: z.string(),
                  availability: z.string(),
                  reason: z.string().optional(),
                }),
              ),
            })
            .parse(payload(response));
          assert.equal(
            caps.actions.find((a) => a.tool === "sticker_create_issue")?.reason,
            "write_permission_required",
          );
          assert.equal(
            caps.actions.find((a) => a.tool === "sticker_get_issue")
              ?.availability,
            "conditional",
          );
          const write = resultSchema.parse(
            await pair.client.callTool({
              name: "sticker_create_version",
              arguments: { projectId: "none", name: "Denied" },
            }),
          );
          assert.equal(write.isError, true);
          assert.equal(
            z.object({ status: z.number() }).parse(payload(write)).status,
            403,
          );
        }
      } finally {
        await pair.close();
      }
    }
  } finally {
    await f.close();
  }
});

void test("existing owner-session TTL expiry blocks a later mutation without leaking the session", async () => {
  const f = await fixture(),
    pair = await linked(
      mcp.createStickerMcp({
        apiUrl: f.apiUrl,
        auth: { mode: "owner-session", sessionProvider: () => f.session },
      }),
    );
  const now = Date.now;
  try {
    await pair.client.callTool({
      name: "sticker_get_capabilities",
      arguments: {},
    });
    Date.now = () => now() + 13 * 60 * 60 * 1000;
    const response = resultSchema.parse(
      await pair.client.callTool({
        name: "sticker_create_project",
        arguments: { key: "NO", name: "Expired" },
      }),
    );
    assert.equal(response.isError, true);
    assert.equal(
      z.object({ status: z.number() }).parse(payload(response)).status,
      401,
    );
    assert.ok(!JSON.stringify(response).includes(f.session));
  } finally {
    Date.now = now;
    await pair.close();
    await f.close();
  }
});

void test("owner verification rejects a non-owner response and scrubs private credentials from upstream error fields", async () => {
  const f = await fixture();
  let invalidActor = true;
  f.setHandler((req, res) => {
    if (invalidActor && req.url === "/api/session" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          actor: {
            id: "scoped",
            name: "Scoped",
            role: "agent",
            canWrite: true,
            projectIds: [],
          },
        }),
      );
    } else if (!invalidActor && req.url === "/api/bootstrap") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: f.session,
          code: f.session,
          fields: { [f.session]: f.session },
        }),
      );
    } else f.instances[0].app(req, res);
  });
  const pair = await linked(
    mcp.createStickerMcp({
      apiUrl: f.apiUrl,
      auth: { mode: "owner-session", sessionProvider: () => f.session },
    }),
  );
  try {
    const invalid = resultSchema.parse(
      await pair.client.callTool({
        name: "sticker_create_project",
        arguments: { key: "NO", name: "Invalid principal" },
      }),
    );
    assert.equal(invalid.isError, true);
    assert.equal(
      z.object({ code: z.string() }).parse(payload(invalid)).code,
      "auth_actor_mismatch",
    );
    invalidActor = false;
    const failure = resultSchema.parse(
      await pair.client.callTool({
        name: "sticker_list_projects",
        arguments: {},
      }),
    );
    assert.equal(failure.isError, true);
    assert.ok(!JSON.stringify(failure).includes(f.session));
    assert.equal(
      z.object({ status: z.number() }).parse(payload(failure)).status,
      503,
    );
  } finally {
    await pair.close();
    await f.close();
  }
});
