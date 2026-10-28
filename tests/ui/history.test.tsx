import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { sessionHttpFixture, sessionOwner } from "../session-fixture.js";
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
const { render, screen, cleanup, waitFor, within, act } =
  await import("@testing-library/react");
const { userEvent } = await import("@testing-library/user-event");
const nativeFetch = globalThis.fetch;
import IssuePanel from "../../client/IssuePanel.js";
import { FieldDiff } from "../../client/features/history/FieldDiff.js";
import { IssueHistory } from "../../client/features/history/IssueHistory.js";
import { navigate, subscribeRoute } from "../../client/router.js";
import type { Issue } from "../../server/types.js";
async function setup() {
  const f = await sessionHttpFixture(),
    user = userEvent.setup({ document: dom.window.document });
  const login = await nativeFetch(`${f.base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "disposable-session-owner-password" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const requests: { path: string; method: string; body: string | null }[] = [];
  let holdNextIssueRead: {
    ready: () => void;
    pause: Promise<void>;
    fail: boolean;
  } | null = null;
  let offline = false,
    loseRestore = false,
    denyNextRestore = false,
    failReads = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      f.base,
    );
    const method = init.method ?? "GET";
    requests.push({
      path: url.pathname,
      method,
      body: typeof init.body === "string" ? init.body : null,
    });
    if (offline || (failReads && method === "GET"))
      throw new Error("offline history fixture");
    const held =
      method === "GET" && url.pathname === `/api/issues/${f.issue.id}`
        ? holdNextIssueRead
        : null;
    if (held) holdNextIssueRead = null;
    const denyRestore =
      denyNextRestore && url.pathname.endsWith("/restore") && method === "POST";
    if (denyRestore) denyNextRestore = false;
    const response = await nativeFetch(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        ...(denyRestore
          ? { authorization: `Bearer ${f.tokens.agent}` }
          : { cookie }),
        origin: "http://localhost:8787",
      },
    });
    if (held) {
      await response.clone().text();
      held.ready();
      await held.pause;
      if (held.fail) throw new Error("older detail failure");
    }
    if (loseRestore && url.pathname.endsWith("/restore") && method === "POST") {
      loseRestore = false;
      throw new Error("lost restore response");
    }
    return response;
  };
  const edited = f.instance.store.updateIssue(sessionOwner, f.issue.id, {
    revision: 1,
    title: "새 제목",
    description: "새 본문",
  });
  const data = f.instance.store.bootstrap(sessionOwner);
  let confirmed: Issue | null = null;
  const show = () =>
    render(
      <IssueHistory
        issue={edited}
        data={data}
        activity={f.instance.store.getIssue(sessionOwner, edited.id).activity}
        onRestored={(issue) => {
          confirmed = issue;
        }}
      />,
    );
  return {
    f,
    user,
    edited,
    data,
    requests,
    show,
    holdIssueRead(fail = false) {
      let release = () => {};
      let arrived = () => {};
      const pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      holdNextIssueRead = { ready: arrived, pause, fail };
      return { release, ready };
    },
    confirmed: () => confirmed,
    offline: (value: boolean) => {
      offline = value;
    },
    failReads: (value: boolean) => {
      failReads = value;
    },
    loseRestore: () => {
      loseRestore = true;
    },
    denyRestore: () => {
      denyNextRestore = true;
    },
    async close() {
      cleanup();
      globalThis.fetch = nativeFetch;
      dom.window.confirm = () => true;
      await f.close();
    },
  };
}
async function compare(f: Awaited<ReturnType<typeof setup>>) {
  f.show();
  const trigger = await screen.findByRole("button", { name: "r1 → r2 비교" });
  await f.user.click(trigger);
  const dialog = await screen.findByRole("dialog", {
    name: "변경 비교 · r1 → r2",
  });
  await within(dialog).findByText("새 본문");
  return { trigger, dialog };
}
void test("history comparison highlights only actual fields and empty text, and Escape returns focus without mutation", async () => {
  const f = await setup();
  try {
    const { trigger, dialog } = await compare(f);
    assert.equal(within(dialog).queryByText("우선순위") === null, true);
    assert.ok(within(dialog).getByText("빈 값"));
    assert.ok(within(dialog).getByText("새 제목"));
    assert.ok(within(dialog).getByText("새 본문"));
    await f.user.keyboard("{Escape}");
    await waitFor(() => {
      assert.equal(screen.queryByRole("dialog") === null, true);
    });
    assert.equal(document.activeElement, trigger);
    assert.equal(
      f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue.revision,
      2,
    );
    assert.equal(
      f.requests.some(
        (request) =>
          request.path.endsWith("/restore") && request.method === "POST",
      ),
      false,
    );
  } finally {
    await f.close();
  }
});
void test("selected restore reviews current→historical values and changes only checked fields after explicit confirmation", async () => {
  const f = await setup();
  try {
    const { dialog } = await compare(f);
    await f.user.click(
      within(dialog).getByRole("checkbox", { name: "본문 복원 선택" }),
    );
    await f.user.click(
      within(dialog).getByRole("button", { name: "복원 검토" }),
    );
    await within(dialog).findByRole("heading", { name: "복원 검토 · r2" });
    assert.ok(within(dialog).getByText("현재"));
    assert.ok(within(dialog).getByText("복원 값"));
    assert.equal(
      f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue.revision,
      2,
    );
    await f.user.click(
      within(dialog).getByRole("button", { name: "선택 필드 복원" }),
    );
    await waitFor(() => {
      assert.equal(screen.queryByRole("dialog") === null, true);
    });
    const issue = f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue;
    assert.equal(issue.description, "");
    assert.equal(issue.title, "새 제목");
    assert.equal(issue.revision, 3);
    assert.deepEqual(f.confirmed(), issue);
    assert.ok(await screen.findByRole("button", { name: "r2 → r3 비교" }));
  } finally {
    await f.close();
  }
});
void test("restore conflict keeps selection, shows current differences, and requires another explicit latest review", async () => {
  const f = await setup();
  try {
    const { dialog } = await compare(f);
    await f.user.click(
      within(dialog).getByRole("checkbox", { name: "본문 복원 선택" }),
    );
    await f.user.click(
      within(dialog).getByRole("button", { name: "복원 검토" }),
    );
    await within(dialog).findByRole("heading", { name: "복원 검토 · r2" });
    f.f.instance.store.updateIssue(sessionOwner, f.edited.id, {
      revision: 2,
      title: "동시 수정 제목",
      description: "동시 수정 본문",
    });
    await f.user.click(
      within(dialog).getByRole("button", { name: "선택 필드 복원" }),
    );
    await within(dialog).findByText("동시 수정 본문");
    assert.equal(
      within(dialog).queryByRole("button", { name: "선택 필드 복원" }) === null,
      true,
    );
    assert.equal(
      f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue.revision,
      3,
    );
    await f.user.click(
      within(dialog).getByRole("button", { name: "최신 값으로 다시 검토" }),
    );
    await within(dialog).findByRole("heading", { name: "복원 검토 · r3" });
    await f.user.click(
      within(dialog).getByRole("button", { name: "선택 필드 복원" }),
    );
    await waitFor(() => {
      assert.equal(screen.queryByRole("dialog") === null, true);
    });
    const issue = f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue;
    assert.equal(issue.title, "동시 수정 제목");
    assert.equal(issue.description, "");
    assert.equal(issue.revision, 4);
  } finally {
    await f.close();
  }
});
void test("lost successful restore response retries the identical operation without duplicate history or dependence on a fresh GET", async () => {
  const f = await setup();
  try {
    const { dialog } = await compare(f);
    await f.user.click(
      within(dialog).getByRole("checkbox", { name: "제목 복원 선택" }),
    );
    await f.user.click(
      within(dialog).getByRole("button", { name: "복원 검토" }),
    );
    await within(dialog).findByRole("heading", { name: "복원 검토 · r2" });
    f.loseRestore();
    await f.user.click(
      within(dialog).getByRole("button", { name: "선택 필드 복원" }),
    );
    await within(dialog).findByText(/lost restore response/);
    assert.equal(
      f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue.revision,
      3,
    );
    f.failReads(true);
    await f.user.click(
      within(dialog).getByRole("button", { name: "복원 결과 다시 확인" }),
    );
    await waitFor(() => {
      assert.equal(screen.queryByRole("dialog") === null, true);
    });
    const writes = f.requests.filter(
      (request) =>
        request.path.endsWith("/restore") && request.method === "POST",
    );
    assert.equal(writes.length, 2);
    assert.equal(writes[0].body, writes[1].body);
    assert.equal(
      f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue.revision,
      3,
    );
    assert.equal(f.confirmed()?.title, f.f.issue.title);
    assert.ok(await screen.findByRole("button", { name: "r2 → r3 비교" }));
  } finally {
    await f.close();
  }
});
void test("a denied retry cannot erase an earlier unknown restore result or replace its operation UUID", async () => {
  const f = await setup();
  try {
    const { dialog } = await compare(f);
    await f.user.click(
      within(dialog).getByRole("checkbox", { name: "제목 복원 선택" }),
    );
    await f.user.click(
      within(dialog).getByRole("button", { name: "복원 검토" }),
    );
    await within(dialog).findByRole("heading", { name: "복원 검토 · r2" });
    f.loseRestore();
    await f.user.click(
      within(dialog).getByRole("button", { name: "선택 필드 복원" }),
    );
    await within(dialog).findByText(/lost restore response/);
    assert.equal(
      f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue.revision,
      3,
    );
    f.denyRestore();
    await f.user.click(
      within(dialog).getByRole("button", { name: "복원 결과 다시 확인" }),
    );
    await within(dialog).findByText("소유자만 할 수 있는 작업입니다.");
    const retry = within(dialog).queryByRole("button", {
      name: "복원 결과 다시 확인",
    });
    assert.equal(retry !== null, true);
    assert.equal(
      within(dialog).getByRole<HTMLButtonElement>("button", {
        name: "선택 수정",
      }).disabled,
      true,
    );
    assert.equal(
      within(dialog).queryByRole("button", { name: "복원 검토" }) === null,
      true,
    );
    let closeMessage = "";
    dom.window.confirm = (message) => {
      closeMessage = message ?? "";
      return false;
    };
    await f.user.click(within(dialog).getByRole("button", { name: "취소" }));
    assert.equal(
      closeMessage,
      "복원 결과를 확인하지 못했습니다. 창을 닫을까요?",
    );
    if (!retry) throw new Error("Missing unresolved restore retry");
    await f.user.click(retry);
    await waitFor(() => {
      assert.equal(screen.queryByRole("dialog") === null, true);
    });
    const writes = f.requests.filter(
      (request) =>
        request.path.endsWith("/restore") && request.method === "POST",
    );
    assert.equal(writes.length, 3);
    assert.equal(writes[0].body, writes[1].body);
    assert.equal(writes[1].body, writes[2].body);
    assert.equal(
      f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue.revision,
      3,
    );
    assert.equal(
      f.f.instance.store.history
        .list(sessionOwner, f.edited.id)
        .filter((entry) => entry.action === "restored").length,
      1,
    );
  } finally {
    await f.close();
  }
});
void test("selected restore guards same-document departure and retains the draft when leaving is dismissed", async () => {
  const f = await setup();
  let stop = () => {};
  try {
    window.history.replaceState(
      null,
      "",
      `/#section=issues&issue=${f.edited.id}`,
    );
    stop = subscribeRoute(() => undefined);
    const { dialog } = await compare(f);
    await f.user.click(
      within(dialog).getByRole("checkbox", { name: "본문 복원 선택" }),
    );
    let confirms = 0;
    dom.window.confirm = () => {
      confirms++;
      return false;
    };
    navigate({ issue: "" });
    assert.equal(confirms, 1);
    assert.equal(
      new URLSearchParams(window.location.hash.slice(1)).get("issue"),
      f.edited.id,
    );
    assert.equal(
      within(dialog).getByRole<HTMLInputElement>("checkbox", {
        name: "본문 복원 선택",
      }).checked,
      true,
    );
    await f.user.keyboard("{Escape}");
    assert.equal(confirms, 2);
    assert.equal(screen.queryByRole("dialog") !== null, true);
    dom.window.confirm = () => true;
    await f.user.keyboard("{Escape}");
    await waitFor(() => {
      assert.equal(screen.queryByRole("dialog") === null, true);
    });
    assert.equal(
      f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue.revision,
      2,
    );
  } finally {
    stop();
    await f.close();
  }
});
void test("history initial-load failure retries and non-owner comparison never offers restore authority", async () => {
  const f = await setup();
  try {
    f.offline(true);
    render(
      <IssueHistory
        issue={f.edited}
        data={{
          ...f.data,
          actor: {
            id: "agent",
            name: "agent",
            role: "agent",
            canWrite: true,
            projectIds: [f.f.project.id],
          },
        }}
        activity={[]}
        onRestored={() => undefined}
      />,
    );
    await screen.findByText(/offline history fixture/);
    f.offline(false);
    await f.user.click(screen.getByRole("button", { name: "이력 새로고침" }));
    await f.user.click(
      await screen.findByRole("button", { name: "r1 → r2 비교" }),
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("새 본문");
    assert.equal(within(dialog).queryByRole("checkbox") === null, true);
    assert.equal(
      within(dialog).queryByRole("button", { name: "복원 검토" }) === null,
      true,
    );
  } finally {
    await f.close();
  }
});

void test("long Markdown remains inert and removed version references display their unavailable ID without fabricated labels", async () => {
  const f = await setup();
  try {
    const version = f.f.instance.store.createVersion(sessionOwner, {
      projectId: f.f.project.id,
      name: "사라질 버전",
    });
    const content =
      "![remote](https://example.invalid/image.png) <script>no execution</script>\n" +
      "긴 본문 ".repeat(5000);
    f.f.instance.store.updateIssue(sessionOwner, f.edited.id, {
      revision: 2,
      description: content,
      targetVersionId: version.id,
    });
    f.f.instance.store.deleteVersion(sessionOwner, version.id);
    const issue = f.f.instance.store.getIssue(sessionOwner, f.edited.id).issue;
    render(
      <IssueHistory
        issue={issue}
        data={f.f.instance.store.bootstrap(sessionOwner)}
        activity={[]}
        onRestored={() => undefined}
      />,
    );
    await f.user.click(
      await screen.findByRole("button", { name: "r2 → r3 비교" }),
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(`사용 불가 · ${version.id}`);
    const body = within(dialog).getByRole("region", { name: "본문" });
    assert.equal(body.querySelector("script,img") === null, true);
    assert.equal(body.textContent.includes(content), true);
    await f.user.click(
      within(dialog).getByRole("checkbox", { name: "목표 버전 복원 선택" }),
    );
    await f.user.selectOptions(
      within(dialog).getByLabelText("복원 시점"),
      "after",
    );
    await f.user.click(
      within(dialog).getByRole("button", { name: "복원 검토" }),
    );
    await within(dialog).findByText(/버전은 이슈와 같은 프로젝트/);
    assert.equal(
      f.f.instance.store.getIssue(sessionOwner, issue.id).issue.revision,
      4,
    );
    assert.equal(
      within(dialog).queryByRole("button", { name: "선택 필드 복원" }) === null,
      true,
    );
  } finally {
    await f.close();
  }
});
void test("legacy activity is retained with explicit unavailable comparison rather than fabricated before values", async () => {
  const f = await setup();
  try {
    f.f.instance.store.addComment(sessionOwner, f.edited.id, { body: "기록" });
    f.show();
    assert.ok(await screen.findByText("이전 값 없음"));
    assert.equal(
      screen.queryByRole("button", { name: /rnull/ }) === null,
      true,
    );
  } finally {
    await f.close();
  }
});

void test("confirmed restore stays authoritative in IssuePanel when refresh fails and an older in-flight issue response arrives", async () => {
  const f = await setup();
  let release = () => {};
  try {
    render(
      <IssuePanel
        id={f.edited.id}
        data={f.data}
        onClose={() => undefined}
        onChanged={() => Promise.resolve()}
      />,
    );
    await screen.findByRole("heading", { name: "새 제목" });
    const held = f.holdIssueRead();
    release = held.release;
    await f.user.click(screen.getByRole("button", { name: "상세 새로고침" }));
    await held.ready;
    await f.user.click(screen.getByRole("button", { name: /변경 기록/ }));
    await f.user.click(
      await screen.findByRole("button", { name: "r1 → r2 비교" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "변경 비교 · r1 → r2",
    });
    await f.user.click(
      await within(dialog).findByRole("checkbox", { name: "제목 복원 선택" }),
    );
    await f.user.click(
      within(dialog).getByRole("button", { name: "복원 검토" }),
    );
    await within(dialog).findByRole("heading", { name: "복원 검토 · r2" });
    f.failReads(true);
    await f.user.click(
      within(dialog).getByRole("button", { name: "선택 필드 복원" }),
    );
    await waitFor(() => {
      assert.equal(
        screen.queryByRole("dialog", { name: "변경 비교 · r1 → r2" }) === null,
        true,
      );
    });
    assert.ok(screen.getByRole("heading", { name: f.f.issue.title }));
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      assert.equal(
        screen.queryByRole("heading", { name: "새 제목" }) === null,
        true,
      );
    });
    assert.ok(screen.getByRole("heading", { name: f.f.issue.title }));
  } finally {
    release();
    await f.close();
  }
});

void test("older IssuePanel detail errors cannot erase a newer successful refresh (#66)", async () => {
  const f = await setup();
  let release = () => {};
  try {
    render(
      <IssuePanel
        id={f.edited.id}
        data={f.data}
        onClose={() => undefined}
        onChanged={() => Promise.resolve()}
      />,
    );
    await screen.findByRole("heading", { name: "새 제목" });
    const held = f.holdIssueRead(true);
    release = held.release;
    await f.user.click(screen.getByRole("button", { name: "상세 새로고침" }));
    await held.ready;
    f.f.instance.store.updateIssue(sessionOwner, f.edited.id, {
      revision: 2,
      title: "최신 상세",
    });
    await f.user.click(screen.getByRole("button", { name: "상세 새로고침" }));
    await screen.findByRole("heading", { name: "최신 상세" });
    await act(async () => {
      release();
      await Promise.resolve();
    });
    assert.equal(screen.queryByText("older detail failure") === null, true);
    assert.ok(screen.getByRole("heading", { name: "최신 상세" }));
  } finally {
    release();
    await f.close();
  }
});

void test("comparison preserves literal object-property names in free-text fields without treating them as label lookups", () => {
  const view = render(
    <FieldDiff
      versions={[]}
      changes={[
        { field: "title", before: "old", after: "__proto__" },
        { field: "description", before: "", after: "constructor" },
        { field: "assignee", before: "", after: "toString" },
      ]}
    />,
  );
  try {
    assert.ok(screen.getByText("__proto__", { exact: true }));
    assert.ok(screen.getByText("constructor", { exact: true }));
    assert.ok(screen.getByText("toString", { exact: true }));
  } finally {
    view.unmount();
  }
});

void test("comparison maps only enum fields and keeps status-like free text literal", () => {
  const view = render(
    <FieldDiff
      versions={[]}
      changes={[
        { field: "title", before: "open", after: "closed" },
        { field: "description", before: "high", after: "low" },
        { field: "assignee", before: "closed", after: "open" },
        { field: "status", before: "ready", after: "closed" },
        { field: "priority", before: "high", after: "low" },
      ]}
    />,
  );
  try {
    const values = (name: string) =>
      [...screen.getByRole("region", { name }).querySelectorAll("pre")].map(
        (node) => node.textContent,
      );
    assert.deepEqual(values("제목"), ["open", "closed"]);
    assert.deepEqual(values("본문"), ["high", "low"]);
    assert.deepEqual(values("담당자"), ["closed", "open"]);
    assert.deepEqual(values("상태"), ["할 일", "소유자 종료"]);
    assert.deepEqual(values("우선순위"), ["높음", "낮음"]);
  } finally {
    view.unmount();
  }
});

void test("comparison keeps label boundaries visible when one label contains a comma", () => {
  const view = render(
    <FieldDiff
      versions={[]}
      changes={[
        { field: "labels", before: ["one, two"], after: ["one", "two"] },
      ]}
    />,
  );
  try {
    const values = [
      ...screen.getByRole("region", { name: "라벨" }).querySelectorAll("pre"),
    ].map((node) => node.textContent);
    assert.notEqual(values[0], values[1]);
    assert.deepEqual(values, ['[\n  "one, two"\n]', '[\n  "one",\n  "two"\n]']);
  } finally {
    view.unmount();
  }
});
