import {
  resourceFileReceipt,
  wantsFileReceipt,
  storedFilePresent,
} from "../file-transfer-receipts.js";
import type { MaintenanceController } from "../maintenance.js";
import type { Express, Request, RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { DomainError } from "../domain-error.js";
import { FileStorage, type StoredFile } from "../file-storage.js";
import type { ResourceService } from "../features/resources.js";
import {
  resourceUploadInputSchema,
  resourcePatchInputSchema,
} from "../contracts/resources.js";
import { requestActor as actor, requestId as id } from "../http-context.js";
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(400, "INVALID_INPUT", "자료 입력을 확인하세요.");
  return parsed.data;
}
function metadata(req: Request): unknown {
  const field = input(
    z.object({ metadata: z.string().max(10000) }).strict(),
    req.body,
  );
  try {
    const data: unknown = JSON.parse(field.metadata);
    return data;
  } catch {
    throw new DomainError(
      400,
      "INVALID_INPUT",
      "업로드 메타데이터를 확인하세요.",
    );
  }
}
function downloadHeaders(file: StoredFile, preview: boolean) {
  const inline =
      preview &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        file.mimeType,
      ),
    fallback = file.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
  return {
    "Content-Type": inline ? file.mimeType : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, (char) => "%" + char.charCodeAt(0).toString(16))}`,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
  };
}
/** Mount only inside the application's authenticated API/origin boundary. */
export function registerResourceRoutes(
  app: Express,
  resources: ResourceService,
  files: FileStorage,
  maintenance?: MaintenanceController,
) {
  app.get("/api/resources", (req, res) =>
    res.json(resources.list(actor(req), req.query)),
  );
  app.post("/api/resources/query", (req, res) =>
    res.json(resources.list(actor(req), req.body)),
  );
  app.post("/api/resources", (req, res) =>
    res.status(201).json(resources.create(actor(req), req.body)),
  );
  app.get("/api/resources/:id", (req, res) =>
    res.json(resources.get(actor(req), id(req))),
  );
  app.patch("/api/resources/:id", (req, res) =>
    res.json(resources.update(actor(req), id(req), req.body)),
  );
  app.delete("/api/resources/:id", (req, res) =>
    res.json(resources.remove(actor(req), id(req), req.body)),
  );
  app.patch("/api/resources/:id/guidance", (req, res) =>
    res.json(resources.guidance(actor(req), id(req), req.body)),
  );
  app.get("/api/projects/:id/guidance", (req, res) =>
    res.json(resources.projectGuidance(actor(req), id(req))),
  );
  app.get("/api/resources/:id/versions/:version", (req, res) =>
    res.json(
      resources.version(
        actor(req),
        id(req),
        input(z.coerce.number().int().positive(), req.params.version),
      ),
    ),
  );
  const resourceDownload: RequestHandler = (req, res, next) => {
    const file = resources.fileRecord(
        actor(req),
        id(req),
        input(z.coerce.number().int().positive(), req.params.version),
      ),
      path = files.filePath(file.storageKey);
    res.set(downloadHeaders(file, req.query.preview === "1"));
    res.sendFile(path, (error) => {
      if (error) next(error);
    });
  };
  app.head("/api/resources/:id/versions/:version/file", resourceDownload);
  app.get("/api/resources/:id/versions/:version/file", resourceDownload);
  const options: multer.Options & { defParamCharset: string } = {
      storage: multer.memoryStorage(),
      defParamCharset: "utf8",
      limits: {
        fileSize: 20 * 1024 * 1024,
        files: 1,
        fields: 1,
        fieldSize: 10000,
        parts: 3,
      },
    },
    upload = multer(options).single("file");
  const receive: RequestHandler = (req, res, next) => {
    upload(req, res, (error: unknown) => {
      if (error && !(error instanceof multer.MulterError)) {
        next(
          new DomainError(
            400,
            "INVALID_MULTIPART",
            "올바른 파일 업로드 요청이 아닙니다.",
          ),
        );
        return;
      }
      next(error);
    });
  };
  app.post(
    "/api/projects/:id/resources/files",
    (req, _res, next) => {
      resources.authorizeProjectWrite(actor(req), id(req));
      wantsFileReceipt(req);
      next();
    },
    maintenance ? maintenance.trackMiddleware(receive) : receive,
    (req, res) => {
      if (!req.file)
        throw new DomainError(400, "FILE_REQUIRED", "파일 하나를 선택하세요.");
      const data = input(
        resourceUploadInputSchema.omit({ projectId: true }),
        metadata(req),
      );
      const value = files.withUpload(
        req.file.buffer,
        req.file.originalname,
        (file) => {
          const saved = resources.createFile(
            actor(req),
            { ...data, projectId: id(req) },
            file,
          );
          return {
            storageKey: resources.fileRecord(
              actor(req),
              saved.resource.id,
              saved.resource.currentVersion,
            ).storageKey,
            value: saved,
          };
        },
      );
      res
        .status(201)
        .json(
          req.query.receipt === "1"
            ? resourceFileReceipt(
                value,
                data.operationId,
                storedFilePresent(
                  files,
                  resources.fileRecord(
                    actor(req),
                    value.resource.id,
                    value.resource.currentVersion,
                  ).storageKey,
                ),
              )
            : value,
        );
    },
  );
  app.post(
    "/api/resources/:id/files",
    (req, _res, next) => {
      resources.authorizeFileUpdate(actor(req), id(req));
      wantsFileReceipt(req);
      next();
    },
    maintenance ? maintenance.trackMiddleware(receive) : receive,
    (req, res) => {
      if (!req.file)
        throw new DomainError(400, "FILE_REQUIRED", "파일 하나를 선택하세요.");
      const data = input(resourcePatchInputSchema, metadata(req)),
        value = files.withUpload(
          req.file.buffer,
          req.file.originalname,
          (file) => {
            const saved = resources.updateFile(actor(req), id(req), data, file);
            return {
              storageKey: resources.fileRecord(
                actor(req),
                saved.resource.id,
                saved.resource.currentVersion,
              ).storageKey,
              value: saved,
            };
          },
        );
      res.json(
        wantsFileReceipt(req)
          ? resourceFileReceipt(
              value,
              data.operationId,
              storedFilePresent(
                files,
                resources.fileRecord(
                  actor(req),
                  value.resource.id,
                  value.resource.currentVersion,
                ).storageKey,
              ),
            )
          : value,
      );
    },
  );
  app.get("/api/issues/:id/resources", (req, res) =>
    res.json(resources.issueLinks(actor(req), id(req))),
  );
  app.post("/api/issues/:id/resources", (req, res) =>
    res.status(201).json(resources.link(actor(req), id(req), req.body)),
  );
  app.delete("/api/issues/:id/resources/:linkId", (req, res) =>
    res.json(
      resources.unlink(actor(req), id(req), req.params.linkId, req.body),
    ),
  );
  app.get("/api/sessions/:id/resources", (req, res) =>
    res.json(resources.sessionReferences(actor(req), id(req))),
  );
  app.post("/api/resource-references", (req, res) =>
    res.status(201).json(resources.recordReference(actor(req), req.body)),
  );
}
