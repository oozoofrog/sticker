import { createHash } from "node:crypto";
import { z } from "zod";
import {
  accountEpochSchema,
  accountSnapshotSchema,
  accountStateSchema,
  capabilityStateSchema,
  driveStateSchema,
  scopeSchema,
  type AccountFailure,
  type AccountSnapshot,
  type CloudError,
} from "./contracts.js";

const identitySchema = z
  .object({
    container: z.string().min(1).max(255),
    environment: z.enum(["Development", "Production"]),
    userRecordId: z.string().min(1).max(4096),
  })
  .strict();
const driveIdentitySchema = z.string().min(1).max(4096).nullable();
const observationSchema = z
  .object({
    // Issued monotonically by the future trusted observer, not an Apple timestamp.
    sequence: accountEpochSchema,
    capability: capabilityStateSchema,
    cloudKit: accountStateSchema,
    drive: driveStateSchema,
    cloudKitIdentity: identitySchema.nullable(),
    // Opaque equality handle supplied by an adapter; never parsed or displayed.
    driveIdentity: driveIdentitySchema,
    identityChanged: z.boolean(),
  })
  .strict();
const privateStateSchema = z
  .object({
    accountEpoch: accountEpochSchema,
    restoreEpoch: accountEpochSchema,
    activeRootId: z.uuid(),
    observation: observationSchema.nullable(),
    checkedAt: z.iso.datetime({ precision: 3 }).max(24).nullable(),
    pendingResolution: z.boolean(),
    dispatchEligible: z.boolean(),
    binding: z
      .object({
        bindingId: z.uuid(),
        datasetId: z.uuid(),
        generation: z.uuid(),
        cloudKitIdentity: identitySchema,
        driveIdentity: driveIdentitySchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
const clockSchema = z.number().int().min(0).max(253402300799999);
const targetSchema = z.enum(["cloudkit", "drive"]);

type PrivateIdentity = z.infer<typeof identitySchema>;
export type AccountObservation = z.infer<typeof observationSchema>;
/** Caller-owned private comparison state. Never serialize this as product status. */
export type PrivateAccountState = z.infer<typeof privateStateSchema>;
export type AccountTransition =
  | { ok: true; state: PrivateAccountState; invalidated: boolean }
  | AccountFailure;

function failure(code: CloudError["code"]): AccountFailure {
  return { ok: false, error: { code } };
}
function sameIdentity(a: PrivateIdentity | null, b: PrivateIdentity | null) {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.container === b.container &&
      a.environment === b.environment &&
      a.userRecordId === b.userRecordId)
  );
}
function resolved(observation: AccountObservation) {
  return (
    observation.cloudKit === "available" &&
    observation.cloudKitIdentity !== null &&
    ((observation.drive === "available" &&
      observation.driveIdentity !== null) ||
      (observation.drive === "unavailable" &&
        observation.driveIdentity === null))
  );
}
function sameObservation(a: AccountObservation, b: AccountObservation) {
  return (
    a.sequence === b.sequence &&
    a.capability === b.capability &&
    a.cloudKit === b.cloudKit &&
    a.drive === b.drive &&
    sameIdentity(a.cloudKitIdentity, b.cloudKitIdentity) &&
    a.driveIdentity === b.driveIdentity &&
    a.identityChanged === b.identityChanged
  );
}

/**
 * In-memory decision only: no provider, attachment, grant or durable fence.
 * Caller supplies time and all IDs. Failure must stop its attempted operation;
 * future orchestration must persist decisions before dispatching anything.
 */
export function transitionAccount(
  stateInput: unknown,
  observationInput: unknown,
  nowInput: unknown,
): AccountTransition {
  const parsedState = privateStateSchema.safeParse(stateInput);
  const parsedObservation = observationSchema.safeParse(observationInput);
  const parsedClock = clockSchema.safeParse(nowInput);
  if (
    !parsedState.success ||
    !parsedObservation.success ||
    !parsedClock.success
  )
    return failure("INVALID_ACCOUNT_INPUT");
  const state = parsedState.data;
  const observation = parsedObservation.data;
  const previous = state.observation;
  if (previous && observation.sequence < previous.sequence)
    return failure("STALE_OBSERVATION");
  if (previous && observation.sequence === previous.sequence) {
    return sameObservation(previous, observation)
      ? { ok: true, state, invalidated: false }
      : failure("OBSERVATION_CONFLICT");
  }
  const identityChanged =
    previous !== null &&
    (!sameIdentity(previous.cloudKitIdentity, observation.cloudKitIdentity) ||
      previous.driveIdentity !== observation.driveIdentity);
  const eligible =
    observation.capability === "ready" &&
    resolved(observation) &&
    !observation.identityChanged;
  const invalidated =
    observation.identityChanged ||
    identityChanged ||
    (state.pendingResolution && state.binding !== null) ||
    (!eligible &&
      (state.binding !== null ||
        state.dispatchEligible ||
        (previous?.capability === "ready" && resolved(previous))));
  if (invalidated && state.accountEpoch === Number.MAX_SAFE_INTEGER)
    return failure("ACCOUNT_EPOCH_EXHAUSTED");
  return {
    ok: true,
    invalidated,
    state: {
      ...state,
      observation,
      checkedAt: new Date(parsedClock.data).toISOString(),
      accountEpoch: state.accountEpoch + (invalidated ? 1 : 0),
      pendingResolution: !eligible || identityChanged,
      binding: invalidated ? null : state.binding,
      dispatchEligible: invalidated ? false : state.dispatchEligible,
    },
  };
}

/** Explicit allowlist projection, including only a container-scoped digest. */
export function projectAccountStatus(
  stateInput: unknown,
): { ok: true; snapshot: AccountSnapshot } | AccountFailure {
  const parsed = privateStateSchema.safeParse(stateInput);
  if (!parsed.success) return failure("INVALID_ACCOUNT_INPUT");
  const state = parsed.data;
  const observation = state.observation;
  let displayAccountId: string | null = null;
  if (
    observation?.capability === "ready" &&
    resolved(observation) &&
    !observation.identityChanged &&
    !state.pendingResolution &&
    state.checkedAt !== null &&
    observation.cloudKitIdentity
  ) {
    const identity = observation.cloudKitIdentity;
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          identity.container,
          identity.environment,
          identity.userRecordId,
        ]),
      )
      .digest("hex");
    displayAccountId = `acct-${digest.slice(0, 12)}`;
  }
  const snapshot = accountSnapshotSchema.safeParse({
    capability: observation?.capability ?? "NOT_CONFIGURED",
    cloudKit: observation?.cloudKit ?? "could_not_determine",
    drive: observation?.drive ?? "could_not_determine",
    displayAccountId,
    checkedAt: state.checkedAt,
  });
  return snapshot.success
    ? { ok: true, snapshot: snapshot.data }
    : failure("INVALID_ACCOUNT_INPUT");
}

/**
 * Checks comparison consistency against trusted caller-owned state, NOT caller
 * authorization. No wire value can create the binding or enable dispatch here.
 */
export function checkAccountScope(
  stateInput: unknown,
  scopeInput: unknown,
  targetInput: unknown,
): { ok: true } | AccountFailure {
  const parsedState = privateStateSchema.safeParse(stateInput);
  if (!parsedState.success) return failure("INVALID_ACCOUNT_INPUT");
  const parsedScope = scopeSchema.safeParse(scopeInput);
  const parsedTarget = targetSchema.safeParse(targetInput);
  if (!parsedScope.success || !parsedTarget.success)
    return failure("INVALID_SCOPE");
  const state = parsedState.data;
  const observation = state.observation;
  if (!observation) return failure("ACCOUNT_UNRESOLVED");
  if (observation.capability !== "ready")
    return failure(observation.capability);
  if (
    state.checkedAt === null ||
    state.pendingResolution ||
    observation.identityChanged ||
    !resolved(observation)
  )
    return failure("ACCOUNT_UNRESOLVED");
  if (parsedTarget.data === "drive" && observation.drive !== "available")
    return failure("ACCOUNT_UNAVAILABLE");
  const binding = state.binding;
  if (!binding) return failure("NOT_BOUND");
  if (
    !sameIdentity(binding.cloudKitIdentity, observation.cloudKitIdentity) ||
    binding.driveIdentity !== observation.driveIdentity
  )
    return failure("ACCOUNT_UNRESOLVED");
  if (!state.dispatchEligible) return failure("DISPATCH_PAUSED");
  const scope = parsedScope.data;
  if (
    binding.bindingId !== scope.bindingId ||
    binding.datasetId !== scope.datasetId ||
    binding.generation !== scope.generation ||
    state.accountEpoch !== scope.accountEpoch ||
    state.restoreEpoch !== scope.restoreEpoch ||
    state.activeRootId !== scope.activeRootId
  )
    return failure("SCOPE_MISMATCH");
  return { ok: true };
}
