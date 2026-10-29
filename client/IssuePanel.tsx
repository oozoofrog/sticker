import { IssueGithubEvidence } from "./features/github/IssueGithubEvidence.js";
import { IssueResources } from "./features/resources/IssueResources.js";
import { IssueRelations } from "./features/relations/IssueRelations.js";
import { issueDetailSchema } from "../server/response-schemas.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, IssueDetail, Attachment } from "../server/types.js";
import { api, json, errorText } from "./api.js";
import { lockBodyScroll } from "./scroll-lock.js";
import { Icon, StatusPill, Modal, Field, ErrorNotice } from "./components.js";
import { IssueEditor, Confirm } from "./editors.js";
import {
  priorityIcons,
  priorityNames,
  dateText,
  relativeTime,
  bytes,
} from "./format.js";
export default function IssuePanel({
  id,
  data,
  onClose,
  onChanged,
  onOpen,
}: {
  id: string;
  data: Bootstrap;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpen?: (id: string) => void;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [linkModal, setLinkModal] = useState(false);
  const [tab, setTab] = useState<"comments" | "activity">("comments");
  const panel = useRef<HTMLDivElement>(null);
  const reload = useCallback(
    () =>
      api(`/issues/${id}`, undefined, issueDetailSchema).then(
        (next) => {
          setDetail(next);
          setError("");
        },
        (e: unknown) => {
          setError(errorText(e));
        },
      ),
    [id],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const releaseScrollLock = lockBodyScroll(document);
    panel.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (document.querySelector(".modal-backdrop")) return;
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && panel.current) {
        const nodes = Array.from(
          panel.current.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]",
          ),
        );
        if (!nodes.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === panel.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      releaseScrollLock();
      previous?.focus();
    };
  }, [onClose]);
  const changed = async () => {
    await reload();
    await onChanged();
  };
  async function commentSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !comment.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(`/issues/${id}/comments`, {
        method: "POST",
        body: json({ body: comment }),
      });
      setComment("");
      await changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    if (uploading) return;
    if (file.size > 20 * 1024 * 1024) {
      setError("파일은 20 MB 이하로 올려 주세요.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      await api(`/issues/${id}/attachments`, { method: "POST", body: form });
      await changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploading(false);
    }
  }
  const issue = detail?.issue;
  const project = data.projects.find((p) => p.id === issue?.projectId);
  const versionName = (versionId: string | null) =>
    data.versions.find((v) => v.id === versionId)?.name || "지정하지 않음";
  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside
        ref={panel}
        className="issue-panel"
        inert={editing || removing || linkModal}
        role="dialog"
        aria-modal="true"
        aria-label="이슈 상세"
        tabIndex={-1}
      >
        <header className="panel-top">
          <span className="issue-breadcrumb">
            <span
              className="project-dot"
              style={{ background: project?.color }}
            />
            {project?.name || "이슈"}
            <Icon name="chevron" size={13} />
            <strong>{issue?.key || "불러오는 중"}</strong>
          </span>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="상세 닫기"
          >
            <Icon name="close" />
          </button>
        </header>
        <ErrorNotice message={error} />
        {!detail || !issue ? (
          <div className="panel-loading">
            {error ? "이슈를 불러오지 못했어요." : "스티커를 가져오는 중…"}
            {error && (
              <button
                className="button secondary"
                onClick={() => void reload()}
              >
                다시 시도
              </button>
            )}
          </div>
        ) : (
          <div className="panel-content">
            <div className="detail-title-row">
              <StatusPill status={issue.status} />
              <div className="panel-actions">
                <button
                  className="icon-button"
                  onClick={() => void reload()}
                  aria-label="상세 새로고침"
                >
                  <Icon name="refresh" size={16} />
                </button>
                <button
                  className="icon-button"
                  onClick={() => {
                    setEditing(true);
                  }}
                  aria-label="이슈 편집"
                >
                  <Icon name="edit" size={16} />
                </button>
                <button
                  className="icon-button muted-danger"
                  onClick={() => {
                    setRemoving(true);
                  }}
                  aria-label="이슈 삭제"
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
            </div>
            <h2 className="detail-title">{issue.title}</h2>
            <p className="detail-time">
              {dateText(issue.createdAt, true)}에 붙임 ·{" "}
              {relativeTime(issue.updatedAt)} 수정
            </p>
            <div className="detail-properties">
              <div>
                <span>담당자</span>
                <strong>
                  <i className="avatar tiny">
                    {issue.assignee.slice(0, 1) || "–"}
                  </i>
                  {issue.assignee || "미지정"}
                </strong>
              </div>
              <div>
                <span>우선순위</span>
                <strong className={`priority-${issue.priority}`}>
                  {priorityIcons[issue.priority]}{" "}
                  {priorityNames[issue.priority]}
                </strong>
              </div>
              <div>
                <span>목표 버전</span>
                <strong>{versionName(issue.targetVersionId)}</strong>
              </div>
              <div>
                <span>발견 버전</span>
                <strong>{versionName(issue.foundVersionId)}</strong>
              </div>
              <div>
                <span>수정 버전</span>
                <strong>{versionName(issue.fixedVersionId)}</strong>
              </div>
              <div>
                <span>라벨</span>
                <strong className="detail-labels">
                  {issue.labels.length
                    ? issue.labels.map((l) => (
                        <span className="label-tag" key={l}>
                          {l}
                        </span>
                      ))
                    : "없음"}
                </strong>
              </div>
            </div>
            {issue.templateId && issue.templateVersion && (
              <div className="template-provenance">
                <span>생성 템플릿</span>
                <code>
                  {issue.templateId} · v{issue.templateVersion}
                </code>
              </div>
            )}
            {issue.status === "done" && (
              <div className="done-note">
                <strong>소유자 확인 전</strong>
              </div>
            )}
            <section className="detail-section">
              <h3>작업 내용</h3>
              <div
                className={`description-text ${!issue.description ? "muted" : ""}`}
              >
                {issue.description || "설명 없음"}
              </div>
            </section>
            <IssueGithubEvidence
              key={`github-${issue.id}`}
              issue={issue}
              canWrite={data.actor.canWrite}
            />
            <IssueResources
              key={`resources-${issue.id}`}
              issue={issue}
              canWrite={data.actor.canWrite}
              onChanged={changed}
            />
            <IssueRelations
              key={issue.id}
              issue={issue}
              data={data}
              onChanged={changed}
              onOpen={onOpen ?? (() => {})}
            />
            <section className="detail-section">
              <div className="section-heading">
                <h3>
                  첨부 리소스 <span>{detail.attachments.length}</span>
                </h3>
                <div className="resource-actions">
                  <button
                    className="text-button"
                    onClick={() => {
                      setLinkModal(true);
                    }}
                  >
                    <Icon name="link" size={14} />
                    링크 추가
                  </button>
                  <label
                    className={`text-button upload-button ${uploading ? "disabled" : ""}`}
                  >
                    <Icon name="upload" size={14} />
                    {uploading ? "업로드 중…" : "파일 첨부"}
                    <input
                      type="file"
                      aria-label="파일 첨부"
                      disabled={uploading}
                      onChange={(e) => {
                        if (e.target.files?.[0]) void upload(e.target.files[0]);
                        e.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>
              {detail.attachments.length ? (
                <div className="resource-list">
                  {detail.attachments.map((a) => (
                    <AttachmentRow
                      attachment={a}
                      key={a.id}
                      onDelete={async () => {
                        try {
                          await api(`/attachments/${a.id}`, {
                            method: "DELETE",
                          });
                          await changed();
                        } catch (e) {
                          setError(errorText(e));
                        }
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div className="resource-empty">
                  <Icon name="file" size={24} />
                  <span>
                    첨부 자료 없음
                    <small>파일당 20 MB 이하</small>
                  </span>
                </div>
              )}
            </section>
            <section className="detail-section conversation">
              <div className="detail-tabs">
                <button
                  className={tab === "comments" ? "active" : ""}
                  onClick={() => {
                    setTab("comments");
                  }}
                >
                  댓글 <span>{detail.comments.length}</span>
                </button>
                <button
                  className={tab === "activity" ? "active" : ""}
                  onClick={() => {
                    setTab("activity");
                  }}
                >
                  변경 기록 <span>{detail.activity.length}</span>
                </button>
              </div>
              {tab === "comments" ? (
                <>
                  <div className="comment-list">
                    {detail.comments.length ? (
                      detail.comments.map((c) => (
                        <article className="comment" key={c.id}>
                          <div className="avatar small">
                            {c.authorName.slice(0, 1)}
                          </div>
                          <div className="comment-main">
                            <header>
                              <strong>{c.authorName}</strong>
                              <time dateTime={c.createdAt}>
                                {relativeTime(c.createdAt)}
                              </time>
                              <button
                                className="icon-button comment-delete"
                                aria-label={`${c.authorName} 댓글 삭제`}
                                onClick={() => {
                                  void (async () => {
                                    try {
                                      await api(`/comments/${c.id}`, {
                                        method: "DELETE",
                                      });
                                      await changed();
                                    } catch (e) {
                                      setError(errorText(e));
                                    }
                                  })();
                                }}
                              >
                                <Icon name="trash" size={13} />
                              </button>
                            </header>
                            <p>{c.body}</p>
                          </div>
                        </article>
                      ))
                    ) : (
                      <p className="quiet-empty">댓글 없음</p>
                    )}
                  </div>
                  <form
                    className="comment-form"
                    onSubmit={(e) => {
                      void commentSubmit(e);
                    }}
                  >
                    <label className="sr-only" htmlFor="comment-body">
                      댓글 작성
                    </label>
                    <textarea
                      id="comment-body"
                      value={comment}
                      onChange={(e) => {
                        setComment(e.target.value);
                      }}
                      placeholder="생각, 진행 상황, 검증 결과를 남겨 주세요…"
                      rows={3}
                      maxLength={20000}
                    />
                    <footer>
                      <span>모든 기록에는 작성자가 남아요.</span>
                      <button
                        className="button primary small"
                        disabled={busy || !comment.trim()}
                      >
                        {busy ? "저장 중…" : "댓글 남기기"}
                      </button>
                    </footer>
                  </form>
                </>
              ) : (
                <div className="activity-list">
                  {detail.activity.map((a) => (
                    <article key={a.id}>
                      <span className="activity-dot" />
                      <div>
                        <p>
                          <strong>{a.authorName}</strong>{" "}
                          <span>{a.detail || a.action}</span>
                        </p>
                        <time dateTime={a.createdAt}>
                          {dateText(a.createdAt, true)}
                        </time>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </aside>
      {editing && issue && (
        <IssueEditor
          issue={issue}
          data={data}
          onClose={() => {
            setEditing(false);
          }}
          onSaved={async () => {
            setEditing(false);
            await changed();
          }}
        />
      )}
      {removing && (
        <Confirm
          title="이 스티커를 삭제할까요?"
          description="이슈와 댓글, 첨부 리소스 연결이 삭제돼요. 이 작업은 되돌릴 수 없어요."
          onClose={() => {
            setRemoving(false);
          }}
          onConfirm={async () => {
            await api(`/issues/${id}`, { method: "DELETE" });
            await onChanged();
            onClose();
          }}
        />
      )}
      {linkModal && (
        <LinkEditor
          issueId={id}
          onClose={() => {
            setLinkModal(false);
          }}
          onSaved={async () => {
            setLinkModal(false);
            await changed();
          }}
        />
      )}
    </>
  );
}
function AttachmentRow({
  attachment: a,
  onDelete,
}: {
  attachment: Attachment;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="resource-row">
      <span className={`resource-icon ${a.kind}`}>
        <Icon name={a.kind === "link" ? "link" : "file"} size={18} />
      </span>
      <a
        href={
          a.kind === "link"
            ? (a.url ?? undefined)
            : `/api/attachments/${a.id}/file`
        }
        target={a.kind === "link" ? "_blank" : undefined}
        rel="noopener noreferrer"
      >
        <strong>{a.name}</strong>
        <span>
          {a.kind === "link" ? "웹 링크" : bytes(a.size)} · {a.authorName}
        </span>
      </a>
      <button
        className="icon-button"
        aria-label={`${a.name} 첨부 삭제`}
        disabled={busy}
        onClick={() => {
          void (async () => {
            setBusy(true);
            try {
              await onDelete();
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}
function LinkEditor({
  issueId,
  onClose,
  onSaved,
}: {
  issueId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="참고 링크 붙이기" onClose={onClose}>
      <form
        className="editor-form"
        onSubmit={(e) => {
          void (async () => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            try {
              await api(`/issues/${issueId}/links`, {
                method: "POST",
                body: json({ name, url }),
              });
              await onSaved();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <Field label="링크 이름">
          <input
            required
            maxLength={255}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder="디자인 시안, API 문서…"
          />
        </Field>
        <Field label="링크 주소">
          <input
            type="url"
            required
            pattern="https?://.*"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
            placeholder="https://"
          />
        </Field>

        <ErrorNotice message={error} />
        <footer className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            취소
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "저장 중…" : "링크 저장"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
