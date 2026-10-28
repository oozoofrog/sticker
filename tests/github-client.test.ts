import test from "node:test";
import assert from "node:assert/strict";
import { parseGithubUrl } from "../server/contracts/github.js";
import {
  GithubReadClient,
  GithubReadError,
} from "../server/github-read-client.js";
const sha = "a".repeat(40),
  newSha = "b".repeat(40);
const repository = { owner: "octocat", name: "project" };
void test("GitHub URLs require an exact credential-free allowlisted HTTPS path", () => {
  assert.deepEqual(
    parseGithubUrl("https://github.com/octocat/project/pull/17"),
    {
      ...repository,
      kind: "pr",
      number: 17,
      url: "https://github.com/octocat/project/pull/17",
    },
  );
  assert.equal(
    parseGithubUrl(`https://github.com/octocat/project/commit/${sha}`).sha,
    sha,
  );
  for (const url of [
    "http://github.com/octocat/project/pull/1",
    "https://user:secret@github.com/octocat/project/pull/1",
    "https://github.com:443/octocat/project/pull/1",
    "https://github.com.evil.test/octocat/project/pull/1",
    "https://github.com/octocat/project/pull/1?x=1",
    "https://github.com/octocat/project/pull/1#x",
    "https://github.com/octocat/%70roject/pull/1",
    "https://github.com/octocat/project/pull/0",
    "https://github.com/octocat/project/commit/main",
  ])
    assert.throws(() => parseGithubUrl(url));
});
void test("default client never accesses network", async () => {
  let calls = 0;
  const client = new GithubReadClient({
    fetch: fixtureFetch(() => {
      calls++;
      return new Response("{}");
    }),
  });
  await assert.rejects(
    client.verify(repository),
    (e) => e instanceof GithubReadError && e.code === "PROVIDER_DISABLED",
  );
  assert.equal(calls, 0);
});
function payload(path: string, head = sha): unknown {
  if (path === "/repos/octocat/project")
    return { full_name: "octocat/project" };
  if (path.endsWith("/pulls/17"))
    return {
      number: 17,
      html_url: "https://github.com/octocat/project/pull/17",
      base: { repo: { full_name: "octocat/project" } },
      head: { sha: head },
    };
  if (path.endsWith("/check-suites"))
    return { total_count: 1, check_suites: [{ id: 1, head_sha: sha }] };
  if (path.endsWith("/check-runs"))
    return {
      total_count: 1,
      check_runs: [
        { id: 1, head_sha: sha, status: "completed", conclusion: "success" },
      ],
    };
  if (path.endsWith("/status"))
    return {
      sha,
      total_count: 1,
      statuses: [{ id: 2, context: "ci", state: "success" }],
    };
  return { sha, html_url: `https://github.com/octocat/project/commit/${sha}` };
}
void test("reads fixed-origin GET endpoints and revalidates PR head after exact-SHA CI", async () => {
  const seen: string[] = [];
  let prReads = 0;
  const client = new GithubReadClient({
    enabled: true,
    fetch: fixtureFetch((input, init) => {
      const u = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      assert.equal(u.origin, "https://api.github.com");
      assert.equal(init?.method, "GET");
      assert.equal(init.redirect, "error");
      seen.push(u.pathname);
      if (u.pathname.endsWith("/pulls/17")) prReads++;
      return Response.json(payload(u.pathname, prReads === 2 ? newSha : sha));
    }),
  });
  const result = await client.inspect(
    parseGithubUrl("https://github.com/octocat/project/pull/17"),
  );
  assert.equal(result.headSha, newSha);
  assert.equal(result.snapshotCi, "success");
  assert.equal(result.snapshotSha, sha);
  assert.equal(result.ci, "unknown");
  assert.equal(result.stale, true);
  assert.equal(prReads, 2);
  assert.ok(seen.some((p) => p.includes(sha)));
});
void test("later pages and non-success check conclusions cannot produce green evidence", async () => {
  for (const conclusion of [
    "failure",
    "timed_out",
    "action_required",
    "cancelled",
    "stale",
    "neutral",
    "skipped",
    null,
  ]) {
    const client = new GithubReadClient({
      enabled: true,
      fetch: fixtureFetch((input) => {
        const u = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        let data = payload(u.pathname);
        if (u.pathname.endsWith("/check-runs"))
          data = {
            total_count: 2,
            check_runs: [
              {
                id: Number(u.searchParams.get("page")),
                head_sha: sha,
                status: "completed",
                conclusion:
                  u.searchParams.get("page") === "1" ? "success" : conclusion,
              },
            ],
          };
        return Response.json(data);
      }),
    });
    const result = await client.inspect(
      parseGithubUrl(`https://github.com/octocat/project/commit/${sha}`),
    );
    assert.notEqual(result.ci, "success");
    assert.equal(result.checkCount, 2);
  }
});
void test("bounded incomplete pages and no checks remain unknown", async () => {
  for (const total of [0, 10000]) {
    const client = new GithubReadClient({
      enabled: true,
      maxPages: 2,
      fetch: fixtureFetch((input) => {
        const u = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (u.pathname.endsWith("/check-runs"))
          return Response.json({
            total_count: total,
            check_runs: total
              ? [
                  {
                    id: Number(u.searchParams.get("page")),
                    head_sha: sha,
                    status: "completed",
                    conclusion: "success",
                  },
                ]
              : [],
          });
        if (u.pathname.endsWith("/status"))
          return Response.json({ sha, total_count: 0, statuses: [] });
        return Response.json(payload(u.pathname));
      }),
    });
    const result = await client.inspect(
      parseGithubUrl(`https://github.com/octocat/project/commit/${sha}`),
    );
    assert.equal(result.ci, "unknown");
    assert.equal(result.complete, total === 0);
  }
});
void test("provider failures expose only bounded categories, never credentials or upstream bodies", async () => {
  const secret = "fixture-secret-do-not-serialize";
  for (const status of [401, 403, 429, 500]) {
    const client = new GithubReadClient({
      enabled: true,
      authenticated: true,
      credential: () => secret,
      fetch: fixtureFetch(() => new Response(secret, { status })),
    });
    await assert.rejects(client.verify(repository), (e) => {
      assert.ok(e instanceof GithubReadError);
      assert.ok(!String(e).includes(secret));
      return true;
    });
  }
  const oversized = new GithubReadClient({
    enabled: true,
    maxBytes: 10,
    fetch: fixtureFetch(() => new Response(" ".repeat(11))),
  });
  await assert.rejects(
    oversized.verify(repository),
    (e) => e instanceof GithubReadError && e.code === "RESPONSE_TOO_LARGE",
  );
  const redirect = new GithubReadClient({
    enabled: true,
    fetch: fixtureFetch(
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://evil.test" },
        }),
    ),
  });
  await assert.rejects(redirect.verify(repository));
  const missing = new GithubReadClient({
    enabled: true,
    authenticated: true,
    fetch: fixtureFetch(() => {
      throw new Error("must not fetch");
    }),
  });
  await assert.rejects(
    missing.verify(repository),
    (e) => e instanceof GithubReadError && e.code === "CREDENTIAL_MISSING",
  );
});
void test("public reads never resolve configured credentials and forged target fields cannot change the request", async () => {
  let credentials = 0,
    calls = 0;
  const client = new GithubReadClient({
    enabled: true,
    credential: () => {
      credentials++;
      return "fixture-secret";
    },
    fetch: fixtureFetch((input, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return Response.json({ full_name: "octocat/project" });
    }),
  });
  await client.verify(repository);
  assert.equal(credentials, 0);
  await assert.rejects(
    client.inspect({
      ...parseGithubUrl(`https://github.com/octocat/project/commit/${sha}`),
      name: "different",
    }),
  );
  assert.equal(calls, 1);
});
void test("commit status later-page failure and changed totals prevent false success", async () => {
  for (const inconsistent of [false, true]) {
    const client = new GithubReadClient({
      enabled: true,
      fetch: fixtureFetch((input) => {
        const u = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (u.pathname.endsWith("/status")) {
          const page = Number(u.searchParams.get("page"));
          return Response.json({
            sha,
            total_count: inconsistent && page === 2 ? 1 : 2,
            statuses: [
              {
                id: page,
                context: `ci-${String(page)}`,
                state: page === 2 ? "failure" : "success",
              },
            ],
          });
        }
        return Response.json(payload(u.pathname));
      }),
    });
    const result = await client.inspect(
      parseGithubUrl(`https://github.com/octocat/project/commit/${sha}`),
    );
    assert.equal(result.ci, inconsistent ? "unknown" : "failure");
  }
});
void test("secondary rate limits without retry headers are sanitized and never retried", async () => {
  let calls = 0;
  const client = new GithubReadClient({
    enabled: true,
    fetch: fixtureFetch(() => {
      calls++;
      return Response.json(
        { message: "You have exceeded a secondary rate limit. fixture-secret" },
        { status: 403 },
      );
    }),
  });
  await assert.rejects(
    client.verify(repository),
    (e) => e instanceof GithubReadError && e.code === "RATE_LIMIT",
  );
  assert.equal(calls, 1);
});

function fixtureFetch(
  handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response,
): typeof fetch {
  return (input, init) => Promise.resolve().then(() => handler(input, init));
}
void test("SHA mismatch and duplicate pagination rows never yield trusted current evidence", async () => {
  for (const mode of ["sha", "duplicate"] as const) {
    const client = new GithubReadClient({
      enabled: true,
      maxPages: 2,
      fetch: fixtureFetch((input) => {
        const u = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (u.pathname.endsWith("/check-runs"))
          return Response.json({
            total_count: mode === "duplicate" ? 2 : 1,
            check_runs: [
              {
                id: 1,
                head_sha: mode === "sha" ? newSha : sha,
                status: "completed",
                conclusion: "success",
              },
            ],
          });
        return Response.json(payload(u.pathname));
      }),
    });
    if (mode === "sha")
      await assert.rejects(
        client.inspect(
          parseGithubUrl(`https://github.com/octocat/project/commit/${sha}`),
        ),
        (e) => e instanceof GithubReadError && e.code === "SHA_MISMATCH",
      );
    else {
      const result = await client.inspect(
        parseGithubUrl(`https://github.com/octocat/project/commit/${sha}`),
      );
      assert.equal(result.complete, false);
      assert.equal(result.ci, "unknown");
    }
  }
});
void test("network and invalid responses never expose upstream details", async () => {
  for (const handler of [
    () => {
      throw new Error("fixture-secret-network");
    },
    () => new Response("fixture-secret-json"),
    () => Response.json({ full_name: "fixture-secret/wrong" }),
  ]) {
    const client = new GithubReadClient({
      enabled: true,
      fetch: fixtureFetch(handler),
    });
    await assert.rejects(client.verify(repository), (e) => {
      assert.ok(e instanceof GithubReadError);
      assert.ok(!String(e).includes("fixture-secret"));
      return true;
    });
  }
});
void test("connection contracts require explicit confirmation and cannot attach credentials to public mode", async () => {
  const {
    githubConnectSchema,
    githubConnectionMutationSchema,
    githubEvidenceCreateSchema,
  } = await import("../server/contracts/github.js");
  const input = { repository, mode: "public", revision: 0, confirm: true };
  assert.ok(githubConnectSchema.safeParse(input).success);
  for (const next of [
    { ...input, confirm: false },
    { ...input, credentialRef: "provider" },
    { ...input, mode: "authenticated" },
    { ...input, mode: "authenticated", credentialRef: "../secret" },
    { ...input, token: "fixture-secret" },
  ])
    assert.equal(githubConnectSchema.safeParse(next).success, false);
  assert.ok(
    githubConnectSchema.safeParse({
      ...input,
      mode: "authenticated",
      credentialRef: "configured_provider",
    }).success,
  );
  assert.equal(
    githubConnectionMutationSchema.safeParse({ revision: 1 }).success,
    false,
  );
  assert.equal(
    githubEvidenceCreateSchema.safeParse({
      url: "https://evil.test/a",
      issueRevision: 1,
    }).success,
    false,
  );
});
void test("provider-side 1000-suite cap is incomplete even when latest filter returns only one successful run", async () => {
  const client = new GithubReadClient({
    enabled: true,
    fetch: fixtureFetch((input) => {
      const u = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (u.pathname.endsWith("/check-suites"))
        return Response.json({
          total_count: 1000,
          check_suites: [{ id: 1, head_sha: sha }],
        });
      return Response.json(payload(u.pathname));
    }),
  });
  const result = await client.inspect(
    parseGithubUrl(`https://github.com/octocat/project/commit/${sha}`),
  );
  assert.equal(result.checkCount, 1);
  assert.equal(result.complete, false);
  assert.equal(result.ci, "unknown");
});
void test("rejected status and oversized declared bodies are cancelled before being consumed", async () => {
  for (const entry of [
    { status: 401, headers: new Headers() },
    { status: 200, headers: new Headers({ "content-length": "9999999" }) },
  ]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      entry,
    );
    const client = new GithubReadClient({
      enabled: true,
      fetch: fixtureFetch(() => response),
    });
    await assert.rejects(client.verify(repository));
    assert.equal(cancelled, true);
  }
});
