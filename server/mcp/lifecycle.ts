import { z } from "zod";
import type { McpFeatureClient } from "./sessions.js";
/** Unkeyed legacy deletes: read back before deciding whether another attempt is needed. */
export function registerLifecycleTools({
  tool,
  deleteNoContent,
}: McpFeatureClient) {
  const id = z.string().min(1).max(128),
    e = encodeURIComponent;
  tool(
    "sticker_delete_project",
    "소유자가 비어 있는 프로젝트를 삭제합니다. 재시도 전에 프로젝트 목록을 확인하세요.",
    { projectId: id },
    async ({ projectId }) => {
      await deleteNoContent(`/api/projects/${e(projectId)}`);
      return { removed: true };
    },
  );
  tool(
    "sticker_delete_version",
    "버전을 삭제합니다. 출시 이력·종결 이슈는 소유자만 처리할 수 있습니다. 재시도 전에 버전과 이슈를 확인하세요.",
    { versionId: id },
    async ({ versionId }) => {
      await deleteNoContent(`/api/versions/${e(versionId)}`);
      return { removed: true };
    },
  );
  tool(
    "sticker_delete_issue",
    "소유자가 이슈를 삭제합니다. GitHub 원격 이슈는 삭제하지 않습니다. 불확실하면 먼저 이슈를 조회하세요.",
    { issueId: id },
    async ({ issueId }) => {
      await deleteNoContent(`/api/issues/${e(issueId)}`);
      return { removed: true };
    },
  );
  tool(
    "sticker_delete_comment",
    "열린 이슈의 댓글을 작성자 또는 소유자가 삭제합니다. 이슈를 읽어 결과를 확인하세요.",
    { commentId: id },
    async ({ commentId }) => {
      await deleteNoContent(`/api/comments/${e(commentId)}`);
      return { removed: true };
    },
  );
  tool(
    "sticker_delete_attachment",
    "열린 이슈의 첨부를 작성자 또는 소유자가 삭제합니다. 이슈를 읽어 결과를 확인하세요.",
    { attachmentId: id },
    async ({ attachmentId }) => {
      await deleteNoContent(`/api/attachments/${e(attachmentId)}`);
      return { removed: true };
    },
  );
}
