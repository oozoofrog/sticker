import test from "node:test";
import assert from "node:assert/strict";
import { sessionHttpFixture } from "./session-fixture.js";
import {
  githubDiscoverySourcesSchema,
  githubDiscoveryPageSchema,
} from "../server/contracts/github-discovery.js";
import { githubConnectionSchema } from "../server/contracts/github.js";
import type { GithubProvider } from "../server/features/github.js";
function required<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}
const option = {
  id: 42,
  repository: { owner: "octocat", name: "selected" },
  visibility: "public" as const,
  archived: false,
  disabled: false,
};
function provider(overrides: Partial<GithubProvider> = {}): GithubProvider {
  return {
    enabled: true,
    client: () => ({
      verify: () => Promise.resolve(),
      inspect: () => Promise.reject(new Error("unused")),
      listRepositories: () =>
        Promise.resolve({ items: [option], hasMore: false }),
      verifySelection: () => Promise.resolve(),
    }),
    ...overrides,
  };
}
async function seed(f: Awaited<ReturnType<typeof sessionHttpFixture>>) {
  return f.call(`/projects/${f.project.id}/github`, "owner", "PUT", {
    repository: { owner: "octocat", name: "existing" },
    mode: "public",
    revision: 0,
    confirm: true,
  });
}
void test("owner discovers and confirms opaque public selection without identifiers; agents see no source metadata", async () => {
  const f = await sessionHttpFixture(provider());
  try {
    const path = `/projects/${f.project.id}/github`;
    await seed(f);
    for (const who of ["agent", "read", "other"] as const)
      assert.equal((await f.call(`${path}/sources`, who)).status, 403);
    const sources = githubDiscoverySourcesSchema.parse(
      await (await f.call(`${path}/sources`)).json(),
    );
    assert.equal(sources.sources.length, 1);
    const source = sources.sources[0];
    const page = githubDiscoveryPageSchema.parse(
      await (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: source.id,
        })
      ).json(),
    );
    const selection = page.repositories[0];
    assert.equal(selection.repository.name, "selected");
    const input = {
      sourceId: source.id,
      selectionId: selection.selectionId,
      revision: sources.revision,
      confirm: true,
    };
    assert.equal(
      (
        await f.call(
          `/projects/${f.other.id}/github/select`,
          "owner",
          "POST",
          input,
        )
      ).status,
      409,
    );
    const connection = githubConnectionSchema.parse(
      await (await f.call(`${path}/select`, "owner", "POST", input)).json(),
    );
    assert.equal(connection.repository?.name, "selected");
    assert.equal(connection.permissionsVerified, false);
    const state = (await (
      await f.call(`${path}/selection-status`, "owner", "POST", input)
    ).json()) as { matches: boolean };
    assert.equal(state.matches, true);
  } finally {
    await f.close();
  }
});
void test("configured source labels never expose ref or token and resolver rotation invalidates tickets", async () => {
  let token = "fixture-sensitive-one";
  const p = provider({
    credentials: {
      secretReference: { label: "개발 계정", resolve: () => token },
    },
  });
  const f = await sessionHttpFixture(p);
  try {
    const path = `/projects/${f.project.id}/github`;
    const response = await (await f.call(`${path}/sources`)).text();
    assert.ok(!response.includes("secretReference"));
    assert.ok(!response.includes(token));
    const sources = githubDiscoverySourcesSchema.parse(JSON.parse(response));
    const source = sources.sources[0];
    token = "fixture-sensitive-two";
    const rotated = await f.call(`${path}/repositories`, "owner", "POST", {
      sourceId: source.id,
    });
    assert.equal(rotated.status, 409);
    const fresh = githubDiscoverySourcesSchema.parse(
      await (await f.call(`${path}/sources`)).json(),
    );
    assert.ok(p.credentials);
    delete p.credentials.secretReference;
    assert.equal(
      (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: fresh.sources[0].id,
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
void test("connection revision changes and removed public owner invalidate discovery without overwriting current state", async () => {
  const f = await sessionHttpFixture(provider());
  try {
    await seed(f);
    const path = `/projects/${f.project.id}/github`;
    const source = githubDiscoverySourcesSchema.parse(
      await (await f.call(`${path}/sources`)).json(),
    ).sources[0];
    const page = githubDiscoveryPageSchema.parse(
      await (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: source.id,
        })
      ).json(),
    );
    await f.call(path, "owner", "DELETE", { revision: 1, confirm: true });
    assert.equal(
      (
        await f.call(`${path}/select`, "owner", "POST", {
          sourceId: source.id,
          selectionId: page.repositories[0].selectionId,
          revision: 1,
          confirm: true,
        })
      ).status,
      409,
    );
    assert.equal(
      githubConnectionSchema.parse(await (await f.call(path)).json()).connected,
      false,
    );
    assert.equal(
      githubDiscoverySourcesSchema.parse(
        await (await f.call(`${path}/sources`)).json(),
      ).sources.length,
      1,
    );
    await f.call(path, "owner", "PUT", {
      repository: { owner: "private-owner", name: "private" },
      mode: "authenticated",
      credentialRef: "missing",
      revision: 2,
      confirm: true,
    });
    assert.equal(
      githubDiscoverySourcesSchema.parse(
        await (await f.call(`${path}/sources`)).json(),
      ).sources.length,
      0,
    );
  } finally {
    await f.close();
  }
});
void test("late verified selection cannot overwrite concurrent connection change", async () => {
  let complete: () => void = () => {};
  let entered: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await sessionHttpFixture(
    provider({
      client: () => ({
        verify: () => Promise.resolve(),
        inspect: () => Promise.reject(new Error("unused")),
        listRepositories: () =>
          Promise.resolve({ items: [option], hasMore: false }),
        verifySelection: () => {
          entered();
          return new Promise<void>((resolve) => {
            complete = resolve;
          });
        },
      }),
    }),
  );
  try {
    await seed(f);
    const path = `/projects/${f.project.id}/github`;
    const source = githubDiscoverySourcesSchema.parse(
      await (await f.call(`${path}/sources`)).json(),
    ).sources[0];
    const page = githubDiscoveryPageSchema.parse(
      await (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: source.id,
        })
      ).json(),
    );
    const pending = f.call(`${path}/select`, "owner", "POST", {
      sourceId: source.id,
      selectionId: page.repositories[0].selectionId,
      revision: 1,
      confirm: true,
    });
    await waiting;
    await f.call(path, "owner", "PUT", {
      repository: { owner: "octocat", name: "concurrent" },
      mode: "public",
      revision: 1,
      confirm: true,
    });
    complete();
    assert.equal((await pending).status, 409);
    assert.equal(
      githubConnectionSchema.parse(await (await f.call(path)).json()).repository
        ?.name,
      "concurrent",
    );
  } finally {
    complete();
    await f.close();
  }
});
void test("pagination tickets are bound to source and revision, expire, and stop honestly at cap", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = await sessionHttpFixture(
    provider({
      credentials: { secondary: { label: "둘째", resolve: () => "fixture" } },
      client: () => ({
        verify: () => Promise.resolve(),
        inspect: () => Promise.reject(new Error("unused")),
        verifySelection: () => Promise.resolve(),
        listRepositories: ({ page }) =>
          Promise.resolve({ items: [{ ...option, id: page }], hasMore: true }),
      }),
    }),
  );
  try {
    await seed(f);
    const path = `/projects/${f.project.id}/github`;
    const sources = githubDiscoverySourcesSchema.parse(
      await (await f.call(`${path}/sources`)).json(),
    );
    const source = required(sources.sources.find((s) => s.mode === "public")),
      other = required(sources.sources.find((s) => s.mode === "authenticated"));
    let page = githubDiscoveryPageSchema.parse(
      await (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: source.id,
        })
      ).json(),
    );
    assert.equal(
      (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: other.id,
          cursor: page.nextCursor,
        })
      ).status,
      409,
    );
    for (let n = 2; n <= 100; n++)
      page = githubDiscoveryPageSchema.parse(
        await (
          await f.call(`${path}/repositories`, "owner", "POST", {
            sourceId: source.id,
            cursor: page.nextCursor,
          })
        ).json(),
      );
    assert.equal(page.limitReached, true);
    assert.equal(page.nextCursor, null);
    assert.equal(page.repositories[0]?.id, 100);
    t.mock.timers.tick(16 * 60 * 1000);
    assert.equal(
      (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: source.id,
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
void test("selection failures preserve old connection and uncertain status does not match different credentials or revision", async () => {
  let fail = true;
  const f = await sessionHttpFixture(
    provider({
      credentials: {
        first: { label: "同名", resolve: () => "one" },
        second: { label: "同名", resolve: () => "two" },
      },
      client: () => ({
        verify: () => Promise.resolve(),
        inspect: () => Promise.reject(new Error("unused")),
        listRepositories: () =>
          Promise.resolve({ items: [option], hasMore: false }),
        verifySelection: () =>
          fail
            ? Promise.reject(new Error("secret transport body"))
            : Promise.resolve(),
      }),
    }),
  );
  try {
    const path = `/projects/${f.project.id}/github`;
    const sources = githubDiscoverySourcesSchema.parse(
      await (await f.call(`${path}/sources`)).json(),
    );
    const source = sources.sources[0];
    const page = githubDiscoveryPageSchema.parse(
      await (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: source.id,
        })
      ).json(),
    );
    const input = {
      sourceId: source.id,
      selectionId: page.repositories[0].selectionId,
      revision: 0,
      confirm: true,
    };
    const bad = await f.call(`${path}/select`, "owner", "POST", input);
    assert.equal(bad.status, 502);
    assert.ok(!(await bad.text()).includes("secret"));
    assert.equal(
      githubConnectionSchema.parse(await (await f.call(path)).json()).revision,
      0,
    );
    fail = false;
    assert.equal(
      (await f.call(`${path}/select`, "owner", "POST", input)).status,
      200,
    );
    await f.call(path, "owner", "PUT", {
      repository: option.repository,
      mode: "authenticated",
      credentialRef: "second",
      revision: 1,
      confirm: true,
    });
    const status = (await (
      await f.call(`${path}/selection-status`, "owner", "POST", input)
    ).json()) as { matches: boolean };
    assert.equal(status.matches, false);
    assert.equal(
      (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: "https://evil.invalid",
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
void test("late repository response cannot reveal results after source credential rotates", async () => {
  let release: () => void = () => {},
    token = "old";
  let entered: () => void = () => {};
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const f = await sessionHttpFixture(
    provider({
      credentials: { ref: { label: "계정", resolve: () => token } },
      client: () => ({
        verify: () => Promise.resolve(),
        inspect: () => Promise.reject(new Error("unused")),
        listRepositories: () => {
          entered();
          return new Promise((r) => {
            release = () => {
              r({
                items: [{ ...option, visibility: "private" }],
                hasMore: false,
              });
            };
          });
        },
        verifySelection: () => Promise.resolve(),
      }),
    }),
  );
  try {
    const path = `/projects/${f.project.id}/github`;
    const sources = githubDiscoverySourcesSchema.parse(
      await (await f.call(`${path}/sources`)).json(),
    );
    const pending = f.call(`${path}/repositories`, "owner", "POST", {
      sourceId: sources.sources[0].id,
    });
    await waiting;
    token = "new";
    release();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.ok(!(await response.text()).includes("selected"));
  } finally {
    release();
    await f.close();
  }
});
void test("disconnect preserves only this project's previous public owner for no-text reconnection", async () => {
  const f = await sessionHttpFixture(provider());
  try {
    await seed(f);
    const path = `/projects/${f.project.id}/github`;
    await f.call(path, "owner", "DELETE", { revision: 1, confirm: true });
    const sources = githubDiscoverySourcesSchema.parse(
      await (await f.call(`${path}/sources`)).json(),
    );
    assert.equal(sources.sources.length, 1);
    assert.match(sources.sources[0].label, /이전 공개 연결/);
    assert.equal(
      githubDiscoverySourcesSchema.parse(
        await (await f.call(`/projects/${f.other.id}/github/sources`)).json(),
      ).sources.length,
      0,
    );
    const source = sources.sources[0],
      page = githubDiscoveryPageSchema.parse(
        await (
          await f.call(`${path}/repositories`, "owner", "POST", {
            sourceId: source.id,
          })
        ).json(),
      );
    const connected = githubConnectionSchema.parse(
      await (
        await f.call(`${path}/select`, "owner", "POST", {
          sourceId: source.id,
          selectionId: page.repositories[0].selectionId,
          revision: 2,
          confirm: true,
        })
      ).json(),
    );
    assert.equal(connected.connected, true);
    assert.equal(connected.repository?.name, "selected");
  } finally {
    await f.close();
  }
});
void test("uncertain save cannot match same label/repository/revision under a different credential", async () => {
  const f = await sessionHttpFixture(
    provider({
      credentials: {
        first: { label: "계정", resolve: () => "one" },
        second: { label: "계정", resolve: () => "two" },
      },
    }),
  );
  try {
    const path = `/projects/${f.project.id}/github`;
    const source = githubDiscoverySourcesSchema.parse(
      await (await f.call(`${path}/sources`)).json(),
    ).sources[0];
    const page = githubDiscoveryPageSchema.parse(
      await (
        await f.call(`${path}/repositories`, "owner", "POST", {
          sourceId: source.id,
        })
      ).json(),
    );
    await f.call(path, "owner", "PUT", {
      repository: option.repository,
      mode: "authenticated",
      credentialRef: "second",
      revision: 0,
      confirm: true,
    });
    const response = await f.call(`${path}/selection-status`, "owner", "POST", {
      sourceId: source.id,
      selectionId: page.repositories[0].selectionId,
      revision: 0,
      confirm: true,
    });
    assert.equal(response.status, 200);
    const data = (await response.json()) as {
      matches: boolean;
      connection: { revision: number; principalLabel: string };
    };
    assert.equal(data.connection.revision, 1);
    assert.equal(data.connection.principalLabel, "계정");
    assert.equal(data.matches, false);
  } finally {
    await f.close();
  }
});
void test("source capabilities have a bounded shared capacity and expiry releases it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const credentials = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [
      `ref${String(i)}`,
      { label: `Account ${String(i)}`, resolve: () => `fixture-${String(i)}` },
    ]),
  );
  const f = await sessionHttpFixture(provider({ credentials }));
  try {
    const path = `/projects/${f.project.id}/github/sources`;
    for (let i = 0; i < 40; i++) assert.equal((await f.call(path)).status, 200);
    assert.equal((await f.call(path)).status, 429);
    t.mock.timers.tick(16 * 60 * 1000);
    assert.equal((await f.call(path)).status, 200);
  } finally {
    await f.close();
  }
});
