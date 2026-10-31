import { relationSummariesSchema } from "../contracts/relations.js";
import { z } from "zod";
import type { McpFeatureClient } from "./sessions.js";
import {
  relationDetailSchema,
  relationSchema,
  relationInputSchema,
  relationRevisionSchema,
} from "../contracts/relations.js";
export function registerRelationTools({
  tool,
  json,
  deleteNoContent,
}: McpFeatureClient) {
  const id = z.string().min(1).max(128),
    e = encodeURIComponent;
  tool(
    "sticker_get_issue_relations",
    "이슈의 부모·하위·관련·차단 관계를 조회합니다. done과 소유자 closed는 다릅니다.",
    { issueId: id },
    async ({ issueId }) =>
      relationDetailSchema.parse(
        await json(`/api/issues/${e(issueId)}/relations`),
      ),
    true,
  );
  tool(
    "sticker_add_issue_relation",
    "같은 프로젝트의 관계를 추가합니다. 순환과 동시 수정은 거부됩니다. 실행·승인·자동 종결하지 않습니다.",
    { issueId: id, ...relationInputSchema.shape },
    async ({ issueId, ...input }) =>
      relationSchema.parse(
        await json(`/api/issues/${e(issueId)}/relations`, "POST", input),
      ),
  );
  tool(
    "sticker_remove_issue_relation",
    "관계만 해제합니다. 양끝 이슈의 현재 revision이 필요하며 이슈는 삭제하지 않습니다.",
    { relationId: id, ...relationRevisionSchema.shape },
    async ({ relationId, ...input }) => {
      await deleteNoContent(`/api/relations/${e(relationId)}`, input);
      return { removed: true };
    },
  );
  tool(
    "sticker_get_relation_summaries",
    "범위 내 이슈 관계와 차단 요약을 읽습니다.",
    { projectId: id.optional() },
    async ({ projectId }) =>
      relationSummariesSchema.parse(
        await json(
          `/api/relations/summary${projectId ? `?projectId=${e(projectId)}` : ""}`,
        ),
      ),
    true,
  );
}
