import { requiredHeader } from "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import { sessionHttpFixture } from "./session-fixture.js";

void test("maintenance is owner-controlled CAS, gates business reads/writes, and preserves status/auth routes", async () => {
  const f = await sessionHttpFixture();
  try {
    const initial = await f.call("/maintenance");
    assert.equal(initial.status, 200);
    const state = (await initial.json()) as {
      instanceId: string;
      revision: number;
      state: string;
    };
    assert.equal(state.state, "serving");
    assert.equal((await f.call("/maintenance", "anonymous")).status, 401);
    const input = {
      instanceId: state.instanceId,
      revision: state.revision,
      confirm: true,
    };
    assert.equal(
      (await f.call("/maintenance/begin", "agent", "POST", input)).status,
      403,
    );
    assert.equal(
      (await f.call("/maintenance/begin", "read", "POST", input)).status,
      403,
    );
    const begun = await f.call("/maintenance/begin", "owner", "POST", input);
    assert.equal(begun.status, 200);
    const draining = (await begun.json()) as typeof state;
    assert.equal(draining.state, "draining");
    assert.equal(
      (draining as typeof draining & { drained: boolean }).drained,
      true,
    );
    assert.equal(draining.revision, state.revision + 1);
    for (const [path, method] of [
      ["/bootstrap", "GET"],
      ["/issues", "POST"],
      ["/maintenance/anything", "GET"],
      ["/maintenance", "DELETE"],
    ]) {
      const denied = await f.call(path, "owner", method);
      assert.equal(denied.status, 503);
      assert.equal(denied.headers.get("retry-after"), "5");
      assert.equal(
        ((await denied.json()) as { code: string }).code,
        "MAINTENANCE",
      );
    }
    assert.equal((await f.call("/maintenance", "agent")).status, 200);
    assert.equal((await f.call("/session")).status, 200);
    assert.equal((await fetch(`${f.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${f.base}/readyz`)).status, 503);
    assert.equal(
      (await f.call("/maintenance/resume", "owner", "POST", input)).status,
      409,
    );
    assert.equal(
      (
        await f.call("/maintenance/begin", "owner", "POST", {
          ...input,
          revision: draining.revision,
        })
      ).status,
      200,
    );
    const resumed = await f.call("/maintenance/resume", "owner", "POST", {
      ...input,
      revision: draining.revision,
    });
    assert.equal(resumed.status, 200);
    assert.equal((await f.call("/bootstrap")).status, 200);
    assert.equal((await fetch(`${f.base}/readyz`)).status, 200);
  } finally {
    await f.close();
  }
});

void test("maintenance retains async operation leases after a disconnected HTTP request", async () => {
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const f = await sessionHttpFixture({
    enabled: true,
    client: () => ({
      verify: async () => {
        entered();
        await pending;
      },
      inspect: () => Promise.reject(new Error("unused")),
    }),
  });
  try {
    const path = `/projects/${f.project.id}/github`;
    await f.call(path, "owner", "PUT", {
      repository: { owner: "octocat", name: "fixture" },
      mode: "public",
      revision: 0,
      confirm: true,
    });
    // Capture the ordinary owner cookie without changing production authentication.
    const login = await fetch(`${f.base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "disposable-session-owner-password" }),
    });
    const cookie = requiredHeader(login, "set-cookie").split(";")[0];
    const abort = new AbortController();
    const request = fetch(`${f.base}/api${path}/verify`, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost:8787",
        "content-type": "application/json",
      },
      body: JSON.stringify({ revision: 1, confirm: true }),
      signal: abort.signal,
    }).catch(() => null);
    await started;
    abort.abort();
    await request;
    const initial = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("begin", {
      instanceId: initial.instanceId,
      revision: initial.revision,
      confirm: true,
    });
    assert.equal(f.instance.maintenance.snapshot().drained, false);
    assert.equal(await f.instance.maintenance.waitForIdle(15), false);
    release();
    assert.equal(await f.instance.maintenance.waitForIdle(1000), true);
    const state = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("resume", {
      instanceId: state.instanceId,
      revision: state.revision,
      confirm: true,
    });
    const connection = (await (await f.call(path)).json()) as {
      revision: number;
      lastVerifiedAt: string | null;
    };
    assert.equal(connection.revision, 2);
    assert.ok(connection.lastVerifiedAt);
  } finally {
    release();
    await f.close();
  }
});

void test("maintenance rejects forged Origin and prior process identity without changing state", async () => {
  const f = await sessionHttpFixture();
  try {
    const state = f.instance.maintenance.snapshot();
    assert.throws(
      () =>
        f.instance.maintenance.change("begin", {
          instanceId: "00000000-0000-4000-8000-000000000001",
          revision: 0,
          confirm: true,
        }),
      /현재 서버/,
    );
    const login = await fetch(`${f.base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "disposable-session-owner-password" }),
    });
    const denied = await fetch(`${f.base}/api/maintenance/begin`, {
      method: "POST",
      headers: {
        cookie: requiredHeader(login, "set-cookie").split(";")[0],
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        instanceId: state.instanceId,
        revision: state.revision,
        confirm: true,
      }),
    });
    assert.equal(denied.status, 403);
    assert.equal(f.instance.maintenance.snapshot().state, "serving");
  } finally {
    await f.close();
  }
});

void test("slow aborted multipart cannot be reported drained before its upload callback settles", async () => {
  const { request } = await import("node:http");
  const f = await sessionHttpFixture();
  let upload: ReturnType<typeof request> | undefined;
  try {
    upload = request(`${f.base}/api/issues/${f.issue.id}/attachments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.tokens.agent}`,
        "content-type": "multipart/form-data; boundary=fixture",
        "content-length": "100000",
      },
    });
    upload.on("error", () => {});
    upload.write(
      '--fixture\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\nContent-Type: text/plain\r\n\r\npartial',
    );
    // A separate status request queued after these bytes ensures server admission has run.
    await f.call("/maintenance");
    const state = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("begin", {
      instanceId: state.instanceId,
      revision: state.revision,
      confirm: true,
    });
    assert.equal(await f.instance.maintenance.waitForIdle(15), false);
    upload.destroy();
    assert.equal(await f.instance.maintenance.waitForIdle(1000), true);
    const next = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("resume", {
      instanceId: next.instanceId,
      revision: next.revision,
      confirm: true,
    });
    const issue = (await (await f.call(`/issues/${f.issue.id}`)).json()) as {
      attachments: unknown[];
    };
    assert.equal(issue.attachments.length, 0);
  } finally {
    upload?.destroy();
    await f.close();
  }
});

void test("real sendFile download abort drains once and subsequent finish/close does not corrupt leases", async () => {
  const { get } = await import("node:http");
  const f = await sessionHttpFixture();
  let download: import("node:http").IncomingMessage | undefined;
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(8 * 1024 * 1024).fill(65)]),
      "synthetic-download.bin",
    );
    const uploaded = await fetch(
      `${f.base}/api/issues/${f.issue.id}/attachments`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${f.tokens.agent}` },
        body: form,
      },
    );
    assert.equal(uploaded.status, 201);
    const attachment = (await uploaded.json()) as { id: string };
    await new Promise<void>((resolve, reject) => {
      const req = get(
        `${f.base}/api/attachments/${attachment.id}/file`,
        { headers: { authorization: `Bearer ${f.tokens.agent}` } },
        (res) => {
          download = res;
          assert.equal(res.statusCode, 200);
          res.once("data", () => {
            res.pause();
            resolve();
          });
          res.on("error", () => {});
        },
      );
      req.once("error", reject);
    });
    const s = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("begin", {
      instanceId: s.instanceId,
      revision: s.revision,
      confirm: true,
    });
    assert.equal(await f.instance.maintenance.waitForIdle(15), false);
    download?.destroy();
    assert.equal(await f.instance.maintenance.waitForIdle(1000), true);
    const d = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("resume", {
      instanceId: d.instanceId,
      revision: d.revision,
      confirm: true,
    });
    assert.equal((await f.call(`/issues/${f.issue.id}`)).status, 200);
    const next = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("begin", {
      instanceId: next.instanceId,
      revision: next.revision,
      confirm: true,
    });
    assert.equal(await f.instance.maintenance.waitForIdle(1000), true);
    assert.equal(f.instance.maintenance.snapshot().drained, true);
  } finally {
    download?.destroy();
    await f.close();
  }
});
