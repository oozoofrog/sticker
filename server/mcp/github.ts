import { z } from "zod";
import type { McpFeatureClient } from "./sessions.js";
import {
  githubConnectSchema,
  githubConnectionMutationSchema,
  githubConnectionSchema,
  githubEvidenceCreateSchema,
  githubEvidenceMutationSchema,
  githubEvidenceSchema,
} from "../contracts/github.js";
import {
  githubDiscoverySourcesSchema,
  githubDiscoveryQuerySchema,
  githubDiscoveryPageSchema,
  githubSelectionConnectSchema,
  githubSelectionStatusSchema,
} from "../contracts/github-discovery.js";
export function registerGithubTools({ tool, json }: McpFeatureClient) {
  const id = z.string().min(1).max(128),
    e = encodeURIComponent;
  const connection = (projectId: string) =>
    `/api/projects/${e(projectId)}/github`;
  const evidence = (evidenceId: string) =>
    `/api/github-evidence/${e(evidenceId)}`;
  tool(
    "sticker_list_github_sources",
    "소유자가 기존 설정에서 사용할 수 있는 GitHub 조회 출처를 확인하고 임시 선택 표를 발급합니다. 토큰이나 내부 자격 참조를 반환하지 않습니다.",
    { projectId: id },
    async ({ projectId }) =>
      githubDiscoverySourcesSchema.parse(
        await json(`${connection(projectId)}/sources`),
      ),
  );
  tool(
    "sticker_list_github_repositories",
    "발급받은 출처와 커서로 저장소를 조회하고 임시 선택 표를 발급합니다. 새 자격증명이나 GitHub 권한을 만들지 않습니다.",
    { projectId: id, ...githubDiscoveryQuerySchema.shape },
    async ({ projectId, ...input }) =>
      githubDiscoveryPageSchema.parse(
        await json(
          `${connection(projectId)}/repositories`,
          "POST",
          githubDiscoveryQuerySchema.parse(input),
        ),
      ),
    false,
    { openWorldHint: true },
  );
  tool(
    "sticker_connect_github_selection",
    "소유자가 확인한 저장소 선택을 현재 revision에 연결합니다. 응답을 잃으면 원래 선택 입력으로 selection status를 조회하고 자동 재전송하지 마세요.",
    { projectId: id, ...githubSelectionConnectSchema.shape },
    async ({ projectId, ...input }) =>
      githubConnectionSchema.parse(
        await json(
          `${connection(projectId)}/select`,
          "POST",
          githubSelectionConnectSchema.parse(input),
        ),
      ),
    false,
    { openWorldHint: true },
  );
  tool(
    "sticker_get_github_selection_status",
    "원래 출처·선택·revision으로 연결 결과가 정확히 일치하는지 읽습니다. 선택 표 만료는 성공이나 실패의 증거가 아닙니다.",
    { projectId: id, ...githubSelectionConnectSchema.shape },
    async ({ projectId, ...input }) =>
      githubSelectionStatusSchema.parse(
        await json(
          `${connection(projectId)}/selection-status`,
          "POST",
          githubSelectionConnectSchema.parse(input),
        ),
      ),
    true,
  );
  tool(
    "sticker_get_github_connection",
    "소유자가 현재 저장된 GitHub 연결과 revision을 읽습니다. 외부 조회나 권한 검증을 수행하지 않습니다.",
    { projectId: id },
    async ({ projectId }) =>
      githubConnectionSchema.parse(await json(connection(projectId))),
    true,
  );
  tool(
    "sticker_set_github_connection",
    "기존 사용자 지정 연결 계약으로 저장소·조회 방식과 현재 revision을 저장합니다. credentialRef는 이미 설정된 참조이며 토큰 입력이나 발급이 아닙니다. 일반 선택에는 출처·저장소 목록을 사용하세요.",
    { projectId: id, ...githubConnectSchema.shape },
    async ({ projectId, ...input }) =>
      githubConnectionSchema.parse(
        await json(
          connection(projectId),
          "PUT",
          githubConnectSchema.parse(input),
        ),
      ),
  );
  tool(
    "sticker_disconnect_github_connection",
    "소유자가 현재 revision을 확인해 로컬 GitHub 연결을 해제합니다. 원격 저장소·권한·근거 기록을 삭제하지 않습니다.",
    { projectId: id, ...githubConnectionMutationSchema.shape },
    async ({ projectId, ...input }) =>
      githubConnectionSchema.parse(
        await json(
          connection(projectId),
          "DELETE",
          githubConnectionMutationSchema.parse(input),
        ),
      ),
  );
  tool(
    "sticker_verify_github_connection",
    "기존 공급자로 저장소를 조회하고 확인 시각 또는 오류와 새 revision을 저장합니다. GitHub 쓰기 권한을 검증하거나 부여하지 않습니다.",
    { projectId: id, ...githubConnectionMutationSchema.shape },
    async ({ projectId, ...input }) =>
      githubConnectionSchema.parse(
        await json(
          `${connection(projectId)}/verify`,
          "POST",
          githubConnectionMutationSchema.parse(input),
        ),
      ),
    false,
    { openWorldHint: true },
  );
  tool(
    "sticker_add_github_evidence",
    "현재 이슈 revision에 연결된 저장소의 PR 또는 전체 커밋 URL을 근거로 저장합니다. 외부 조회나 이슈 상태 변경은 하지 않습니다.",
    { issueId: id, ...githubEvidenceCreateSchema.shape },
    async ({ issueId, ...input }) =>
      githubEvidenceSchema.parse(
        await json(
          `/api/issues/${e(issueId)}/github-evidence`,
          "POST",
          githubEvidenceCreateSchema.parse(input),
        ),
      ),
  );
  tool(
    "sticker_get_github_evidence_item",
    "정확한 근거 ID의 저장된 확인 결과를 현재 이슈 권한으로 읽습니다. 기존 이슈별 근거 목록 도구도 유지합니다.",
    { evidenceId: id },
    async ({ evidenceId }) =>
      githubEvidenceSchema.parse(await json(evidence(evidenceId))),
    true,
  );
  tool(
    "sticker_remove_github_evidence",
    "현재 근거 revision과 이슈 쓰기 권한을 확인하여 로컬 근거를 제거합니다. GitHub PR이나 커밋은 변경하지 않습니다.",
    { evidenceId: id, ...githubEvidenceMutationSchema.shape },
    async ({ evidenceId, ...input }) =>
      z
        .object({ ok: z.literal(true) })
        .parse(
          await json(
            evidence(evidenceId),
            "DELETE",
            githubEvidenceMutationSchema.parse(input),
          ),
        ),
  );
  tool(
    "sticker_refresh_github_evidence",
    "기존 공급자로 근거를 조회해 스냅샷 또는 오류와 새 revision을 저장합니다. 이슈 종결이나 원격 변경을 수행하지 않습니다.",
    { evidenceId: id, ...githubEvidenceMutationSchema.shape },
    async ({ evidenceId, ...input }) =>
      githubEvidenceSchema.parse(
        await json(
          `${evidence(evidenceId)}/refresh`,
          "POST",
          githubEvidenceMutationSchema.parse(input),
        ),
      ),
    false,
    { openWorldHint: true },
  );
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
