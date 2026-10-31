import { z } from "zod";
import type { McpFeatureClient } from "./sessions.js";
import { ApiError, type createStickerTransport } from "./transport.js";
import { mcpSettingsSchema } from "../contracts/mcp-settings.js";
import { accessModeSchema } from "../contracts/access.js";
import {
  maintenanceSnapshotSchema,
  maintenanceControlSchema,
} from "../contracts/maintenance.js";
export function registerSettingsTools(
  { tool, json, deleteNoContent }: McpFeatureClient,
  transport: ReturnType<typeof createStickerTransport>,
) {
  tool(
    "sticker_get_mcp_settings",
    "소유자가 비밀 값 없는 MCP 연결 메타데이터와 에이전트 범위를 읽습니다. 설정을 바꾸지 않습니다.",
    {},
    async () => mcpSettingsSchema.parse(await json("/api/mcp/settings")),
    true,
  );
  tool(
    "sticker_get_access_mode",
    "서버의 인증 방식을 읽습니다. 선택된 인증 주체와 권한은 바뀌지 않습니다.",
    {},
    async () => {
      await transport.verifiedActor();
      return accessModeSchema.parse(await json("/api/access-mode"));
    },
    true,
  );
  tool(
    "sticker_get_server_health",
    "현재 인증 주체를 확인한 뒤 서버 생존 상태만 읽습니다. 호스트 작업은 하지 않습니다.",
    {},
    async () => transport.probeStatus("health"),
    true,
  );
  tool(
    "sticker_get_server_readiness",
    "현재 인증 주체를 확인한 뒤 준비 또는 점검 상태를 읽습니다. 점검 중이라는 관찰은 작업 성공을 뜻하지 않습니다.",
    {},
    async () => transport.probeStatus("readiness"),
    true,
  );
  tool(
    "sticker_get_maintenance",
    "현재 서버 인스턴스와 점검 revision·진행 상태를 읽습니다.",
    {},
    async () => maintenanceSnapshotSchema.parse(await json("/api/maintenance")),
    true,
  );
  tool(
    "sticker_begin_maintenance",
    "소유자가 검토한 instanceId·revision과 confirm:true로 쓰기 진입을 멈춥니다. 서버 프로세스는 종료하지 않습니다.",
    maintenanceControlSchema.shape,
    async (input) =>
      maintenanceSnapshotSchema.parse(
        await json(
          "/api/maintenance/begin",
          "POST",
          maintenanceControlSchema.parse(input),
        ),
      ),
  );
  tool(
    "sticker_resume_maintenance",
    "소유자가 검토한 instanceId·revision과 confirm:true로 쓰기 진입을 재개합니다. 프로세스를 시작하지 않습니다.",
    maintenanceControlSchema.shape,
    async (input) =>
      maintenanceSnapshotSchema.parse(
        await json(
          "/api/maintenance/resume",
          "POST",
          maintenanceControlSchema.parse(input),
        ),
      ),
  );
  tool(
    "sticker_end_owner_session",
    "confirm:true로 현재 소유자 세션만 끝냅니다. 소유자 세션 모드에서만 가능합니다. 토큰·로컬 소유자 모드·자격 파일을 삭제하지 않습니다.",
    { confirm: z.literal(true) },
    async () => {
      if (transport.mode !== "owner-session")
        throw new ApiError(
          403,
          "owner_session_mode_required",
          "현재 소유자 세션 모드에서만 로그아웃할 수 있습니다. 에이전트 토큰과 로컬 소유자 모드는 변경하지 않습니다.",
        );
      await deleteNoContent("/api/session");
      return { ended: true };
    },
  );
}
