import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
const dom = new JSDOM("<html><body></body></html>", {
  url: "http://localhost/",
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
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
const { render, screen, cleanup } = await import("@testing-library/react");
const { userEvent } = await import("@testing-library/user-event");
import type { GithubEvidence } from "../../server/contracts/github.js";
const sha = "a".repeat(40),
  head = "b".repeat(40);
const evidence: GithubEvidence = {
  id: "e",
  issueId: "i",
  projectId: "p",
  url: "https://github.com/octocat/project/pull/1",
  kind: "pr",
  repository: { owner: "octocat", name: "project" },
  number: 1,
  revision: 1,
  headSha: sha,
  snapshot: {
    headSha: sha,
    snapshotSha: sha,
    ci: "success",
    snapshotCi: "success",
    stale: false,
    complete: true,
    checkCount: 1,
    statusCount: 1,
  },
  checkedAt: "2026-10-28T00:00:00Z",
  lastAttemptAt: "2026-10-28T00:00:00Z",
  stale: false,
  disconnected: false,
  errorCode: null,
  createdBy: "owner",
  createdAt: "2026-10-28T00:00:00Z",
};
void test("GitHub evidence card never attributes old successful CI to a new SHA or disconnected provider", async () => {
  const { GithubEvidenceCard } =
    await import("../../client/features/github/GithubEvidenceCard.js");
  let refreshes = 0;
  const user = userEvent.setup({ document: dom.window.document });
  try {
    const view = render(
      <GithubEvidenceCard
        evidence={evidence}
        busy={false}
        onRefresh={() => {
          refreshes++;
        }}
        onDelete={() => {}}
      />,
    );
    assert.ok(screen.getByText("현재 CI · 성공"));
    assert.equal(
      screen.getByRole("link", { name: "GitHub 원문" }).getAttribute("href"),
      evidence.url,
    );
    view.rerender(
      <GithubEvidenceCard
        evidence={{
          ...evidence,
          headSha: head,
          stale: true,
          errorCode: "NETWORK",
        }}
        busy={false}
        onRefresh={() => {
          refreshes++;
        }}
        onDelete={() => {}}
      />,
    );
    assert.ok(screen.getByText("현재 CI · 미확인"));
    assert.ok(screen.getByText("이전 검증 · 성공"));
    assert.ok(screen.getByText(head));
    assert.ok(screen.getByText(sha));
    await user.click(screen.getByRole("button", { name: "다시 확인" }));
    assert.equal(refreshes, 1);
    view.rerender(
      <GithubEvidenceCard
        evidence={{ ...evidence, disconnected: true, stale: true }}
        busy={false}
        onRefresh={() => {
          refreshes++;
        }}
        onDelete={() => {}}
      />,
    );
    assert.equal(
      screen.getByRole<HTMLButtonElement>("button", { name: "다시 확인" })
        .disabled,
      true,
    );
    assert.ok(screen.getByText("연결 해제됨"));
    assert.ok(screen.getByText("현재 CI · 미확인"));
  } finally {
    cleanup();
  }
});
void test("connection editor requires explicit read consent and preserves repository draft on conflict", async () => {
  const { GithubConnectionEditor } =
    await import("../../client/features/github/GithubConnectionEditor.js");
  const user = userEvent.setup({ document: dom.window.document });
  let calls = 0;
  try {
    render(
      <GithubConnectionEditor
        connection={{
          projectId: "p",
          repository: null,
          mode: "public",
          connected: false,
          revision: 0,
          principalLabel: "공개 조회",
          credentialConfigured: false,
          providerEnabled: false,
          permissionsVerified: false,
          lastVerifiedAt: null,
          lastErrorCode: null,
        }}
        onClose={() => {}}
        onConnect={() => {
          calls++;
          return Promise.reject(new Error("revision conflict"));
        }}
      />,
    );
    await user.type(screen.getByLabelText("저장소 소유자"), "octocat");
    await user.type(screen.getByLabelText("저장소 이름"), "project");
    assert.equal(
      screen.getByRole<HTMLButtonElement>("button", { name: "저장소 연결" })
        .disabled,
      true,
    );
    assert.equal(calls, 0);
    await user.click(screen.getByLabelText("이 저장소의 읽기 조회 허용"));
    await user.click(screen.getByRole("button", { name: "저장소 연결" }));
    await screen.findByText("revision conflict");
    assert.equal(calls, 1);
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("저장소 이름").value,
      "project",
    );
    assert.equal(screen.queryByLabelText("토큰"), null);
  } finally {
    cleanup();
  }
});
void test("GitHub issue workspace uses cached reads only, preserves add drafts on errors and renders confirmed refresh without a following GET", async () => {
  const { IssueGithubEvidence } =
    await import("../../client/features/github/IssueGithubEvidence.js");
  const { sessionHttpFixture } = await import("../session-fixture.js");
  const { waitFor, within } = await import("@testing-library/react");
  let calls = 0;
  const f = await sessionHttpFixture({
    enabled: true,
    client: () => ({
      verify: () => Promise.resolve(),
      inspect: () => {
        calls++;
        assert.ok(evidence.snapshot);
        return Promise.resolve(evidence.snapshot);
      },
    }),
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (typeof input === "string" && input.startsWith("/api"))
      return f.call(
        input.slice(4),
        "owner",
        init?.method ?? "GET",
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
      );
    return original(input, init);
  };
  const user = userEvent.setup({ document: dom.window.document });
  try {
    await f.call(`/projects/${f.project.id}/github`, "owner", "PUT", {
      repository: { owner: "octocat", name: "project" },
      mode: "public",
      revision: 0,
      confirm: true,
    });
    render(<IssueGithubEvidence issue={f.issue} canWrite={true} />);
    await screen.findByText("GitHub 근거 없음");
    assert.equal(calls, 0);
    await user.click(screen.getByRole("button", { name: "근거 추가" }));
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("PR 또는 커밋 URL"),
      "https://github.com/foreign/project/pull/1",
    );
    await user.click(within(dialog).getByRole("button", { name: "추가" }));
    await within(dialog).findByText(
      "연결한 저장소의 근거만 추가할 수 있습니다.",
    );
    assert.equal(
      within(dialog).getByLabelText<HTMLInputElement>("PR 또는 커밋 URL").value,
      "https://github.com/foreign/project/pull/1",
    );
    await user.clear(within(dialog).getByLabelText("PR 또는 커밋 URL"));
    await user.type(
      within(dialog).getByLabelText("PR 또는 커밋 URL"),
      evidence.url,
    );
    await user.click(within(dialog).getByRole("button", { name: "추가" }));
    await waitFor(() => {
      assert.ok(screen.queryByRole("dialog") === null);
    });
    await screen.findByText("현재 CI · 미확인");
    assert.equal(calls, 0);
    await user.click(screen.getByRole("button", { name: "다시 확인" }));
    await screen.findByText("현재 CI · 성공");
    assert.equal(calls, 1);
  } finally {
    cleanup();
    globalThis.fetch = original;
    await f.close();
  }
});
void test("GitHub settings require confirmed connection and explicit disconnect without automatic verification", async () => {
  const { GithubSettings } =
    await import("../../client/features/github/GithubSettings.js");
  const { sessionHttpFixture } = await import("../session-fixture.js");
  const { within } = await import("@testing-library/react");
  let calls = 0;
  const f = await sessionHttpFixture({
    enabled: true,
    client: () => ({
      verify: () => {
        calls++;
        return Promise.resolve();
      },
      inspect: () => Promise.reject(new Error("unused")),
    }),
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) =>
    typeof input === "string" && input.startsWith("/api")
      ? f.call(
          input.slice(4),
          "owner",
          init?.method ?? "GET",
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined,
        )
      : original(input, init);
  const user = userEvent.setup({ document: dom.window.document });
  try {
    render(<GithubSettings projectId={f.project.id} onClose={() => {}} />);
    await screen.findByText("연결 안 됨");
    await user.click(screen.getByRole("button", { name: "저장소 설정" }));
    const editor = screen.getByRole("dialog", { name: "GitHub 저장소 연결" });
    await user.type(within(editor).getByLabelText("저장소 소유자"), "octocat");
    await user.type(within(editor).getByLabelText("저장소 이름"), "project");
    await user.click(
      within(editor).getByLabelText("이 저장소의 읽기 조회 허용"),
    );
    await user.click(
      within(editor).getByRole("button", { name: "저장소 연결" }),
    );
    await screen.findByText("octocat/project");
    assert.equal(calls, 0);
    await user.click(screen.getByRole("button", { name: "연결 확인" }));
    await screen.findByText("확인 완료");
    assert.equal(calls, 1);
    await user.click(screen.getByRole("button", { name: "연결 해제" }));
    const confirmation = screen.getByRole("dialog", {
      name: "GitHub 연결 해제",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "해제하기" }),
    );
    await screen.findByText("연결 안 됨");
    assert.equal(calls, 1);
  } finally {
    cleanup();
    globalThis.fetch = original;
    await f.close();
  }
});
void test("evidence read failure keeps prior identity but never a fresh success; read-only actors cannot mutate", async () => {
  const { IssueGithubEvidence } =
    await import("../../client/features/github/IssueGithubEvidence.js");
  const { sessionHttpFixture } = await import("../session-fixture.js");
  const f = await sessionHttpFixture();
  const original = globalThis.fetch;
  let fail = false;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          fail
            ? { error: "cache unavailable" }
            : [{ ...evidence, issueId: f.issue.id, projectId: f.project.id }],
        ),
        {
          status: fail ? 503 : 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  const user = userEvent.setup({ document: dom.window.document });
  try {
    render(<IssueGithubEvidence issue={f.issue} canWrite={false} />);
    await screen.findByText("현재 CI · 성공");
    assert.ok(screen.queryByRole("button", { name: "근거 추가" }) === null);
    assert.ok(screen.queryByRole("button", { name: "다시 확인" }) === null);
    fail = true;
    await user.click(screen.getByRole("button", { name: "목록 새로고침" }));
    await screen.findByText("cache unavailable");
    await screen.findByText("현재 CI · 미확인");
    assert.ok(screen.getByText("이전 검증 · 성공"));
  } finally {
    cleanup();
    globalThis.fetch = original;
    await f.close();
  }
});
void test("pending settings GET cannot silently rebase a connection draft; conflict review preserves draft and requires renewed consent", async () => {
  const { GithubSettings } =
    await import("../../client/features/github/GithubSettings.js");
  const { sessionHttpFixture, sessionOwner } =
    await import("../session-fixture.js");
  const { act, waitFor } = await import("@testing-library/react");
  const f = await sessionHttpFixture(),
    original = globalThis.fetch;
  const path = `/projects/${f.project.id}/github`;
  f.instance.store.github.connect(sessionOwner, f.project.id, {
    repository: { owner: "octocat", name: "original" },
    mode: "public",
    revision: 0,
    confirm: true,
  });
  let release: () => void = () => {},
    done: () => void = () => {},
    gets = 0;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    finished = new Promise<void>((r) => {
      done = r;
    });
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string" || !input.startsWith("/api"))
      return original(input, init);
    const second =
      input === `/api${path}` &&
      (!init?.method || init.method === "GET") &&
      ++gets === 2;
    if (second) await gate;
    const response = await f.call(
      input.slice(4),
      "owner",
      init?.method ?? "GET",
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined,
    );
    if (second) done();
    return response;
  };
  const user = userEvent.setup({ document: dom.window.document });
  try {
    render(<GithubSettings projectId={f.project.id} onClose={() => {}} />);
    await screen.findByText("octocat/original");
    await user.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => {
      assert.equal(gets, 2);
    });
    await user.click(screen.getByRole("button", { name: "저장소 설정" }));
    await user.clear(screen.getByLabelText("저장소 이름"));
    await user.type(screen.getByLabelText("저장소 이름"), "local-draft");
    f.instance.store.github.connect(sessionOwner, f.project.id, {
      repository: { owner: "octocat", name: "remote-new" },
      mode: "public",
      revision: 1,
      confirm: true,
    });
    await act(async () => {
      release();
      await finished;
    });
    await user.click(screen.getByLabelText("이 저장소의 읽기 조회 허용"));
    await user.click(screen.getByRole("button", { name: "저장소 연결" }));
    await screen.findByText(
      /연결 또는 근거가 변경되었습니다\. 최신 상태를 확인하세요\./,
    );
    assert.equal(
      f.instance.store.github.connection(sessionOwner, f.project.id).repository
        ?.name,
      "remote-new",
    );
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("저장소 이름").value,
      "local-draft",
    );
    await user.click(screen.getByRole("button", { name: "최신 연결 확인" }));
    await screen.findByText("octocat/remote-new");
    await user.click(
      screen.getByRole("button", { name: "이 버전 기준으로 검토" }),
    );
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("저장소 이름").value,
      "local-draft",
    );
    assert.equal(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "저장소 연결",
      }).disabled,
      true,
    );
    await user.click(screen.getByLabelText("이 저장소의 읽기 조회 허용"));
    await user.click(screen.getByRole("button", { name: "저장소 연결" }));
    await screen.findByText("octocat/local-draft");
    assert.equal(
      f.instance.store.github.connection(sessionOwner, f.project.id).revision,
      3,
    );
  } finally {
    release();
    cleanup();
    globalThis.fetch = original;
    await f.close();
  }
});
void test("pending GET cannot retarget an already open disconnect confirmation", async () => {
  const { GithubSettings } =
    await import("../../client/features/github/GithubSettings.js");
  const { sessionHttpFixture, sessionOwner } =
    await import("../session-fixture.js");
  const { act, waitFor, within } = await import("@testing-library/react");
  const f = await sessionHttpFixture(),
    original = globalThis.fetch,
    path = `/projects/${f.project.id}/github`;
  f.instance.store.github.connect(sessionOwner, f.project.id, {
    repository: { owner: "octocat", name: "original" },
    mode: "public",
    revision: 0,
    confirm: true,
  });
  let release: () => void = () => {},
    done: () => void = () => {},
    gets = 0;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    finished = new Promise<void>((r) => {
      done = r;
    });
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string" || !input.startsWith("/api"))
      return original(input, init);
    const second =
      input === `/api${path}` &&
      (!init?.method || init.method === "GET") &&
      ++gets === 2;
    if (second) await gate;
    const response = await f.call(
      input.slice(4),
      "owner",
      init?.method ?? "GET",
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined,
    );
    if (second) done();
    return response;
  };
  const user = userEvent.setup({ document: dom.window.document });
  try {
    render(<GithubSettings projectId={f.project.id} onClose={() => {}} />);
    await screen.findByText("octocat/original");
    await user.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => {
      assert.equal(gets, 2);
    });
    await user.click(screen.getByRole("button", { name: "연결 해제" }));
    const dialog = screen.getByRole("dialog", {
      name: "GitHub 연결 해제",
    });
    f.instance.store.github.connect(sessionOwner, f.project.id, {
      repository: { owner: "octocat", name: "remote-new" },
      mode: "public",
      revision: 1,
      confirm: true,
    });
    await act(async () => {
      release();
      await finished;
    });
    assert.ok(within(dialog).getByText(/octocat\/original/));
    await user.click(within(dialog).getByRole("button", { name: "해제하기" }));
    await within(dialog).findByText(/연결 또는 근거가 변경되었습니다/);
    const current = f.instance.store.github.connection(
      sessionOwner,
      f.project.id,
    );
    assert.equal(current.repository?.name, "remote-new");
    assert.equal(current.connected, true);
    assert.equal(current.revision, 2);
  } finally {
    release();
    cleanup();
    globalThis.fetch = original;
    await f.close();
  }
});
