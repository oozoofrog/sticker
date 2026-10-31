import { z } from "zod";
import { attachmentSchema } from "../response-schemas.js";
const id = z.string().min(1).max(128);
export const MAX_ATTACHMENT_OPERATION_JSON_BYTES = 8192;
export const attachmentFileFingerprintSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(150),
    size: z
      .number()
      .int()
      .min(0)
      .max(20 * 1024 * 1024),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const attachmentOperationPayloadSchema = z
  .object({
    contractVersion: z.literal(1),
    kind: z.literal("issue_file_create"),
    issueId: id,
    file: attachmentFileFingerprintSchema,
  })
  .strict();
export const attachmentOperationReceiptSchema = attachmentSchema
  .extend({
    id: z.uuid(),
    issueId: id,
    kind: z.literal("file"),
    name: z.string().min(1).max(255),
    url: z.null(),
    storageKey: z.uuid(),
    mimeType: z.string().min(1).max(150),
    size: z
      .number()
      .int()
      .min(0)
      .max(20 * 1024 * 1024),
    authorId: z.string().min(1).max(80),
    authorName: z.string().min(1).max(80),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const attachmentMultipartSchema = z
  .object({ operationId: z.uuid().optional() })
  .strict();
