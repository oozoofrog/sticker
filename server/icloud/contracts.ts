import { z } from "zod";

export const accountStateSchema = z.enum([
  "available",
  "no_account",
  "restricted",
  "temporarily_unavailable",
  "could_not_determine",
]);
export const driveStateSchema = z.enum([
  "available",
  "unavailable",
  "could_not_determine",
]);
export const capabilityStateSchema = z.enum([
  "ready",
  "NOT_CONFIGURED",
  "NATIVE_BRIDGE_REQUIRED",
  "BRIDGE_UNAVAILABLE",
  "SYNC_OS_UNSUPPORTED",
]);
export const accountEpochSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/** Wire comparison data only. Parsing this value never establishes authority. */
export const scopeSchema = z
  .object({
    bindingId: z.uuid(),
    datasetId: z.uuid(),
    generation: z.uuid(),
    accountEpoch: accountEpochSchema,
    restoreEpoch: accountEpochSchema,
    activeRootId: z.uuid(),
  })
  .strict();

/** No provider errors, private identities, paths, grants or sync-success fields. */
export const accountSnapshotSchema = z
  .object({
    capability: capabilityStateSchema,
    cloudKit: accountStateSchema,
    drive: driveStateSchema,
    displayAccountId: z
      .string()
      .regex(/^acct-[a-f0-9]{12}$/)
      .max(17)
      .nullable(),
    checkedAt: z.iso.datetime({ precision: 3 }).max(24).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.displayAccountId === null ||
      (value.capability === "ready" &&
        value.cloudKit === "available" &&
        value.drive !== "could_not_determine" &&
        value.checkedAt !== null),
    "Account display requires a resolved observation.",
  );

export const cloudErrorSchema = z
  .object({
    code: z.enum([
      "INVALID_ACCOUNT_INPUT",
      "INVALID_SCOPE",
      "ACCOUNT_UNRESOLVED",
      "ACCOUNT_UNAVAILABLE",
      "NOT_BOUND",
      "DISPATCH_PAUSED",
      "SCOPE_MISMATCH",
      "STALE_OBSERVATION",
      "OBSERVATION_CONFLICT",
      "ACCOUNT_EPOCH_EXHAUSTED",
      "NOT_CONFIGURED",
      "NATIVE_BRIDGE_REQUIRED",
      "BRIDGE_UNAVAILABLE",
      "SYNC_OS_UNSUPPORTED",
    ]),
  })
  .strict();

export type Scope = z.infer<typeof scopeSchema>;
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;
export type CloudError = z.infer<typeof cloudErrorSchema>;
export type AccountFailure = { ok: false; error: CloudError };
