import { useEffect, useRef, useState } from "react";
import type { Project } from "../../../server/types.js";
import { mcpSettingsSchema } from "../../../server/contracts/mcp-settings.js";
import { ErrorNotice, Field, Modal } from "../../components.js";
import { useResource } from "../sessions/useResource.js";
import { FetchStamp } from "../sessions/shared.js";
import { buildCodexMcpConfig, type CodexMcpConfig } from "./config.js";

export function McpSettings({
  projects,
  onClose,
}: {
  projects: Project[];
  onClose: () => void;
}) {
  const resource = useResource("/mcp/settings", mcpSettingsSchema);
  const [cwd, setCwd] = useState("");
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState("");
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );
  let config: CodexMcpConfig | null = null;
  let pathError = "";
  if (cwd) {
    try {
      config = buildCodexMcpConfig(cwd);
    } catch {
      pathError = "설치 위치에 소스 루트의 절대 경로를 입력하세요.";
    }
  }
  async function copy() {
    if (!config || copying) return;
    const ticket = ++sequence.current;
    const text = config.toml;
    setCopying(true);
    setCopied(false);
    setCopyError("");
    try {
      // DOM typings omit unsupported/insecure contexts where Clipboard is absent.
      const clipboard = (navigator as { clipboard?: Clipboard }).clipboard;
      if (!clipboard) throw new Error("Clipboard unavailable");
      await clipboard.writeText(text);
      if (ticket === sequence.current) setCopied(true);
    } catch {
      if (ticket === sequence.current)
        setCopyError("복사 실패 · 아래 설정을 선택해 복사할 수 있습니다.");
    } finally {
      if (ticket === sequence.current) setCopying(false);
    }
  }
  return (
    <Modal title="MCP 연결" onClose={onClose} wide>
      <div className="mcp-settings">
        <ErrorNotice message={resource.error} />
        <dl className="mcp-connection-facts">
          <div>
            <dt>서버 자격증명</dt>
            <dd>
              {resource.data
                ? resource.data.agents.length
                  ? "설정됨"
                  : "미설정"
                : resource.loading
                  ? "조회 중…"
                  : "확인 실패"}
            </dd>
          </div>
          <div>
            <dt>Codex 연결</dt>
            <dd>확인 안 됨</dd>
          </div>
          <div>
            <dt>설정 적용</dt>
            <dd>수동</dd>
          </div>
          <div>
            <dt>전송</dt>
            <dd>Docker STDIO</dd>
          </div>
          <div>
            <dt>환경 변수</dt>
            <dd>
              <code>STICKER_AGENT_TOKEN</code>
              <span>토큰 환경변수 필요</span>
            </dd>
          </div>
          <div>
            <dt>경로 존재</dt>
            <dd>확인 안 됨</dd>
          </div>
        </dl>
        <div className="mcp-settings-actions">
          <button
            className="button secondary small"
            disabled={resource.loading}
            onClick={() => {
              void resource.refresh();
            }}
          >
            서버 설정 새로고침
          </button>
          <a
            href="https://github.com/oozoofrog/sticker/blob/main/docs/MCP.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            운영 문서
          </a>
        </div>
        <FetchStamp value={resource.lastFetched} failed={!!resource.error} />
        <section aria-label="서버 에이전트 권한">
          <h3>서버 에이전트 권한</h3>
          <p className="mcp-permission-recommendation">권장 권한: 읽기 전용</p>
          {resource.data &&
            (resource.data.agents.length === 0 ? (
              <p>설정된 에이전트 없음</p>
            ) : (
              <ul className="mcp-grants">
                {resource.data.agents.map((agent) => (
                  <li key={agent.id} aria-label={`${agent.name} 권한`}>
                    <div>
                      <strong>{agent.name}</strong>
                      <code>{agent.id}</code>
                      <span>{agent.canWrite ? "읽기·쓰기" : "읽기 전용"}</span>
                    </div>
                    {agent.projectIds === null ? (
                      <p>모든 프로젝트</p>
                    ) : agent.projectIds.length === 0 ? (
                      <p>허용 프로젝트 없음</p>
                    ) : (
                      <ul aria-label="허용 프로젝트">
                        {agent.projectIds.map((id, index) => {
                          const project = projects.find(
                            (value) => value.id === id,
                          );
                          return (
                            <li key={`${id}-${String(index)}`}>
                              {project ? (
                                <>
                                  <span>{project.name}</span>
                                  <code>{id}</code>
                                </>
                              ) : (
                                <span>사용 불가 · {id}</span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            ))}
        </section>
        <section aria-label="Codex 설정 복사" className="mcp-config-builder">
          <h3>Codex 설정</h3>
          <Field label="소스 설치 위치 (cwd)">
            <input
              value={cwd}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={!!pathError}
              onChange={(event) => {
                sequence.current += 1;
                setCwd(event.target.value);
                setCopied(false);
                setCopying(false);
                setCopyError("");
              }}
            />
          </Field>
          <ErrorNotice message={pathError || copyError} />
          <Field label="Codex MCP 설정">
            <textarea
              readOnly
              rows={11}
              wrap="off"
              spellCheck={false}
              value={config?.toml ?? ""}
            />
          </Field>
          <div className="mcp-settings-actions">
            <button
              className="button primary"
              disabled={!config || copying}
              onClick={() => {
                void copy();
              }}
            >
              {copying ? "복사 중…" : "Codex 설정 복사"}
            </button>
            {copied && <span role="status">설정 복사됨</span>}
          </div>
        </section>
        <div className="form-actions">
          <button className="button secondary" onClick={onClose}>
            설정 닫기
          </button>
        </div>
      </div>
    </Modal>
  );
}
