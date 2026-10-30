import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GithubConnection } from "../../../server/contracts/github.js";
import {
  githubDiscoverySourcesSchema,
  githubDiscoveryPageSchema,
  githubSelectionStatusSchema,
  type GithubDiscoverySources,
  type GithubDiscoveryPage,
  type GithubSelectionConnect,
} from "../../../server/contracts/github-discovery.js";
import { Modal, Field, ErrorNotice } from "../../components.js";
import { api, json, ApiError, errorText } from "../../api.js";
type Selection = GithubDiscoveryPage["repositories"][number];
export function GithubConnectionEditor({
  connection,
  onClose,
  onConnect,
  onReload,
  onResolved,
}: {
  connection: GithubConnection;
  onClose: () => void;
  onConnect: (input: GithubSelectionConnect) => Promise<void>;
  onReload?: () => Promise<GithubConnection>;
  onResolved?: (value: GithubConnection) => void;
}) {
  const path = `/projects/${connection.projectId}/github`;
  const [revision, setRevision] = useState(connection.revision),
    [sources, setSources] = useState<GithubDiscoverySources | null>(null),
    [sourceId, setSourceId] = useState(""),
    [items, setItems] = useState<Selection[]>([]),
    [selectionId, setSelectionId] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [limit, setLimit] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState(false),
    [latest, setLatest] = useState<GithubConnection | null>(null),
    [uncertain, setUncertain] = useState<GithubSelectionConnect | null>(null);
  const initialRevision = useRef(connection.revision);
  const sequence = useRef(0),
    alive = useRef(true),
    controller = useRef<AbortController | null>(null);
  const selected = items.find((item) => item.selectionId === selectionId),
    source = sources?.sources.find((item) => item.id === sourceId);
  const isCurrent = useCallback(
    (ticket: number) => alive.current && ticket === sequence.current,
    [],
  );
  const invalidate = useCallback(() => {
    sequence.current++;
    controller.current?.abort();
  }, []);
  const clearDenied = useCallback((error: unknown) => {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      setLatest(null);
      setSources(null);
      setSourceId("");
      setItems([]);
      setSelectionId("");
      setCursor(null);
      setConfirm(false);
    }
  }, []);
  const loadSources = useCallback(
    async (expected: number) => {
      const ticket = ++sequence.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      await Promise.resolve();
      if (!isCurrent(ticket)) return;
      setLoading(true);
      setError("");
      setSources(null);
      setSourceId("");
      setItems([]);
      setSelectionId("");
      setConfirm(false);
      setCursor(null);
      setLimit(false);
      try {
        const next = await api(
          `${path}/sources`,
          { signal: abort.signal },
          githubDiscoverySourcesSchema,
        );
        if (!isCurrent(ticket)) return;
        if (next.revision !== expected) {
          setReview(true);
          setError("연결이 변경되었습니다. 최신 연결을 확인하세요.");
          return;
        }
        setSources(next);
      } catch (e) {
        if (isCurrent(ticket) && !abort.signal.aborted) setError(errorText(e));
      } finally {
        if (isCurrent(ticket)) setLoading(false);
      }
    },
    [path, isCurrent],
  );
  useEffect(() => {
    alive.current = true;
    queueMicrotask(() => {
      void loadSources(initialRevision.current);
    });
    return () => {
      alive.current = false;
      invalidate();
    };
  }, [loadSources, invalidate]);
  async function loadPage(id: string, nextCursor?: string) {
    const ticket = ++sequence.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError("");
    setConfirm(false);
    setSelectionId("");
    if (!nextCursor) {
      setItems([]);
      setCursor(null);
      setLimit(false);
    }
    setSourceId(id);
    if (!id) {
      setLoading(false);
      return;
    }
    try {
      const value = await api(
        `${path}/repositories`,
        {
          method: "POST",
          body: json({
            sourceId: id,
            ...(nextCursor ? { cursor: nextCursor } : {}),
          }),
          signal: abort.signal,
        },
        githubDiscoveryPageSchema,
      );
      if (!isCurrent(ticket)) return;
      if (value.sourceId !== id || value.revision !== revision)
        throw new Error("저장소 목록이 변경되었습니다. 다시 선택하세요.");
      setItems((old) => {
        const all = nextCursor
          ? [...old, ...value.repositories]
          : value.repositories;
        return all.filter(
          (item, index) =>
            all.findIndex((candidate) => candidate.id === item.id) === index,
        );
      });
      setCursor(value.nextCursor);
      setLimit(value.limitReached);
    } catch (e) {
      if (
        alive.current &&
        ticket === sequence.current &&
        !abort.signal.aborted
      ) {
        clearDenied(e);
        setError(errorText(e));
        setItems([]);
        setCursor(null);
        if (e instanceof ApiError && e.status === 409) setReview(true);
      }
    } finally {
      if (isCurrent(ticket)) setLoading(false);
    }
  }
  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      busy ||
      loading ||
      review ||
      uncertain ||
      !selected ||
      !source ||
      !confirm ||
      selected.disabled
    )
      return;
    const input: GithubSelectionConnect = {
      sourceId,
      selectionId,
      revision,
      confirm: true,
    };
    setBusy(true);
    setError("");
    try {
      await onConnect(input);
    } catch (e) {
      if (!alive.current) return;
      clearDenied(e);
      setError(errorText(e));
      setConfirm(false);
      if (e instanceof ApiError && e.status === 409) setReview(true);
      else setUncertain(input);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function inspectSave() {
    if (!uncertain || busy) return;
    setBusy(true);
    setError("");
    try {
      const status = await api(
        `${path}/selection-status`,
        { method: "POST", body: json(uncertain) },
        githubSelectionStatusSchema,
      );
      if (!alive.current) return;
      if (status.matches) {
        onResolved?.(status.connection);
        setError("선택한 저장소가 연결되어 있습니다.");
      } else {
        setLatest(status.connection);
        setReview(true);
        setUncertain(null);
        setError("현재 연결이 선택 결과와 다릅니다. 최신 상태를 검토하세요.");
      }
    } catch (e) {
      if (alive.current) {
        clearDenied(e);
        setError(errorText(e));
        setReview(true);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="GitHub 저장소 연결"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="editor-form github-connection-editor"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <ErrorNotice message={error} />
        {loading && <div role="status">저장소 목록 확인 중…</div>}
        {sources && !sources.providerEnabled && (
          <div role="status">GitHub 조회 공급자 비활성</div>
        )}
        {sources?.providerEnabled && sources.sources.length === 0 && (
          <div role="status">
            선택 가능한 계정 없음 · 기존 공개 연결 또는 설정된 인증 필요
          </div>
        )}
        {sources && sources.sources.length > 0 && (
          <Field label="조회 주체">
            <select
              value={sourceId}
              disabled={busy || review || !!uncertain}
              onChange={(e) => {
                void loadPage(e.target.value);
              }}
            >
              <option value="">선택하세요</option>
              {sources.sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} ·{" "}
                  {item.mode === "public" ? "인증 없음" : "설정된 인증"}
                </option>
              ))}
            </select>
          </Field>
        )}
        {sourceId && !loading && items.length === 0 && !error && (
          <div role="status">저장소 없음</div>
        )}
        {items.length > 0 && (
          <Field label="저장소">
            <select
              value={selectionId}
              disabled={busy || loading || review || !!uncertain}
              onChange={(e) => {
                setSelectionId(e.target.value);
                setConfirm(false);
              }}
            >
              <option value="">선택하세요</option>
              {items.map((item) => (
                <option
                  key={item.id}
                  value={item.selectionId}
                  disabled={item.disabled}
                >
                  {item.repository.owner}/{item.repository.name} ·{" "}
                  {item.visibility === "private" ? "비공개" : "공개"}
                  {item.archived ? " · 보관됨" : ""}
                  {item.disabled ? " · 이용 불가" : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
        {cursor && (
          <button
            type="button"
            disabled={busy || loading || review || !!uncertain}
            onClick={() => {
              void loadPage(sourceId, cursor);
            }}
          >
            더 보기
          </button>
        )}
        {limit && (
          <div role="status">목록 조회 한도 도달 · 일부 저장소만 표시</div>
        )}
        {selected && (
          <dl>
            <div>
              <dt>저장소</dt>
              <dd>
                {selected.repository.owner}/{selected.repository.name}
              </dd>
            </div>
            <div>
              <dt>조회 방식</dt>
              <dd>
                {source?.mode === "authenticated"
                  ? "설정된 인증"
                  : "공개 조회 · 인증 없음"}
              </dd>
            </div>
            <div>
              <dt>읽기 범위</dt>
              <dd>선택 저장소의 PR · 커밋 · CI (GET)</dd>
            </div>
            <div>
              <dt>토큰 권한</dt>
              <dd>미검증</dd>
            </div>
          </dl>
        )}
        {uncertain && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void inspectSave();
            }}
          >
            저장 결과 확인
          </button>
        )}
        {review && onReload && (
          <section aria-label="연결 충돌 검토">
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => {
                setBusy(true);
                void onReload()
                  .then(
                    (value) => {
                      if (alive.current) setLatest(value);
                    },
                    (e: unknown) => {
                      if (alive.current) {
                        clearDenied(e);
                        setError(errorText(e));
                      }
                    },
                  )
                  .finally(() => {
                    if (alive.current) setBusy(false);
                  });
              }}
            >
              최신 연결 확인
            </button>
            {latest && (
              <>
                <dl>
                  <div>
                    <dt>최신 저장소</dt>
                    <dd>
                      {latest.repository
                        ? `${latest.repository.owner}/${latest.repository.name}`
                        : "미지정"}
                    </dd>
                  </div>
                  <div>
                    <dt>연결 주체</dt>
                    <dd>{latest.principalLabel}</dd>
                  </div>
                  <div>
                    <dt>수정 버전</dt>
                    <dd>{latest.revision}</dd>
                  </div>
                </dl>
                <button
                  type="button"
                  disabled={busy || loading}
                  onClick={() => {
                    setRevision(latest.revision);
                    setReview(false);
                    setUncertain(null);
                    setLatest(null);
                    void loadSources(latest.revision);
                  }}
                >
                  이 버전 기준으로 다시 선택
                </button>
              </>
            )}
          </section>
        )}
        {!review && !uncertain && (
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => {
              void loadSources(revision);
            }}
          >
            목록 새로고침
          </button>
        )}
        <label className="github-confirm">
          <input
            type="checkbox"
            checked={confirm}
            disabled={!selected || busy || loading || review || !!uncertain}
            onChange={(e) => {
              setConfirm(e.target.checked);
            }}
          />
          이 저장소의 읽기 조회 허용
        </label>
        <footer className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="button primary"
            disabled={
              busy || loading || !confirm || !selected || review || !!uncertain
            }
          >
            {busy ? "연결 중…" : "저장소 연결"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
