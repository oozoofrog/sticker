import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safeText = z
  .string()
  .min(1)
  .max(300)
  .refine((v) =>
    Array.from(v).every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return (
        point >= 32 && point !== 127 && !(point >= 0xd800 && point <= 0xdfff)
      );
    }),
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Shared wire contract: proleptic Gregorian years 0001–9999, literal UTC Z,
// seconds 00–59, optional 1–9 fractional digits (30 characters maximum).
function isStrictUTCStamp(value: string): boolean {
  const match =
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?Z$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0);
}
const stamp = z.string().max(30).refine(isStrictUTCStamp);
export const nativeClientIdSchema = z.enum([
  "codex-local",
  "claude-code-local",
  "claude-desktop",
]);
const action = z.enum(["connect", "update", "remove"]);
const availability = z.enum([
  "ready",
  "not_detected",
  "ambiguous_installation",
  "unsupported_profile",
  "provider_managed",
  "policy_blocked",
  "credential_unavailable",
  "permission_required",
  "writer_unavailable",
  "owned_conflict",
  "companion_unavailable",
]);
const reason = z.enum([
  "not_in_checked_locations",
  "multiple_installations",
  "invalid_metadata",
  "candidate_limit",
  "writer_not_certified",
  "provider_managed",
  "metadata_unavailable",
]);
const errorCode = z.enum([
  "invalid_input",
  "message_too_large",
  "owned_conflict",
  "writer_unavailable",
  "operation_conflict",
  "permission_required",
  "plan_expired",
  "plan_capacity",
  "unsafe_storage",
  "invalid_storage",
  "cancellation_unconfirmed",
  "project_required",
  "unsupported_profile",
  "config_too_large",
  "config_ambiguous",
]);
const protocolCheck = z.enum([
  "not_checked",
  "initialized",
  "tools_verified",
  "failed",
]);
const clientLoad = z.enum([
  "unknown",
  "refresh_required",
  "verified",
  "policy_blocked",
]);
const phase = z.enum([
  "planned",
  "awaiting_native_confirmation",
  "provisioning",
  "grant_provisional",
  "prepared",
  "provider_applied",
  "activating",
  "cleanup_pending",
  "verifying",
  "committed",
  "rolled_back",
  "canceled",
  "conflict",
  "uncertain",
]);
export const nativeCleanupReceiptsSchema = z
  .object({
    configCompensation: z.enum([
      "not_needed",
      "pending",
      "restored",
      "conflict",
      "uncertain",
    ]),
    newGrantCleanup: z.enum([
      "not_created",
      "pending",
      "revoked",
      "confirmed_expired",
      "uncertain",
    ]),
    secretCleanup: z.enum(["not_owned", "retained", "deleted"]),
  })
  .strict();
export const nativeClientSnapshotSchema = z
  .object({
    clientId: nativeClientIdSchema,
    displayName: safeText,
    safeVersion: z
      .string()
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/)
      .max(80)
      .optional(),
    availability,
    registration: z.enum([
      "unknown",
      "absent",
      "owned",
      "modified_owned",
      "unmanaged_conflict",
    ]),
    ownershipRevision: revision,
    allowedActions: z
      .array(action)
      .max(3)
      .refine((a) => new Set(a).size === a.length),
    credentialState: z.enum([
      "available",
      "grant_required",
      "provisional",
      "expired",
      "unverified",
    ]),
    protocolCheck,
    clientLoad,
    checkedAt: stamp,
    reasonCodes: z.array(reason).max(8),
  })
  .strict();
const rights = z
  .object({ projectIds: z.array(id).length(1), canWrite: z.boolean() })
  .strict();
export const nativeConnectionPlanSchema = z
  .object({
    kind: z.literal("plan"),
    planId: id,
    action,
    clientId: nativeClientIdSchema,
    targetSummary: safeText,
    rights,
    changes: z
      .array(
        z
          .object({
            field: z.enum(["launcher", "tool_visibility", "registration"]),
            change: z.enum(["add", "update", "remove"]),
          })
          .strict(),
      )
      .max(3),
    retainedFilters: z
      .object({
        hasCustomFilters: z.boolean(),
        enabledToolsCount: revision,
        disabledToolsCount: revision,
        approvalsPreserved: z.literal(true),
      })
      .strict(),
    expectedOwnershipRevision: revision,
    expectedProviderVersion: id,
    digest,
    expiresAt: stamp,
    requiredIntent: z.enum([
      "connect_scoped_project",
      "update_owned_connection",
      "remove_owned_connection",
    ]),
    verificationExpectation: z.literal("initialize_tools_and_safe_read"),
  })
  .strict();
const operation = z
  .object({
    kind: z.literal("operation"),
    operationId: id,
    clientId: nativeClientIdSchema,
    action,
    phase,
    cleanup: nativeCleanupReceiptsSchema,
    checkedAt: stamp,
    reason: errorCode.optional(),
  })
  .strict();
const verification = z
  .object({
    kind: z.literal("verification"),
    clientId: nativeClientIdSchema,
    config: z.enum(["not_checked", "saved", "conflict", "invalid"]),
    protocol: protocolCheck,
    actualClient: clientLoad,
    expectedToolCount: revision,
    availableToolCount: revision,
    missingToolNames: z.array(id).max(512),
    checkedAt: stamp,
    actor: z
      .object({
        role: z.literal("agent"),
        canWrite: z.boolean(),
        projectIds: z.array(id).length(1),
      })
      .strict()
      .optional(),
  })
  .strict();
const base = { version: z.literal(1), requestId: id };
export const nativeLifecycleRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      ...base,
      method: z.literal("detectClients"),
      refreshMetadata: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("planChange"),
      clientId: nativeClientIdSchema,
      action,
      expectedOwnershipRevision: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("applyChange"),
      planId: id,
      digest,
      operationId: id,
    })
    .strict(),
  z
    .object({ ...base, method: z.literal("getOperation"), operationId: id })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("verifyConnection"),
      clientId: nativeClientIdSchema,
      expectedOwnershipRevision: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      method: z.literal("planRollback"),
      appliedOperationId: id,
      expectedOwnershipRevision: revision,
    })
    .strict(),
  z.object({ ...base, method: z.literal("cancelPlan"), planId: id }).strict(),
]);
const planResult = z.union([
  nativeConnectionPlanSchema,
  z.object({ kind: z.literal("unavailable"), reason: availability }).strict(),
]);
export const nativeLifecycleResponseSchema = z.union([
  z.object({ ...base, error: z.object({ code: errorCode }).strict() }).strict(),
  z.discriminatedUnion("method", [
    z
      .object({
        ...base,
        method: z.literal("detectClients"),
        result: z
          .array(nativeClientSnapshotSchema)
          .max(3)
          .refine((v) => new Set(v.map((s) => s.clientId)).size === v.length),
      })
      .strict(),
    z
      .object({ ...base, method: z.literal("planChange"), result: planResult })
      .strict(),
    z
      .object({
        ...base,
        method: z.literal("planRollback"),
        result: planResult,
      })
      .strict(),
    z
      .object({ ...base, method: z.literal("applyChange"), result: operation })
      .strict(),
    z
      .object({ ...base, method: z.literal("getOperation"), result: operation })
      .strict(),
    z
      .object({
        ...base,
        method: z.literal("verifyConnection"),
        result: verification,
      })
      .strict(),
    z
      .object({
        ...base,
        method: z.literal("cancelPlan"),
        // Durable plan-admission fence accepted; getOperation owns cleanup status.
        result: z.object({ canceled: z.literal(true) }).strict(),
      })
      .strict(),
  ]),
]);

function boundedJSON(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > 65536)
    throw new Error("message_too_large");
  rejectDuplicateKeys(text);
  return JSON.parse(text) as unknown;
}
export const parseNativeLifecycleRequest = (text: string) =>
  nativeLifecycleRequestSchema.parse(boundedJSON(text));
export const parseNativeLifecycleResponse = (text: string) =>
  nativeLifecycleResponseSchema.parse(boundedJSON(text));
export type NativeLifecycleRequest = z.infer<
  typeof nativeLifecycleRequestSchema
>;
export type NativeLifecycleResponse = z.infer<
  typeof nativeLifecycleResponseSchema
>;

function rejectDuplicateKeys(text: string): void {
  let cursor = 0;
  const whitespace = () => {
    while (" \t\r\n".includes(text[cursor] ?? "\0")) cursor++;
  };
  const take = (character: string) => {
    if (text[cursor] !== character) throw new Error("invalid_input");
    cursor++;
  };
  const string = () => {
    const start = cursor;
    take('"');
    while (cursor < text.length) {
      if (text[cursor] === '"') {
        cursor++;
        return text.slice(start, cursor);
      }
      if (text[cursor] === "\\") {
        if (cursor + 1 >= text.length) throw new Error("invalid_input");
        cursor += 2;
      } else cursor++;
    }
    throw new Error("invalid_input");
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error("invalid_input");
    whitespace();
    if (cursor >= text.length) throw new Error("invalid_input");
    if (text[cursor] === "{") {
      cursor++;
      whitespace();
      if (text[cursor] === "}") {
        cursor++;
        return;
      }
      const keys = new Set<string>();
      for (;;) {
        const key: unknown = JSON.parse(string());
        if (typeof key !== "string" || keys.has(key))
          throw new Error("invalid_input");
        keys.add(key);
        whitespace();
        take(":");
        value(depth + 1);
        whitespace();
        if (text[cursor] === "}") {
          cursor++;
          return;
        }
        take(",");
        whitespace();
      }
    }
    if (text[cursor] === "[") {
      cursor++;
      whitespace();
      if (text[cursor] === "]") {
        cursor++;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        if (text[cursor] === "]") {
          cursor++;
          return;
        }
        take(",");
        whitespace();
      }
    }
    if (text[cursor] === '"') {
      string();
      return;
    }
    const start = cursor;
    while (cursor < text.length && !" \t\r\n,]}".includes(text[cursor] ?? ""))
      cursor++;
    if (cursor === start) throw new Error("invalid_input");
  };
  value(0);
  whitespace();
  if (cursor !== text.length) throw new Error("invalid_input");
}
