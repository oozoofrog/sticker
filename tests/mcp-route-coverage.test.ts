import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ordinaryMcpFixture } from "./mcp-product-fixture.js";
void test("ordinary route/discovery contract covers every actual route without prior build assets", async () => {
  const previousCwd = process.cwd(),
    cleanCwd = mkdtempSync(join(tmpdir(), "sticker-mcp-clean-cwd-"));
  let f: Awaited<ReturnType<typeof ordinaryMcpFixture>> | undefined;
  try {
    process.chdir(cleanCwd);
    f = await ordinaryMcpFixture();
    process.chdir(previousCwd);
    const {
      routeCoverage,
      normalizedRoute,
      MCP_ROUTE_EQUIVALENTS,
      MCP_ROUTE_EXCEPTIONS,
    } = await import("../server/mcp/route-coverage.js");
    const { MCP_CATALOGUE } = await import("../server/mcp/catalogue.js");
    const routeSchema = z.object({
      route: z
        .object({
          path: z.union([z.string(), z.array(z.string())]),
          methods: z.record(z.string(), z.boolean()),
        })
        .optional(),
    });
    const stack: z.infer<typeof routeSchema>[] = z
      .array(routeSchema)
      .parse(f.instance.app.router.stack);
    const actual = stack.flatMap((layer) =>
      layer.route
        ? Object.entries(layer.route.methods)
            .filter(([, enabled]) => enabled)
            .flatMap(([method]) =>
              (Array.isArray(layer.route?.path)
                ? layer.route.path
                : [layer.route?.path]
              ).map((path) => `${method.toUpperCase()} ${String(path)}`),
            )
        : [],
    );
    assert.equal(actual.length, 106);
    for (const route of actual) {
      const coverage = routeCoverage(route);
      assert.ok(
        coverage.tools.length || coverage.equivalent || coverage.exception,
        `Unmapped route: ${route}`,
      );
      assert.ok(
        !(coverage.exception && coverage.tools.length),
        `Shipped route still excepted: ${route}`,
      );
    }
    for (const entry of [
      ...MCP_CATALOGUE.flatMap((e) => e.route.map((route) => ({ route }))),
      ...MCP_ROUTE_EQUIVALENTS,
      ...MCP_ROUTE_EXCEPTIONS,
    ])
      assert.ok(
        actual.some(
          (route) => normalizedRoute(route) === normalizedRoute(entry.route),
        ),
        `Coverage targets absent route ${entry.route}`,
      );
    const tools = (await f.clients[0].client.listTools()).tools;
    assert.equal(new Set(tools.map((t) => t.name)).size, 97);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      MCP_CATALOGUE.map((t) => t.tool).sort(),
    );
    for (const entry of MCP_CATALOGUE) {
      const discovered = tools.find((t) => t.name === entry.tool);
      assert.ok(discovered);
      if (entry.effect === "write")
        assert.ok(
          entry.readback,
          `${entry.tool} needs meaningful readback guidance`,
        );
      assert.equal(
        discovered.annotations?.readOnlyHint,
        entry.effect === "read",
      );
      if (entry.confirm === "literal-true")
        assert.ok(
          JSON.stringify(discovered.inputSchema).includes('"const":true'),
        );
    }
    assert.equal(routeCoverage("GET /api/brand-new-feature").tools.length, 0);
    assert.equal(
      routeCoverage("GET /api/brand-new-feature").exception,
      undefined,
    );
    const shell = await fetch(`${f.apiUrl}/`);
    assert.equal(shell.status, 200);
    assert.ok((await shell.text()).includes("synthetic MCP fixture"));
  } finally {
    process.chdir(previousCwd);
    await f?.close();
    rmSync(cleanCwd, { recursive: true, force: true });
  }
});
