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
}
