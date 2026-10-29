import React from "react";
import type {
  GithubEvidence,
  GithubCi,
  GithubErrorCode,
} from "../../../server/contracts/github.js";
const names: Record<GithubCi, string> = {
  success: "성공",
  failure: "실패",
  pending: "대기",
  unknown: "미확인",
};
export const githubErrorNames: Record<GithubErrorCode, string> = {
  PROVIDER_DISABLED: "조회 공급자 비활성",
  CREDENTIAL_MISSING: "설정된 자격증명 없음",
  UNAUTHORIZED: "인증 만료 또는 실패",
  FORBIDDEN: "조회 권한 없음",
  RATE_LIMIT: "GitHub 요청 제한",
  NOT_FOUND: "저장소 또는 근거를 찾을 수 없음",
  NETWORK: "네트워크 확인 실패",
  TIMEOUT: "조회 시간 초과",
  INVALID_RESPONSE: "응답 형식 확인 실패",
  RESPONSE_TOO_LARGE: "응답 크기 제한 초과",
  REPOSITORY_MISMATCH: "저장소 불일치",
  SHA_MISMATCH: "커밋 SHA 불일치",
};
export function GithubEvidenceCard({
  evidence: e,
  busy,
  canWrite = true,
  onRefresh,
  onDelete,
}: {
  evidence: GithubEvidence;
  busy: boolean;
  canWrite?: boolean;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const old =
    e.stale ||
    e.disconnected ||
    !e.snapshot ||
    e.snapshot.stale ||
    e.snapshot.snapshotSha !== e.headSha ||
    !e.snapshot.complete;
  const current = old ? "unknown" : (e.snapshot?.ci ?? "unknown");
  return (
    <article
      className="github-evidence-card"
      aria-label={`${e.repository.owner}/${e.repository.name} ${e.kind === "pr" ? `PR ${String(e.number)}` : "커밋"}`}
    >
      <header>
        <strong>
          {e.repository.owner}/{e.repository.name} ·{" "}
          {e.kind === "pr" ? `PR #${String(e.number)}` : "커밋"}
        </strong>
        <a href={e.url} target="_blank" rel="noopener noreferrer">
          GitHub 원문
        </a>
      </header>
      <span className={`github-ci github-ci-${current}`}>
        현재 CI · {names[current]}
      </span>
      {e.disconnected && <span>연결 해제됨</span>}
      {e.stale && !e.disconnected && <span>이전 정보</span>}
      {e.errorCode && <div role="status">{githubErrorNames[e.errorCode]}</div>}
      <dl>
        <div>
          <dt>확인한 헤드 SHA</dt>
          <dd>
            <code>{e.headSha ?? "미확인"}</code>
          </dd>
        </div>
        {e.snapshot && (
          <>
            <div>
              <dt>검증 SHA</dt>
              <dd>
                <code>{e.snapshot.snapshotSha}</code>
              </dd>
            </div>
            <div>
              <dt>검증 결과</dt>
              <dd>
                {old
                  ? `이전 검증 · ${names[e.snapshot.snapshotCi]}`
                  : names[e.snapshot.snapshotCi]}
              </dd>
            </div>
            <div>
              <dt>수집 범위</dt>
              <dd>
                {e.snapshot.complete ? "전체" : "일부 · 미확인"} · 체크{" "}
                {e.snapshot.checkCount} · 상태 {e.snapshot.statusCount}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>마지막 확인</dt>
          <dd>
            {e.checkedAt ? (
              <time dateTime={e.checkedAt}>
                {new Date(e.checkedAt).toLocaleString("ko-KR")}
              </time>
            ) : (
              "확인 기록 없음"
            )}
          </dd>
        </div>
        {e.lastAttemptAt && e.lastAttemptAt !== e.checkedAt && (
          <div>
            <dt>최근 시도</dt>
            <dd>
              <time dateTime={e.lastAttemptAt}>
                {new Date(e.lastAttemptAt).toLocaleString("ko-KR")}
              </time>
            </dd>
          </div>
        )}
      </dl>
      {canWrite && (
        <footer>
          <button
            type="button"
            disabled={busy || e.disconnected}
            onClick={onRefresh}
          >
            {busy ? "확인 중…" : "다시 확인"}
          </button>
          <button type="button" disabled={busy} onClick={onDelete}>
            근거 삭제
          </button>
        </footer>
      )}
    </article>
  );
}
