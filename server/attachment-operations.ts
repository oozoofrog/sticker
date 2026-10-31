import { createHash } from "node:crypto";
import { openSync, closeSync, readSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { normalizeFileName } from "./file-storage.js";
import {
  attachmentOperationPayloadSchema,
  attachmentOperationReceiptSchema,
  MAX_ATTACHMENT_OPERATION_JSON_BYTES,
} from "./contracts/attachment-operations.js";
export function attachmentPayloadHash(payload: unknown) {
  return createHash("sha256")
    .update(canonicalJson(attachmentOperationPayloadSchema.parse(payload)))
    .digest("hex");
}
export function boundedAttachmentJson(value: unknown): unknown {
  const text = z.string().parse(value);
  if (Buffer.byteLength(text) > MAX_ATTACHMENT_OPERATION_JSON_BYTES)
    throw new Error("Attachment operation JSON exceeds limit");
  return JSON.parse(text) as unknown;
}
function fileHash(path: string) {
  const fd = openSync(path, "r"),
    buffer = Buffer.alloc(65536),
    hash = createHash("sha256");
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
/** Historical deleted receipts are retained; active bytes must still match the committed fingerprint. */
export function validateAttachmentOperations(root: string, db: DatabaseSync) {
  for (const row of db.prepare("SELECT * FROM attachment_operations").all()) {
    try {
      const fields = z
        .object({
          actorId: z.string().min(1).max(80),
          kind: z.literal("issue_file_create"),
          operationId: z.uuid(),
          projectId: z.string().min(1).max(128),
          issueId: z.string().min(1).max(128),
          attachmentId: z.uuid().nullable(),
          payload: z.string(),
          payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
          result: z.string(),
          createdAt: z.iso.datetime(),
        })
        .strict()
        .parse(row);
      const payload = attachmentOperationPayloadSchema.parse(
          boundedAttachmentJson(fields.payload),
        ),
        receipt = attachmentOperationReceiptSchema.parse(
          boundedAttachmentJson(fields.result),
        );
      if (
        fields.payload !== canonicalJson(payload) ||
        fields.payloadHash !== attachmentPayloadHash(payload) ||
        fields.issueId !== payload.issueId ||
        receipt.issueId !== fields.issueId ||
        receipt.authorId !== fields.actorId ||
        receipt.createdAt !== fields.createdAt ||
        receipt.name !== payload.file.fileName ||
        receipt.mimeType !== payload.file.mimeType ||
        receipt.size !== payload.file.size ||
        normalizeFileName(receipt.name) !== receipt.name
      )
        throw new Error("Inconsistent attachment operation receipt");
      const issue = db
        .prepare("SELECT projectId FROM issues WHERE id=?")
        .get(fields.issueId);
      if (issue && issue.projectId !== fields.projectId)
        throw new Error("Attachment operation project mismatch");
      const current = db
        .prepare("SELECT * FROM attachments WHERE id=?")
        .get(receipt.id);
      if (fields.attachmentId !== null && fields.attachmentId !== receipt.id)
        throw new Error("Attachment operation target mismatch");
      if (current) {
        if (
          fields.attachmentId === null ||
          !issue ||
          canonicalJson(attachmentOperationReceiptSchema.parse(current)) !==
            canonicalJson(receipt)
        )
          throw new Error("Attachment operation current metadata mismatch");
        const path = join(root, "uploads", receipt.storageKey),
          stat = lstatSync(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size !== receipt.size ||
          fileHash(path) !== payload.file.checksum
        )
          throw new Error("Attachment operation checksum mismatch");
      } else if (fields.attachmentId !== null)
        throw new Error("Attachment operation active file missing");
    } catch (error) {
      throw new Error("Invalid attachment operation/checksum in backup", {
        cause: error,
      });
    }
  }
}
