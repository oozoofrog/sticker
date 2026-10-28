import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/domain.js";
import { StoreContext } from "../server/store-context.js";
import {
  GithubService,
  type GithubProvider,
} from "../server/features/github.js";
import { DomainError } from "../server/domain-error.js";
import type { Actor } from "../server/types.js";
import type { GithubSnapshot } from "../server/contracts/github.js";
const owner: Actor = {
  id: "owner",
  name: "Owner",
  role: "owner",
  canWrite: true,
  projectIds: null,
};
const sha = "a".repeat(40);
const snapshot: GithubSnapshot = {
  headSha: sha,
  snapshotSha: sha,
  ci: "success",
  snapshotCi: "success",
  complete: true,
  stale: false,
  checkCount: 1,
  statusCount: 0,
};
function fixture(
  t: test.TestContext,
  provider: GithubProvider = { enabled: false },
) {
  const dir = mkdtempSync(join(tmpdir(), "sticker-github-"));
  const store = new Store(dir),
    p = store.createProject(owner, { key: "GH", name: "GitHub" }),
    other = store.createProject(owner, { key: "GX", name: "Other" }),
    issue = store.createIssue(owner, { projectId: p.id, title: "Evidence" });
  store.close();
  const ctx = new StoreContext(dir);
  const service = new GithubService(ctx, provider);
  t.after(() => {
    ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ctx,
    service,
    p,
    other,
    issue,
    agent: {
      id: "agent",
      name: "Agent",
      role: "agent",
      canWrite: true,
      projectIds: [p.id],
    } satisfies Actor,
  };
}
function connect(f: ReturnType<typeof fixture>) {
  return f.service.connect(owner, f.p.id, {
    repository: { owner: "octocat", name: "project" },
    mode: "public",
    revision: 0,
    confirm: true,
  });
}
void test("GitHub settings default disconnected and require owner confirmation; evidence follows current issue scope", (t) => {
  const f = fixture(t);
  assert.equal(f.service.connection(owner, f.p.id).connected, false);
  assert.throws(
    () =>
      f.service.connect(f.agent, f.p.id, {
        repository: { owner: "octocat", name: "project" },
        mode: "public",
        revision: 0,
        confirm: true,
      }),
    DomainError,
  );
  assert.throws(
    () =>
      f.service.connect(owner, f.p.id, {
        repository: { owner: "octocat", name: "project" },
        mode: "public",
        revision: 0,
      }),
    DomainError,
  );
  connect(f);
  const e = f.service.add(f.agent, f.issue.id, {
    url: "https://github.com/octocat/project/pull/1",
    issueRevision: 1,
  });
  assert.equal(e.snapshot, null);
  assert.equal(f.service.list(f.agent, f.issue.id).length, 1);
  assert.throws(
    () => f.service.get({ ...f.agent, projectIds: [f.other.id] }, e.id),
    DomainError,
  );
  assert.throws(
    () =>
      f.service.add(f.agent, f.issue.id, {
        url: "https://github.com/another/project/pull/1",
        issueRevision: 1,
      }),
    DomainError,
  );
  assert.equal(f.ctx.issue(owner, f.issue.id).status, "backlog");
});
void test("disconnect during an in-flight refresh discards late success and prevents further fetches", async (t) => {
  let resolve: ((s: GithubSnapshot) => void) | undefined,
    calls = 0;
  const f = fixture(t, {
    enabled: true,
    client: () => ({
      verify: () => Promise.resolve(),
      inspect: () => {
        calls++;
        return new Promise<GithubSnapshot>((r) => {
          resolve = r;
        });
      },
    }),
  });
  const c = connect(f),
    e = f.service.add(owner, f.issue.id, {
      url: "https://github.com/octocat/project/pull/1",
      issueRevision: 1,
    });
  const pending = f.service.refresh(owner, e.id, { revision: e.revision });
  assert.equal(calls, 1);
  f.service.disconnect(owner, f.p.id, { revision: c.revision, confirm: true });
  assert.ok(resolve);
  resolve(snapshot);
  await assert.rejects(
    pending,
    (e) => e instanceof DomainError && e.status === 409,
  );
  assert.equal(f.service.get(owner, e.id).snapshot, null);
  assert.equal(f.service.get(owner, e.id).disconnected, true);
  await assert.rejects(
    f.service.refresh(owner, e.id, { revision: e.revision }),
  );
  assert.equal(calls, 1);
});
void test("failures preserve last verified evidence and never mutate issue or version state", async (t) => {
  let fail = false;
  const f = fixture(t, {
    enabled: true,
    client: () => ({
      verify: () => Promise.resolve(),
      inspect: () =>
        fail
          ? Promise.reject(new Error("fixture-secret-network"))
          : Promise.resolve(snapshot),
    }),
  });
  connect(f);
  const added = f.service.add(f.agent, f.issue.id, {
      url: "https://github.com/octocat/project/pull/1",
      issueRevision: 1,
    }),
    fresh = await f.service.refresh(f.agent, added.id, {
      revision: added.revision,
    });
  assert.equal(fresh.snapshot?.ci, "success");
  fail = true;
  const stale = await f.service.refresh(f.agent, fresh.id, {
    revision: fresh.revision,
  });
  assert.equal(stale.checkedAt, fresh.checkedAt);
  assert.deepEqual(stale.snapshot, fresh.snapshot);
  assert.equal(stale.stale, true);
  assert.equal(stale.errorCode, "NETWORK");
  assert.ok(!JSON.stringify(stale).includes("fixture-secret"));
  assert.equal(f.ctx.issue(owner, f.issue.id).status, "backlog");
  assert.throws(
    () =>
      f.service.remove({ ...f.agent, canWrite: false }, stale.id, {
        revision: stale.revision,
      }),
    DomainError,
  );
});
void test("reconnect or repository change invalidates in-flight verification without leaking credential references", async (t) => {
  let resolve: (() => void) | undefined;
  const f = fixture(t, {
    enabled: true,
    credentials: {
      configured: {
        label: "Configured identity",
        resolve: () => "fixture-secret",
      },
    },
    client: () => ({
      verify: () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
      inspect: () => Promise.resolve(snapshot),
    }),
  });
  const first = f.service.connect(owner, f.p.id, {
    repository: { owner: "octocat", name: "project" },
    mode: "authenticated",
    credentialRef: "configured",
    revision: 0,
    confirm: true,
  });
  assert.equal(first.permissionsVerified, false);
  assert.ok(!JSON.stringify(first).includes("fixture-secret"));
  assert.ok(!JSON.stringify(first).includes("credentialRef"));
  const pending = f.service.verify(owner, f.p.id, {
    revision: first.revision,
    confirm: true,
  });
  f.service.connect(owner, f.p.id, {
    repository: { owner: "octocat", name: "another" },
    mode: "public",
    revision: first.revision,
    confirm: true,
  });
  assert.ok(resolve);
  resolve();
  await assert.rejects(
    pending,
    (e) => e instanceof DomainError && e.status === 409,
  );
  assert.equal(f.service.connection(owner, f.p.id).lastVerifiedAt, null);
});
void test("scope, readonly and closed-issue guards reject before any external call; duplicate URLs are idempotent", async (t) => {
  let calls = 0;
  const f = fixture(t, {
    enabled: true,
    client: () => ({
      verify: () => {
        calls++;
        return Promise.resolve();
      },
      inspect: () => {
        calls++;
        return Promise.resolve(snapshot);
      },
    }),
  });
  const connection = connect(f);
  const input = {
      url: "https://github.com/octocat/project/pull/1",
      issueRevision: 1,
    },
    e = f.service.add(f.agent, f.issue.id, input);
  assert.equal(f.service.add(f.agent, f.issue.id, input).id, e.id);
  assert.equal(f.service.list(f.agent, f.issue.id).length, 1);
  await assert.rejects(
    f.service.refresh({ ...f.agent, projectIds: [f.other.id] }, e.id, {
      revision: 1,
    }),
    DomainError,
  );
  await assert.rejects(
    f.service.refresh({ ...f.agent, canWrite: false }, e.id, { revision: 1 }),
    DomainError,
  );
  await assert.rejects(
    f.service.verify(f.agent, f.p.id, {
      revision: connection.revision,
      confirm: true,
    }),
    DomainError,
  );
  assert.equal(calls, 0);
  f.ctx.db
    .prepare("UPDATE issues SET status=? WHERE id=?")
    .run("closed", f.issue.id);
  await assert.rejects(
    f.service.refresh(f.agent, e.id, { revision: 1 }),
    DomainError,
  );
  assert.equal(calls, 0);
  assert.throws(
    () => f.service.remove(owner, e.id, { revision: 99 }),
    DomainError,
  );
  assert.equal(f.service.list(owner, f.issue.id).length, 1);
});
void test("repository replacement preserves old evidence only as disconnected and cannot fetch the old repository", async (t) => {
  let calls = 0;
  const f = fixture(t, {
    enabled: true,
    client: () => ({
      verify: () => Promise.resolve(),
      inspect: () => {
        calls++;
        return Promise.resolve(snapshot);
      },
    }),
  });
  const c = connect(f),
    e = f.service.add(owner, f.issue.id, {
      url: "https://github.com/octocat/project/pull/1",
      issueRevision: 1,
    });
  const fresh = await f.service.refresh(owner, e.id, { revision: 1 });
  f.service.connect(owner, f.p.id, {
    repository: { owner: "octocat", name: "other" },
    mode: "public",
    revision: c.revision,
    confirm: true,
  });
  const cached = f.service.get(owner, e.id);
  assert.equal(cached.disconnected, true);
  assert.equal(cached.stale, true);
  assert.deepEqual(cached.snapshot, fresh.snapshot);
  await assert.rejects(
    f.service.refresh(owner, e.id, { revision: fresh.revision }),
    DomainError,
  );
  assert.equal(calls, 1);
});
void test("only own configured credential references count as available", (t) => {
  const f = fixture(t, { enabled: true, credentials: {} });
  const settings = f.service.connect(owner, f.p.id, {
    repository: { owner: "octocat", name: "project" },
    mode: "authenticated",
    credentialRef: "toString",
    revision: 0,
    confirm: true,
  });
  assert.equal(settings.credentialConfigured, false);
  assert.equal(settings.principalLabel, "미설정");
});
void test("concurrent verification accepts one revision and never erases a newer confirmed success", async (t) => {
  let rejectFirst: ((error: Error) => void) | undefined;
  let calls = 0;
  const f = fixture(t, {
    enabled: true,
    client: () => ({
      verify: () => {
        calls++;
        return calls === 1
          ? new Promise<void>((_resolve, reject) => {
              rejectFirst = reject;
            })
          : Promise.resolve();
      },
      inspect: () => Promise.resolve(snapshot),
    }),
  });
  const c = connect(f);
  const first = f.service.verify(owner, f.p.id, {
    revision: c.revision,
    confirm: true,
  });
  const success = await f.service.verify(owner, f.p.id, {
    revision: c.revision,
    confirm: true,
  });
  assert.ok(success.lastVerifiedAt);
  assert.ok(rejectFirst);
  rejectFirst(new Error("old failure"));
  await assert.rejects(
    first,
    (e) => e instanceof DomainError && e.status === 409,
  );
  assert.deepEqual(f.service.connection(owner, f.p.id), success);
  assert.equal(success.revision, c.revision + 1);
});
void test("late successful verification cannot hide an accepted newer failure; sequential failure retains last accepted success time", async (t) => {
  let resolveOld: (() => void) | undefined;
  let calls = 0;
  const f = fixture(t, {
    enabled: true,
    client: () => ({
      verify: () => {
        calls++;
        if (calls === 1) return Promise.resolve();
        if (calls === 2)
          return new Promise<void>((resolve) => {
            resolveOld = resolve;
          });
        return Promise.reject(new Error("new failure"));
      },
      inspect: () => Promise.resolve(snapshot),
    }),
  });
  const c = connect(f);
  const confirmed = await f.service.verify(owner, f.p.id, {
    revision: c.revision,
    confirm: true,
  });
  assert.ok(confirmed.lastVerifiedAt);
  const old = f.service.verify(owner, f.p.id, {
    revision: confirmed.revision,
    confirm: true,
  });
  const failed = await f.service.verify(owner, f.p.id, {
    revision: confirmed.revision,
    confirm: true,
  });
  assert.equal(failed.lastVerifiedAt, confirmed.lastVerifiedAt);
  assert.equal(failed.lastErrorCode, "NETWORK");
  assert.ok(resolveOld);
  resolveOld();
  await assert.rejects(
    old,
    (e) => e instanceof DomainError && e.status === 409,
  );
  assert.deepEqual(f.service.connection(owner, f.p.id), failed);
});
