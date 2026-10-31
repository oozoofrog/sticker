import type { Express, Request } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientGrantService } from "../features/client-grants.js";
import type { AuthenticatedPrincipal } from "../auth.js";
import { requestActor, requestId } from "../http-context.js";
import { DomainError } from "../domain-error.js";
/** Extra strictness only for these private mutation bodies; ordinary JSON behavior is unchanged. */
export function rejectGrantDuplicateKeys(
  req: IncomingMessage,
  _res: ServerResponse,
  bytes: Buffer,
) {
  if (
    req.method !== "POST" ||
    !/^\/client-grants(?:\/[^/?]+\/(?:activate|revoke))?$/.test(req.url ?? "")
  )
    return;
  const text = bytes.toString("utf8");
  const stack: (Set<string> | null)[] = [];
  const tokens = text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g);
  for (const match of tokens) {
    const token = match[0];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (
      text
        .slice(match.index + token.length)
        .trimStart()
        .startsWith(":")
    ) {
      const key = JSON.parse(token) as unknown,
        keys = stack.at(-1);
      if (typeof key !== "string" || !keys || keys.has(key))
        throw new DomainError(
          400,
          "VALIDATION",
          "관리 연결 JSON 요청을 확인하세요.",
        );
      keys.add(key);
    }
  }
}
export function registerClientGrantRoutes(
  app: Express,
  service: ClientGrantService,
) {
  const json = (req: Request) => {
    // Express normally accepts case/trailing-slash/query aliases. This private
    // confirmation-bearing protocol uses one exact wire route per mutation.
    if (
      req.originalUrl !== "/api/client-grants" &&
      !/^\/api\/client-grants\/[a-f0-9-]{36}\/(?:activate|revoke)$/.test(
        req.originalUrl,
      )
    )
      throw new DomainError(400, "VALIDATION", "관리 연결 경로를 확인하세요.");
    if (!req.is("application/json"))
      throw new DomainError(415, "CONTENT_TYPE", "JSON 요청이 필요합니다.");
  };
  app.post("/api/client-grants", (req, res) => {
    json(req);
    res.status(201).json(service.provision(requestActor(req), req.body));
  });
  app.post("/api/client-grants/:id/activate", (req, res) => {
    json(req);
    res.json(service.activate(requestActor(req), requestId(req), req.body));
  });
  app.post("/api/client-grants/:id/revoke", (req, res) => {
    json(req);
    res.json(service.revoke(requestActor(req), requestId(req), req.body));
  });
  app.get("/api/client-grants/operations/:operationId", (req, res) =>
    res.json(service.operation(requestActor(req), req.params.operationId)),
  );
  app.get("/api/client-grants/self/verify", (req, res) => {
    const principal = (req as Request & { principal: AuthenticatedPrincipal })
      .principal;
    if (
      !principal.access ||
      req.originalUrl !== "/api/client-grants/self/verify" ||
      req.method !== "GET" ||
      (req.headers["content-length"] &&
        req.headers["content-length"] !== "0") ||
      req.headers["transfer-encoding"]
    )
      throw new DomainError(
        403,
        "MANAGED_REQUIRED",
        "관리 연결 인증이 필요합니다.",
      );
    res.json({ actor: principal.actor, access: principal.access });
  });
}
