import React, { useState } from "react";
import { z } from "zod";
import {
  githubEvidenceSchema,
  githubEvidenceCreateSchema,
  type GithubEvidence,
} from "../../../server/contracts/github.js";
import type { Issue } from "../../../server/types.js";
import { api, json, errorText } from "../../api.js";
import { Modal, Field, ErrorNotice } from "../../components.js";
import { Confirm } from "../../editors.js";
import { useViewResource } from "../views/useViewResource.js";
import { GithubEvidenceCard } from "./GithubEvidenceCard.js";
const listSchema = z.array(githubEvidenceSchema);
export function IssueGithubEvidence({
  issue,
  canWrite,
}: {
  issue: Issue;
  canWrite: boolean;
}) {
  const path = `/issues/${issue.id}/github-evidence`;
  const resource = useViewResource(path, listSchema, true, issue.revision);
  const [adding, setAdding] = useState(false),
    [removing, setRemoving] = useState<GithubEvidence | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  const writable = canWrite && issue.status !== "closed";
  async function refresh(e: GithubEvidence) {
    if (busy) return;
    setBusy(e.id);
    setError("");
    try {
      const next = await api(
        `/github-evidence/${e.id}/refresh`,
        { method: "POST", body: json({ revision: e.revision }) },
        githubEvidenceSchema,
      );
      resource.accept(
        (resource.value ?? []).map((item) =>
          item.id === next.id ? next : item,
        ),
        path,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section
      className="detail-section github-evidence-section"
      aria-label="GitHub 근거"
    >
      <div className="section-heading">
        <h3>
          GitHub 근거 <span>{resource.value?.length ?? 0}</span>
        </h3>
        <div className="resource-actions">
          <button
            type="button"
            disabled={resource.loading || !!busy}
            onClick={() => {
              void resource.refresh();
            }}
          >
            목록 새로고침
          </button>
          {writable && (
            <button
              type="button"
              onClick={() => {
                setAdding(true);
              }}
            >
              근거 추가
            </button>
          )}
        </div>
      </div>
      <ErrorNotice message={error || resource.error} />
      {resource.loading && !resource.value && (
        <div role="status">불러오는 중…</div>
      )}
      {resource.value?.length === 0 && (
        <div className="muted">GitHub 근거 없음</div>
      )}
      {resource.value?.map((e) => (
        <GithubEvidenceCard
          key={e.id}
          evidence={{ ...e, stale: e.stale || !!resource.error || !!error }}
          busy={!!busy}
          canWrite={writable}
          onRefresh={() => {
            void refresh(e);
          }}
          onDelete={() => {
            setRemoving(e);
          }}
        />
      ))}
      {adding && (
        <AddEvidence
          issue={issue}
          onClose={() => {
            setAdding(false);
          }}
          onAdd={async (input) => {
            const next = await api(
              path,
              { method: "POST", body: json(input) },
              githubEvidenceSchema,
            );
            resource.accept(
              [...(resource.value ?? []).filter((e) => e.id !== next.id), next],
              path,
            );
            setAdding(false);
          }}
        />
      )}
      {removing && (
        <Confirm
          title="GitHub 근거 삭제"
          description="이 이슈의 연결 근거만 삭제합니다. GitHub 원본은 유지됩니다."
          onClose={() => {
            setRemoving(null);
          }}
          onConfirm={async () => {
            await api(`/github-evidence/${removing.id}`, {
              method: "DELETE",
              body: json({ revision: removing.revision }),
            });
            resource.accept(
              (resource.value ?? []).filter((e) => e.id !== removing.id),
              path,
            );
          }}
        />
      )}
    </section>
  );
}
function AddEvidence({
  issue,
  onClose,
  onAdd,
}: {
  issue: Issue;
  onClose: () => void;
  onAdd: (input: z.infer<typeof githubEvidenceCreateSchema>) => Promise<void>;
}) {
  const [issueRevision] = useState(issue.revision);
  const [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="GitHub 근거 추가" onClose={onClose}>
      <form
        className="editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const parsed = githubEvidenceCreateSchema.safeParse({
            url: url.trim(),
            issueRevision,
          });
          if (!parsed.success) {
            setError("정확한 GitHub PR 또는 커밋 URL을 입력하세요.");
            return;
          }
          setBusy(true);
          setError("");
          void onAdd(parsed.data)
            .catch((e: unknown) => {
              setError(errorText(e));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <Field label="PR 또는 커밋 URL">
          <input
            type="url"
            value={url}
            required
            onChange={(e) => {
              setUrl(e.target.value);
            }}
          />
        </Field>
        <ErrorNotice message={error} />
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "추가 중…" : "추가"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
