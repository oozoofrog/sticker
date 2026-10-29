import { z } from "zod";
import type { McpFeatureClient } from "./sessions.js";
import { githubEvidenceSchema } from "../contracts/github.js";
export function registerGithubTools({ tool, json }: McpFeatureClient) {
  tool(
    "sticker_get_github_evidence",
    "현재 이슈 권한 내 저장된 GitHub 검증 근거를 읽습니다. GitHub를 호출하거나 상태를 변경하지 않습니다.",
    { issueId: z.string().min(1).max(128) },
    async ({ issueId }) =>
      githubEvidenceSchema
        .array()
        .parse(
          await json(
            `/api/issues/${encodeURIComponent(issueId)}/github-evidence`,
          ),
        ),
    true,
  );
}
