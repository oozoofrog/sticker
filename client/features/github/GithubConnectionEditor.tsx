import React, { useState } from "react";
import type { z } from "zod";
import {
  githubConnectSchema,
  type GithubConnection,
} from "../../../server/contracts/github.js";
import { Modal, Field, ErrorNotice } from "../../components.js";
import { ApiError, errorText } from "../../api.js";
export function GithubConnectionEditor({
  connection,
  onClose,
  onConnect,
  onReload,
}: {
  connection: GithubConnection;
  onClose: () => void;
  onReload?: () => Promise<GithubConnection>;
  onConnect: (input: z.infer<typeof githubConnectSchema>) => Promise<void>;
}) {
  const [revision, setRevision] = useState(connection.revision),
    [conflict, setConflict] = useState(false),
    [latest, setLatest] = useState<GithubConnection | null>(null),
    [loadingLatest, setLoadingLatest] = useState(false);
  const [owner, setOwner] = useState(connection.repository?.owner ?? ""),
    [name, setName] = useState(connection.repository?.name ?? ""),
    [mode, setMode] = useState(connection.mode),
    [reference, setReference] = useState(""),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || conflict || loadingLatest) return;
    setError("");
    const parsed = githubConnectSchema.safeParse({
      repository: { owner: owner.trim(), name: name.trim() },
      mode,
      ...(mode === "authenticated" ? { credentialRef: reference.trim() } : {}),
      revision,
      confirm,
    });
    if (!parsed.success) {
      setError("저장소와 조회 동의를 확인하세요.");
      return;
    }
    setBusy(true);
    try {
      await onConnect(parsed.data);
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        setLatest(null);
      }
    } finally {
      setBusy(false);
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
        className="editor-form"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <ErrorNotice message={error} />
        {conflict && onReload && (
          <section className="github-conflict" aria-label="연결 충돌 검토">
            <button
              type="button"
              disabled={loadingLatest || busy}
              onClick={() => {
                setLoadingLatest(true);
                void onReload()
                  .then(
                    (value) => {
                      setLatest(value);
                    },
                    (e: unknown) => {
                      setError(errorText(e));
                    },
                  )
                  .finally(() => {
                    setLoadingLatest(false);
                  });
              }}
            >
              {loadingLatest ? "확인 중…" : "최신 연결 확인"}
            </button>
            {latest && (
              <>
                <dl>
                  <div>
                    <dt>연결 주체</dt>
                    <dd>{latest.principalLabel}</dd>
                  </div>
                  <div>
                    <dt>최신 저장소</dt>
                    <dd>
                      {latest.repository
                        ? `${latest.repository.owner}/${latest.repository.name}`
                        : "미지정"}
                    </dd>
                  </div>
                  <div>
                    <dt>연결 상태</dt>
                    <dd>{latest.connected ? "연결됨" : "연결 안 됨"}</dd>
                  </div>
                  <div>
                    <dt>조회 방식</dt>
                    <dd>
                      {latest.mode === "public" ? "공개 저장소" : "설정된 인증"}
                    </dd>
                  </div>
                  <div>
                    <dt>수정 버전</dt>
                    <dd>{latest.revision}</dd>
                  </div>
                </dl>
                <button
                  type="button"
                  disabled={busy || loadingLatest}
                  onClick={() => {
                    setRevision(latest.revision);
                    setConflict(false);
                    setLatest(null);
                    setConfirm(false);
                    setError("");
                  }}
                >
                  이 버전 기준으로 검토
                </button>
              </>
            )}
          </section>
        )}
        <Field label="저장소 소유자">
          <input
            required
            maxLength={39}
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value);
            }}
          />
        </Field>
        <Field label="저장소 이름">
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </Field>
        <Field label="조회 방식">
          <select
            value={mode}
            onChange={(e) => {
              setMode(
                e.target.value === "authenticated" ? "authenticated" : "public",
              );
            }}
          >
            <option value="public">공개 저장소</option>
            <option value="authenticated">설정된 인증 사용</option>
          </select>
        </Field>
        {mode === "authenticated" && (
          <Field label="자격증명 설정 참조">
            <input
              required
              maxLength={64}
              autoComplete="off"
              value={reference}
              onChange={(e) => {
                setReference(e.target.value);
              }}
            />
          </Field>
        )}
        <label className="github-confirm">
          <input
            type="checkbox"
            checked={confirm}
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
            disabled={busy || !confirm || conflict}
          >
            {busy ? "연결 중…" : "저장소 연결"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
