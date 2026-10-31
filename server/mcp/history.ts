import { restoreResultSchema } from "../response-schemas.js";
import {
  restorePreviewInputSchema,
  restoreInputSchema,
  restorePreviewSchema,
} from "../contracts/history.js";
import { z } from "zod";
import type { McpFeatureClient } from "./sessions.js";
import {
  historyListSchema,
  historyDetailSchema,
} from "../contracts/history.js";
export function registerHistoryTools({ tool, json }: McpFeatureClient) {
  const id = z.string().min(1).max(128);
  tool(
    "sticker_list_issue_history",
    "현재 프로젝트 권한으로 이슈 변경 이력을 읽습니다.",
    { issueId: id },
    async ({ issueId }) =>
      historyListSchema.parse(
        await json(`/api/issues/${encodeURIComponent(issueId)}/history`),
      ),
    true,
  );
  tool(
    "sticker_get_issue_change",
    "이슈 변경의 기록된 이전·이후 값을 읽습니다. 이전 값이 없는 기록은 비교 불가로 반환합니다.",
    { issueId: id, changeId: id },
    async ({ issueId, changeId }) =>
      historyDetailSchema.parse(
        await json(
          `/api/issues/${encodeURIComponent(issueId)}/history/${encodeURIComponent(changeId)}`,
        ),
      ),
    true,
  );
  tool(
    "sticker_preview_issue_restore",
    "소유자가 선택한 과거 필드의 복원 차이를 미리 봅니다. 저장하지 않으며 적용하지 않으면 취소입니다.",
    { issueId: id, ...restorePreviewInputSchema.shape },
    async ({ issueId, ...input }) => {
      const body = restorePreviewInputSchema.parse(input);
      return restorePreviewSchema.parse(
        await json(
          `/api/issues/${encodeURIComponent(issueId)}/restore/preview`,
          "POST",
          body,
        ),
      );
    },
    true,
  );
  tool(
    "sticker_restore_issue_fields",
    "소유자가 검토한 필드만 현재 revision으로 복원하고 이력을 남깁니다. 동일 operationId·입력으로만 재시도하세요.",
    { issueId: id, ...restoreInputSchema.shape },
    async ({ issueId, ...input }) => {
      const body = restoreInputSchema.parse(input);
      return restoreResultSchema.parse(
        await json(
          `/api/issues/${encodeURIComponent(issueId)}/restore`,
          "POST",
          body,
        ),
      );
    },
  );
}
