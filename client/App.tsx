import { AccessControl } from "./features/access/AccessControl.js";
import { accessModeSchema } from "../server/contracts/access.js";
import { useViewResource } from "./features/views/useViewResource.js";
import { ResourceWorkspace } from "./features/resources/ResourceWorkspace.js";
import TemplateWorkspace from "./features/templates/TemplateWorkspace.js";
import { SavedIssueWorkspace } from "./features/views/SavedIssueWorkspace.js";
import { SavedViewNavigation } from "./features/views/SavedViewNavigation.js";
import VersionDetail from "./features/releases/VersionDetail.js";
import { useRelationSummaries } from "./features/relations/RelationSummary.js";
import { bootstrapSchema } from "../server/response-schemas.js";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Bootstrap, Project, Status, Version } from "../server/types.js";
import { api, ApiError, json, errorText } from "./api.js";
import { Icon, Empty, ErrorNotice } from "./components.js";
import {
  ProjectEditor,
  VersionEditor,
  IssueEditor,
  Confirm,
} from "./editors.js";
import IssuePanel from "./IssuePanel.js";
import { versionStateNames, dateText } from "./format.js";
import { readRoute, navigate, subscribeRoute, type Route } from "./router.js";
import AgentSessions from "./features/sessions/AgentSessions.js";
import OwnerInbox from "./features/sessions/OwnerInbox.js";
export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const relations = useRelationSummaries(data);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const access = useViewResource(
    "/access-mode",
    accessModeSchema,
    authenticated,
  );
  const [error, setError] = useState("");
  const [route, setRoute] = useState<Route>(readRoute);
  const [projectEditor, setProjectEditor] = useState<Project | "new" | null>(
    null,
  );
  const [versionEditor, setVersionEditor] = useState<Version | "new" | null>(
    null,
  );
  const [issueEditor, setIssueEditor] = useState<Status | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "project" | "version";
    id: string;
    name: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [reportTime, setReportTime] = useState(Date.now);
  const [viewRefresh, setViewRefresh] = useState(0);
  const viewsChanged = useCallback(() => {
    setViewRefresh((v) => v + 1);
  }, []);
  const selectView = useCallback((view: string, project?: string) => {
    navigate({
      section: "issues",
      view,
      issue: "",
      ...(project ? { project } : {}),
    });
  }, []);
  const refresh = useCallback(
    () =>
      api("/bootstrap", undefined, bootstrapSchema)
        .then(
          (next) => {
            setData(next);
            setAuthenticated(true);
            setError("");
          },
          (e: unknown) => {
            if (e instanceof ApiError && e.status === 401) {
              setAuthenticated(false);
              setData(null);
            } else setError(errorText(e));
          },
        )
        .finally(() => {
          setReportTime(Date.now());
          setLoading(false);
        }),
    [],
  );
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => subscribeRoute(setRoute), []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const tag =
        event.target instanceof HTMLElement ? event.target.tagName : "";
      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(tag) &&
        !document.querySelector("[role=dialog]")
      ) {
        const search = document.querySelector<HTMLInputElement>(
          '[aria-label="이슈 검색"]',
        );
        if (search) {
          event.preventDefault();
          search.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => {
      setNotice("");
    }, 3500);
    return () => {
      clearTimeout(timeout);
    };
  }, [notice]);
  const closeIssue = useCallback(() => {
    navigate({ issue: "" });
  }, []);
  const project = data?.projects.find((p) => p.id === route.project);
  const projectIssues = useMemo(
    () =>
      data?.issues.filter(
        (i) => !route.project || i.projectId === route.project,
      ) || [],
    [data, route.project],
  );
  const currentVersions =
    data?.versions.filter(
      (v) => !route.project || v.projectId === route.project,
    ) || [];
  const newIssue = () => {
    if (!data?.projects.length) {
      setProjectEditor("new");
      setNotice("먼저 첫 프로젝트를 만들어 주세요.");
    } else setIssueEditor("backlog");
  };
  const newVersion = () => {
    if (!data?.projects.length) {
      setProjectEditor("new");
      setNotice("먼저 첫 프로젝트를 만들어 주세요.");
    } else setVersionEditor("new");
  };
  async function logout() {
    try {
      await api("/session", { method: "DELETE" });
      setAuthenticated(false);
      setData(null);
      navigate({ section: "issues", project: "", issue: "" });
    } catch (e) {
      setError(errorText(e));
    }
  }
  if (loading)
    return (
      <div className="loading-screen">
        <Logo />
        <p>작업 공간을 펼치는 중…</p>
      </div>
    );
  if (!authenticated) return <Login onLogin={refresh} error={error} />;
  if (!data)
    return (
      <div className="loading-screen">
        <ErrorNotice message={error} />
        <button className="button primary" onClick={() => void refresh()}>
          다시 시도
        </button>
      </div>
    );
  const counts = {
    active: projectIssues.filter((i) => !["done", "closed"].includes(i.status))
      .length,
    done: projectIssues.filter((i) => i.status === "done").length,
    waiting: projectIssues.filter((i) => i.status === "waiting").length,
  };
  const heading =
    route.section === "resources"
      ? `${project?.name || "프로젝트"} 자료실`
      : route.section === "templates"
        ? `${project?.name || "프로젝트"} 템플릿`
        : route.section === "projects"
          ? "프로젝트"
          : route.section === "versions"
            ? "버전과 릴리스"
            : route.section === "agents"
              ? "에이전트 기록"
              : route.section === "inbox"
                ? "사용자 확인함"
                : project?.name || "내 작업 공간";
  return (
    <div className="app-shell">
      <aside
        className="sidebar"
        inert={
          !!(
            route.issue ||
            route.session ||
            route.request ||
            projectEditor ||
            versionEditor ||
            issueEditor ||
            deleteTarget
          )
        }
      >
        <a className="brand" href="#" aria-label="스티커 홈">
          <Logo />
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">나</span>
          <div>
            <strong>나의 스티커</strong>
            <span>개인 작업 공간</span>
          </div>
          <Icon name="lock" size={13} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="작업 공간 메뉴">
          <button
            className={
              route.section === "issues" && !route.project ? "active" : ""
            }
            onClick={() => {
              navigate({ section: "issues", project: "", issue: "" });
            }}
          >
            <Icon name="grid" />
            <span>내 작업 공간</span>
            <small>{data.issues.length}</small>
          </button>
          <button
            className={route.section === "projects" ? "active" : ""}
            onClick={() => {
              navigate({ section: "projects", project: "", issue: "" });
            }}
          >
            <Icon name="folder" />
            <span>프로젝트</span>
          </button>
          <button
            className={route.section === "versions" ? "active" : ""}
            onClick={() => {
              navigate({ section: "versions", issue: "" });
            }}
          >
            <Icon name="version" />
            <span>버전과 릴리스</span>
          </button>
          <button
            className={route.section === "agents" ? "active" : ""}
            onClick={() => {
              navigate({ section: "agents", issue: "" });
            }}
          >
            <Icon name="agent" />
            <span>에이전트 기록</span>
          </button>
          <button
            className={route.section === "inbox" ? "active" : ""}
            onClick={() => {
              navigate({ section: "inbox", issue: "" });
            }}
          >
            <Icon name="message" />
            <span>사용자 확인함</span>
          </button>
        </nav>
        <div className="project-nav-header">
          <span className="nav-label">MY PROJECTS</span>
          <button
            className="icon-button"
            aria-label="새 프로젝트"
            onClick={() => {
              setProjectEditor("new");
            }}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
        <nav className="project-nav" aria-label="프로젝트 목록">
          {data.projects.map((p) => (
            <button
              className={route.project === p.id ? "active" : ""}
              key={p.id}
              onClick={() => {
                navigate({ section: "issues", project: p.id, issue: "" });
              }}
            >
              <span className="project-dot" style={{ background: p.color }} />
              <span>{p.name}</span>
              <small>
                {
                  data.issues.filter(
                    (i) => i.projectId === p.id && i.status !== "closed",
                  ).length
                }
              </small>
            </button>
          ))}
          {!data.projects.length && (
            <span className="sidebar-empty">아직 붙인 프로젝트가 없어요.</span>
          )}
        </nav>
        <SavedViewNavigation
          projectId={route.project}
          selectedId={route.view}
          refreshToken={viewRefresh}
          onSelect={selectView}
          onChanged={viewsChanged}
        />
        <div className="sidebar-bottom">
          <AccessControl
            className="account-button"
            mode={access.value?.mode ?? null}
            owner={data.actor.role === "owner"}
            onRefresh={() => {
              void access.refresh();
            }}
            onLogout={() => {
              void logout();
            }}
          >
            <span className="avatar small">나</span>
            <span>
              {data.actor.name}
              <small>소유자 · 비공개</small>
            </span>
            <span className="account-exit">로그아웃</span>
            <Icon name="logout" size={17} />
          </AccessControl>
        </div>
      </aside>
      <div
        className="main-shell"
        inert={
          !!(
            route.issue ||
            route.session ||
            route.request ||
            projectEditor ||
            versionEditor ||
            issueEditor ||
            deleteTarget
          )
        }
      >
        <header className="topbar">
          <div className="breadcrumb">
            <span className="mobile-brand">✳</span>
            <span>나의 스티커</span>
            <span>/</span>
            <strong>{heading}</strong>
          </div>
          <div className="topbar-right">
            <span className="private-label">
              <Icon name="lock" size={11} /> PRIVATE
            </span>
            <button
              className="icon-button"
              aria-label="작업 공간 새로고침"
              onClick={() => void refresh()}
            >
              <Icon name="refresh" size={16} />
            </button>
            <span className="avatar small">나</span>
            <AccessControl
              className="text-button mobile-logout"
              mode={access.value?.mode ?? null}
              owner={data.actor.role === "owner"}
              onRefresh={() => {
                void access.refresh();
              }}
              onLogout={() => {
                void logout();
              }}
            >
              로그아웃
            </AccessControl>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>
                {heading}
                {route.section === "issues" && (
                  <span className="title-spark" aria-hidden="true">
                    ✳
                  </span>
                )}
              </h1>
              {route.section === "issues" && project?.description && (
                <p>{project.description}</p>
              )}
            </div>
            <div className="heading-actions">
              {project && ["issues", "versions"].includes(route.section) && (
                <button
                  className="button secondary"
                  onClick={() => {
                    navigate({
                      section: "resources",
                      resource: "",
                      resourceScope:
                        route.section === "versions" ? route.version : "",
                      issue: "",
                    });
                  }}
                >
                  자료실
                </button>
              )}
              {project && route.section === "issues" && (
                <button
                  className="button secondary"
                  onClick={() => {
                    setProjectEditor(project);
                  }}
                  aria-label="프로젝트 편집"
                >
                  <Icon name="edit" size={15} />
                  <span>프로젝트 편집</span>
                </button>
              )}
              {project && route.section === "issues" && (
                <button
                  className="button secondary"
                  onClick={() => {
                    navigate({ section: "templates", template: "", issue: "" });
                  }}
                >
                  템플릿 관리
                </button>
              )}
              {!["templates", "resources"].includes(route.section) && (
                <button
                  className="button primary"
                  onClick={
                    route.section === "projects"
                      ? () => {
                          setProjectEditor("new");
                        }
                      : route.section === "versions"
                        ? newVersion
                        : newIssue
                  }
                >
                  <Icon name="plus" size={17} />
                  {route.section === "projects"
                    ? "새 프로젝트"
                    : route.section === "versions"
                      ? "새 버전"
                      : "새 이슈"}
                </button>
              )}
            </div>
          </div>
          <ErrorNotice message={error} />
          {route.section === "issues" && (
            <>
              <div className="summary-strip">
                <div className="summary-card yellow">
                  <div>
                    <span>미완료 이슈</span>
                    <strong>
                      {counts.active}
                      <small>개의 스티커</small>
                    </strong>
                  </div>
                  <span className="summary-doodle" aria-hidden="true">
                    ↗
                  </span>
                  <span className="peel" />
                </div>
                <div className="summary-card lilac">
                  <div>
                    <span>구현 완료 · 검토할 일</span>
                    <strong>
                      {counts.done}
                      <small>소유자 확인 전</small>
                    </strong>
                  </div>
                  <span className="summary-doodle circle" aria-hidden="true">
                    ✓
                  </span>
                  <span className="peel" />
                </div>
                <div className="summary-card peach">
                  <div>
                    <span>승인을 기다리는 일</span>
                    <strong>
                      {counts.waiting}
                      <small>승인 대기</small>
                    </strong>
                  </div>
                  <span className="summary-doodle" aria-hidden="true">
                    Ⅱ
                  </span>
                  <span className="peel" />
                </div>
              </div>
              <SavedIssueWorkspace
                data={data}
                projectId={route.project}
                viewId={route.view}
                onSelect={selectView}
                onChanged={viewsChanged}
                onNew={(s) => {
                  if (!data.projects.length) setProjectEditor("new");
                  else setIssueEditor(s);
                }}
                relations={relations.summaries}
                relationStale={!!relations.error}
                onOpen={(id) => {
                  navigate({ issue: id });
                }}
              />
              {relations.error && (
                <div role="alert" className="error-notice">
                  관계 요약을 갱신하지 못했어요. 이전 정보일 수 있습니다.{" "}
                  <button
                    className="text-button"
                    onClick={() => {
                      void relations.reload();
                    }}
                  >
                    관계 요약 재시도
                  </button>
                </div>
              )}
            </>
          )}
          {route.section === "resources" && (
            <ResourceWorkspace
              key={route.project}
              projectId={route.project}
              resourceId={route.resource}
              scopeVersion={route.resourceScope}
              contentVersion={route.resourceVersion}
              data={data}
              onSelect={(resource) => {
                navigate({ resource, resourceVersion: "" });
              }}
              onScope={(resourceScope) => {
                navigate({ resourceScope, resource: "", resourceVersion: "" });
              }}
            />
          )}
          {route.section === "templates" && (
            <TemplateWorkspace
              key={route.project}
              projectId={route.project}
              templateId={route.template}
              data={data}
              onSelect={(template) => {
                navigate({ template });
              }}
              onBack={() => {
                navigate({ section: "projects", template: "" });
              }}
            />
          )}
          {route.section === "projects" && (
            <div className="projects-grid">
              {data.projects.map((p) => {
                const issues = data.issues.filter((i) => i.projectId === p.id);
                const complete = issues.filter(
                  (i) => i.status === "closed",
                ).length;
                return (
                  <article className="project-card" key={p.id}>
                    <div className="project-card-top">
                      <span
                        className="project-symbol"
                        style={{ background: p.color }}
                      >
                        {p.key.slice(0, 2)}
                      </span>
                      <span className="project-key">{p.key}</span>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`${p.name} 편집`}
                          onClick={() => {
                            setProjectEditor(p);
                          }}
                        >
                          <Icon name="edit" size={16} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`${p.name} 삭제`}
                          onClick={() => {
                            setDeleteTarget({
                              type: "project",
                              id: p.id,
                              name: p.name,
                            });
                          }}
                        >
                          <Icon name="trash" size={16} />
                        </button>
                      </div>
                    </div>
                    <button
                      className="project-card-link"
                      onClick={() => {
                        navigate({ section: "issues", project: p.id });
                      }}
                    >
                      <h2>{p.name}</h2>
                      <p>{p.description || "설명 없음"}</p>
                    </button>
                    <div className="project-progress">
                      <div>
                        <span>소유자 종료</span>
                        <strong>
                          {complete} / {issues.length}
                        </strong>
                      </div>
                      <span className="progress-track">
                        <span
                          style={{
                            width: `${String(issues.length ? (complete / issues.length) * 100 : 0)}%`,
                            background: p.color,
                          }}
                        />
                      </span>
                    </div>
                    <footer>
                      <button
                        className="text-button"
                        aria-label={`${p.name} 템플릿 관리`}
                        onClick={() => {
                          navigate({
                            section: "templates",
                            project: p.id,
                            template: "",
                            issue: "",
                          });
                        }}
                      >
                        템플릿 관리
                      </button>
                      <span>
                        {
                          data.versions.filter((v) => v.projectId === p.id)
                            .length
                        }
                        개 버전 · {issues.length}개 이슈
                      </span>
                      <button
                        className="text-button"
                        onClick={() => {
                          navigate({ section: "issues", project: p.id });
                        }}
                      >
                        열기 <Icon name="arrow" size={15} />
                      </button>
                    </footer>
                  </article>
                );
              })}
              <button
                className="new-project-card"
                onClick={() => {
                  setProjectEditor("new");
                }}
              >
                <span>
                  <Icon name="plus" size={26} />
                </span>
                <strong>새 프로젝트 붙이기</strong>
              </button>
            </div>
          )}
          {route.section === "versions" &&
            (route.version ? (
              <VersionDetail
                key={route.version}
                id={route.version}
                data={data}
                tab={route.tab}
                bucket={route.bucket}
                onTab={(tab) => {
                  navigate({ tab, bucket: "all" });
                }}
                onBucket={(bucket) => {
                  navigate({ bucket });
                }}
                onOpenIssue={(issue) => {
                  navigate({ issue });
                }}
                onBack={() => {
                  navigate({ version: "", tab: "", bucket: "" });
                }}
                onChanged={refresh}
              />
            ) : (
              <>
                <div className="section-filter">
                  <label>
                    프로젝트
                    <select
                      aria-label="버전 프로젝트 필터"
                      value={route.project}
                      onChange={(e) => {
                        navigate({ project: e.target.value });
                      }}
                    >
                      <option value="">모든 프로젝트</option>
                      {data.projects.map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {currentVersions.length ? (
                  <div className="versions-list">
                    {currentVersions.map((v) => {
                      const p = data.projects.find((p) => p.id === v.projectId);
                      const issues = data.issues.filter(
                        (i) => i.targetVersionId === v.id,
                      );
                      return (
                        <article className="version-card" key={v.id}>
                          <div className={`version-sticker ${v.state}`}>
                            <Icon name="version" size={24} />
                          </div>
                          <div className="version-main">
                            <div className="version-title">
                              <h2>
                                <button
                                  className="version-open"
                                  onClick={() => {
                                    navigate({
                                      version: v.id,
                                      tab: "target",
                                      bucket: "all",
                                      project: v.projectId,
                                    });
                                  }}
                                  aria-label={`${v.name} 버전 상세`}
                                >
                                  {v.name}
                                </button>
                              </h2>
                              <span
                                className={`version-state state-${v.state}`}
                              >
                                {versionStateNames[v.state]}
                              </span>
                            </div>
                            <p>{v.description || "설명 없음"}</p>
                            <div className="version-meta">
                              <span>
                                <i
                                  className="project-dot"
                                  style={{ background: p?.color }}
                                />
                                {p?.name}
                              </span>
                              <span>{dateText(v.dueDate)}</span>
                              <span>목표 이슈 {issues.length}개</span>
                            </div>
                          </div>
                          <div className="row-actions">
                            <button
                              className="icon-button"
                              aria-label={`${v.name} 버전 편집`}
                              onClick={() => {
                                setVersionEditor(v);
                              }}
                            >
                              <Icon name="edit" size={17} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`${v.name} 버전 삭제`}
                              onClick={() => {
                                setDeleteTarget({
                                  type: "version",
                                  id: v.id,
                                  name: v.name,
                                });
                              }}
                            >
                              <Icon name="trash" size={17} />
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <Empty
                    title="다음 릴리스를 위한 한 장"
                    description="버전을 만들고 목표 이슈를 연결해 보세요. 발견한 버전과 수정한 버전도 별도로 남길 수 있어요."
                    action={
                      <button className="button primary" onClick={newVersion}>
                        첫 버전 만들기
                      </button>
                    }
                  />
                )}
              </>
            ))}
          {route.section === "agents" && (
            <AgentSessions
              key={route.project}
              data={data}
              projectId={route.project}
              sessionId={route.session}
              observedAt={reportTime}
            />
          )}
          {route.section === "inbox" && (
            <OwnerInbox
              key={route.project}
              data={data}
              projectId={route.project}
              requestId={route.request}
            />
          )}
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={17} />
          {notice}
        </div>
      )}
      {projectEditor && (
        <ProjectEditor
          project={projectEditor === "new" ? undefined : projectEditor}
          onClose={() => {
            setProjectEditor(null);
          }}
          onSaved={async (p) => {
            setProjectEditor(null);
            await refresh();
            navigate({ section: "issues", project: p.id });
            setNotice("프로젝트를 저장했어요.");
          }}
        />
      )}
      {versionEditor && (
        <VersionEditor
          version={versionEditor === "new" ? undefined : versionEditor}
          data={data}
          projectId={route.project}
          onReview={(version) => {
            setVersionEditor(null);
            navigate({
              section: "versions",
              project: version.projectId,
              version: version.id,
              tab: "target",
              bucket: "all",
              issue: "",
            });
          }}
          onClose={() => {
            setVersionEditor(null);
          }}
          onSaved={async () => {
            setVersionEditor(null);
            await refresh();
            setNotice("버전을 저장했어요.");
          }}
        />
      )}
      {issueEditor && (
        <IssueEditor
          initialStatus={issueEditor}
          data={data}
          projectId={route.project}
          onClose={() => {
            setIssueEditor(null);
          }}
          onSaved={async (issue) => {
            setIssueEditor(null);
            await refresh();
            navigate({ issue: issue.id });
            setNotice("스티커를 붙였어요.");
          }}
        />
      )}
      {route.issue && (
        <IssuePanel
          key={route.issue}
          id={route.issue}
          data={data}
          onClose={closeIssue}
          onChanged={refresh}
          onOpen={(id) => {
            navigate({ issue: id });
          }}
        />
      )}
      {deleteTarget && (
        <Confirm
          title={`${deleteTarget.name} 삭제`}
          description={
            deleteTarget.type === "project"
              ? "프로젝트에 이슈나 버전이 남아 있으면 삭제할 수 없어요. 빈 프로젝트만 삭제돼요."
              : "이 버전의 모든 이슈 연결이 해제돼요. 이슈 자체는 삭제되지 않아요."
          }
          onClose={() => {
            setDeleteTarget(null);
          }}
          onConfirm={async () => {
            await api(
              `/${deleteTarget.type === "project" ? "projects" : "versions"}/${deleteTarget.id}`,
              { method: "DELETE" },
            );
            if (
              deleteTarget.type === "project" &&
              route.project === deleteTarget.id
            )
              navigate({ project: "" });
            await refresh();
            setNotice("삭제했어요.");
          }}
        />
      )}
    </div>
  );
}
function Logo() {
  return (
    <span className="logo">
      <span className="logo-mark">✳</span>
      <strong>
        스티커<span className="logo-period">.</span>
      </strong>
    </span>
  );
}
function Login({
  onLogin,
  error: outerError,
}: {
  onLogin: () => Promise<void>;
  error: string;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <header>
        <Logo />
        <span>
          <Icon name="lock" size={13} /> YOUR PRIVATE WORKSPACE
        </span>
      </header>
      <main className="login-content">
        <div className="login-story">
          <div className="eyebrow">SMALL NOTES. CLEAR DIRECTION.</div>
          <h1>
            생각을 붙이고,
            <br />
            일을 움직여요.
          </h1>

          <div className="login-stickers" aria-hidden="true">
            <div className="login-sticker green">
              <span>IDEA → DONE</span>
              <strong>
                한 장씩,
                <br />
                앞으로.
              </strong>
              <i>↗</i>
            </div>
            <div className="login-sticker purple">
              <span>LESS NOISE.</span>
              <strong>
                더 선명한
                <br />
                다음 할 일.
              </strong>
              <i>✳</i>
            </div>
            <span className="login-scribble">붙여 두면, 잊지 않으니까.</span>
          </div>
        </div>
        <section className="login-card">
          <span className="login-card-icon">
            <Icon name="lock" size={25} />
          </span>
          <h2>나의 작업 공간으로</h2>
          <form
            onSubmit={(e) => {
              void (async () => {
                e.preventDefault();
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  await api("/session", {
                    method: "POST",
                    body: json({ password }),
                  });
                  await onLogin();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            <label className="field">
              <span>소유자 비밀번호</span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
                placeholder="비밀번호를 입력하세요"
              />
            </label>
            <ErrorNotice message={error || outerError} />
            <button className="button primary" disabled={busy}>
              {busy ? "확인하는 중…" : "작업 공간 열기"}
              <Icon name="arrow" size={18} />
            </button>
          </form>
          <div className="login-security">
            <Icon name="lock" size={14} />
            <span>비공개 · 소유자 인증</span>
          </div>
        </section>
      </main>
      <footer>STICKER — FOR YOUR NEXT LITTLE BIG THING.</footer>
    </div>
  );
}
