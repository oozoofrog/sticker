import {
  registerClientGrantRoutes,
  rejectGrantDuplicateKeys,
} from "./routes/client-grants.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import { registerFileTransferRoutes } from "./routes/file-transfers.js";
import {
  attachmentFileReceipt,
  wantsFileReceipt,
  storedFilePresent,
} from "./file-transfer-receipts.js";
import { attachmentMultipartSchema } from "./contracts/attachment-operations.js";
import { MaintenanceController } from "./maintenance.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import {
  LocalOwnerPolicy,
  localOwnerActor,
  localOwnerMode,
  type LocalOwnerMode,
} from "./local-owner.js";
import { registerResourceRoutes } from "./routes/resources.js";
import { FileStorage } from "./file-storage.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerGithubRoutes } from "./routes/github.js";
import type { GithubProvider } from "./features/github.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerMcpSettingsRoutes } from "./routes/mcp-settings.js";
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from "express";
import multer from "multer";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { AuthManager, type AgentConfig } from "./auth.js";
import { Store, DomainError } from "./domain.js";
import { registerReleaseRoutes } from "./routes/releases.js";
import { registerViewRoutes } from "./routes/views.js";
import { registerRelationRoutes } from "./routes/relations.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import type { Actor } from "./types.js";
export interface AppConfig {
  dataDir: string;
  githubProvider?: GithubProvider;
  ownerPassword: string;
  localOwnerMode?: LocalOwnerMode;
  agents?: AgentConfig[];
  appOrigin?: string;
  secureCookies?: boolean;
  clientDir?: string;
}
const actor = (req: Request) => (req as Request & { actor: Actor }).actor;
const identifier = (req: Request) => String(req.params.id);
function passwordInput(body: unknown): unknown {
  return body !== null && typeof body === "object" && "password" in body
    ? body.password
    : undefined;
}
export function createApp(config: AppConfig) {
  const maintenance = new MaintenanceController();
  const mode = localOwnerMode(config.localOwnerMode);
  const localPolicy = mode
    ? new LocalOwnerPolicy(config.appOrigin ?? "http://localhost:8787")
    : null;
  const auth = new AuthManager({
    ownerPassword: config.ownerPassword,
    ownerPasswordEnabled: !localPolicy,
    agents: config.agents,
  });
  const dataDir = resolve(config.dataDir),
    uploadDir = join(dataDir, "uploads");
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const appOrigin = new URL(config.appOrigin ?? "http://localhost:8787");
  if (!["http:", "https:"].includes(appOrigin.protocol))
    throw new Error("APP_ORIGIN must be an http(s) origin.");
  const store = new Store(
      dataDir,
      Date.now,
      appOrigin.origin,
      () => auth.directory(),
      config.githubProvider,
    ),
    files = new FileStorage(dataDir),
    app = express();
  try {
    auth.attachManagedRegistry(store.clientGrants);
  } catch (error) {
    store.close();
    throw error;
  }
  const origins = new Set([appOrigin.origin]);
  if (["localhost", "127.0.0.1"].includes(appOrigin.hostname)) {
    const alias = new URL(appOrigin);
    alias.hostname =
      appOrigin.hostname === "localhost" ? "127.0.0.1" : "localhost";
    origins.add(alias.origin);
  }
  const validOrigin = (origin: string | undefined) =>
    origin !== undefined && origins.has(origin);
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.secureCookies ?? appOrigin.protocol === "https:",
    path: "/api",
    maxAge: 12 * 60 * 60 * 1000,
  };
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/readyz", (_req, res) =>
    res
      .set("Cache-Control", "no-store")
      .status(maintenance.snapshot().state === "serving" ? 200 : 503)
      .json({
        status:
          maintenance.snapshot().state === "serving" ? "ready" : "maintenance",
      }),
  );
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (req, _res, next) => {
    localPolicy?.validate(
      req.method,
      req.rawHeaders,
      req.headers.authorization !== undefined,
    );
    next();
  });
  app.use(
    "/api",
    express.json({ limit: "512kb", verify: rejectGrantDuplicateKeys }),
  );
  app.post("/api/session", (req, res) => {
    // Explicit MCP modes consume existing authority; browser login is unmarked.
    if (req.headers["x-sticker-auth-mode"] !== undefined)
      throw new DomainError(
        401,
        "UNAUTHENTICATED",
        "이 인증 방식에서는 기존 자격증명이 필요합니다.",
      );
    // Login is registered before general auth admission. A provisional Bearer
    // must not enter this handler, even when an independent password is supplied.
    // Explicit MCP-mode rejection above and ordinary/static login stay unchanged.
    if (
      auth.resolve(req.headers.authorization)?.access?.state === "provisional"
    )
      throw new DomainError(
        403,
        "ACTIVATION_REQUIRED",
        "연결 활성화가 필요합니다.",
      );
    if (!req.is("application/json"))
      throw new DomainError(415, "CONTENT_TYPE", "JSON 요청이 필요합니다.");
    if (req.headers.origin && !validOrigin(req.headers.origin))
      throw new DomainError(403, "ORIGIN", "허용되지 않은 요청 출처입니다.");
    if (localPolicy) {
      if (req.headers.authorization !== undefined)
        throw new DomainError(
          401,
          "UNAUTHENTICATED",
          "소유자 접속 요청에 에이전트 인증을 사용할 수 없습니다.",
        );
      res.json({ actor: { ...localOwnerActor } });
      return;
    }
    const token = auth.login(passwordInput(req.body), req.ip ?? "unknown");
    if (!token)
      throw new DomainError(
        401,
        "LOGIN_FAILED",
        "비밀번호를 확인하세요. 반복 실패 시 15분 후 다시 시도하세요.",
      );
    res.cookie("sticker_session", token, cookieOptions).json({
      actor: auth.authenticate(undefined, `sticker_session=${token}`),
    });
  });
  app.use("/api", (req, res, next) => {
    // This header constrains authentication; it never grants a role. Unmarked
    // browser/legacy requests preserve the existing deployment policy.
    const expected = req.headers["x-sticker-auth-mode"];
    const modeHeaders = req.rawHeaders.filter(
      (_, index) =>
        index % 2 === 0 &&
        req.rawHeaders[index].toLowerCase() === "x-sticker-auth-mode",
    );
    const mismatch =
      modeHeaders.length > 1 ||
      (expected !== undefined &&
        !["agent", "trusted-local-owner", "owner-session"].includes(
          String(expected),
        )) ||
      (expected === "trusted-local-owner" &&
        (!localPolicy || req.headers.authorization !== undefined)) ||
      (expected === "owner-session" &&
        (Boolean(localPolicy) || req.headers.authorization !== undefined)) ||
      (expected === "agent" && req.headers.authorization === undefined);
    const principal = mismatch
      ? null
      : expected === "owner-session"
        ? auth.resolve(undefined, req.headers.cookie)
        : localPolicy && req.headers.authorization === undefined
          ? { actor: { ...localOwnerActor } }
          : auth.resolve(req.headers.authorization, req.headers.cookie);
    if (!principal)
      return res
        .status(401)
        .json({ error: "로그인이 필요합니다.", code: "UNAUTHENTICATED" });
    (req as Request & { actor: Actor }).actor = principal.actor;
    (req as Request & { principal: AuthenticatedPrincipal }).principal =
      principal;
    if (
      principal.access?.state === "provisional" &&
      !(
        req.method === "GET" &&
        ["/api/session", "/api/client-grants/self/verify"].includes(
          req.originalUrl,
        )
      )
    )
      throw new DomainError(
        403,
        "ACTIVATION_REQUIRED",
        "연결 활성화가 필요합니다.",
      );
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.headers.authorization &&
      !validOrigin(req.headers.origin)
    )
      throw new DomainError(403, "ORIGIN", "허용되지 않은 요청 출처입니다.");
    next();
  });
  app.use("/api", maintenance.admit);
  registerMaintenanceRoutes(app, maintenance);
  app.get("/api/access-mode", (_req, res) =>
    res.json({ mode: mode ?? "password" }),
  );
  app.get("/api/session", (req, res) => {
    const access = (req as Request & { principal: AuthenticatedPrincipal })
      .principal.access;
    res.json({ actor: actor(req), ...(access ? { access } : {}) });
  });
  registerClientGrantRoutes(app, store.clientGrants);
  app.delete("/api/session", (req, res) => {
    if (localPolicy)
      throw new DomainError(
        409,
        "LOCAL_OWNER_MODE",
        "로컬 소유자 모드에서는 배포 설정을 변경하여 접근을 종료해야 합니다.",
      );
    auth.logout(req.headers.cookie);
    res
      .clearCookie("sticker_session", { ...cookieOptions, maxAge: undefined })
      .status(204)
      .end();
  });
  registerHistoryRoutes(app, store.history);
  registerGithubRoutes(app, store.github, maintenance);
  registerMcpSettingsRoutes(app, () => auth.directory());
  registerTemplateRoutes(app, store.templates);
  registerResourceRoutes(app, store.resources, files, maintenance);
  registerSessionRoutes(app, store.sessions);
  registerRelationRoutes(app, store.relations);
  registerViewRoutes(app, store.views);
  registerReleaseRoutes(app, store.releases);
  app.get("/api/bootstrap", (req, res) =>
    res.json(store.bootstrap(actor(req))),
  );
  app.post("/api/projects", (req, res) =>
    res.status(201).json(store.createProject(actor(req), req.body)),
  );
  app.patch("/api/projects/:id", (req, res) =>
    res.json(store.updateProject(actor(req), identifier(req), req.body)),
  );
  app.delete("/api/projects/:id", (req, res) => {
    store.deleteProject(actor(req), identifier(req));
    res.status(204).end();
  });
  app.post("/api/versions", (req, res) =>
    res.status(201).json(store.createVersion(actor(req), req.body)),
  );
  app.patch("/api/versions/:id", (req, res) =>
    res.json(store.updateVersion(actor(req), identifier(req), req.body)),
  );
  app.delete("/api/versions/:id", (req, res) => {
    store.deleteVersion(actor(req), identifier(req));
    res.status(204).end();
  });
  app.post("/api/issues", (req, res) =>
    res.status(201).json(store.createIssue(actor(req), req.body)),
  );
  app.get("/api/issues/:id", (req, res) =>
    res.json(store.getIssue(actor(req), identifier(req))),
  );
  app.patch("/api/issues/:id", (req, res) =>
    res.json(store.updateIssue(actor(req), identifier(req), req.body)),
  );
  app.delete("/api/issues/:id", (req, res) => {
    const attachments = store.getIssue(actor(req), identifier(req)).attachments;
    store.deleteIssue(actor(req), identifier(req));
    for (const attachment of attachments)
      if (attachment.storageKey) removeFile(attachment.storageKey);
    res.status(204).end();
  });
  app.post("/api/issues/:id/comments", (req, res) =>
    res
      .status(201)
      .json(store.addComment(actor(req), identifier(req), req.body)),
  );
  app.delete("/api/comments/:id", (req, res) => {
    store.deleteComment(actor(req), identifier(req));
    res.status(204).end();
  });
  app.post("/api/issues/:id/links", (req, res) =>
    res.status(201).json(
      store.addAttachment(actor(req), identifier(req), {
        ...req.body,
        kind: "link",
      }),
    ),
  );
  // Multer 2.5 forwards charset options to Busboy; decode ordinary browser filenames
  // as UTF-8 while letting filename* declarations choose their own charset.
  registerFileTransferRoutes(app, store, files, maintenance);
  const uploadOptions: multer.Options & { defParamCharset: string } = {
    storage: multer.memoryStorage(),
    defParamCharset: "utf8",
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1,
      fields: 1,
      fieldSize: 36,
      fieldNameSize: 32,
      parts: 3,
    },
  };
  const upload = multer(uploadOptions).single("file");
  app.post(
    "/api/issues/:id/attachments",
    (req, _res, next) => {
      store.authorizeAttachmentWrite(actor(req), identifier(req));
      wantsFileReceipt(req);
      next();
    },
    maintenance.trackMiddleware((req, res, next) =>
      upload(req, res, (error) => {
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
      }),
    ),
    (req, res) => {
      if (!req.file)
        throw new DomainError(400, "FILE_REQUIRED", "파일 하나를 선택하세요.");
      const parsed = attachmentMultipartSchema.safeParse(req.body);
      if (!parsed.success)
        throw new DomainError(
          400,
          "INVALID_INPUT",
          "첨부 작업 식별자를 확인하세요.",
        );
      const projectId = store.authorizeAttachmentWrite(
        actor(req),
        identifier(req),
      ).projectId;
      const committed = files.withUpload(
        req.file.buffer,
        req.file.originalname,
        (file) => {
          const value = store.addFileAttachment(
            actor(req),
            identifier(req),
            file,
            parsed.data.operationId,
          );
          return {
            storageKey: value.storageKey ?? file.storageKey,
            value: { attachment: value, checksum: file.checksum },
          };
        },
      );
      const attachment = committed.attachment;
      if (wantsFileReceipt(req)) {
        let currentPresent = false;
        try {
          const current = store.getAttachment(actor(req), attachment.id);
          currentPresent = storedFilePresent(files, current.storageKey);
        } catch (error) {
          if (!(error instanceof DomainError) || error.status !== 404)
            throw error;
        }
        res
          .status(201)
          .json(
            attachmentFileReceipt(
              attachment,
              projectId,
              parsed.data.operationId ?? null,
              committed.checksum,
              currentPresent,
            ),
          );
      } else res.status(201).json(attachment);
    },
  );
  function safePath(storageKey: string) {
    if (!/^[0-9a-f-]{36}$/.test(storageKey))
      throw new DomainError(404, "NOT_FOUND", "파일을 찾을 수 없습니다.");
    return join(uploadDir, storageKey);
  }
  function removeFile(storageKey: string) {
    try {
      unlinkSync(safePath(storageKey));
    } catch (e) {
      if (!(
        e !== null &&
        typeof e === "object" &&
        "code" in e &&
        e.code === "ENOENT"
      ))
        console.error(
          "An orphaned attachment may remain on disk; check storage permissions.",
        );
    }
  }
  const attachmentDownload: RequestHandler = (req, res, next) => {
    const attachment = store.getAttachment(actor(req), identifier(req));
    if (attachment.kind !== "file" || !attachment.storageKey)
      throw new DomainError(404, "NOT_FOUND", "파일을 찾을 수 없습니다.");
    const path = safePath(attachment.storageKey);
    if (!existsSync(path))
      throw new DomainError(
        404,
        "FILE_MISSING",
        "저장 파일이 없습니다. 백업을 확인하세요.",
      );
    const preview =
      req.query.preview === "1" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        attachment.mimeType ?? "",
      );
    const fallback =
      attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
    res.set({
      "Content-Type": preview
        ? (attachment.mimeType ?? "application/octet-stream")
        : "application/octet-stream",
      "Content-Disposition": `${preview ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.sendFile(path, (e) => {
      if (e) next(e);
    });
  };
  app.head("/api/attachments/:id/file", attachmentDownload);
  app.get("/api/attachments/:id/file", attachmentDownload);
  app.delete("/api/attachments/:id", (req, res) => {
    const attachment = store.deleteAttachment(actor(req), identifier(req));
    if (attachment.storageKey) removeFile(attachment.storageKey);
    res.status(204).end();
  });
  app.post("/api/reports", (req, res) =>
    res.status(201).json(store.reportAgent(actor(req), req.body)),
  );
  app.use("/api", (_req, res) =>
    res
      .status(404)
      .json({ error: "API 경로를 찾을 수 없습니다.", code: "NOT_FOUND" }),
  );
  const clientDir = resolve(config.clientDir ?? "dist/client");
  if (existsSync(join(clientDir, "index.html"))) {
    app.use(
      express.static(clientDir, {
        index: false,
        dotfiles: "deny",
        maxAge: "1h",
      }),
    );
    app.get("/{*path}", (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(join(clientDir, "index.html"));
    });
  }
  const handleError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof DomainError) {
      res.status(err.status).json({
        error: err.message,
        code: err.code,
        ...(err.fields ? { fields: err.fields } : {}),
      });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: "파일은 20 MiB 이하 한 개만 업로드할 수 있습니다.",
        code: err.code,
      });
      return;
    }
    const errorType =
      err !== null && typeof err === "object" && "type" in err
        ? err.type
        : undefined;
    if (
      errorType === "charset.unsupported" ||
      errorType === "encoding.unsupported"
    ) {
      res.status(415).json({
        error: "지원하지 않는 요청 문자셋 또는 인코딩입니다.",
        code: "UNSUPPORTED_ENCODING",
      });
      return;
    }
    if (errorType === "entity.too.large") {
      res.status(413).json({ error: "요청이 너무 큽니다.", code: "TOO_LARGE" });
      return;
    }
    if (err instanceof SyntaxError || err instanceof URIError) {
      res
        .status(400)
        .json({ error: "잘못된 요청 형식입니다.", code: "BAD_REQUEST" });
      return;
    }
    console.error(
      "Request failed:",
      err instanceof Error ? err.name : "UnknownError",
    );
    res.status(500).json({
      error: "서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.",
      code: "INTERNAL_ERROR",
    });
  };
  app.use(handleError);
  return {
    app,
    store,
    maintenance,
    close: () => {
      store.close();
    },
  };
}
