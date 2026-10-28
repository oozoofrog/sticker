import type { Express } from "express";
import type { Actor } from "../types.js";
import { DomainError } from "../domain.js";
import { requestActor } from "../http-context.js";
import { mcpSettingsSchema } from "../contracts/mcp-settings.js";

/** Register after authentication. This route cannot configure or launch anything. */
export function registerMcpSettingsRoutes(
  app: Express,
  directory: () => Actor[],
) {
  app.get("/api/mcp/settings", (req, res) => {
    if (requestActor(req).role !== "owner")
      throw new DomainError(
        403,
        "OWNER_ONLY",
        "소유자만 MCP 연결 설정을 확인할 수 있습니다.",
      );
    res.json(
      mcpSettingsSchema.parse({
        transport: "stdio",
        application: "manual",
        verification: "unknown",
        tokenEnvironmentVariable: "STICKER_AGENT_TOKEN",
        agents: directory()
          .filter((agent) => agent.role === "agent")
          .map(({ id, name, canWrite, projectIds }) => ({
            id,
            name,
            canWrite,
            projectIds: projectIds === null ? null : [...projectIds],
          })),
      }),
    );
  });
}
