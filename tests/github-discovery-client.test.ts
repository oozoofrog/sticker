import test from "node:test";
import assert from "node:assert/strict";
import {
  GithubReadClient,
  GithubReadError,
} from "../server/github-read-client.js";
function repo(
  id = 1,
  owner = "octocat",
  name = "sticker",
  privateRepo = false,
) {
  return {
    id,
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner },
    private: privateRepo,
    archived: false,
    disabled: false,
  };
}
function transport(
  fn: (url: URL, init: RequestInit) => Response,
): typeof fetch {
  return (input: string | URL | Request, init: RequestInit = {}) =>
    Promise.resolve(
      fn(
        new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        ),
        init,
      ),
    );
}
void test("discovery uses fixed-origin GET and public user or organization routes without credentials", async () => {
  for (const type of ["User", "Organization"]) {
    const paths: string[] = [];
    const c = new GithubReadClient({
      enabled: true,
      credential: () => "private-secret",
      fetch: transport((url, init) => {
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "error");
        assert.equal(new Headers(init.headers).has("authorization"), false);
        paths.push(url.pathname);
        return Response.json(
          url.pathname === "/users/octocat"
            ? { login: "octocat", type }
            : [repo()],
        );
      }),
    });
    const result = await c.listRepositories({
      publicOwner: "octocat",
      page: 1,
    });
    assert.equal(result.items[0]?.repository.name, "sticker");
    assert.equal(result.hasMore, false);
    assert.deepEqual(paths, [
      "/users/octocat",
      type === "User" ? "/users/octocat/repos" : "/orgs/octocat/repos",
    ]);
  }
});
void test("authenticated discovery uses only existing credential and bounded explicit pages", async () => {
  const c = new GithubReadClient({
    enabled: true,
    authenticated: true,
    credential: () => "fixture-only",
    fetch: transport((url, init) => {
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer fixture-only",
      );
      assert.equal(url.pathname, "/user/repos");
      assert.equal(url.searchParams.get("page"), "2");
      assert.equal(url.searchParams.get("per_page"), "30");
      return Response.json(
        Array.from({ length: 30 }, (_, i) =>
          repo(i + 1, "org", `repo-${String(i)}`, true),
        ),
      );
    }),
  });
  const result = await c.listRepositories({ page: 2 });
  assert.equal(result.items.length, 30);
  assert.equal(result.hasMore, true);
  assert.equal(result.items[0]?.visibility, "private");
  await assert.rejects(
    c.listRepositories({ page: 101 }),
    (e) => e instanceof GithubReadError && e.code === "INVALID_RESPONSE",
  );
  await assert.rejects(
    c.listRepositories({ page: 1, publicOwner: "octocat" }),
    (e) => e instanceof GithubReadError && e.code === "INVALID_RESPONSE",
  );
});
void test("discovery validates owner and full-name identity, duplicates, public visibility and bounded errors", async () => {
  for (const data of [
    [{ ...repo(), full_name: "other/sticker" }],
    [repo(1, "other")],
    [repo(1, "octocat", "sticker", true)],
    [{ ...repo(), id: 0 }],
  ]) {
    const c = new GithubReadClient({
      enabled: true,
      fetch: transport((url) =>
        Response.json(
          url.pathname === "/users/octocat"
            ? { login: "octocat", type: "User" }
            : data,
        ),
      ),
    });
    await assert.rejects(
      c.listRepositories({ page: 1, publicOwner: "octocat" }),
      GithubReadError,
    );
  }
  const c = new GithubReadClient({
    enabled: true,
    fetch: transport((url) =>
      Response.json(
        url.pathname === "/users/octocat"
          ? { login: "octocat", type: "User" }
          : [repo(), repo()],
      ),
    ),
  });
  assert.equal(
    (await c.listRepositories({ page: 1, publicOwner: "octocat" })).items
      .length,
    1,
  );
  for (const [status, code] of [
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [429, "RATE_LIMIT"],
  ] as const) {
    const bad = new GithubReadClient({
      enabled: true,
      authenticated: true,
      credential: () => "secret",
      fetch: transport(() =>
        Response.json({ message: "private upstream secret" }, { status }),
      ),
    });
    await assert.rejects(
      bad.listRepositories({ page: 1 }),
      (e) =>
        e instanceof GithubReadError &&
        e.code === code &&
        !e.message.includes("secret"),
    );
  }
  let calls = 0;
  const off = new GithubReadClient({
    fetch: transport(() => {
      calls++;
      return Response.json([]);
    }),
  });
  await assert.rejects(
    off.listRepositories({ page: 1, publicOwner: "octocat" }),
    (e) => e instanceof GithubReadError && e.code === "PROVIDER_DISABLED",
  );
  assert.equal(calls, 0);
});
void test("selected repository revalidation rejects replaced IDs, disabled or changed visibility before connect", async () => {
  const selected = {
    id: 1,
    repository: { owner: "octocat", name: "sticker" },
    visibility: "public" as const,
    archived: false,
    disabled: false,
  };
  for (const payload of [
    { ...repo(), id: 2 },
    { ...repo(), private: true },
    { ...repo(), disabled: true },
  ]) {
    const c = new GithubReadClient({
      enabled: true,
      fetch: transport(() => Response.json(payload)),
    });
    await assert.rejects(
      c.verifySelection(selected),
      (e) => e instanceof GithubReadError && e.code === "REPOSITORY_MISMATCH",
    );
  }
  const c = new GithubReadClient({
    enabled: true,
    fetch: transport(() => Response.json(repo())),
  });
  await c.verifySelection(selected);
});
