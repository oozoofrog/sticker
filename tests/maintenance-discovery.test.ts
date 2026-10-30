import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { sessionHttpFixture } from "./session-fixture.js";
import { requiredHeader } from "./helpers.js";
import {
  githubDiscoverySourcesSchema,
  githubDiscoveryPageSchema,
  githubSelectionStatusSchema,
} from "../server/contracts/github-discovery.js";

for (const route of ["repositories", "select"] as const) {
  for (const outcome of ["success", "failure", "stale"] as const) {
    void test(`discovery ${route} ${outcome}: disconnected request retains lease until provider settles`, async () => {
      let release!: () => void,
        entered!: () => void,
        gated = false,
        calls = 0;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const option = {
        id: 123,
        repository: { owner: "octocat", name: "selected" },
        visibility: "public" as const,
        archived: false,
        disabled: false,
      };
      const wait = async (current: typeof route) => {
        calls++;
        if (!gated || current !== route) return;
        entered();
        await pending;
        if (outcome === "failure")
          throw new Error("synthetic provider failure");
      };
      const f = await sessionHttpFixture({
        enabled: true,
        client: () => ({
          verify: () => Promise.resolve(),
          inspect: () => Promise.reject(new Error("unused")),
          listRepositories: async () => {
            await wait("repositories");
            return { items: [option], hasMore: false };
          },
          verifySelection: async () => {
            await wait("select");
          },
        }),
      });
      try {
        const path = `/projects/${f.project.id}/github`;
        assert.equal(
          (
            await f.call(path, "owner", "PUT", {
              repository: { owner: "octocat", name: "original" },
              mode: "public",
              revision: 0,
              confirm: true,
            })
          ).status,
          200,
        );
        const sources = githubDiscoverySourcesSchema.parse(
          await (await f.call(`${path}/sources`)).json(),
        );
        const sourceId = sources.sources[0].id;
        const page = githubDiscoveryPageSchema.parse(
          await (
            await f.call(`${path}/repositories`, "owner", "POST", { sourceId })
          ).json(),
        );
        const selection = {
          sourceId,
          selectionId: page.repositories[0].selectionId,
          revision: sources.revision,
          confirm: true,
        };
        const login = await fetch(`${f.base}/api/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            password: "disposable-session-owner-password",
          }),
        });
        const cookie = requiredHeader(login, "set-cookie").split(";")[0];
        gated = true;
        const abort = new AbortController();
        const request = fetch(`${f.base}/api${path}/${route}`, {
          method: "POST",
          headers: {
            cookie,
            origin: "http://localhost:8787",
            "content-type": "application/json",
          },
          body: JSON.stringify(route === "select" ? selection : { sourceId }),
          signal: abort.signal,
        }).catch(() => null);
        await started;
        abort.abort();
        await request;
        // Let the server observe socket close, otherwise the HTTP lease masks missing operation leases.
        await delay(25);
        if (outcome === "stale")
          assert.equal(
            (
              await f.call(path, "owner", "DELETE", {
                revision: 1,
                confirm: true,
              })
            ).status,
            200,
          );
        const initial = f.instance.maintenance.snapshot();
        f.instance.maintenance.change("begin", {
          instanceId: initial.instanceId,
          revision: initial.revision,
          confirm: true,
        });
        assert.equal(await f.instance.maintenance.waitForIdle(25), false);
        const before = calls;
        for (const [suffix, method, body] of [
          ["sources", "GET", undefined],
          ["repositories", "POST", { sourceId }],
          ["select", "POST", selection],
          ["selection-status", "POST", selection],
        ] as const)
          assert.equal(
            (await f.call(`${path}/${suffix}`, "owner", method, body)).status,
            503,
          );
        assert.equal(calls, before);
        release();
        assert.equal(await f.instance.maintenance.waitForIdle(1000), true);
        const state = f.instance.maintenance.snapshot();
        f.instance.maintenance.change("resume", {
          instanceId: state.instanceId,
          revision: state.revision,
          confirm: true,
        });
        const status = githubSelectionStatusSchema.parse(
          await (
            await f.call(`${path}/selection-status`, "owner", "POST", selection)
          ).json(),
        );
        assert.equal(
          status.matches,
          route === "select" && outcome === "success",
        );
        assert.equal(
          status.connection.revision,
          outcome === "stale" || (route === "select" && outcome === "success")
            ? 2
            : 1,
        );
        assert.equal(status.connection.connected, outcome !== "stale");
        assert.equal((await f.call(`${path}/sources`, "agent")).status, 403);
        assert.equal(
          (await f.call(`${path}/selection-status`, "read", "POST", selection))
            .status,
          403,
        );
        assert.equal((await f.call(`${path}/sources`)).status, 200);
      } finally {
        release();
        await f.instance.maintenance.waitForIdle(1000);
        await f.close();
      }
    });
  }
}
