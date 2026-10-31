import { z } from "zod";
const id = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const binding = {
  installationId: id,
  connectionId: id,
  clientId: z.literal("codex-local"),
  approvalDigest: digest,
};
export const grantProvisionSchema = z
  .object({
    ...binding,
    operationId: id,
    projectId: z.string().min(1).max(100),
    requestedCanWrite: z.boolean(),
    tokenHash: digest,
    planExpiresAt: z.iso.datetime({ precision: 3 }),
    confirm: z.literal(true),
  })
  .strict();
export const grantPhaseSchema = z
  .object({
    ...binding,
    operationId: id,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    confirm: z.literal(true),
  })
  .strict();
export const grantRowSchema = z
  .object({
    grantId: id,
    agentId: z.string().regex(/^client-[a-f0-9-]{36}$/),
    ...binding,
    tokenHash: digest,
    projectId: z.string().min(1).max(100),
    requestedCanWrite: z.union([z.literal(0), z.literal(1)]),
    ownerId: z.literal("owner"),
    planExpiresAt: z.iso.datetime({ precision: 3 }),
    provisionOperationId: id,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    provisionalUntil: z.iso.datetime({ precision: 3 }),
    state: z.enum(["provisional", "active", "revoked"]),
    createdAt: z.iso.datetime({ precision: 3 }),
    updatedAt: z.iso.datetime({ precision: 3 }),
    reason: z.enum([
      "provision",
      "activate",
      "revoke",
      "project_deleted",
      "restore",
    ]),
  })
  .strict();
export type GrantRow = z.infer<typeof grantRowSchema>;
export const grantReceiptSchema = z
  .object({
    grantId: id,
    phase: z.enum(["provision", "activate", "revoke"]),
    revision: z.number().int().positive(),
    state: z.enum(["provisional", "active", "revoked"]),
    recordedAt: z.iso.datetime({ precision: 3 }),
  })
  .strict();
export const grantOperationRowSchema = z
  .object({
    ownerId: z.literal("owner"),
    operationId: id,
    phase: z.enum(["provision", "activate", "revoke"]),
    grantId: id,
    fingerprint: digest,
    receipt: z.string().max(1024),
    createdAt: z.iso.datetime({ precision: 3 }),
  })
  .strict();

export const managedAccessSchema = z
  .object({
    state: z.enum(["provisional", "active"]),
    grantId: z.uuid(),
    requestedCanWrite: z.boolean(),
    provisionalUntil: z.iso.datetime({ precision: 3 }),
    projectIds: z.tuple([z.string().min(1).max(100)]),
  })
  .strict();
