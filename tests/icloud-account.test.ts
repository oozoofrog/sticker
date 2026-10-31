import assert from "node:assert/strict";
import test from "node:test";
import {
  checkAccountScope,
  projectAccountStatus,
  transitionAccount,
  type AccountObservation,
  type PrivateAccountState,
} from "../server/icloud/account.js";

const now = 1793448000000;
const identityA = {
  container: "iCloud.fixture.sticker",
  environment: "Development" as const,
  userRecordId: "PRIVATE-IDENTITY-A-CANARY",
};
const observationA: AccountObservation = {
  sequence: 10,
  capability: "ready",
  cloudKit: "available",
  drive: "available",
  cloudKitIdentity: identityA,
  driveIdentity: "DRIVE-TOKEN-A-CANARY",
  identityChanged: false,
};
const scope = {
  bindingId: "11111111-1111-4111-8111-111111111111",
  datasetId: "22222222-2222-4222-8222-222222222222",
  generation: "33333333-3333-4333-8333-333333333333",
  accountEpoch: 4,
  restoreEpoch: 2,
  activeRootId: "44444444-4444-4444-8444-444444444444",
};
function boundState(): PrivateAccountState {
  return {
    accountEpoch: 4,
    restoreEpoch: 2,
    activeRootId: scope.activeRootId,
    checkedAt: "2026-10-31T12:00:00.000Z",
    observation: structuredClone(observationA),
    pendingResolution: false,
    dispatchEligible: true,
    binding: {
      bindingId: scope.bindingId,
      datasetId: scope.datasetId,
      generation: scope.generation,
      cloudKitIdentity: structuredClone(identityA),
      driveIdentity: observationA.driveIdentity,
    },
  };
}
function next(
  state: PrivateAccountState,
  observation: AccountObservation,
  time = now,
) {
  const result = transitionAccount(state, observation, time);
  assert.equal(result.ok, true);
  return result;
}
function status(state: PrivateAccountState) {
  const result = projectAccountStatus(state);
  assert.equal(result.ok, true);
  return result.snapshot;
}

void test("available observation never binds a dataset or grants dispatch", () => {
  const state: PrivateAccountState = {
    ...boundState(),
    observation: null,
    checkedAt: null,
    binding: null,
    dispatchEligible: false,
    pendingResolution: true,
  };
  const result = next(state, observationA);
  assert.equal(result.state.binding, null);
  assert.equal(result.state.dispatchEligible, false);
  assert.equal(result.state.accountEpoch, 4);
  assert.deepEqual(checkAccountScope(result.state, scope, "cloudkit"), {
    ok: false,
    error: { code: "NOT_BOUND" },
  });
  assert.equal(status(result.state).cloudKit, "available");
  assert.equal("synced" in status(result.state), false);
  assert.equal("uploaded" in status(result.state), false);
});

void test("matching scope needs both resolved identity and caller-supplied dispatch eligibility", () => {
  assert.deepEqual(checkAccountScope(boundState(), scope, "cloudkit"), {
    ok: true,
  });
  assert.deepEqual(checkAccountScope(boundState(), scope, "drive"), {
    ok: true,
  });
  assert.deepEqual(
    checkAccountScope(
      { ...boundState(), dispatchEligible: false },
      scope,
      "cloudkit",
    ),
    { ok: false, error: { code: "DISPATCH_PAUSED" } },
  );
  assert.deepEqual(
    checkAccountScope(
      { ...boundState(), pendingResolution: true },
      scope,
      "cloudkit",
    ),
    { ok: false, error: { code: "ACCOUNT_UNRESOLVED" } },
  );
});

void test("every independent scope axis invalidates an old claim", () => {
  const other = "55555555-5555-4555-8555-555555555555";
  for (const [axis, value] of Object.entries({
    bindingId: other,
    datasetId: other,
    generation: other,
    accountEpoch: 5,
    restoreEpoch: 3,
    activeRootId: other,
  })) {
    assert.deepEqual(
      checkAccountScope(boundState(), { ...scope, [axis]: value }, "cloudkit"),
      {
        ok: false,
        error: { code: "SCOPE_MISMATCH" },
      },
      axis,
    );
  }
});

void test("A to B drops display and old binding until a fresh resolution, never reattaches", () => {
  const first = next(boundState(), {
    ...observationA,
    sequence: 11,
    cloudKitIdentity: {
      ...identityA,
      userRecordId: "PRIVATE-IDENTITY-B-CANARY",
    },
    driveIdentity: "DRIVE-TOKEN-B-CANARY",
  });
  assert.equal(first.invalidated, true);
  assert.equal(first.state.accountEpoch, 5);
  assert.equal(first.state.binding, null);
  assert.equal(first.state.dispatchEligible, false);
  assert.equal(status(first.state).displayAccountId, null);
  assert.equal(checkAccountScope(first.state, scope, "cloudkit").ok, false);
  const resolved = next(
    first.state,
    {
      ...observationA,
      sequence: 12,
      cloudKitIdentity: {
        ...identityA,
        userRecordId: "PRIVATE-IDENTITY-B-CANARY",
      },
      driveIdentity: "DRIVE-TOKEN-B-CANARY",
    },
    now - 50000,
  );
  assert.equal(resolved.state.accountEpoch, 5);
  assert.equal(resolved.state.binding, null);
  assert.equal(resolved.state.dispatchEligible, false);
  assert.match(
    status(resolved.state).displayAccountId ?? "",
    /^acct-[a-f0-9]{12}$/,
  );
  assert.notEqual(
    status(resolved.state).displayAccountId,
    status(boundState()).displayAccountId,
  );
  assert.equal(checkAccountScope(resolved.state, scope, "cloudkit").ok, false);
});

void test("sign-out and every uncertain account state clear identity display and invalidate scope", () => {
  for (const cloudKit of [
    "no_account",
    "restricted",
    "temporarily_unavailable",
    "could_not_determine",
  ] as const) {
    const result = next(boundState(), {
      ...observationA,
      sequence: 11,
      cloudKit,
      cloudKitIdentity: null,
    });
    assert.equal(result.invalidated, true, cloudKit);
    assert.equal(result.state.accountEpoch, 5);
    assert.equal(result.state.binding, null);
    assert.equal(status(result.state).cloudKit, cloudKit);
    assert.equal(status(result.state).displayAccountId, null);
    assert.equal(checkAccountScope(result.state, scope, "cloudkit").ok, false);
  }
});

void test("available without resolved identity fails closed", () => {
  for (const override of [
    { cloudKitIdentity: null },
    { driveIdentity: null },
  ]) {
    const result = next(boundState(), {
      ...observationA,
      sequence: 11,
      ...override,
    });
    assert.equal(result.invalidated, true);
    assert.equal(result.state.accountEpoch, 5);
    assert.equal(status(result.state).displayAccountId, null);
    assert.equal(checkAccountScope(result.state, scope, "cloudkit").ok, false);
  }
});

void test("Drive changes and identity-change signals fence both transports", () => {
  for (const override of [
    { driveIdentity: "DRIVE-TOKEN-B-CANARY" },
    { drive: "could_not_determine" as const, driveIdentity: null },
    { identityChanged: true },
    { cloudKitIdentity: { ...identityA, environment: "Production" as const } },
    { cloudKitIdentity: { ...identityA, container: "iCloud.other.fixture" } },
  ]) {
    const result = next(boundState(), {
      ...observationA,
      sequence: 11,
      ...override,
    });
    assert.equal(result.invalidated, true);
    assert.equal(result.state.accountEpoch, 5);
    assert.equal(status(result.state).displayAccountId, null);
    assert.equal(checkAccountScope(result.state, scope, "cloudkit").ok, false);
    assert.equal(checkAccountScope(result.state, scope, "drive").ok, false);
  }
});

void test("known Drive unavailability is independent of CloudKit eligibility", () => {
  const state = boundState();
  state.observation = {
    ...observationA,
    drive: "unavailable",
    driveIdentity: null,
  };
  if (!state.binding) throw new Error("Fixture binding missing");
  state.binding.driveIdentity = null;
  assert.equal(status(state).cloudKit, "available");
  assert.equal(status(state).drive, "unavailable");
  assert.deepEqual(checkAccountScope(state, scope, "cloudkit"), { ok: true });
  assert.deepEqual(checkAccountScope(state, scope, "drive"), {
    ok: false,
    error: { code: "ACCOUNT_UNAVAILABLE" },
  });
});

void test("capability failures never masquerade as sign-out or preserve dispatch", () => {
  for (const capability of [
    "NOT_CONFIGURED",
    "NATIVE_BRIDGE_REQUIRED",
    "BRIDGE_UNAVAILABLE",
    "SYNC_OS_UNSUPPORTED",
  ] as const) {
    const result = next(boundState(), {
      ...observationA,
      sequence: 11,
      capability,
    });
    assert.equal(status(result.state).capability, capability);
    assert.equal(status(result.state).cloudKit, "available");
    assert.equal(result.state.binding, null);
    assert.equal(result.state.dispatchEligible, false);
    assert.deepEqual(checkAccountScope(result.state, scope, "cloudkit"), {
      ok: false,
      error: { code: capability },
    });
  }
});

void test("duplicates and old observations cannot restore a fenced account or mint a binding", () => {
  const uncertain = {
    ...observationA,
    sequence: 11,
    cloudKit: "could_not_determine" as const,
    cloudKitIdentity: null,
  };
  const result = next(boundState(), uncertain);
  const duplicate = next(result.state, uncertain, now + 10000);
  assert.deepEqual(duplicate.state, result.state);
  assert.equal(duplicate.invalidated, false);
  assert.deepEqual(transitionAccount(result.state, observationA, now - 10000), {
    ok: false,
    error: { code: "STALE_OBSERVATION" },
  });
  assert.deepEqual(
    transitionAccount(result.state, { ...observationA, sequence: 11 }, now),
    {
      ok: false,
      error: { code: "OBSERVATION_CONFLICT" },
    },
  );
  assert.equal(status(result.state).displayAccountId, null);
});

void test("private identity mismatch prevents dispatch even with a matching wire scope", () => {
  const state = boundState();
  if (!state.binding) throw new Error("Fixture binding missing");
  state.binding.cloudKitIdentity.userRecordId = "PRIVATE-IDENTITY-B-CANARY";
  assert.deepEqual(checkAccountScope(state, scope, "cloudkit"), {
    ok: false,
    error: { code: "ACCOUNT_UNRESOLVED" },
  });
});

void test("public projection exposes only a bounded scoped digest, never private identities", () => {
  const projected = status(boundState());
  assert.deepEqual(Object.keys(projected).sort(), [
    "capability",
    "checkedAt",
    "cloudKit",
    "displayAccountId",
    "drive",
  ]);
  assert.match(projected.displayAccountId ?? "", /^acct-[a-f0-9]{12}$/);
  for (const canary of [
    "PRIVATE-IDENTITY-A-CANARY",
    "DRIVE-TOKEN-A-CANARY",
    "iCloud.fixture.sticker",
  ]) {
    assert.equal(JSON.stringify(projected).includes(canary), false);
  }
  const otherContainer = boundState();
  if (!otherContainer.observation?.cloudKitIdentity)
    throw new Error("Fixture identity missing");
  otherContainer.observation.cloudKitIdentity.container =
    "iCloud.other.fixture";
  assert.notEqual(
    status(otherContainer).displayAccountId,
    projected.displayAccountId,
  );
});

void test("malformed provider input, scope and clock produce only bounded safe errors", () => {
  const invalid = transitionAccount(
    boundState(),
    { ...observationA, rawError: "SECRET-PROVIDER-CANARY /private/account" },
    now,
  );
  assert.deepEqual(invalid, {
    ok: false,
    error: { code: "INVALID_ACCOUNT_INPUT" },
  });
  assert.deepEqual(
    transitionAccount(boundState(), observationA, Infinity),
    invalid,
  );
  assert.deepEqual(
    transitionAccount(
      boundState(),
      {
        ...observationA,
        sequence: 11,
        cloudKitIdentity: { ...identityA, userRecordId: "x".repeat(4097) },
      },
      now,
    ),
    invalid,
  );
  assert.deepEqual(
    projectAccountStatus({ ...boundState(), token: "SECRET-CANARY" }),
    invalid,
  );
  assert.deepEqual(
    checkAccountScope(
      boundState(),
      { ...scope, token: "SECRET-CANARY" },
      "cloudkit",
    ),
    {
      ok: false,
      error: { code: "INVALID_SCOPE" },
    },
  );
  assert.deepEqual(
    checkAccountScope(boundState(), scope, "arbitrary-service"),
    {
      ok: false,
      error: { code: "INVALID_SCOPE" },
    },
  );
  assert.equal(JSON.stringify(invalid).includes("CANARY"), false);
});

void test("epoch exhaustion refuses invalidation without wrapping to an old scope", () => {
  const state = { ...boundState(), accountEpoch: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(
    transitionAccount(
      state,
      { ...observationA, sequence: 11, identityChanged: true },
      now,
    ),
    {
      ok: false,
      error: { code: "ACCOUNT_EPOCH_EXHAUSTED" },
    },
  );
});

void test("transitions and scope checks leave supplied state and observations untouched", () => {
  const state = boundState();
  const before = structuredClone(state);
  const observation = { ...observationA, sequence: 11, identityChanged: true };
  const input = structuredClone(observation);
  const result = next(state, observation);
  checkAccountScope(state, scope, "cloudkit");
  status(state);
  assert.deepEqual(state, before);
  assert.deepEqual(observation, input);
  result.state.accountEpoch = 77;
  if (result.state.observation?.cloudKitIdentity)
    result.state.observation.cloudKitIdentity.userRecordId = "changed";
  assert.deepEqual(state, before);
  assert.deepEqual(observation, input);
});

void test("an unchecked observation cannot validate a dispatch scope", () => {
  const state = { ...boundState(), checkedAt: null };
  assert.deepEqual(checkAccountScope(state, scope, "cloudkit"), {
    ok: false,
    error: { code: "ACCOUNT_UNRESOLVED" },
  });
  assert.equal(status(state).displayAccountId, null);
});
