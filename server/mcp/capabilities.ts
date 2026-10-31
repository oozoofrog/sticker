import { z } from "zod";
import { bootstrapSchema } from "../response-schemas.js";
import { maintenanceSnapshotSchema } from "../contracts/maintenance.js";
import { MCP_CATALOGUE } from "./catalogue.js";
import type { McpFeatureClient } from "./sessions.js";
import type { createStickerTransport } from "./transport.js";

export function registerCapabilityTools(
  { tool, json }: McpFeatureClient,
  transport: ReturnType<typeof createStickerTransport>,
) {
  const visibleTools = z.array(z.string().min(1).max(128)).max(100).optional();
  async function help(visible?: string[], selectedTool?: string) {
    const actor = await transport.verifiedActor();
    const actions = MCP_CATALOGUE.filter(
      (entry) => !selectedTool || entry.tool === selectedTool,
    ).map((entry) => {
      const reason =
        entry.authenticationMode && entry.authenticationMode !== transport.mode
          ? "authentication_mode_required"
          : entry.authority === "owner" && actor.role !== "owner"
            ? "owner_required"
            : entry.authority === "agent-writer" && actor.role !== "agent"
              ? "agent_required"
              : (entry.authority === "writer" ||
                    entry.authority === "agent-writer" ||
                    entry.effect === "write") &&
                  !actor.canWrite
                ? "write_permission_required"
                : undefined;
      return {
        ...entry,
        availability: reason
          ? "permission_needed"
          : entry.conditions.length
            ? "conditional"
            : "available",
        ...(reason ? { reason } : {}),
      };
    });
    return {
      contractVersion: 1,
      actor,
      authentication: {
        mode: transport.mode,
        ownerActivation: "explicit_trusted_launcher_only",
        automaticFallback: false,
      },
      actions,
      clientVisibility:
        visible === undefined
          ? {
              status: "unknown",
              guidance:
                "The server cannot observe client filtering. Reconnect or review the client allowlist if a listed tool is absent.",
            }
          : {
              status: "reported",
              missingTools: MCP_CATALOGUE.filter(
                (entry) => !visible.includes(entry.tool),
              ).map((entry) => entry.tool),
              guidance:
                "Client-reported visibility only; permissions and client configuration are unchanged.",
            },
      workflow: [
        "sticker_get_capabilities",
        "sticker_list_projects",
        "sticker_create_project (owner, if empty)",
        "sticker_get_project_guidance",
        "sticker_list_issue_templates",
        "sticker_create_issue (operationId)",
        "sticker_get_issue",
      ],
      scope:
        "Creating a project never extends any agent token's projectIds. Scope changes require separate operator authority.",
      statusSemantics:
        "waiting records waiting or blocked work; it does not itself grant approval. Reports are self-reports, not execution proof; responses do not authorize or resume execution.",
      limits: {
        legacyFileBytes: 5 * 1024 * 1024,
        httpFileBytes: 20 * 1024 * 1024,
        chunkedFileBytes: 20 * 1024 * 1024,
        chunkBytes: 64 * 1024,
        liveTransferHandles: 2,
        transferRawReservationBytes: 40 * 1024 * 1024,
        transferOwnedAllocationBytes: 80 * 1024 * 1024,
        transferSlidingTtlMs: 10 * 60 * 1000,
        transferAbsoluteTtlMs: 30 * 60 * 1000,
        requestTimeoutMs: 15_000,
        automaticRetry: false,
      },
      coverage:
        "Only the listed shipped tools are exposed. Full product parity and zero-setup native installation are not yet complete.",
    };
  }
  tool(
    "sticker_get_capabilities",
    "현재 인증 주체·범위와 실제 지원 도구·조건·확인·재시도 경계를 읽습니다. 클라이언트 필터는 전달받은 목록이 있을 때만 비교하며 권한을 변경하지 않습니다.",
    { visibleTools },
    async ({ visibleTools }) => ({
      ...(await help(visibleTools)),
      maintenance: maintenanceSnapshotSchema.parse(
        await json("/api/maintenance"),
      ),
    }),
    true,
  );
  tool(
    "sticker_get_help",
    "화면 없이 시작하는 순서와 도구별 경로·필요 권한·재시도 경계를 읽습니다. 인증 기술 설정은 신뢰된 실행기의 내부 계약입니다.",
    {
      tool: z
        .enum(MCP_CATALOGUE.map((entry) => entry.tool) as [string, ...string[]])
        .optional(),
      visibleTools,
    },
    async ({ tool: selected, visibleTools }) => help(visibleTools, selected),
    true,
  );
  tool(
    "sticker_get_bootstrap",
    "접근 가능한 프로젝트·버전·이슈·자기 보고와 현재 주체를 읽습니다. 빈 저장소의 프로젝트 생성에는 명시적으로 인증된 소유자가 필요합니다.",
    {},
    async () => bootstrapSchema.parse(await json("/api/bootstrap")),
    true,
  );
}
