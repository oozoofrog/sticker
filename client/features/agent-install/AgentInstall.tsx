import { useEffect, useRef, useState } from "react";
import type { Project } from "../../../server/types.js";
import { agentInstallCatalogSchema } from "../../../server/contracts/agent-install.js";
import { ErrorNotice, Field, Modal } from "../../components.js";
import { useResource } from "../sessions/useResource.js";
export function AgentInstall({
  projects,
  onClose,
}: {
  projects: Project[];
  onClose: () => void;
}) {
  const resource = useResource("/agent-install", agentInstallCatalogSchema);
  const [agentId, setAgentId] = useState("");
  const [mcp, setMcp] = useState(true),
    [skill, setSkill] = useState(true);
  const [reviewed, setReviewed] = useState(false),
    [pending, setPending] = useState(false);
  const [error, setError] = useState(""),
    [requested, setRequested] = useState(false);
  const sequence = useRef(0),
    controller = useRef<AbortController | null>(null),
    objectUrl = useRef<string | null>(null);
  function invalidate() {
    sequence.current++;
    controller.current?.abort();
    controller.current = null;
    setPending(false);
    setRequested(false);
    setReviewed(false);
    setError("");
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  }
  useEffect(
    () => () => {
      sequence.current++;
      controller.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  const catalog = resource.data,
    agent = catalog?.agents.find((item) => item.id === agentId);
  async function prepare() {
    if (!catalog || pending || !reviewed || (!mcp && !skill) || (mcp && !agent))
      return;
    const ticket = ++sequence.current,
      abort = new AbortController();
    controller.current = abort;
    setPending(true);
    setError("");
    setRequested(false);
    try {
      const response = await fetch("/api/agent-install/bundle", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          previewHash: catalog.previewHash,
          agentId: mcp ? agentId : null,
          mcp,
          skill,
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "설정이 바뀌었습니다. 새로고침 후 다시 검토하세요."
            : "설치 파일을 준비하지 못했습니다.",
        );
      const length = Number(response.headers.get("content-length"));
      if (
        response.headers.get("content-type")?.split(";")[0] !==
          "application/zip" ||
        !Number.isInteger(length) ||
        length < 22 ||
        length > 2 * 1024 * 1024
      )
        throw new Error("설치 파일 형식이 올바르지 않습니다.");
      const bytes = await response.arrayBuffer();
      if (
        bytes.byteLength !== length ||
        new DataView(bytes).getUint32(0, true) !== 0x04034b50
      )
        throw new Error("설치 파일을 확인하지 못했습니다.");
      if (sequence.current !== ticket) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/zip" }),
      );
      objectUrl.current = url;
      const link = document.createElement("a");
      link.href = url;
      link.download = "sticker-agent-install-1.0.0.zip";
      document.body.append(link);
      link.click();
      link.remove();
      setRequested(true);
    } catch (caught) {
      if (sequence.current === ticket)
        setError(
          caught instanceof Error ? caught.message : "설치 파일 준비 실패",
        );
    } finally {
      if (sequence.current === ticket) {
        setPending(false);
        controller.current = null;
      }
    }
  }
  return (
    <Modal title="에이전트 설치" onClose={onClose} wide>
      <div className="mcp-settings agent-install">
        <ErrorNotice message={resource.error || error} />
        <dl className="agent-install-targets">
          <div>
            <dt>대상</dt>
            <dd>Codex Mac</dd>
          </div>
          <div>
            <dt>설치 위치</dt>
            <dd>
              사용자 <span>로컬 실행 시 선택</span>
            </dd>
          </div>
        </dl>
        <div className="agent-install-options">
          <label className="agent-install-choice">
            <input
              type="checkbox"
              checked={mcp}
              onChange={(event) => {
                invalidate();
                setMcp(event.target.checked);
              }}
            />
            <span>MCP</span>
          </label>
          <label className="agent-install-choice">
            <input
              type="checkbox"
              checked={skill}
              onChange={(event) => {
                invalidate();
                setSkill(event.target.checked);
              }}
            />
            <span>Sticker 스킬</span>
          </label>
        </div>
        {mcp && (
          <Field label="기존 에이전트 권한">
            <select
              aria-label="기존 에이전트 권한"
              value={agentId}
              onChange={(event) => {
                invalidate();
                setAgentId(event.target.value);
              }}
            >
              <option value="">선택</option>
              {catalog?.agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {agent && mcp && (
          <dl className="mcp-connection-facts">
            <div>
              <dt>서버 권한</dt>
              <dd>{agent.canWrite ? "읽기·쓰기" : "읽기 전용"}</dd>
            </div>
            <div>
              <dt>프로젝트 범위</dt>
              <dd>
                {agent.projectIds === null
                  ? "전체 프로젝트"
                  : agent.projectIds.length
                    ? agent.projectIds
                        .map(
                          (id) =>
                            projects.find((project) => project.id === id)
                              ?.name ?? `미확인 (${id})`,
                        )
                        .join(", ")
                    : "없음"}
              </dd>
            </div>
            <div>
              <dt>선택 에이전트와 로컬 연결</dt>
              <dd>일치 미확인</dd>
            </div>
          </dl>
        )}
        {catalog && (
          <>
            <details>
              <summary>변경 계획 · {catalog.version}</summary>
              <ul>
                {mcp && (
                  <>
                    <li>기존 sticker MCP: 유지·재사용</li>
                    <li>새 MCP: 로컬에서 승인된 실행 파일 선택</li>
                    <li>
                      새 항목 활성 도구: 읽기 {catalog.readTools.length}개
                    </li>
                  </>
                )}
                {skill && (
                  <li>
                    {catalog.skill.name} · {catalog.skill.version} · 명시 호출
                  </li>
                )}
              </ul>
              {mcp && <pre>{catalog.readTools.join("\n")}</pre>}
            </details>
            {skill && (
              <details>
                <summary>스킬 내용 · {catalog.skill.version}</summary>
                <pre>{catalog.skill.content}</pre>
                <code>{catalog.skill.sha256}</code>
              </details>
            )}
          </>
        )}
        <label className="agent-install-choice">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(event) => {
              setReviewed(event.target.checked);
            }}
            disabled={!catalog || pending}
          />
          <span>변경 계획 확인</span>
        </label>
        <dl className="mcp-connection-facts">
          <div>
            <dt>설치 파일</dt>
            <dd role="status">
              {pending ? "준비 중…" : requested ? "다운로드 요청됨" : "준비 전"}
            </dd>
          </div>
          <div>
            <dt>로컬 적용</dt>
            <dd>명시 실행 필요 · 미확인</dd>
          </div>
          <div>
            <dt>MCP 초기화·도구 발견</dt>
            <dd>미확인</dd>
          </div>
          <div>
            <dt>API 권한·기존 GUI 반영</dt>
            <dd>미확인</dd>
          </div>
        </dl>
        <div className="mcp-settings-actions">
          <button
            className="button secondary"
            onClick={() => {
              invalidate();
              void resource.refresh();
            }}
            disabled={pending}
          >
            새로고침
          </button>
          <button
            className="button primary"
            disabled={
              !catalog ||
              pending ||
              !reviewed ||
              (!mcp && !skill) ||
              (mcp && !agent)
            }
            onClick={() => {
              void prepare();
            }}
          >
            설치 파일 준비
          </button>
          <button className="button secondary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </Modal>
  );
}
