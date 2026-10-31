import {
  templateCreateSchema,
  templateUpdateSchema,
  templateDeleteSchema,
  templateAssigneeSchema,
} from "../contracts/templates.js";
import { z } from "zod";
import type { McpFeatureClient } from "./sessions.js";
import {
  issueTemplateSchema,
  templateDetailSchema,
  templatePreviewSchema,
  templateValuesSchema,
} from "../contracts/templates.js";
export function registerTemplateTools({
  tool,
  json,
  deleteNoContent,
}: McpFeatureClient) {
  const id = z.string().min(1).max(128),
    e = encodeURIComponent;
  tool(
    "sticker_list_issue_templates",
    "프로젝트 범위의 저장된 이슈 템플릿과 현재 버전을 읽습니다.",
    { projectId: id },
    async ({ projectId }) =>
      issueTemplateSchema
        .array()
        .parse(await json(`/api/projects/${e(projectId)}/templates`)),
    true,
  );
  tool(
    "sticker_get_issue_template",
    "이슈 템플릿의 불변 버전, 필수 항목과 기본 속성을 읽습니다.",
    { templateId: id, version: z.number().int().positive().optional() },
    async ({ templateId, version }) =>
      templateDetailSchema.parse(
        await json(
          `/api/templates/${e(templateId)}${version ? `?version=${String(version)}` : ""}`,
        ),
      ),
    true,
  );
  tool(
    "sticker_preview_issue_template",
    "이슈를 만들지 않고 본문과 필수 항목 오류를 미리 봅니다. 템플릿 문구는 실행 권한이 아닙니다.",
    {
      templateId: id,
      version: z.number().int().positive().optional(),
      values: templateValuesSchema.default({}),
      body: z.string().max(20000).optional(),
    },
    async ({ templateId, ...input }) =>
      templatePreviewSchema.parse(
        await json(`/api/templates/${e(templateId)}/preview`, "POST", input),
      ),
    true,
  );
  tool(
    "sticker_create_issue_template",
    "소유자가 이슈 템플릿을 만듭니다. 같은 operationId와 동일 입력으로만 재시도하세요.",
    templateCreateSchema.shape,
    async (input) => {
      const { projectId, ...body } = templateCreateSchema.parse(input);
      return templateDetailSchema.parse(
        await json(`/api/projects/${e(projectId)}/templates`, "POST", body),
      );
    },
  );
  tool(
    "sticker_update_issue_template",
    "소유자가 현재 revision으로 템플릿 전체 정의의 새 불변 버전을 저장합니다. 재시도 전 현재 버전을 읽으세요.",
    { templateId: id, ...templateUpdateSchema.shape },
    async ({ templateId, ...input }) => {
      const body = templateUpdateSchema.parse(input);
      return templateDetailSchema.parse(
        await json(`/api/templates/${e(templateId)}`, "PATCH", body),
      );
    },
  );
  tool(
    "sticker_delete_issue_template",
    "소유자가 현재 revision의 템플릿을 삭제 표시합니다. 이슈는 보존됩니다.",
    { templateId: id, ...templateDeleteSchema.shape },
    async ({ templateId, ...input }) => {
      const body = templateDeleteSchema.parse(input);
      await deleteNoContent(`/api/templates/${e(templateId)}`, body);
      return { removed: true };
    },
  );
  tool(
    "sticker_list_template_assignees",
    "프로젝트에서 템플릿 기본 담당자로 쓸 수 있는 주체를 읽습니다.",
    { projectId: id },
    async ({ projectId }) =>
      templateAssigneeSchema
        .array()
        .parse(await json(`/api/projects/${e(projectId)}/template-assignees`)),
    true,
  );
}
