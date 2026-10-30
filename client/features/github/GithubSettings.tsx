import React, { useState } from "react";
import {
  githubConnectionSchema,
  type GithubConnection,
} from "../../../server/contracts/github.js";
import { Modal, ErrorNotice } from "../../components.js";
import { api, json, errorText } from "../../api.js";
import { useViewResource } from "../views/useViewResource.js";
import { GithubConnectionEditor } from "./GithubConnectionEditor.js";
import { githubErrorNames } from "./GithubEvidenceCard.js";
export function GithubSettings({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const path = `/projects/${projectId}/github`,
    resource = useViewResource(path, githubConnectionSchema);
  const [editing, setEditing] = useState(false),
    [disconnecting, setDisconnecting] = useState<GithubConnection | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const connection = resource.value;
  async function change(
    action: "verify" | "disconnect",
    baseline = connection,
  ) {
    if (!baseline || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await api(
        action === "verify" ? `${path}/verify` : path,
        {
          method: action === "verify" ? "POST" : "DELETE",
          body: json({ revision: baseline.revision, confirm: true }),
        },
        githubConnectionSchema,
      );
      resource.accept(next, path);
      setDisconnecting(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!editing && !disconnecting && (
        <Modal title="GitHub 연결" onClose={onClose}>
          <div className="editor-form github-settings">
            <ErrorNotice message={error || resource.error} />
            {resource.loading && !connection && (
              <div role="status">불러오는 중…</div>
            )}
            {connection && (
              <>
                <strong>
                  {connection.repository
                    ? `${connection.repository.owner}/${connection.repository.name}`
                    : "저장소 미지정"}
                </strong>
                <dl>
                  <div>
                    <dt>조회 범위</dt>
                    <dd>선택 저장소의 PR · 커밋 · CI (GET)</dd>
                  </div>
                  <div>
                    <dt>상태</dt>
                    <dd>{connection.connected ? "연결됨" : "연결 안 됨"}</dd>
                  </div>
                  <div>
                    <dt>조회 공급자</dt>
                    <dd>{connection.providerEnabled ? "활성" : "비활성"}</dd>
                  </div>
                  <div>
                    <dt>연결 주체</dt>
                    <dd>{connection.principalLabel}</dd>
                  </div>
                  <div>
                    <dt>자격증명</dt>
                    <dd>
                      {connection.mode === "public"
                        ? "불필요"
                        : connection.credentialConfigured
                          ? "설정됨"
                          : "설정 없음"}
                    </dd>
                  </div>
                  <div>
                    <dt>토큰 권한 범위</dt>
                    <dd>미검증</dd>
                  </div>
                  <div>
                    <dt>마지막 확인</dt>
                    <dd>
                      {connection.lastVerifiedAt ? (
                        <time dateTime={connection.lastVerifiedAt}>
                          {new Date(connection.lastVerifiedAt).toLocaleString(
                            "ko-KR",
                          )}
                        </time>
                      ) : (
                        "확인 기록 없음"
                      )}
                    </dd>
                  </div>
                </dl>
                {connection.lastErrorCode ? (
                  <div role="status">
                    {githubErrorNames[connection.lastErrorCode]}
                  </div>
                ) : (
                  connection.lastVerifiedAt && (
                    <div role="status">확인 완료</div>
                  )
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(true);
                    }}
                  >
                    저장소 설정
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !connection.connected ||
                      !connection.providerEnabled
                    }
                    onClick={() => {
                      void change("verify");
                    }}
                  >
                    {busy ? "처리 중…" : "연결 확인"}
                  </button>
                  {connection.connected && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setDisconnecting(connection);
                      }}
                    >
                      연결 해제
                    </button>
                  )}
                </div>
              </>
            )}
            <footer className="form-actions">
              <button
                type="button"
                disabled={busy || resource.loading}
                onClick={() => {
                  void resource.refresh();
                }}
              >
                새로고침
              </button>
              <button type="button" onClick={onClose}>
                닫기
              </button>
            </footer>
          </div>
        </Modal>
      )}
      {editing && connection && (
        <GithubConnectionEditor
          connection={connection}
          onReload={async () => {
            const latest = await api(path, undefined, githubConnectionSchema);
            resource.accept(latest, path);
            return latest;
          }}
          onClose={() => {
            setEditing(false);
          }}
          onResolved={(next) => {
            resource.accept(next, path);
            setEditing(false);
          }}
          onConnect={async (input) => {
            const next = await api(
              `${path}/select`,
              { method: "POST", body: json(input) },
              githubConnectionSchema,
            );
            resource.accept(next, path);
            setEditing(false);
          }}
        />
      )}
      {disconnecting && (
        <Modal
          title="GitHub 연결 해제"
          onClose={() => {
            setDisconnecting(null);
          }}
        >
          <div className="editor-form">
            <p className="confirm-description">
              {disconnecting.repository
                ? `${disconnecting.repository.owner}/${disconnecting.repository.name}`
                : "이 프로젝트"}
              의 GitHub 조회를 중단합니다. 저장된 근거는 이전 정보로 남습니다.
            </p>
            <ErrorNotice message={error} />
            <footer className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDisconnecting(null);
                }}
              >
                취소
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void change("disconnect", disconnecting);
                }}
              >
                해제하기
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}
