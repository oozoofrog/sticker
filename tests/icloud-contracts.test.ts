import assert from "node:assert/strict";
import test from "node:test";
import {
  accountSnapshotSchema,
  accountStateSchema,
  cloudErrorSchema,
  scopeSchema,
} from "../server/icloud/contracts.js";

const scope = {
  bindingId: "11111111-1111-4111-8111-111111111111",
  datasetId: "22222222-2222-4222-8222-222222222222",
  generation: "33333333-3333-4333-8333-333333333333",
  accountEpoch: 4,
  restoreEpoch: 2,
  activeRootId: "44444444-4444-4444-8444-444444444444",
};
const snapshot = {
  capability: "ready",
  cloudKit: "available",
  drive: "unavailable",
  displayAccountId: "acct-012345abcdef",
  checkedAt: "2026-10-31T12:00:00.000Z",
};

void test("all five account states survive parsing without conflation", () => {
  for (const value of [
    "available",
    "no_account",
    "restricted",
    "temporarily_unavailable",
    "could_not_determine",
  ]) {
    assert.equal(accountStateSchema.parse(value), value);
  }
  assert.equal(accountStateSchema.safeParse("signed_in").success, false);
});

void test("CloudKit, Drive and capability failures remain distinct", () => {
  assert.deepEqual(accountSnapshotSchema.parse(snapshot), snapshot);
  for (const capability of [
    "NOT_CONFIGURED",
    "NATIVE_BRIDGE_REQUIRED",
    "BRIDGE_UNAVAILABLE",
    "SYNC_OS_UNSUPPORTED",
  ]) {
    const result = accountSnapshotSchema.parse({
      ...snapshot,
      capability,
      displayAccountId: null,
    });
    assert.equal(result.capability, capability);
    assert.equal(result.cloudKit, "available");
    assert.equal(result.drive, "unavailable");
  }
});

void test("public account status rejects private, unsafe and fabricated status fields", () => {
  for (const extra of [
    { userRecordId: "PRIVATE-IDENTITY-CANARY" },
    { driveIdentity: "DRIVE-TOKEN-CANARY" },
    { email: "private@example.invalid" },
    { path: "/private/account/file" },
    { token: "SECRET-CANARY" },
    { rawError: { message: "PRIVATE-PROVIDER-ERROR" } },
    { synced: true },
    { uploaded: true },
    { dispatchEligible: true },
  ]) {
    assert.equal(
      accountSnapshotSchema.safeParse({ ...snapshot, ...extra }).success,
      false,
    );
  }
  for (const displayAccountId of [
    "private@example.invalid",
    "/private/account",
    "acct-" + "a".repeat(1000),
    "acct-012345abcde\n",
  ]) {
    assert.equal(
      accountSnapshotSchema.safeParse({ ...snapshot, displayAccountId })
        .success,
      false,
    );
  }
  assert.equal(
    accountSnapshotSchema.safeParse({ ...snapshot, checkedAt: "not-a-date" })
      .success,
    false,
  );
  assert.equal(
    accountSnapshotSchema.safeParse({
      ...snapshot,
      checkedAt: "x".repeat(1000),
    }).success,
    false,
  );
});

void test("unresolved status cannot claim a resolved display account", () => {
  for (const override of [
    { cloudKit: "no_account" },
    { cloudKit: "could_not_determine" },
    { drive: "could_not_determine" },
    { capability: "NOT_CONFIGURED" },
    { checkedAt: null },
  ]) {
    assert.equal(
      accountSnapshotSchema.safeParse({ ...snapshot, ...override }).success,
      false,
    );
  }
});

void test("scope accepts bounded comparison data but rejects invalid axes or grants", () => {
  assert.deepEqual(scopeSchema.parse(scope), scope);
  for (const axis of ["bindingId", "datasetId", "generation", "activeRootId"]) {
    for (const value of ["", "x".repeat(1000), "/private/data", "not-a-uuid"]) {
      assert.equal(
        scopeSchema.safeParse({ ...scope, [axis]: value }).success,
        false,
      );
    }
  }
  for (const axis of ["accountEpoch", "restoreEpoch"]) {
    for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "4"]) {
      assert.equal(
        scopeSchema.safeParse({ ...scope, [axis]: value }).success,
        false,
      );
    }
  }
  assert.equal(
    scopeSchema.safeParse({ ...scope, role: "owner" }).success,
    false,
  );
  assert.equal(
    scopeSchema.safeParse({ ...scope, trusted: true }).success,
    false,
  );
});

void test("safe errors cannot carry freeform provider messages or secrets", () => {
  assert.deepEqual(cloudErrorSchema.parse({ code: "ACCOUNT_UNRESOLVED" }), {
    code: "ACCOUNT_UNRESOLVED",
  });
  for (const error of [
    { code: "PRIVATE-PROVIDER-ERROR" },
    { code: "ACCOUNT_UNRESOLVED", message: "SECRET-CANARY" },
    { code: "ACCOUNT_UNRESOLVED", cause: { path: "/private/account/file" } },
    { code: "a".repeat(1000) },
  ]) {
    assert.equal(cloudErrorSchema.safeParse(error).success, false);
  }
});
