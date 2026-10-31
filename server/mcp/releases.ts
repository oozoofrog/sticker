import {
  carryoverInputSchema,
  carryoverPreviewSchema,
  carryoverResultSchema,
  changelogInputSchema,
  generateChangelogInputSchema,
  releaseInputSchema,
  releaseResultSchema,
} from "../contracts/releases.js";
import { z } from "zod";
import type { McpFeatureClient } from "./sessions.js";
import { readinessSchema, changelogSchema } from "../contracts/releases.js";
export function registerReleaseTools({ tool, json }: McpFeatureClient) {
  const id = z.string().min(1).max(128);
  const versionId = id;
  tool(
    "sticker_get_version_readiness",
    "버전의 목표·발견·수정 이슈와 미완료/구현 완료/소유자 종결/차단 집계를 읽습니다.",
    { versionId },
    async (a) =>
      readinessSchema.parse(
        await json(
          `/api/versions/${encodeURIComponent(a.versionId)}/readiness`,
        ),
      ),
    true,
  );
  tool(
    "sticker_get_version_changelog",
    "범위 내 버전의 저장된 Markdown 초안과 선택한 이슈를 읽습니다. 출시/외부 발행하지 않습니다.",
    { versionId },
    async (a) =>
      changelogSchema.parse(
        await json(
          `/api/versions/${encodeURIComponent(a.versionId)}/changelog`,
        ),
      ),
    true,
  );
  tool(
    "sticker_preview_version_carryover",
    "이월 가능 여부를 미리 봅니다. 저장하지 않으며 적용하지 않으면 취소입니다.",
    { versionId: id, ...carryoverInputSchema.shape },
    async ({ versionId, ...input }) => {
      const body = carryoverInputSchema.parse(input);
      return carryoverPreviewSchema.parse(
        await json(
          `/api/versions/${encodeURIComponent(versionId)}/carryover/preview`,
          "POST",
          body,
        ),
      );
    },
    true,
  );
  tool(
    "sticker_apply_version_carryover",
    "검토한 이슈를 현재 양쪽 버전·이슈 revision으로 이월합니다. 항목별 충돌과 실패를 확인하세요. 동일 operationId·입력으로만 재시도하세요.",
    { versionId: id, ...carryoverInputSchema.shape },
    async ({ versionId, ...input }) => {
      const body = carryoverInputSchema.parse(input);
      return carryoverResultSchema.parse(
        await json(
          `/api/versions/${encodeURIComponent(versionId)}/carryover`,
          "POST",
          body,
        ),
      );
    },
  );
  tool(
    "sticker_save_version_changelog",
    "버전 Markdown 초안을 저장합니다. 외부 발행하지 않습니다. 불확실하면 현재 초안을 먼저 읽으세요.",
    { versionId: id, ...changelogInputSchema.shape },
    async ({ versionId, ...input }) => {
      const body = changelogInputSchema.parse(input);
      return changelogSchema.parse(
        await json(
          `/api/versions/${encodeURIComponent(versionId)}/changelog`,
          "PUT",
          body,
        ),
      );
    },
  );
  tool(
    "sticker_generate_version_changelog",
    "선택한 이슈로 Markdown 초안을 생성하고 저장합니다. 읽기 전용이 아닙니다. 외부 발행하지 않습니다.",
    { versionId: id, ...generateChangelogInputSchema.shape },
    async ({ versionId, ...input }) => {
      const body = generateChangelogInputSchema.parse(input);
      return changelogSchema.parse(
        await json(
          `/api/versions/${encodeURIComponent(versionId)}/changelog/generate`,
          "POST",
          body,
        ),
      );
    },
  );
  tool(
    "sticker_release_version",
    "소유자가 검토한 revision과 confirm:true로 출시 상태를 전환하고 감사를 남깁니다. 외부 발행하지 않습니다. 동일 operationId·입력으로만 재시도하세요.",
    { versionId: id, ...releaseInputSchema.shape },
    async ({ versionId, ...input }) => {
      const body = releaseInputSchema.parse(input);
      return releaseResultSchema.parse(
        await json(
          `/api/versions/${encodeURIComponent(versionId)}/release`,
          "POST",
          body,
        ),
      );
    },
  );
}
