import { finished } from "node:stream/promises";
import { storedFilePresent } from "../file-transfer-receipts.js";
import type { Express } from "express";
import { createReadStream, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Store, DomainError } from "../domain.js";
import type { FileStorage } from "../file-storage.js";
import type { MaintenanceController } from "../maintenance.js";
import { requestActor as actor, requestId as id } from "../http-context.js";
import {
  attachmentFileMetadataSchema,
  MAX_TRANSFER_BYTES,
} from "../contracts/file-transfers.js";
export function registerFileTransferRoutes(
  app: Express,
  store: Store,
  files: FileStorage,
  maintenance: MaintenanceController,
) {
  app.head("/api/issues/:id/attachments", (req, res) => {
    const issue = store.authorizeAttachmentWrite(actor(req), id(req));
    res
      .set("X-Sticker-Project-Id", encodeURIComponent(issue.projectId))
      .status(204)
      .end();
  });
  app.head("/api/projects/:id/resources/files", (req, res) => {
    store.resources.authorizeProjectWrite(actor(req), id(req));
    res
      .set("X-Sticker-Project-Id", encodeURIComponent(id(req)))
      .status(204)
      .end();
  });
  app.head("/api/resources/:id/files", (req, res) => {
    const resource = store.resources.authorizeFileUpdate(actor(req), id(req));
    res
      .set("X-Sticker-Project-Id", encodeURIComponent(resource.projectId))
      .status(204)
      .end();
  });
  app.get(
    "/api/projects/:id/attachment-operations/:operationId",
    (req, res) => {
      const operation = store.getAttachmentOperation(
          actor(req),
          id(req),
          req.params.operationId,
        ),
        status = operation.status;
      res.json(
        status.recorded
          ? {
              ...status,
              receipt: {
                ...status.receipt,
                currentPresent:
                  status.receipt.currentPresent &&
                  storedFilePresent(files, operation.storageKey),
              },
            }
          : status,
      );
    },
  );
  app.get("/api/attachments/:id/metadata", async (req, res, next) => {
    try {
      const scope = store.attachmentFileScope(actor(req), id(req)),
        attachment = scope.attachment;
      if (attachment.kind !== "file" || !attachment.storageKey)
        throw new DomainError(404, "NOT_FOUND", "파일을 찾을 수 없습니다.");
      const path = files.filePath(attachment.storageKey),
        stat = lstatSync(path);
      if (stat.size !== attachment.size || attachment.size > MAX_TRANSFER_BYTES)
        throw new DomainError(
          409,
          "FILE_CHANGED",
          "저장 파일 정보가 다릅니다.",
        );
      await maintenance.runOperation(async () => {
        const stream = createReadStream(path, { highWaterMark: 65536 }),
          hash = createHash("sha256");
        let size = 0;
        const cancel = () => {
          stream.destroy(new Error("Metadata reader disconnected"));
        };
        res.once("close", cancel);
        try {
          for await (const raw of stream) {
            const chunk = z.instanceof(Buffer).parse(raw);
            size += chunk.length;
            if (size > attachment.size)
              throw new DomainError(
                409,
                "FILE_CHANGED",
                "저장 파일 크기가 다릅니다.",
              );
            hash.update(chunk);
          }
          if (size !== attachment.size)
            throw new DomainError(
              409,
              "FILE_CHANGED",
              "저장 파일 크기가 다릅니다.",
            );
          const checksum = hash.digest("hex");
          if (
            scope.expectedChecksum !== null &&
            scope.expectedChecksum !== checksum
          )
            throw new DomainError(
              409,
              "FILE_CHANGED",
              "저장 파일 내용이 다릅니다.",
            );
          // Recheck current access/identity after asynchronous hashing, before disclosing metadata.
          const current = store.attachmentFileScope(actor(req), id(req));
          if (current.attachment.storageKey !== attachment.storageKey)
            throw new DomainError(
              409,
              "FILE_CHANGED",
              "저장 파일이 변경되었습니다.",
            );
          if (!res.destroyed)
            res.json(
              attachmentFileMetadataSchema.parse({
                kind: "attachment",
                attachmentId: attachment.id,
                issueId: attachment.issueId,
                projectId: scope.projectId,
                name: attachment.name,
                mimeType: attachment.mimeType,
                size,
                checksum,
              }),
            );
        } finally {
          res.off("close", cancel);
          stream.destroy();
          await finished(stream, { cleanup: true }).catch(() => undefined);
        }
      });
    } catch (error) {
      next(error);
    }
  });
}
