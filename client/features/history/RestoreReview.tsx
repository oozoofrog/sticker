import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, Issue } from "../../../server/types.js";
import {
  historyDetailSchema,
  restorePreviewSchema,
  HISTORY_FIELDS,
  historyFieldChangeSchema,
  type HistoryField,
  type RestorePreview,
  type RestoreInput,
} from "../../../server/contracts/history.js";
import { selectedHistoryPatch } from "../../../server/features/history-values.js";
import {
  issueDetailSchema,
  restoreResultSchema,
} from "../../../server/response-schemas.js";
import { api, json, ApiError, errorText } from "../../api.js";
import { ErrorNotice, Modal, Field } from "../../components.js";
import { registerRouteGuard } from "../../router.js";
import { useResource } from "../sessions/useResource.js";
import { FetchStamp } from "../sessions/shared.js";
import { FieldDiff } from "./FieldDiff.js";
export function RestoreReview({
  issue,
  changeId,
  label,
  data,
  onClose,
  onRestored,
}: {
  issue: Issue;
  changeId: string;
  label: string;
  data: Bootstrap;
  onClose: () => void;
  onRestored: (value: ReturnType<typeof restoreResultSchema.parse>) => void;
}) {
  const resource = useResource(
    `/issues/${encodeURIComponent(issue.id)}/history/${encodeURIComponent(changeId)}`,
    historyDetailSchema,
  );
  const [fields, setFields] = useState<HistoryField[]>([]),
    [side, setSide] = useState<"before" | "after">("before");
  const [preview, setPreview] = useState<RestorePreview | null>(null),
    [conflict, setConflict] = useState<Issue | null>(null);
  const [reviewing, setReviewing] = useState(false),
    [saving, setSaving] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState("");
  const operation = useRef<RestoreInput | null>(null),
    active = useRef(true),
    reviewRequest = useRef<AbortController | null>(null),
    pending = useRef(false);
  const isMounted = () => active.current;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      reviewRequest.current?.abort();
    };
  }, []);
  const mayLeave = useCallback(
    () =>
      !pending.current &&
      (fields.length === 0 ||
        window.confirm(
          uncertain
            ? "복원 결과를 확인하지 못했습니다. 창을 닫을까요?"
            : "선택한 복원 내용을 버릴까요?",
        )),
    [fields.length, uncertain],
  );
  useEffect(
    () => registerRouteGuard((next) => next.issue === issue.id || mayLeave()),
    [issue.id, mayLeave],
  );
  useEffect(() => {
    if (!fields.length && !saving) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("beforeunload", before);
    };
  }, [fields.length, saving]);
  function close() {
    if (mayLeave()) onClose();
  }
  const historical = resource.data;
  const writable = data.actor.role === "owner" && data.actor.canWrite;
  async function review() {
    if (reviewing || pending.current || !fields.length || !historical) return;
    reviewRequest.current?.abort();
    const controller = new AbortController();
    reviewRequest.current = controller;
    setReviewing(true);
    setError("");
    setPreview(null);
    operation.current = null;
    try {
      const current = await api(
        `/issues/${encodeURIComponent(issue.id)}`,
        { signal: controller.signal },
        issueDetailSchema,
      );
      const result = await api(
        `/issues/${encodeURIComponent(issue.id)}/restore/preview`,
        {
          method: "POST",
          signal: controller.signal,
          body: json({
            changeId,
            fields,
            side,
            revision: current.issue.revision,
          }),
        },
        restorePreviewSchema,
      );
      if (!isMounted() || controller.signal.aborted) return;
      setPreview(result);
      setConflict(null);
    } catch (reason) {
      if (!isMounted() || controller.signal.aborted) return;
      setError(errorText(reason));
    } finally {
      if (isMounted() && !controller.signal.aborted) setReviewing(false);
    }
  }
  async function restore() {
    if (pending.current || (!preview && !operation.current)) return;
    const input =
      operation.current ??
      (preview
        ? {
            changeId,
            side,
            fields,
            revision: preview.revision,
            operationId: crypto.randomUUID(),
          }
        : null);
    if (!input) return;
    operation.current = input;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await api(
        `/issues/${encodeURIComponent(issue.id)}/restore`,
        { method: "POST", body: json(input) },
        restoreResultSchema,
      );
      if (!isMounted()) return;
      operation.current = null;
      setUncertain(false);
      onRestored(result);
    } catch (reason) {
      if (!isMounted()) return;
      setError(errorText(reason));
      // A refused retry cannot establish the outcome of an earlier lost reply.
      if (!uncertain && reason instanceof ApiError && reason.status < 500) {
        operation.current = null;
        setUncertain(false);
        setPreview(null);
        if (reason.code === "REVISION_CONFLICT") {
          try {
            const latest = await api(
              `/issues/${encodeURIComponent(issue.id)}`,
              undefined,
              issueDetailSchema,
            );
            if (isMounted()) setConflict(latest.issue);
          } catch (refreshError) {
            if (isMounted())
              setError(`${errorText(reason)} ${errorText(refreshError)}`);
          }
        }
      } else setUncertain(true);
    } finally {
      pending.current = false;
      if (isMounted()) setSaving(false);
    }
  }
  const currentChanges =
    conflict && historical
      ? (() => {
          const patch = selectedHistoryPatch(historical.changes, fields, side);
          return HISTORY_FIELDS.flatMap((field) =>
            Object.hasOwn(patch, field)
              ? [
                  historyFieldChangeSchema.parse({
                    field,
                    before: conflict[field],
                    after: patch[field],
                  }),
                ]
              : [],
          );
        })()
      : null;
  return (
    <Modal title={`변경 비교 · ${label}`} onClose={close} wide>
      <div className="history-review">
        <ErrorNotice message={resource.error || error} />
        {!historical ? (
          <>
            <p role="status">
              {resource.loading
                ? "변경 불러오는 중…"
                : "변경을 불러오지 못했습니다."}
            </p>
            <button
              className="button secondary"
              onClick={() => {
                void resource.refresh();
              }}
            >
              비교 다시 시도
            </button>
          </>
        ) : (
          <>
            <p className="history-source">
              {historical.authorName} · {historical.createdAt} · {label}
            </p>
            {!historical.comparisonAvailable ? (
              <p>이전·이후 값 없음</p>
            ) : preview || currentChanges ? (
              <>
                <h3>
                  {preview
                    ? `복원 검토 · r${String(preview.revision)}`
                    : `최신 이슈 · r${String(conflict?.revision)}`}
                </h3>
                <FieldDiff
                  changes={preview?.changes ?? currentChanges ?? []}
                  versions={data.versions}
                  beforeLabel="현재"
                  afterLabel="복원 값"
                />
                <div className="history-actions">
                  <button
                    className="button secondary"
                    disabled={saving || uncertain}
                    onClick={() => {
                      setPreview(null);
                      setConflict(null);
                    }}
                  >
                    선택 수정
                  </button>
                  {preview ? (
                    <button
                      className="button primary"
                      disabled={saving}
                      onClick={() => {
                        void restore();
                      }}
                    >
                      {saving
                        ? "복원 중…"
                        : uncertain
                          ? "복원 결과 다시 확인"
                          : "선택 필드 복원"}
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      disabled={reviewing}
                      onClick={() => {
                        void review();
                      }}
                    >
                      {reviewing ? "최신 값 확인 중…" : "최신 값으로 다시 검토"}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                {writable && (
                  <Field label="복원 시점">
                    <select
                      value={side}
                      disabled={reviewing}
                      onChange={(event) => {
                        setSide(
                          event.target.value === "after" ? "after" : "before",
                        );
                        setError("");
                      }}
                    >
                      <option value="before">이전 값</option>
                      <option value="after">이후 값</option>
                    </select>
                  </Field>
                )}
                <FieldDiff
                  changes={historical.changes}
                  versions={data.versions}
                  selected={fields}
                  disabled={reviewing}
                  onSelect={
                    writable
                      ? (field, checked) => {
                          setFields((current) =>
                            checked
                              ? [...current, field]
                              : current.filter((value) => value !== field),
                          );
                          setError("");
                        }
                      : undefined
                  }
                />
                {writable && (
                  <div className="history-actions">
                    <button
                      className="button primary"
                      disabled={reviewing || !fields.length}
                      onClick={() => {
                        void review();
                      }}
                    >
                      {reviewing ? "최신 값 확인 중…" : "복원 검토"}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
        <FetchStamp value={resource.lastFetched} failed={!!resource.error} />
        <div className="history-actions">
          <button
            className="button secondary"
            disabled={saving}
            onClick={() => {
              if (uncertain ? mayLeave() : true) onClose();
            }}
          >
            취소
          </button>
        </div>
      </div>
    </Modal>
  );
}
