import { z } from "zod";
import {
  attachmentFileFingerprintSchema,
  attachmentOperationPayloadSchema,
} from "./attachment-operations.js";
export const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;
export const MAX_TRANSFER_CHUNK_BYTES = 65536;
const id = z.string().min(1).max(128),
  uuid = z.uuid();
export const fileIdentitySchema = attachmentFileFingerprintSchema
  .omit({ fileName: true })
  .extend({ name: z.string().min(1).max(255) })
  .strict();
export const attachmentFileMetadataSchema = fileIdentitySchema
  .extend({
    kind: z.literal("attachment"),
    attachmentId: uuid,
    issueId: id,
    projectId: id,
  })
  .strict();
const committed = fileIdentitySchema.extend({
  projectId: id,
  historicalCommitted: z.literal(true),
  currentPresent: z.boolean(),
});
export const attachmentFileReceiptSchema = committed
  .extend({
    kind: z.literal("attachment"),
    operationId: uuid.nullable(),
    attachmentId: uuid,
    issueId: id,
  })
  .strict();
export const resourceFileReceiptSchema = committed
  .extend({
    kind: z.literal("resource"),
    operationId: uuid,
    resourceId: uuid,
    resourceVersion: z.number().int().positive(),
    revision: z.number().int().positive(),
  })
  .strict();
export const fileCommitReceiptSchema = z.discriminatedUnion("kind", [
  attachmentFileReceiptSchema,
  resourceFileReceiptSchema,
]);
export const attachmentOperationStatusSchema = z.discriminatedUnion(
  "recorded",
  [
    z.object({ recorded: z.literal(false) }).strict(),
    z
      .object({
        recorded: z.literal(true),
        operationId: uuid,
        payload: attachmentOperationPayloadSchema,
        receipt: attachmentFileReceiptSchema,
      })
      .strict(),
  ],
);

const checksum = z.string().regex(/^[a-f0-9]{64}$/),
  revision = z.number().int().positive();
export const uploadTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue_attachment"), issueId: id }).strict(),
  z
    .object({
      kind: z.literal("resource_file"),
      projectId: id,
      title: z.string().trim().min(1).max(255),
      versionId: id.nullable().optional().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resource_file_replacement"),
      resourceId: uuid,
      revision,
      title: z.string().trim().min(1).max(255).optional(),
      versionId: id.nullable().optional(),
    })
    .strict(),
]);
export const fileReadTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attachment"), attachmentId: uuid }).strict(),
  z
    .object({
      kind: z.literal("resource"),
      resourceId: uuid,
      resourceVersion: revision,
    })
    .strict(),
]);
export const beginUploadSchema = z
  .object({
    target: uploadTargetSchema,
    operationId: uuid,
    name: z.string().min(1).max(1000),
    size: z.number().int().min(0).max(MAX_TRANSFER_BYTES),
    checksum,
  })
  .strict();
export const uploadChunkSchema = z
  .object({
    handle: uuid,
    offset: z.number().int().min(0),
    base64: z.string().max(Math.ceil(MAX_TRANSFER_CHUNK_BYTES / 3) * 4),
    checksum,
  })
  .strict();
export const finishUploadSchema = z
  .object({ handle: uuid, operationId: uuid, checksum })
  .strict();
export const beginFileReadSchema = z
  .object({ target: fileReadTargetSchema })
  .strict();
export const fileReadChunkSchema = z
  .object({
    handle: uuid,
    offset: z.number().int().min(0),
    length: z
      .number()
      .int()
      .min(1)
      .max(MAX_TRANSFER_CHUNK_BYTES)
      .default(MAX_TRANSFER_CHUNK_BYTES),
  })
  .strict();
export const cancelTransferSchema = z.object({ handle: uuid }).strict();

export const attachmentOperationLookupSchema = z
  .object({
    projectId: id,
    issueId: id,
    operationId: uuid,
    name: z.string().min(1).max(1000),
    size: z.number().int().min(0).max(MAX_TRANSFER_BYTES),
    checksum,
  })
  .strict();
