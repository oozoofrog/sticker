import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MaintenanceController } from "../server/maintenance.js";
import { createShutdown } from "../server/runtime-shutdown.js";

async function serverFixture() {
  const server = createServer((_req, res) => res.end("ok"));
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return server;
}
void test("shutdown waits detached operations and closes data once across repeated signals", async () => {
  const maintenance = new MaintenanceController(),
    server = await serverFixture();
  let finish!: () => void,
    closed = 0;
  const pending = maintenance.runOperation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const shutdown = createShutdown({
    server,
    maintenance,
    closeData: () => {
      closed++;
    },
    timeoutMs: 500,
  });
  const first = shutdown(),
    second = shutdown();
  assert.equal(first, second);
  assert.equal(maintenance.snapshot().state, "stopping");
  assert.throws(
    () =>
      maintenance.change("resume", {
        instanceId: maintenance.snapshot().instanceId,
        revision: maintenance.snapshot().revision,
        confirm: true,
      }),
    /종료 중/,
  );
  assert.equal(closed, 0);
  finish();
  await pending;
  assert.equal(await first, true);
  assert.equal(closed, 1);
  assert.equal(await shutdown(), true);
  assert.equal(closed, 1);
});
void test("shutdown timeout does not close a database still used by detached operations", async () => {
  const maintenance = new MaintenanceController(),
    server = await serverFixture();
  let finish!: () => void,
    closed = 0;
  const pending = maintenance.runOperation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const shutdown = createShutdown({
    server,
    maintenance,
    closeData: () => {
      closed++;
    },
    timeoutMs: 10,
  });
  try {
    assert.equal(await shutdown(), false);
    assert.equal(closed, 0);
  } finally {
    finish();
    await pending;
  }
  assert.equal(closed, 0);
});

void test("callback middleware lease survives response close until its completion callback", async () => {
  const express = (await import("express")).default;
  const { request } = await import("node:http");
  const app = express(),
    maintenance = new MaintenanceController();
  let settle!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  app.use(maintenance.admit);
  app.post(
    "/upload",
    maintenance.trackMiddleware((_req, _res, next) => {
      settle = () => {
        next();
      };
      entered();
    }),
    (_req, res) => {
      res.end("done");
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const req = request(`http://127.0.0.1:${String(address.port)}/upload`, {
    method: "POST",
  });
  req.on("error", () => {});
  req.end();
  try {
    await ready;
    req.destroy();
    const s = maintenance.snapshot();
    maintenance.change("begin", {
      instanceId: s.instanceId,
      revision: s.revision,
      confirm: true,
    });
    assert.equal(await maintenance.waitForIdle(15), false);
    settle();
    assert.equal(await maintenance.waitForIdle(1000), true);
  } finally {
    settle();
    req.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
  }
});
