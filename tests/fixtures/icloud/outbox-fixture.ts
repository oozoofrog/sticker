import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { Store } from "../../../server/domain.js";
import type { Actor } from "../../../server/types.js";
import type { Scope } from "../../../server/icloud/contracts.js";
import {
  SyntheticIssueOutbox,
  type FixtureTransport,
  type IssueEnvelope,
} from "../../../server/icloud/outbox.js";

export const owner: Actor = {
  id: "owner",
  name: "fixture",
  role: "owner",
  canWrite: true,
  projectIds: null,
};
export const scope: Scope = {
  bindingId: "11111111-1111-4111-8111-111111111111",
  datasetId: "22222222-2222-4222-8222-222222222222",
  generation: "33333333-3333-4333-8333-333333333333",
  accountEpoch: 1,
  restoreEpoch: 0,
  activeRootId: "44444444-4444-4444-8444-444444444444",
};

// Test-owned DDL only. No public migration or runtime schema initialization.
export function fixtureSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS fixture_cloud_boundary (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), availability TEXT NOT NULL,
    scope TEXT, lastScope TEXT, fence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS fixture_cloud_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, operationId TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL, fence INTEGER NOT NULL, payload TEXT NOT NULL,
    digest TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    retryAt INTEGER NOT NULL DEFAULT 0, errorCode TEXT);
    CREATE INDEX IF NOT EXISTS fixture_cloud_ready ON fixture_cloud_outbox(state,sequence);`);
  db.prepare(
    "INSERT OR IGNORE INTO fixture_cloud_boundary VALUES(1,'available',?,?,1)",
  ).run(JSON.stringify(scope), JSON.stringify(scope));
}

export class FixtureClock {
  now = 1000;
  private serial = 0;
  private tasks = new Map<number, { at: number; callback: () => void }>();
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.serial;
    this.tasks.set(id, { at: this.now + delay, callback });
    return () => {
      this.tasks.delete(id);
    };
  };
  async turn() {
    const tasks = [...this.tasks.entries()].filter(
      ([, task]) => task.at <= this.now,
    );
    for (const [id, task] of tasks) {
      this.tasks.delete(id);
      task.callback();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  async settle() {
    for (let i = 0; i < 500; i++) {
      const tasks = [...this.tasks.entries()].filter(
        ([, task]) => task.at <= this.now,
      );
      for (const [id, task] of tasks) {
        this.tasks.delete(id);
        task.callback();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (![...this.tasks.values()].some((task) => task.at <= this.now)) return;
    }
    assert.fail("Automatic scheduler failed to settle within fixture bound");
  }
  async advance(ms: number) {
    this.now += ms;
    await this.settle();
  }
}

export class MemoryTransport implements FixtureTransport {
  readonly records = new Map<
    string,
    { digest: string; envelope: IssueEnvelope }
  >();
  sends = 0;
  lookups = 0;
  send: FixtureTransport["send"] = async (envelope, digest) => {
    await Promise.resolve();
    this.sends++;
    const old = this.records.get(envelope.operationId);
    if (old && old.digest !== digest)
      return {
        kind: "saved",
        operationId: envelope.operationId,
        digest: old.digest,
      };
    this.records.set(envelope.operationId, { digest, envelope });
    return { kind: "saved", operationId: envelope.operationId, digest };
  };
  lookup: FixtureTransport["lookup"] = async (operationId) => {
    await Promise.resolve();
    this.lookups++;
    const old = this.records.get(operationId);
    return old
      ? { kind: "saved", operationId, digest: old.digest }
      : { kind: "missing" };
  };
}

export function attach(
  store: Store,
  clock: FixtureClock,
  transport: FixtureTransport,
) {
  let db!: DatabaseSync;
  let outbox!: SyntheticIssueOutbox;
  const detach = store.observeIssueMutations((connection) => {
    db = connection;
    fixtureSchema(db);
    outbox = new SyntheticIssueOutbox(db, {
      clock: () => clock.now,
      schedule: clock.schedule,
      transport,
    });
    return outbox.observer();
  });
  outbox.start();
  return {
    db,
    outbox,
    detach,
    stop() {
      outbox.stop();
      detach();
    },
  };
}

export function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "sticker-icloud-outbox-"));
  const clock = new FixtureClock(),
    transport = new MemoryTransport();
  let store = new Store(dir);
  const project = store.createProject(owner, { key: "IC", name: "synthetic" });
  const issue = store.createIssue(owner, {
    projectId: project.id,
    title: "before",
    description: "old body",
  });
  let attached = attach(store, clock, transport);
  t.after(() => {
    attached.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    clock,
    transport,
    project,
    issue,
    get store() {
      return store;
    },
    get db() {
      return attached.db;
    },
    get outbox() {
      return attached.outbox;
    },
    rows() {
      return attached.db
        .prepare("SELECT * FROM fixture_cloud_outbox ORDER BY sequence")
        .all();
    },
    edit(patch: Record<string, unknown> = { title: "after" }) {
      const current = store.getIssue(owner, issue.id).issue;
      return store.updateIssue(owner, issue.id, {
        revision: current.revision,
        ...patch,
      });
    },
    restart() {
      attached.stop();
      store.close();
      store = new Store(dir);
      attached = attach(store, clock, transport);
    },
  };
}
