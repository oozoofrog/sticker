import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Activity, Bootstrap, Issue } from "../../../server/types.js";
import {
  historyListSchema,
  historySummarySchema,
} from "../../../server/contracts/history.js";
import { ErrorNotice } from "../../components.js";
import { dateText } from "../../format.js";
import { useResource } from "../sessions/useResource.js";
import { FetchStamp } from "../sessions/shared.js";
import { RestoreReview } from "./RestoreReview.js";
const actions: Record<string, string> = {
  created: "이슈 생성",
  updated: "이슈 수정",
  restored: "선택 필드 복원",
  carryover: "목표 버전 이월",
  version_removed: "버전 삭제",
  relation_added: "관계 추가",
  relation_removed: "관계 해제",
  relation_target_deleted: "관계 대상 삭제",
  resource_linked: "자료 연결",
  resource_unlinked: "자료 연결 해제",
};
export function IssueHistory({
  issue,
  data,
  activity,
  onRestored,
  onModalChange,
}: {
  issue: Issue;
  data: Bootstrap;
  activity: Activity[];
  onRestored: (issue: Issue) => void;
  onModalChange?: (open: boolean) => void;
}) {
  const resource = useResource(
    `/issues/${encodeURIComponent(issue.id)}/history`,
    historyListSchema,
  );
  const [selected, setSelected] = useState<{
    id: string;
    label: string;
  } | null>(null);
  useEffect(
    () => () => {
      onModalChange?.(false);
    },
    [onModalChange],
  );
  function close() {
    onModalChange?.(false);
    setSelected(null);
  }
  return (
    <section className="issue-history" aria-label="변경 기록">
      <div className="history-toolbar">
        <h3>변경 기록</h3>
        <button
          className="text-button"
          onClick={() => {
            void resource.refresh();
          }}
        >
          이력 새로고침
        </button>
      </div>
      <ErrorNotice message={resource.error} />
      <FetchStamp value={resource.lastFetched} failed={!!resource.error} />
      {!resource.data ? (
        <p role="status">
          {resource.loading
            ? "이력 불러오는 중…"
            : "이력을 불러오지 못했습니다."}
        </p>
      ) : resource.data.length === 0 ? (
        <p>변경 기록 없음</p>
      ) : (
        <div className="activity-list">
          {resource.data.map((entry) => {
            const label = `r${String(entry.revisionBefore)} → r${String(entry.revisionAfter)}`;
            return (
              <article key={entry.id}>
                <span className="activity-dot" />
                <div>
                  <p>
                    <strong>{entry.authorName}</strong>{" "}
                    <span>
                      {activity.find((value) => value.id === entry.id)
                        ?.detail ||
                        actions[entry.action] ||
                        entry.action}
                    </span>
                  </p>
                  <time dateTime={entry.createdAt}>
                    {dateText(entry.createdAt, true)}
                  </time>
                  {entry.comparisonAvailable ? (
                    <button
                      className="text-button"
                      onClick={() => {
                        onModalChange?.(true);
                        setSelected({ id: entry.id, label });
                      }}
                    >
                      {label} 비교
                    </button>
                  ) : (
                    <span className="history-unavailable">
                      {entry.unavailableReason === "creation"
                        ? `생성 r${String(entry.revisionAfter)}`
                        : entry.unavailableReason === "revision_only"
                          ? `r${String(entry.revisionAfter)} · 필드 변경 없음`
                          : entry.unavailableReason === "unchanged"
                            ? `r${String(entry.revisionAfter)} · 값 변경 없음`
                            : "이전 값 없음"}
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {selected &&
        createPortal(
          <RestoreReview
            key={selected.id}
            issue={issue}
            changeId={selected.id}
            label={selected.label}
            data={data}
            onClose={close}
            onRestored={(result) => {
              const summary = historySummarySchema.parse(
                Object.fromEntries(
                  Object.entries(result.change).filter(
                    ([key]) => key !== "changes",
                  ),
                ),
              );
              resource.accept([
                summary,
                ...(resource.data ?? []).filter(
                  (entry) => entry.id !== summary.id,
                ),
              ]);
              void resource.refresh();
              onRestored(result.issue);
              close();
            }}
          />,
          document.body,
        )}
    </section>
  );
}
