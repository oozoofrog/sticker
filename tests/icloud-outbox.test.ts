import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, scope } from "./fixtures/icloud/outbox-fixture.js";
import { canonicalJson } from "../server/canonical-json.js";
import { issueEnvelopeSchema } from "../server/icloud/mutations.js";

void test("committed edits automatically deliver without a caller sending or pumping", async (t) => {
  const f = fixture(t);
  f.edit();
  assert.equal(f.rows()[0].state, "pending");
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "acknowledged");
  assert.equal(f.transport.records.size, 1);
  assert.deepEqual(f.outbox.status(), {
    mode: "synthetic",
    bound: true,
    online: true,
    pending: 0,
    acknowledged: 1,
    quarantined: 0,
    blocked: 0,
    errorCode: null,
  });
});

void test("offline committed work survives until a connectivity event automatically resumes delivery", async (t) => {
  const f = fixture(t);
  f.outbox.setOnline(false);
  f.edit();
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "pending");
  assert.equal(f.transport.lookups, 0);
  f.outbox.setOnline(true);
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "acknowledged");
});

void test("restart recovers a commit whose wake never ran", async (t) => {
  const f = fixture(t);
  f.edit();
  f.restart();
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "acknowledged");
  assert.equal(f.transport.records.size, 1);
});

void test("lost send acknowledgment is read back on restart without a second remote operation", async (t) => {
  const f = fixture(t);
  const send = f.transport.send;
  f.transport.send = async (...args) => {
    await send(...args);
    throw new Error("secret transport detail");
  };
  f.edit();
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "inflight");
  assert.equal(f.transport.records.size, 1);
  f.restart();
  await f.clock.advance(1000);
  assert.equal(f.rows()[0].state, "acknowledged");
  assert.equal(f.transport.sends, 1);
  assert.equal(f.transport.lookups, 2);
});

void test("acknowledging N cannot erase the edit N+1 accepted while sending", async (t) => {
  const f = fixture(t);
  const send = f.transport.send;
  let release!: () => void;
  let first = true;
  f.transport.send = async (...args) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return send(...args);
  };
  f.edit({ title: "N" });
  await f.clock.settle();
  f.edit({ title: "N+1" });
  assert.deepEqual(
    f.rows().map((row) => row.state),
    ["inflight", "pending"],
  );
  release();
  await f.clock.settle();
  assert.deepEqual(
    f.rows().map((row) => row.state),
    ["acknowledged", "acknowledged"],
  );
  assert.deepEqual(
    [...f.transport.records.values()].map(
      (record) => record.envelope.content.title,
    ),
    ["N", "N+1"],
  );
});

for (const [axis, value] of Object.entries({
  bindingId: "55555555-5555-4555-8555-555555555555",
  datasetId: "66666666-6666-4666-8666-666666666666",
  generation: "77777777-7777-4777-8777-777777777777",
  accountEpoch: 2,
  restoreEpoch: 1,
  activeRootId: "88888888-8888-4888-8888-888888888888",
})) {
  void test(`changed ${axis} quarantines old work and rejects an in-flight late acknowledgment`, async (t) => {
    const f = fixture(t);
    const send = f.transport.send;
    let release!: () => void;
    f.transport.send = async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return send(...args);
    };
    f.edit();
    await f.clock.settle();
    f.outbox.bindScope({ ...scope, [axis]: value });
    release();
    await f.clock.settle();
    assert.equal(f.rows()[0].state, "quarantined");
    assert.equal(f.rows()[0].errorCode, "SCOPE_CHANGED");
    assert.equal(f.outbox.status().acknowledged, 0);
  });
}

for (const state of [
  "no_account",
  "restricted",
  "temporarily_unavailable",
  "could_not_determine",
] as const) {
  void test(`${state} fences dispatch; becoming available cannot bind or reuse the old account epoch`, async (t) => {
    const f = fixture(t);
    f.edit();
    f.outbox.observeAccount(state);
    f.outbox.observeAccount("available");
    await f.clock.settle();
    assert.equal(f.transport.records.size, 0);
    assert.equal(f.outbox.status().bound, false);
    assert.throws(() => {
      f.outbox.bindScope(scope);
    }, /STALE_SCOPE/);
    f.edit({ title: "unbound local edit" });
    assert.equal(f.rows()[1].state, "quarantined");
    f.outbox.bindScope({ ...scope, accountEpoch: 2 });
    f.edit({ title: "new scope" });
    await f.clock.settle();
    assert.deepEqual(
      f.rows().map((row) => row.state),
      ["quarantined", "quarantined", "acknowledged"],
    );
    assert.equal(f.transport.records.size, 1);
  });
}

void test("a changed operation digest from readback is retained blocked, never acknowledged or overwritten", async (t) => {
  const f = fixture(t);
  f.transport.lookup = (operationId) =>
    Promise.resolve({
      kind: "saved",
      operationId,
      digest: "a".repeat(64),
    });
  f.edit();
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "blocked");
  assert.equal(f.rows()[0].errorCode, "REMOTE_MISMATCH");
  assert.equal(f.transport.sends, 0);
});

void test("quota backoff is durable and respects retry-after without exposing transport details", async (t) => {
  const f = fixture(t);
  const lookup = f.transport.lookup;
  let first = true;
  f.transport.lookup = async (...args) =>
    first
      ? ((first = false), { kind: "retry", code: "QUOTA", retryAfterMs: 3000 })
      : lookup(...args);
  f.edit();
  await f.clock.settle();
  assert.equal(f.rows()[0].errorCode, "QUOTA");
  assert.equal(f.rows()[0].retryAt, 4000);
  f.restart();
  await f.clock.advance(2999);
  assert.equal(f.transport.records.size, 0);
  await f.clock.advance(1);
  assert.equal(f.rows()[0].state, "acknowledged");
  assert.equal(f.rows()[0].errorCode, null);
  assert.equal(JSON.stringify(f.outbox.status()).includes("payload"), false);
});

void test("unknown transport errors are redacted and replay preserves the same operation identity", async (t) => {
  const f = fixture(t);
  f.transport.lookup = () => Promise.reject(new Error("/private/token=CANARY"));
  f.edit();
  const original = f.rows()[0];
  await f.clock.settle();
  assert.equal(f.rows()[0].errorCode, "TRANSPORT_UNAVAILABLE");
  assert.equal(JSON.stringify(f.rows()).includes("CANARY"), false);
  assert.equal(JSON.stringify(f.outbox.status()).includes("CANARY"), false);
  await f.clock.advance(1000);
  assert.equal(f.rows()[0].operationId, original.operationId);
  assert.equal(f.rows()[0].digest, original.digest);
});

void test("tampered envelope unknown fields or duplicate keys remain blocked before transport", async (t) => {
  const f = fixture(t);
  for (const mutate of [
    (s: string) => s.slice(0, -1) + ',"token":"canary"}',
    (s: string) => '{"version":1,' + s.slice(1),
  ]) {
    f.edit({ title: String(f.rows().length) });
    const row = f.rows().at(-1);
    assert.ok(row);
    const payload = mutate(String(row.payload));
    f.db
      .prepare(
        "UPDATE fixture_cloud_outbox SET payload=?,digest=? WHERE operationId=?",
      )
      .run(
        payload,
        createHash("sha256").update(payload).digest("hex"),
        row.operationId,
      );
  }
  await f.clock.settle();
  assert.deepEqual(
    f.rows().map((row) => row.state),
    ["blocked", "blocked"],
  );
  assert.equal(f.transport.lookups, 0);
});

void test("same operation identity cannot be silently reused with changed payload", async (t) => {
  const f = fixture(t);
  f.edit();
  const row = f.rows()[0];
  const payload = canonicalJson({
    ...JSON.parse(String(row.payload)),
    content: { title: "forged", description: "old body" },
  });
  f.transport.records.set(String(row.operationId), {
    digest: String(row.digest),
    envelope: issueEnvelopeSchema.parse(JSON.parse(String(row.payload))),
  });
  f.db
    .prepare(
      "UPDATE fixture_cloud_outbox SET payload=?,digest=? WHERE operationId=?",
    )
    .run(
      payload,
      createHash("sha256").update(payload).digest("hex"),
      row.operationId,
    );
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "blocked");
  assert.equal(
    f.transport.records.get(String(row.operationId))?.envelope.content.title,
    "after",
  );
});

void test("oversized corrupt row is refused before payload loading and scheduler keeps valid later work", async (t) => {
  const f = fixture(t);
  f.edit();
  f.db.exec(
    "UPDATE fixture_cloud_outbox SET payload=replace(hex(zeroblob(600000)),'0','x')",
  );
  f.edit({ title: "later" });
  await f.clock.settle();
  assert.deepEqual(
    f.rows().map((row) => row.state),
    ["blocked", "acknowledged"],
  );
  assert.equal(f.transport.records.size, 1);
});

void test("stopped worker ignores late responses and restart reads the saved result", async (t) => {
  const f = fixture(t);
  const send = f.transport.send;
  let release!: () => void;
  f.transport.send = async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return send(...args);
  };
  f.edit();
  await f.clock.settle();
  f.outbox.stop();
  release();
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "inflight");
  f.restart();
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "acknowledged");
  assert.equal(f.transport.sends, 1);
});

void test("stop then start on the same worker recovers after its old pending response finishes", async (t) => {
  const f = fixture(t);
  const send = f.transport.send;
  let release!: () => void;
  f.transport.send = async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return send(...args);
  };
  f.edit();
  await f.clock.settle();
  f.outbox.stop();
  f.outbox.start();
  release();
  await f.clock.settle();
  assert.equal(f.rows()[0].state, "acknowledged");
  assert.equal(f.transport.sends, 1);
});

void test("each automatic turn is bounded to 100 operations and yields before draining the remainder", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 101; i++) f.edit({ title: `edit ${String(i)}` });
  await f.clock.turn();
  assert.equal(f.outbox.status().acknowledged, 100);
  assert.equal(f.outbox.status().pending, 1);
  await f.clock.settle();
  assert.equal(f.outbox.status().acknowledged, 101);
});

void test("UTF8 payload byte limit splits large batches without dropping a later edit", async (t) => {
  const f = fixture(t);
  f.edit({ description: "😀".repeat(50000) });
  f.edit({ description: "😁".repeat(50000) });
  f.edit({ description: "😂".repeat(50000) });
  f.edit({ description: "😃".repeat(50000) });
  await f.clock.turn();
  assert.equal(f.outbox.status().acknowledged, 3);
  assert.equal(f.outbox.status().pending, 1);
  await f.clock.settle();
  assert.equal(f.outbox.status().acknowledged, 4);
});

void test("account uncertainty during readback prevents the following send and survives restart", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  f.transport.lookup = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { kind: "missing" };
  };
  f.edit();
  await f.clock.settle();
  f.outbox.observeAccount("could_not_determine");
  release();
  await f.clock.settle();
  assert.equal(f.transport.sends, 0);
  f.restart();
  await f.clock.settle();
  assert.equal(f.outbox.status().bound, false);
  assert.equal(f.rows()[0].state, "quarantined");
});

void test("a retrying older revision cannot be overtaken by its newer pending revision", async (t) => {
  const f = fixture(t);
  const lookup = f.transport.lookup;
  let first = true;
  f.transport.lookup = async (...args) =>
    first
      ? ((first = false),
        { kind: "retry", code: "THROTTLED", retryAfterMs: 1000 })
      : lookup(...args);
  f.edit({ title: "N" });
  f.edit({ title: "N+1" });
  await f.clock.settle();
  assert.equal(f.transport.records.size, 0);
  assert.deepEqual(
    f.rows().map((row) => row.state),
    ["inflight", "pending"],
  );
  await f.clock.advance(1000);
  assert.deepEqual(
    [...f.transport.records.values()].map(
      (value) => value.envelope.content.title,
    ),
    ["N", "N+1"],
  );
});
