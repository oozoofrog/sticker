import {
  viewCreateSchema,
  viewUpdateSchema,
  viewDeleteSchema,
  viewPreferenceInputSchema,
  viewPreferencesSchema,
} from "../contracts/views.js";
import { z } from "zod";
import type { McpFeatureClient } from "./sessions.js";
import { issueQuerySchema } from "../contracts/issue-query.js";
import { issueQueryResultSchema, savedViewSchema } from "../contracts/views.js";
import { STATUSES } from "../types.js";
export function registerViewTools({
  tool,
  json,
  deleteNoContent,
}: McpFeatureClient) {
  const id = z.string().min(1).max(128),
    e = encodeURIComponent;
  tool(
    "sticker_query_issues",
    "동일한 프로젝트·버전·관계·입력요청 필터와 정렬로 이슈를 조회합니다. 삭제된 참조는 경고와 빈 결과를 반환합니다.",
    issueQuerySchema.shape,
    async (input) =>
      issueQueryResultSchema.parse(
        await json("/api/issues/query", "POST", input),
      ),
    true,
  );
  tool(
    "sticker_list_issues",
    "권한 내 이슈를 공통 필터로 조회합니다. 단일 status 문자열도 호환합니다.",
    {
      ...issueQuerySchema.shape,
      status: z
        .union([z.enum(STATUSES), issueQuerySchema.shape.status.unwrap()])
        .optional(),
    },
    async (input) =>
      issueQueryResultSchema.parse(
        await json("/api/issues/query", "POST", {
          ...input,
          status:
            typeof input.status === "string" ? [input.status] : input.status,
        }),
      ).issues,
    true,
  );
  tool(
    "sticker_list_saved_views",
    "현재 인증 주체의 개인 저장 뷰만 조회합니다.",
    { projectId: id.optional() },
    async ({ projectId }) =>
      savedViewSchema
        .array()
        .parse(
          await json(
            `/api/views${projectId ? `?projectId=${e(projectId)}` : ""}`,
          ),
        ),
    true,
  );
  tool(
    "sticker_get_saved_view",
    "현재 인증 주체의 개인 뷰 조건을 읽습니다. URL은 권한을 부여하지 않습니다.",
    { viewId: id },
    async ({ viewId }) =>
      savedViewSchema.parse(await json(`/api/views/${e(viewId)}`)),
    true,
  );
  tool(
    "sticker_create_saved_view",
    "현재 인증 주체의 개인 저장 뷰를 만듭니다. 권한을 공유하지 않습니다.",
    viewCreateSchema.shape,
    async (input) =>
      savedViewSchema.parse(
        await json("/api/views", "POST", viewCreateSchema.parse(input)),
      ),
  );
  tool(
    "sticker_update_saved_view",
    "자신의 개인 뷰 전체 정의를 현재 revision으로 수정합니다.",
    { viewId: id, ...viewUpdateSchema.shape },
    async ({ viewId, ...input }) => {
      const body = viewUpdateSchema.parse(input);
      return savedViewSchema.parse(
        await json(`/api/views/${e(viewId)}`, "PATCH", body),
      );
    },
  );
  tool(
    "sticker_delete_saved_view",
    "자신의 개인 뷰를 현재 revision으로 삭제합니다.",
    { viewId: id, ...viewDeleteSchema.shape },
    async ({ viewId, ...input }) => {
      const body = viewDeleteSchema.parse(input);
      await deleteNoContent(`/api/views/${e(viewId)}`, body);
      return { removed: true };
    },
  );
  tool(
    "sticker_get_view_preferences",
    "자신의 프로젝트별 기본 뷰와 즐겨찾기를 읽습니다.",
    { projectId: id },
    async ({ projectId }) =>
      viewPreferencesSchema.parse(
        await json(`/api/view-preferences/${e(projectId)}`),
      ),
    true,
  );
  tool(
    "sticker_set_view_preferences",
    "자신의 기본 뷰와 중복 없는 즐겨찾기를 현재 revision으로 저장합니다.",
    { projectId: id, ...viewPreferenceInputSchema.shape },
    async ({ projectId, ...input }) => {
      const body = viewPreferenceInputSchema.parse(input);
      return viewPreferencesSchema.parse(
        await json(`/api/view-preferences/${e(projectId)}`, "PUT", body),
      );
    },
  );
}
