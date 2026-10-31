import type { FileStorage } from "./file-storage.js";
import type { Request } from "express";
import type { Attachment } from "./types.js";
import type { ResourceDetail } from "./contracts/resources.js";
import {
  attachmentFileReceiptSchema,
  resourceFileReceiptSchema,
} from "./contracts/file-transfers.js";
import { DomainError } from "./domain-error.js";
export function attachmentFileReceipt(
  attachment: Attachment,
  projectId: string,
  operationId: string | null,
  checksum: string,
  currentPresent: boolean,
) {
  return attachmentFileReceiptSchema.parse({
    kind: "attachment",
    operationId,
    projectId,
    issueId: attachment.issueId,
    attachmentId: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    checksum,
    historicalCommitted: true,
    currentPresent,
  });
}
export function resourceFileReceipt(
  detail: ResourceDetail,
  operationId: string,
  currentPresent: boolean,
) {
  const version = detail.current;
  if (!version || version.kind !== "file")
    throw new DomainError(
      500,
      "FILE_RECEIPT_INVALID",
      "파일 작업 결과를 확인하지 못했습니다.",
    );
  return resourceFileReceiptSchema.parse({
    kind: "resource",
    operationId,
    projectId: detail.resource.projectId,
    resourceId: detail.resource.id,
    resourceVersion: version.version,
    revision: detail.resource.revision,
    name: version.fileName,
    mimeType: version.mimeType,
    size: version.size,
    checksum: version.checksum,
    historicalCommitted: true,
    currentPresent,
  });
}

export function wantsFileReceipt(req: Request) {
  if (req.query.receipt !== undefined && req.query.receipt !== "1")
    throw new DomainError(400, "INVALID_INPUT", "파일 결과 형식을 확인하세요.");
  return req.query.receipt === "1";
}
export function storedFilePresent(files: FileStorage, key: string | null) {
  if (!key) return false;
  try {
    files.filePath(key);
    return true;
  } catch {
    return false;
  }
}
