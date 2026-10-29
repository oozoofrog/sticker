import type { Express } from "express";
import type { Actor } from "../types.js";
import { requestActor } from "../http-context.js";
import { DomainError } from "../domain.js";
import { agentInstallBundle, agentInstallCatalog } from "../agent-install.js";
export function registerAgentInstallRoutes(
  app: Express,
  directory: () => Actor[],
) {
  app.use("/api/agent-install", (req, _res, next) => {
    if (requestActor(req).role !== "owner")
      throw new DomainError(
        403,
        "OWNER_ONLY",
        "소유자만 에이전트 설치를 준비할 수 있습니다.",
      );
    next();
  });
  app.get("/api/agent-install", (_req, res) =>
    res.json(agentInstallCatalog(directory())),
  );
  app.post("/api/agent-install/bundle", (req, res) => {
    const bundle = agentInstallBundle(directory(), req.body);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="sticker-agent-install-1.0.0.zip"',
    );
    res.send(bundle);
  });
}
