import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import React from "react";
import { createApp } from "../../server/app.js";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:8787/",
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "Node",
  "MutationObserver",
  "getComputedStyle",
])
  Object.defineProperty(globalThis, name, {
    value: (dom.window as unknown as Record<string, unknown>)[name],
    configurable: true,
    writable: true,
  });
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, waitFor, cleanup, within, act } =
  await import("@testing-library/react");
const { userEvent } = await import("@testing-library/user-event");
const App = (await import("../../client/App.js")).default;
const nativeFetch = globalThis.fetch;
const password = "temporary-dom-test-password";
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "sticker-ui-"));
  const instance = createApp({
    dataDir,
    ownerPassword: password,
    appOrigin: "http://localhost:8787",
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  let cookie = "";
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    if (init.method && !["GET", "HEAD"].includes(init.method))
      headers.set("origin", "http://localhost:8787");
    const r = await nativeFetch(new URL(path, base), { ...init, headers });
    const received = r.headers.get("set-cookie");
    if (received) cookie = received.split(";")[0];
    return r;
  };
  dom.window.history.replaceState({}, "", "/");
  const user = userEvent.setup({ document: dom.window.document });
  render(<App />);
  return {
    instance,
    user,
    async close() {
      cleanup();
      server.closeAllConnections();
      globalThis.fetch = nativeFetch;
      await new Promise<void>((r, j) =>
        server.close((e) => {
          if (e) j(e);
          else r();
        }),
      );
      instance.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    async login() {
      await screen.findByRole("heading", {
        name: "나의 작업 공간으로",
        level: 1,
      });
      await user.type(screen.getByLabelText("소유자 비밀번호"), password);
      await user.click(screen.getByRole("button", { name: "작업 공간 열기" }));
      await screen.findByRole("heading", { name: "내 작업 공간" });
    },
    async click(name: string) {
      await user.click(screen.getAllByRole("button", { name })[0]);
    },
  };
}
void test("DOM + real API: login, project/issue persistence, comments, links, status and cancel", async () => {
  const f = await fixture();
  try {
    await f.login();
    assert.ok(await screen.findByText("프로젝트 없음"));
    await f.click("새 프로젝트");
    await f.user.type(
      screen.getByLabelText("프로젝트 이름"),
      "실제 UI 프로젝트",
    );
    await f.user.type(screen.getByLabelText("프로젝트 키"), "UIT");
    await f.click("프로젝트 만들기");
    await screen.findByRole("heading", { name: "실제 UI 프로젝트" });
    await f.click("새 이슈");
    await f.user.type(
      screen.getByLabelText("이슈 제목"),
      "첫 번째 실제 스티커",
    );
    await f.user.type(
      screen.getByLabelText("설명", {}),
      "클라이언트에서 서버까지 연결됩니다.",
    );
    await f.click("이슈 만들기");
    await screen.findByRole("heading", {
      name: "첫 번째 실제 스티커",
      level: 2,
    });
    await f.user.type(
      screen.getByLabelText("댓글 작성"),
      "검증한 내용을 남겨요.",
    );
    await f.click("댓글 남기기");
    await screen.findByText("검증한 내용을 남겨요.", {});
    await f.click("링크 추가");
    await f.user.type(screen.getByLabelText("링크 이름"), "API 참고");
    await f.user.type(
      screen.getByLabelText("링크 주소"),
      "https://example.com/docs",
    );
    await f.click("링크 저장");
    const resource = await screen.findByRole("link", { name: /API 참고/ });
    assert.equal(resource.getAttribute("href"), "https://example.com/docs");
    assert.equal(resource.getAttribute("rel"), "noopener noreferrer");
    await f.click("이슈 편집");
    await f.user.selectOptions(screen.getByLabelText("상태", {}), "done");
    await f.click("변경 저장");
    const donePanel = screen.getByRole("dialog", { name: "이슈 상세" });
    await within(donePanel).findByText("구현 완료");
    await within(donePanel).findByText("소유자 확인 전");
    await f.click("상세 닫기");
    await waitFor(() => {
      assert.equal(
        screen.queryByRole("dialog", { name: "이슈 상세" }) === null,
        true,
      );
    });
    await f.click("리스트");
    assert.ok(
      await screen.findByRole("button", { name: /UIT-1.*첫 번째 실제 스티커/ }),
    );
    await f.click("새 이슈");
    await f.user.type(screen.getByLabelText("이슈 제목"), "취소한 변경");
    await f.click("취소");
    assert.equal(screen.queryByText("취소한 변경"), null);
    await f.click("보드");
    await f.user.click(
      await screen.findByRole("button", { name: "할 일 이슈 추가" }),
    );
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>("상태").value,
      "ready",
    );
    await f.click("취소");
    const owner = {
      id: "owner",
      name: "소유자",
      role: "owner" as const,
      canWrite: true,
      projectIds: null,
    };
    const saved = f.instance.store.bootstrap(owner);
    assert.equal(saved.issues.length, 1);
    assert.equal(saved.issues[0].status, "done");
    assert.equal(
      saved.issues[0].description,
      "클라이언트에서 서버까지 연결됩니다.",
    );
    const detail = f.instance.store.getIssue(owner, saved.issues[0].id);
    assert.equal(detail.comments.length, 1);
    assert.equal(detail.attachments.length, 1);
    // A remount is a fresh application load and must retain server data and hash routing.
    act(() => {
      dom.window.location.hash = `project=${saved.projects[0].id}&issue=${saved.issues[0].id}`;
    });
    cleanup();
    render(<App />);
    await screen.findByRole("heading", {
      name: "첫 번째 실제 스티커",
      level: 2,
    });
    await screen.findByText("검증한 내용을 남겨요.", {});
  } finally {
    await f.close();
  }
});
void test("DOM + real API: wrong password, Escape focus return, version creation/edit/deletion and truthful report empty state", async () => {
  const f = await fixture();
  try {
    await screen.findByLabelText("소유자 비밀번호");
    await f.user.type(screen.getByLabelText("소유자 비밀번호"), "wrong");
    await f.click("작업 공간 열기");
    assert.ok(await screen.findByRole("alert"));
    await f.user.clear(screen.getByLabelText("소유자 비밀번호"));
    await f.login();
    const trigger = screen.getAllByRole("button", { name: "새 프로젝트" })[0];
    await f.user.click(trigger);
    await screen.findByRole("dialog");
    await f.user.keyboard("{Escape}");
    assert.equal(
      screen.queryByRole("dialog") === null,
      true,
      "dialog should be closed",
    );
    assert.equal(
      document.activeElement === trigger,
      true,
      "Escape must restore focus to the opening button",
    );
    await f.click("새 프로젝트");
    await f.user.type(screen.getByLabelText("프로젝트 이름"), "버전 테스트");
    await f.user.type(screen.getByLabelText("프로젝트 키"), "VER");
    await f.click("프로젝트 만들기");
    await screen.findByRole("heading", { name: "버전 테스트" });
    await f.click("버전과 릴리스");
    await screen.findByRole("heading", { name: "버전과 릴리스" });
    await f.click("새 버전");
    await f.user.type(screen.getByLabelText("버전 이름"), "v1.0");
    await f.user.type(screen.getByLabelText("버전 설명"), "첫 배포");
    await f.click("버전 만들기");
    await screen.findByRole("heading", { name: "v1.0" });
    await f.click("v1.0 버전 편집");
    assert.equal(screen.queryByRole("option", { name: "출시 확정" }), null);
    await f.user.selectOptions(screen.getByLabelText("버전 상태"), "archived");
    await f.click("변경 저장");
    await screen.findByText("보관됨");
    await f.click("v1.0 버전 상세");
    await screen.findByRole("button", { name: "출시 검토" });
    await f.click("출시 검토");
    await screen.findByLabelText(/상태 기록을 확인합니다/);
    await f.user.click(screen.getByLabelText(/상태 기록을 확인합니다/));
    await f.click("출시 상태 확정");
    await screen.findByText("출시 상태가 기록되었습니다.");
    await f.click("취소");
    await f.click("버전 목록");
    await screen.findByText("출시 확정");
    await f.click("v1.0 버전 삭제");
    await f.click("삭제하기");
    await waitFor(() => {
      assert.equal(
        screen.queryByRole("heading", { name: "v1.0" }) === null,
        true,
      );
    });
    await f.click("에이전트 기록");
    await screen.findByText("출처: 에이전트 자기 보고");
    assert.ok(await screen.findByText(/아직 전달된 세션이 없어요/));
    await f.click("로그아웃");
    await screen.findByRole("heading", {
      name: "나의 작업 공간으로",
      level: 1,
    });
  } finally {
    await f.close();
  }
});
void test("DOM + real API: conflicting issue edits preserve drafts and require review before retry", async () => {
  const f = await fixture();
  try {
    const owner = {
      id: "owner",
      name: "소유자",
      role: "owner" as const,
      canWrite: true,
      projectIds: null,
    };
    const project = f.instance.store.createProject(owner, {
      name: "충돌 검증",
      key: "CON",
    });
    const issue = f.instance.store.createIssue(owner, {
      projectId: project.id,
      title: "원래 제목",
    });
    await f.login();
    await f.user.click(
      await screen.findByRole("button", { name: /CON-1.*원래 제목/ }),
    );
    await screen.findByRole("heading", { name: "원래 제목", level: 2 });
    const panel = screen.getByRole("dialog", { name: "이슈 상세" });
    assert.equal(document.body.style.overflow, "hidden");
    const targets = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]",
      ),
    );
    act(() => {
      targets[0].focus();
    });
    await f.user.keyboard("{Shift>}{Tab}{/Shift}");
    assert.equal(
      document.activeElement === targets.at(-1),
      true,
      "Shift+Tab remains in the issue panel",
    );
    await f.user.keyboard("{Tab}");
    assert.equal(
      document.activeElement === targets[0],
      true,
      "Tab loops back to the first panel control",
    );
    const first = within(panel).getByRole("button", { name: "상세 닫기" });
    await f.user.click(first);
    await waitFor(() => {
      assert.equal(
        screen.queryByRole("dialog", { name: "이슈 상세" }) === null,
        true,
      );
    });
    await f.user.click(
      await screen.findByRole("button", { name: /CON-1.*원래 제목/ }),
    );
    await screen.findByRole("heading", { name: "원래 제목", level: 2 });
    await f.click("이슈 편집");
    await f.user.clear(screen.getByLabelText("이슈 제목"));
    await f.user.type(screen.getByLabelText("이슈 제목"), "내 초안 제목");
    f.instance.store.updateIssue(owner, issue.id, {
      revision: issue.revision,
      title: "먼저 저장한 다른 변경",
    });
    await f.click("변경 저장");
    await screen.findByRole("alert");
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("이슈 제목").value,
      "내 초안 제목",
    );
    await f.click("최신 내용 확인");
    await screen.findByText(/먼저 저장한 다른 변경/);
    await f.click("검토 완료 · 초안 유지");
    await f.click("변경 저장");
    await screen.findByRole("heading", { name: "내 초안 제목", level: 2 });
    assert.equal(
      f.instance.store.getIssue(owner, issue.id).issue.title,
      "내 초안 제목",
    );
  } finally {
    await f.close();
  }
});
void test("nested issue/editor teardown restores the original body overflow", async () => {
  for (const initialOverflow of ["", "auto"]) {
    const f = await fixture();
    try {
      document.body.style.overflow = initialOverflow;
      const owner = {
        id: "owner",
        name: "소유자",
        role: "owner" as const,
        canWrite: true,
        projectIds: null,
      };
      const project = f.instance.store.createProject(owner, {
        name: "스크롤 검증",
        key: "SCR",
      });
      f.instance.store.createIssue(owner, {
        projectId: project.id,
        title: "중첩 창",
      });
      await f.login();
      await f.user.click(
        await screen.findByRole("button", { name: /SCR-1.*중첩 창/ }),
      );
      await screen.findByRole("heading", { name: "중첩 창", level: 2 });
      await f.click("이슈 편집");
      await screen.findByLabelText("이슈 제목");
      assert.equal(document.body.style.overflow, "hidden");
      // App unmount models the same nested effect teardown as a session-expiry login transition.
      cleanup();
      assert.equal(document.body.style.overflow, initialOverflow);
    } finally {
      await f.close();
      document.body.style.overflow = "";
    }
  }
});

void test("project navigation clears all filters and keyed issue navigation resets drafts", async () => {
  const f = await fixture();
  try {
    const owner = {
      id: "owner",
      name: "나",
      role: "owner" as const,
      canWrite: true,
      projectIds: null,
    };
    const first = f.instance.store.createProject(owner, {
      name: "첫 공간",
      key: "ONE",
    });
    const second = f.instance.store.createProject(owner, {
      name: "둘째 공간",
      key: "TWO",
    });
    const one = f.instance.store.createIssue(owner, {
      projectId: first.id,
      title: "첫 상세",
      status: "ready",
      assignee: "나",
    });
    const two = f.instance.store.createIssue(owner, {
      projectId: second.id,
      title: "둘째 상세",
      status: "done",
    });
    await f.login();
    await f.user.click(screen.getByRole("button", { name: /^첫 공간/ }));
    await screen.findByRole("heading", { name: "첫 공간" });
    await f.user.type(screen.getByLabelText("이슈 검색"), "첫");
    await f.user.selectOptions(screen.getByLabelText("상태 필터"), "ready");
    await f.user.selectOptions(screen.getByLabelText("우선순위 필터"), "none");
    await f.user.selectOptions(screen.getByLabelText("담당자 필터"), "나");
    await f.user.click(screen.getByRole("button", { name: /^둘째 공간/ }));
    await screen.findByRole("heading", { name: "둘째 공간" });
    for (const label of [
      "이슈 검색",
      "상태 필터",
      "우선순위 필터",
      "담당자 필터",
    ]) {
      assert.equal(
        screen.getByLabelText<HTMLInputElement | HTMLSelectElement>(label)
          .value,
        "",
      );
    }
    assert.ok(await screen.findByRole("button", { name: /TWO-1.*둘째 상세/ }));
    act(() => {
      dom.window.location.hash = `project=${first.id}&issue=${one.id}`;
    });
    await screen.findByRole("heading", { name: "첫 상세", level: 2 });
    await f.user.type(screen.getByLabelText("댓글 작성"), "저장하지 않은 초안");
    act(() => {
      dom.window.location.hash = `project=${second.id}&issue=${two.id}`;
    });
    await screen.findByRole("heading", { name: "둘째 상세", level: 2 });
    assert.equal(
      screen.queryByRole("heading", { name: "첫 상세", level: 2 }),
      null,
    );
    assert.equal(
      screen.getByLabelText<HTMLTextAreaElement>("댓글 작성").value,
      "",
    );
  } finally {
    await f.close();
  }
});

void test("modal rerenders use the latest close callback without moving focus", async () => {
  const { Modal } = await import("../../client/components.js");
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  let previousCalls = 0;
  let latestCalls = 0;
  const view = render(
    <Modal
      title="초점 검증"
      onClose={() => {
        previousCalls++;
      }}
    >
      <input aria-label="초점 입력" />
    </Modal>,
  );
  try {
    const input = screen.getByLabelText("초점 입력");
    act(() => {
      input.focus();
    });
    assert.ok(document.activeElement === input);
    view.rerender(
      <Modal
        title="초점 검증"
        onClose={() => {
          latestCalls++;
        }}
      >
        <input aria-label="초점 입력" />
      </Modal>,
    );
    assert.ok(document.activeElement === input);
    await userEvent
      .setup({ document: dom.window.document })
      .keyboard("{Escape}");
    assert.equal(previousCalls, 0);
    assert.equal(latestCalls, 1);
    view.unmount();
    assert.ok(document.activeElement === trigger);
  } finally {
    cleanup();
    trigger.remove();
  }
});

void test("agent freshness is reevaluated on workspace refresh", async (t) => {
  const f = await fixture();
  const now = Date.now();
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  try {
    const owner = {
      id: "owner",
      name: "나",
      role: "owner" as const,
      canWrite: true,
      projectIds: null,
    };
    const project = f.instance.store.createProject(owner, {
      name: "보고 공간",
      key: "RPT",
    });
    f.instance.store.reportAgent(
      {
        id: "fixture",
        name: "검증 에이전트",
        role: "agent",
        canWrite: true,
        projectIds: null,
      },
      { projectId: project.id, state: "working", message: "자기 보고" },
    );
    await f.login();
    await f.click("에이전트 기록");
    await screen.findByText("↗ 작업 중이라는 자기 보고");
    clock = now + 360_000;
    await f.click("작업 공간 새로고침");
    await screen.findByText("◷ 오래된 자기 보고");
  } finally {
    await f.close();
  }
});

void test("editor awaits save callbacks and reports their rejection in the form", async (t) => {
  const { ProjectEditor } = await import("../../client/editors.js");
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      Response.json({
        id: "fixture",
        key: "CB",
        name: "콜백 검증",
        description: "",
        color: "#d7f45b",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      }),
    ),
  );
  render(
    <ProjectEditor
      onClose={() => {
        assert.fail("Unexpected close");
      }}
      onSaved={() => Promise.reject(new Error("저장 후 갱신 실패"))}
    />,
  );
  try {
    const user = userEvent.setup({ document: dom.window.document });
    await user.type(screen.getByLabelText("프로젝트 이름"), "콜백 검증");
    await user.type(screen.getByLabelText("프로젝트 키"), "CB");
    await user.click(screen.getByRole("button", { name: "프로젝트 만들기" }));
    assert.match(
      (await screen.findByRole("alert")).textContent,
      /저장 후 갱신 실패/,
    );
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("프로젝트 이름").value,
      "콜백 검증",
    );
  } finally {
    cleanup();
  }
});
void test("cached agent reports age when workspace refresh fails", async (t) => {
  const f = await fixture();
  const now = Date.now();
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  try {
    const owner = {
      id: "owner",
      name: "나",
      role: "owner" as const,
      canWrite: true,
      projectIds: null,
    };
    const project = f.instance.store.createProject(owner, {
      name: "오프라인 보고",
      key: "OFF",
    });
    f.instance.store.reportAgent(
      {
        id: "fixture",
        name: "검증 에이전트",
        role: "agent",
        canWrite: true,
        projectIds: null,
      },
      { projectId: project.id, state: "working", message: "캐시된 자기 보고" },
    );
    await f.login();
    await f.click("에이전트 기록");
    await screen.findByText("↗ 작업 중이라는 자기 보고");
    clock = now + 360_000;
    t.mock.method(globalThis, "fetch", () =>
      Promise.reject(new Error("오프라인 새로고침 실패")),
    );
    await f.click("작업 공간 새로고침");
    await screen.findByText("오프라인 새로고침 실패");
    assert.ok(
      screen.queryByText("↗ 작업 중이라는 자기 보고") === null,
      "A failed refresh must not keep an old working report marked recent.",
    );
    assert.ok(screen.getByText("◷ 오래된 자기 보고"));
    assert.ok(screen.getByText("캐시된 자기 보고"));
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

void test("session UI uses separate keyboard cards, deep-linked timeline and retained cached data on refresh failure", async (t) => {
  const f = await fixture();
  try {
    const owner = {
      id: "owner",
      name: "나",
      role: "owner" as const,
      canWrite: true,
      projectIds: null,
    };
    const p = f.instance.store.createProject(owner, {
      key: "SU",
      name: "세션 UI",
    });
    const empty = f.instance.store.createProject(owner, {
      key: "SE",
      name: "빈 기록",
    });
    const issue = f.instance.store.createIssue(owner, {
      projectId: p.id,
      title: "연결 이슈",
    });
    const agent = {
      id: "fixture",
      name: "검증 에이전트",
      role: "agent" as const,
      canWrite: true,
      projectIds: null,
    };
    const body = {
      projectId: p.id,
      issueId: issue.id,
      eventId: "e",
      kind: "report",
      message: "자기 보고",
    };
    const first = f.instance.store.sessions.report(agent, {
      ...body,
      externalSessionId: "parallel-a",
    });
    f.instance.store.sessions.report(agent, {
      ...body,
      externalSessionId: "parallel-b",
    });
    await f.login();
    await f.click("에이전트 기록");
    assert.equal(
      Boolean(screen.queryByText("상태 보고는 실행 증명이 아니에요.")),
      false,
    );
    const card = await screen.findByRole("button", {
      name: "세션 parallel-a 상세",
    });
    assert.ok(screen.getByRole("button", { name: "세션 parallel-b 상세" }));
    card.focus();
    await f.user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "에이전트 세션 상세",
    });
    assert.ok(
      await within(dialog).findByRole("list", { name: "이벤트 타임라인" }),
    );
    assert.ok(within(dialog).getByText("eventId: e"));
    assert.ok(dom.window.location.hash.includes(first.session.id));
    await f.user.keyboard("{Escape}");
    await waitFor(() => {
      assert.equal(document.activeElement, card);
    });
    let fail = true;
    const realFetch = globalThis.fetch;
    t.mock.method(
      globalThis,
      "fetch",
      (input: RequestInfo | URL, init?: RequestInit) => {
        if (fail && input === "/api/sessions")
          return Promise.resolve(
            Response.json({ error: "일시 조회 실패" }, { status: 503 }),
          );
        return realFetch(input, init);
      },
    );
    const stamp = screen.getByText(/마지막 확인:/).textContent;
    await f.click("세션 새로고침");
    await screen.findByText("일시 조회 실패");
    assert.ok(screen.getByRole("button", { name: "세션 parallel-a 상세" }));
    assert.ok(screen.getByText(/마지막 확인:/).textContent.startsWith(stamp));
    fail = false;
    await f.user.selectOptions(
      screen.getByLabelText("세션 프로젝트 필터"),
      empty.id,
    );
    await screen.findByText("아직 전달된 세션이 없어요");
    act(() => {
      dom.window.location.hash = `section=agents&session=${first.session.id}`;
    });
    await screen.findByRole("dialog", { name: "에이전트 세션 상세" });
    assert.ok(await screen.findByRole("list", { name: "이벤트 타임라인" }));
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

void test("owner inbox preserves exact-request draft on real stale revision and refreshes processed state without closing its issue", async (t) => {
  const f = await fixture();
  try {
    const owner = {
      id: "owner",
      name: "나",
      role: "owner" as const,
      canWrite: true,
      projectIds: null,
    };
    const p = f.instance.store.createProject(owner, {
      key: "IN",
      name: "확인함 UI",
    });
    const issue = f.instance.store.createIssue(owner, {
      projectId: p.id,
      title: "닫히지 않을 이슈",
    });
    const agent = {
      id: "fixture",
      name: "검증 에이전트",
      role: "agent" as const,
      canWrite: true,
      projectIds: null,
    };
    const event = f.instance.store.sessions.report(agent, {
      projectId: p.id,
      issueId: issue.id,
      externalSessionId: "inbox-run",
      eventId: "q",
      kind: "request",
      requestKind: "input",
      message: "정확한 질문",
    });
    assert.ok(event.request);
    const id = event.request.id;
    await f.login();
    await f.click("사용자 확인함");
    assert.equal(Boolean(screen.queryByText(/답변·검토 종결은/)), false);
    await f.user.click(
      await screen.findByRole("button", { name: "요청 정확한 질문 확인" }),
    );
    await screen.findByRole("dialog", { name: "요청 확인" });
    const input = await screen.findByLabelText("답변");
    await f.user.type(input, "작성 중인 답변 유지");
    f.instance.store.sessions.respond(owner, id, {
      revision: 1,
      operationId: crypto.randomUUID(),
      body: "다른 창에서 기록한 답변",
    });
    await f.click("답변 기록");
    await screen.findByRole("alert");
    assert.equal(
      screen.getByLabelText<HTMLTextAreaElement>("답변").value,
      "작성 중인 답변 유지",
    );
    await screen.findByText("처리 완료: 답변 기록됨");
    assert.ok(screen.getByText("다른 창에서 기록한 답변"));
    assert.equal(
      screen.getByRole<HTMLButtonElement>("button", { name: "답변 기록" })
        .disabled,
      true,
    );
    await f.user.keyboard("{Escape}");
    await screen.findByText("미처리 요청 0건");
    await waitFor(() => {
      assert.equal(
        document.activeElement,
        screen.getByRole("button", { name: "처리 완료 보기" }),
      );
    });
    await f.click("처리 완료 보기");
    assert.ok(
      await screen.findByRole("button", { name: "요청 정확한 질문 확인" }),
    );
    assert.equal(
      f.instance.store.getIssue(owner, issue.id).issue.status,
      "backlog",
    );
    assert.equal(
      f.instance.store.sessions.getRequest(owner, id).response,
      "다른 창에서 기록한 답변",
    );
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

void test("session pending controls precede long history, show only pending requests and route the exact keyboard-selected request", async () => {
  const f = await fixture();
  try {
    const owner = {
      id: "owner",
      name: "나",
      role: "owner" as const,
      canWrite: true,
      projectIds: null,
    };
    const project = f.instance.store.createProject(owner, {
      key: "PC",
      name: "미처리 요청",
    });
    const issue = f.instance.store.createIssue(owner, {
      projectId: project.id,
      title: "확인 작업",
    });
    const agent = {
      id: "fixture",
      name: "검증 에이전트",
      role: "agent" as const,
      canWrite: true,
      projectIds: null,
    };
    const base = {
      projectId: project.id,
      issueId: issue.id,
      externalSessionId: "pending-controls",
      kind: "request",
      requestKind: "input",
    };
    f.instance.store.sessions.report(agent, {
      projectId: project.id,
      issueId: issue.id,
      externalSessionId: base.externalSessionId,
      eventId: "long",
      kind: "result",
      message: "긴 출력".repeat(1500),
    });
    const a = f.instance.store.sessions.report(agent, {
      ...base,
      eventId: "a",
      message: "입력 A",
    });
    const b = f.instance.store.sessions.report(agent, {
      ...base,
      eventId: "b",
      requestKind: "review",
      message: "검토 B",
    });
    const c = f.instance.store.sessions.report(agent, {
      ...base,
      eventId: "c",
      message: "답변 C",
    });
    const d = f.instance.store.sessions.report(agent, {
      ...base,
      eventId: "d",
      message: "종결 D",
    });
    assert.ok(a.request);
    assert.ok(b.request);
    assert.ok(c.request);
    assert.ok(d.request);
    f.instance.store.sessions.respond(owner, c.request.id, {
      revision: 1,
      operationId: crypto.randomUUID(),
      body: "기록된 답변",
    });
    f.instance.store.sessions.closeRequest(owner, d.request.id, {
      revision: 1,
      operationId: crypto.randomUUID(),
    });
    f.instance.store.sessions.report(agent, {
      projectId: project.id,
      issueId: issue.id,
      externalSessionId: "blocked-only",
      eventId: "blocked",
      kind: "report",
      state: "blocked",
      message: "외부 의존성",
    });
    await f.login();
    await f.click("에이전트 기록");
    await f.user.click(
      await screen.findByRole("button", { name: "세션 pending-controls 상세" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "에이전트 세션 상세",
    });
    const controls = await within(dialog).findByRole("region", {
      name: "미처리 요청",
    });
    assert.equal(within(controls).getAllByRole("button").length, 2);
    assert.ok(
      within(controls).getByRole("button", {
        name: `결과 검토 요청 ${b.request.id} 확인`,
      }),
    );
    const metadata = within(dialog).getByText(/^시작:/);
    assert.ok(
      controls.compareDocumentPosition(metadata) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.equal(
      Boolean(
        within(controls).queryByRole("button", {
          name: `입력 요청 ${c.request.id} 확인`,
        }),
      ),
      false,
    );
    assert.equal(
      Boolean(
        within(controls).queryByRole("button", {
          name: `입력 요청 ${d.request.id} 확인`,
        }),
      ),
      false,
    );
    const timeline = within(dialog).getByRole("list", {
      name: "이벤트 타임라인",
    });
    assert.equal(within(timeline).getAllByRole("button").length, 4);
    assert.ok(
      controls.compareDocumentPosition(timeline) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const action = within(controls).getByRole("button", {
      name: `입력 요청 ${a.request.id} 확인`,
    });
    const descriptionId = action.getAttribute("aria-describedby");
    assert.ok(descriptionId);
    assert.equal(document.getElementById(descriptionId)?.textContent, "입력 A");
    action.focus();
    await f.user.keyboard("{Enter}");
    const requestDialog = await screen.findByRole("dialog", {
      name: "요청 확인",
    });
    assert.ok(await within(requestDialog).findByText("입력 A"));
    assert.equal(
      new URLSearchParams(dom.window.location.hash.slice(1)).get("request"),
      a.request.id,
    );
    assert.equal(
      f.instance.store.sessions.getRequest(owner, a.request.id).status,
      "pending",
    );
    assert.equal(
      f.instance.store.getIssue(owner, issue.id).issue.status,
      "backlog",
    );
    await f.user.keyboard("{Escape}");
    await f.click("에이전트 기록");
    await f.user.click(
      await screen.findByRole("button", { name: "세션 blocked-only 상세" }),
    );
    const blockedDialog = await screen.findByRole("dialog", {
      name: "에이전트 세션 상세",
    });
    await within(blockedDialog).findByText("! 막힘이라는 자기 보고");
    assert.equal(
      Boolean(
        within(blockedDialog).queryByRole("region", { name: "미처리 요청" }),
      ),
      false,
    );
  } finally {
    await f.close();
  }
});
