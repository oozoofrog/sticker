import {
  responseInputSchema,
  closeInputSchema,
} from "../contracts/sessions.js";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  sessionSchema,
  sessionDetailSchema,
  sessionEventResultSchema,
  sessionRequestSchema,
} from "../contracts/sessions.js";
export interface McpFeatureClient {
  tool: <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    readOnly?: boolean,
    annotations?: ToolAnnotations,
  ) => void;
  json: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  deleteNoContent: (path: string, body?: unknown) => Promise<void>;
}
export function registerSessionTools({ tool, json }: McpFeatureClient) {
  const id = z.string().min(1).max(128),
    e = encodeURIComponent;
  tool(
    "sticker_list_sessions",
    "범위 내 세션별 자기 보고를 조회합니다. working은 실제 프로세스 실행 증거가 아닙니다.",
    { projectId: id.optional() },
    async ({ projectId }) =>
      sessionSchema
        .array()
        .parse(
          await json(
            `/api/sessions${projectId ? `?projectId=${e(projectId)}` : ""}`,
          ),
        ),
    true,
  );
  tool(
    "sticker_get_session",
    "세션의 불변 이벤트와 정확한 요청 ID·응답을 조회합니다. 발생/수신/eventId 순입니다.",
    { sessionId: id },
    async ({ sessionId }) =>
      sessionDetailSchema.parse(await json(`/api/sessions/${e(sessionId)}`)),
    true,
  );
  tool(
    "sticker_report_session_event",
    "현재 인증 에이전트의 자기 보고만 기록합니다. eventId 재시도는 중복되지 않으며 다른 내용이면 409입니다. 요청 응답은 실행·승인이 아닙니다.",
    {
      projectId: id,
      issueId: id.nullable().optional(),
      externalSessionId: id,
      eventId: id,
      kind: z.enum(["report", "request", "result", "error", "end"]),
      occurredAt: z.iso.datetime().optional(),
      message: z.string().min(1).max(20000),
      state: z.enum(["working", "idle", "blocked"]).optional(),
      requestKind: z.enum(["input", "review"]).optional(),
    },
    async (input) =>
      sessionEventResultSchema.parse(
        await json("/api/sessions/events", "POST", input),
      ),
  );
  tool(
    "sticker_list_pending_requests",
    "현재 에이전트 자신의 범위 내 미처리 요청을 읽습니다. 소유자 응답·종결 기능은 에이전트 도구가 아닙니다.",
    { projectId: id.optional() },
    async ({ projectId }) =>
      sessionRequestSchema
        .array()
        .parse(
          await json(
            `/api/inbox${projectId ? `?projectId=${e(projectId)}` : ""}`,
          ),
        ),
    true,
  );
  tool(
    "sticker_list_completed_requests",
    "완료 요청을 읽습니다. 에이전트의 받은 요청함은 자신이 만든 요청만 포함합니다. 응답은 실행 승인이 아닙니다.",
    { projectId: id.optional() },
    async ({ projectId }) =>
      sessionRequestSchema
        .array()
        .parse(
          await json(
            `/api/inbox?completed=true${projectId ? `&projectId=${e(projectId)}` : ""}`,
          ),
        ),
    true,
  );
  tool(
    "sticker_get_request",
    "정확한 요청을 프로젝트 권한으로 읽습니다. 받은 요청함과 달리 작성자 필터를 적용하지 않습니다.",
    { requestId: id },
    async ({ requestId }) =>
      sessionRequestSchema.parse(await json(`/api/requests/${e(requestId)}`)),
    true,
  );
  tool(
    "sticker_respond_to_request",
    "소유자가 입력·검토 요청에 답변을 기록합니다. 실행하거나 권한을 부여하지 않습니다. 동일 operationId·입력으로만 재시도하세요.",
    { requestId: id, ...responseInputSchema.shape },
    async ({ requestId, ...input }) => {
      const body = responseInputSchema.parse(input);
      return sessionRequestSchema.parse(
        await json(`/api/requests/${e(requestId)}/responses`, "POST", body),
      );
    },
  );
  tool(
    "sticker_close_request",
    "소유자가 현재 revision으로 요청을 종결합니다. 실행 승인이 아닙니다.",
    { requestId: id, ...closeInputSchema.shape },
    async ({ requestId, ...input }) => {
      const body = closeInputSchema.parse(input);
      return sessionRequestSchema.parse(
        await json(`/api/requests/${e(requestId)}/close`, "POST", body),
      );
    },
  );
  tool(
    "sticker_close_session",
    "소유자가 현재 revision으로 자기 보고 세션을 종결합니다. 프로세스를 종료하지 않습니다.",
    { sessionId: id, ...closeInputSchema.shape },
    async ({ sessionId, ...input }) => {
      const body = closeInputSchema.parse(input);
      return sessionSchema.parse(
        await json(`/api/sessions/${e(sessionId)}/close`, "POST", body),
      );
    },
  );
}
