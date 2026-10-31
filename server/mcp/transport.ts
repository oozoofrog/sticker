import { AsyncLocalStorage } from "node:async_hooks";
import type { McpCatalogueEntry } from "./catalogue.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
} from "node:fs";
import { z } from "zod";
import {
  healthStatusSchema,
  readinessStatusSchema,
  readyStatusSchema,
} from "../contracts/system-status.js";
import { actorSchema, apiErrorSchema } from "../response-schemas.js";

export type McpAuthentication =
  | { mode: "agent"; token: string }
  | { mode: "trusted-local-owner" }
  | { mode: "owner-session"; sessionProvider: () => string | Promise<string> };
export interface StickerMcpOptions {
  apiUrl: string;
  auth: McpAuthentication;
}
type CredentialHeaders = {
  authorization?: string;
  cookie?: string;
  origin?: string;
  "x-sticker-auth-mode": McpAuthentication["mode"];
};
type FailureDetails = {
  outcome?: "uncertain";
  retryable?: boolean;
  readback?: string;
  retry?:
    "safe_read" | "same_key_same_payload" | "readback" | "before_dispatch";
  retryKeyFields?: string[];
  retryInstruction?: string;
  phase?: "before_dispatch" | "after_dispatch";
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
    public maintenance?: z.infer<typeof apiErrorSchema>["maintenance"],
    public retryAfterSeconds?: number,
    public details?: FailureDetails,
  ) {
    super(message);
  }
}
function originFor(options: StickerMcpOptions): string {
  const { apiUrl, auth } = options;
  if (!["agent", "trusted-local-owner", "owner-session"].includes(auth.mode))
    throw new Error("Unsupported Sticker MCP authentication mode.");
  if (
    auth.mode === "agent" &&
    (typeof auth.token !== "string" ||
      auth.token.trim().length < 16 ||
      auth.token.length > 4089 ||
      /[\r\n]/.test(auth.token))
  )
    throw new Error(
      "STICKER_AGENT_TOKEN must contain a configured agent token (at least 16 characters).",
    );
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error("STICKER_API_URL must be a valid origin.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error(
      "STICKER_API_URL must be an origin, without credentials, query, fragment or path.",
    );
  if (
    auth.mode === "trusted-local-owner" &&
    (url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname))
  )
    throw new Error(
      "Trusted local owner requires a canonical HTTP loopback origin.",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Use HTTPS for non-loopback STICKER_API_URL destinations.");
  return url.origin;
}
const sessionValue = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// Read only an explicitly selected, existing credential. Never discover browser profiles.
export function readOwnerSessionFile(path: string): string {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > 1024 ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      before.isSymbolicLink()
    )
      throw new Error();
    const bytes = Buffer.alloc(1025);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd),
      named = lstatSync(path);
    if (
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      named.dev !== stat.dev ||
      named.ino !== stat.ino ||
      named.isSymbolicLink()
    )
      throw new Error();
    const raw: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    return z.object({ session: sessionValue }).strict().parse(raw).session;
  } catch {
    throw new Error(
      "Sticker owner session credential is unavailable or invalid; a private existing session file is required.",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function mcpOptionsFromEnvironment(
  env: NodeJS.ProcessEnv,
): StickerMcpOptions {
  const apiUrl = env.STICKER_API_URL ?? "http://127.0.0.1:8787",
    mode = env.STICKER_MCP_AUTH_MODE ?? "agent";
  if (mode === "agent")
    return { apiUrl, auth: { mode, token: env.STICKER_AGENT_TOKEN ?? "" } };
  if (mode === "trusted-local-owner") return { apiUrl, auth: { mode } };
  if (mode !== "owner-session")
    throw new Error("Unsupported Sticker MCP authentication mode.");
  if (!env.STICKER_OWNER_SESSION_FILE)
    throw new Error(
      "An explicit private owner session credential file is required.",
    );
  const session = readOwnerSessionFile(env.STICKER_OWNER_SESSION_FILE);
  return { apiUrl, auth: { mode, sessionProvider: () => session } };
}
export function createStickerTransport(options: StickerMcpOptions) {
  const origin = originFor(options),
    { auth } = options;
  // Each invocation owns its metadata and dispatch progress, including concurrent tools.
  const actions = new AsyncLocalStorage<{
    entry: McpCatalogueEntry;
    retryKeyFields: string[];
    mutationDispatched: boolean;
    domainResponseReceived: boolean;
  }>();
  function withAction<T>(
    entry: McpCatalogueEntry,
    args: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    const retryKeyFields =
      ["exact-operation", "conditional-operation"].includes(entry.retry) &&
      typeof args.operationId === "string"
        ? ["operationId"]
        : entry.retry === "event-id" &&
            typeof args.externalSessionId === "string" &&
            typeof args.eventId === "string"
          ? ["externalSessionId", "eventId"]
          : [];
    return actions.run(
      {
        entry,
        retryKeyFields,
        mutationDispatched: false,
        domainResponseReceived: false,
      },
      run,
    );
  }
  function recovery(method = "GET"): FailureDetails {
    const action = actions.getStore();
    const mutated = action
      ? action.mutationDispatched
      : !["GET", "HEAD", "OPTIONS"].includes(method);
    if (!mutated)
      return action?.entry.effect === "write"
        ? {
            phase: "before_dispatch",
            retryable: true,
            retry: "before_dispatch",
          }
        : { phase: "after_dispatch", retryable: true, retry: "safe_read" };
    return {
      phase: "after_dispatch",
      outcome: "uncertain",
      ...(action?.retryKeyFields.length
        ? {
            retryable: true,
            retry: "same_key_same_payload" as const,
            retryKeyFields: action.retryKeyFields,
            retryInstruction:
              "Retry only with the same listed key fields and identical complete original input. Do not generate a new key or change payload/revision; read current state separately after replay.",
          }
        : { retryable: false, retry: "readback" as const }),
      ...(action?.entry.readback ? { readback: action.entry.readback } : {}),
    };
  }
  const scrub = (value: string) =>
    (auth.mode === "agent"
      ? value.replaceAll(auth.token, "[redacted]")
      : value
    ).slice(0, 500);
  const result = (value: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
  async function headers(): Promise<CredentialHeaders> {
    if (auth.mode === "agent")
      return {
        authorization: `Bearer ${auth.token}`,
        "x-sticker-auth-mode": "agent",
      };
    if (auth.mode === "owner-session") {
      let session: string;
      try {
        session = sessionValue.parse(await auth.sessionProvider());
      } catch {
        throw new ApiError(
          401,
          "owner_session_required",
          "유효한 소유자 세션이 필요합니다.",
        );
      }
      return {
        cookie: `sticker_session=${session}`,
        origin,
        "x-sticker-auth-mode": "owner-session",
      };
    }
    return { origin, "x-sticker-auth-mode": "trusted-local-owner" };
  }
  async function send(
    path: string,
    method: string,
    body: unknown,
    credentials: CredentialHeaders,
    domainRequest = false,
    probe?: "health" | "readiness",
  ): Promise<Response> {
    if (
      !(probe
        ? method === "GET" &&
          body === undefined &&
          path === (probe === "health" ? "/healthz" : "/readyz")
        : path.startsWith("/api/")) ||
      path.startsWith("//") ||
      /[\\\r\n#]/.test(path)
    )
      throw new ApiError(400, "adapter_path", "지원하지 않는 API 경로입니다.");
    // Bind redaction to this request, including concurrent provider rotations.
    const requestSecrets = [
      auth.mode === "agent" ? auth.token : "",
      credentials.cookie?.slice(16) ?? "",
    ].filter(Boolean);
    const scrub = (value: string) =>
      requestSecrets
        .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
        .slice(0, 500);
    let response: Response;
    const serializedBody =
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body);
    try {
      const action = actions.getStore();
      if (
        domainRequest &&
        action?.entry.effect === "write" &&
        !["GET", "HEAD", "OPTIONS"].includes(method)
      )
        action.mutationDispatched = true;
      response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...credentials,
          ...(body instanceof FormData || body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: serializedBody,
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new ApiError(
        503,
        "api_unavailable",
        "스티커 API 응답을 받지 못했습니다. 재시도 조건을 확인하세요.",
        undefined,
        undefined,
        undefined,
        recovery(method),
      );
    }
    if (probe === "readiness" && response.status === 503) {
      const raw: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      if (
        z
          .object({ status: z.literal("maintenance") })
          .strict()
          .safeParse(raw).success
      )
        return response;
    }
    if (!response.ok) {
      const raw: unknown = await response.json().catch(() => null),
        parsed = apiErrorSchema.safeParse(raw),
        error = parsed.success ? parsed.data : {};
      throw new ApiError(
        response.status,
        typeof error.code === "string" ? scrub(error.code) : "api_error",
        typeof error.error === "string"
          ? scrub(error.error)
          : `API HTTP ${String(response.status)}`,
        error.fields
          ? Object.fromEntries(
              Object.entries(error.fields)
                .slice(0, 20)
                .map(([key, value]) => [scrub(key), scrub(value)]),
            )
          : undefined,
        error.code === "MAINTENANCE" &&
          error.maintenance &&
          !requestSecrets.some((secret) =>
            JSON.stringify(error.maintenance).includes(secret),
          )
          ? error.maintenance
          : undefined,
        error.code === "MAINTENANCE" ? error.retryAfterSeconds : undefined,
        response.status >= 500 && error.code !== "MAINTENANCE"
          ? recovery(method)
          : undefined,
      );
    }
    const action = actions.getStore();
    if (domainRequest && action) action.domainResponseReceived = true;
    return response;
  }
  async function verifiedActorWith(credentials: CredentialHeaders) {
    if (auth.mode !== "agent") {
      const response = await send(
        "/api/access-mode",
        "GET",
        undefined,
        credentials,
      );
      const mode = z
        .object({ mode: z.enum(["password", "trusted-loopback"]) })
        .parse(await response.json()).mode;
      if (
        mode !==
        (auth.mode === "owner-session" ? "password" : "trusted-loopback")
      )
        throw new ApiError(
          401,
          "auth_mode_mismatch",
          "선택한 소유자 인증 방식이 서버와 일치하지 않습니다.",
        );
    }
    const response = await send("/api/session", "GET", undefined, credentials);
    const actor = z
      .object({ actor: actorSchema })
      .parse(await response.json()).actor;
    if (
      actor.role !== (auth.mode === "agent" ? "agent" : "owner") ||
      (auth.mode !== "agent" &&
        (actor.id !== "owner" || !actor.canWrite || actor.projectIds !== null))
    )
      throw new ApiError(
        401,
        "auth_actor_mismatch",
        "서버가 요청한 인증 주체를 확인하지 못했습니다.",
      );
    return actor;
  }
  async function verifiedActor() {
    return verifiedActorWith(await headers());
  }
  async function probeStatus(kind: "health" | "readiness") {
    const credentials = await headers();
    await verifiedActorWith(credentials);
    const response = await send(
      kind === "health" ? "/healthz" : "/readyz",
      "GET",
      undefined,
      credentials,
      true,
      kind,
    );
    try {
      const raw: unknown = await response.json();
      return kind === "health"
        ? healthStatusSchema.parse(raw)
        : response.status === 503
          ? readinessStatusSchema.parse(raw)
          : readyStatusSchema.parse(raw);
    } catch {
      throw new ApiError(
        502,
        "api_response_invalid",
        "상태 응답 형식을 확인하지 못했습니다.",
      );
    }
  }
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> {
    const credentials = await headers();
    if (auth.mode !== "agent") await verifiedActorWith(credentials);
    return send(path, method, body, credentials, true);
  }
  /** Only a completed no-content DELETE establishes the legacy removal contract. */
  async function deleteNoContent(path: string, body?: unknown): Promise<void> {
    const response = await request(path, "DELETE", body);
    if (response.status !== 204) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(
        502,
        "api_response_invalid",
        "작업 완료 응답 형식을 확인하지 못했습니다. 현재 상태를 먼저 확인하세요.",
        undefined,
        undefined,
        undefined,
        recovery("DELETE"),
      );
    }
  }
  async function json(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const response = await request(path, method, body);
    try {
      return response.status === 204 ? { ok: true } : await response.json();
    } catch {
      throw new ApiError(
        502,
        "api_response_invalid",
        "API 응답을 읽지 못했습니다. 재시도 조건을 확인하세요.",
        undefined,
        undefined,
        undefined,
        recovery(method),
      );
    }
  }
  function formatFailure(error: unknown, readback?: string): CallToolResult {
    const action = actions.getStore();
    if (error instanceof z.ZodError) {
      const afterResponse = action?.domainResponseReceived === true;
      error = new ApiError(
        afterResponse ? 502 : 400,
        afterResponse ? "api_response_invalid" : "adapter_validation_error",
        afterResponse
          ? "API 응답 형식을 확인하지 못했습니다. 재시도 조건을 확인하세요."
          : "요청 값을 확인하지 못했습니다.",
        undefined,
        undefined,
        undefined,
        afterResponse ? recovery() : { phase: "before_dispatch" },
      );
    }
    if (error instanceof ApiError)
      return {
        ...result({
          error: scrub(error.message),
          code: scrub(error.code),
          status: error.status,
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.maintenance ? { maintenance: error.maintenance } : {}),
          ...(error.retryAfterSeconds
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
          ...error.details,
          ...(error.details?.outcome === "uncertain" && readback
            ? { readback }
            : {}),
        }),
        isError: true,
      };
    return {
      ...result({
        error: "요청을 처리하지 못했습니다.",
        code: "adapter_error",
        ...(action?.mutationDispatched ? recovery() : {}),
      }),
      isError: true,
    };
  }
  return {
    request,
    json,
    deleteNoContent,
    probeStatus,
    verifiedActor,
    formatFailure,
    withAction,
    mode: auth.mode,
  };
}
