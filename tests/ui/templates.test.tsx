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
const { render, screen, cleanup, waitFor, act } =
  await import("@testing-library/react");
const { userEvent } = await import("@testing-library/user-event");
const nativeFetch = globalThis.fetch;
const nativeConfirm = dom.window.confirm.bind(dom.window);
import { IssueEditor } from "../../client/editors.js";
import TemplateWorkspace from "../../client/features/templates/TemplateWorkspace.js";
import { TEMPLATE_EXAMPLES } from "../../server/contracts/templates.js";
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
  let failGet = false,
    dropCreateResponse = false;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      f.base,
    );
    if (failGet && (!init.method || init.method === "GET"))
      return Promise.reject(new Error("offline fixture"));
    const response = nativeFetch(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        cookie,
        origin: "http://localhost:8787",
      },
    });
    if (
      dropCreateResponse &&
      url.pathname === "/api/issues" &&
      init.method === "POST"
    ) {
      dropCreateResponse = false;
      return response.then(() => {
        throw new Error("unknown create response fixture");
      });
    }
    return response;
  };
  const version = f.instance.store.createVersion(sessionOwner, {
    projectId: f.project.id,
    name: "1.0",
  });
  const example = TEMPLATE_EXAMPLES[0];
  const definition = {
    name: example.name,
    body: example.body,
    requiredFields: example.requiredFields,
    defaults: example.defaults,
  };
  const template = f.instance.store.templates.create(sessionOwner, {
    ...definition,
    projectId: f.project.id,
    operationId: crypto.randomUUID(),
  });
  return {
    f,
    user,
    version,
    template,
    dropNextCreateResponse: () => {
      dropCreateResponse = true;
    },
    setFailGet: (v: boolean) => {
      failGet = v;
    },
    close: async () => {
      cleanup();
      window.confirm = nativeConfirm;
      globalThis.fetch = nativeFetch;
      await f.close();
    },
  };
}
void test("template issue fields validate exact sections, cancel overwrite, render preview and persist provenance", async () => {
  const s = await setup();
  try {
    let saved = "";
    render(
      <IssueEditor
        data={s.f.instance.store.bootstrap(sessionOwner)}
        projectId={s.f.project.id}
        onClose={() => undefined}
        onSaved={(i) => {
          saved = i.id;
        }}
      />,
    );
    await screen.findByRole("option", { name: "버그 · v1" });
    await s.user.selectOptions(
      screen.getByLabelText("이슈 템플릿"),
      s.template.template.id,
    );
    await screen.findByRole("heading", { name: "버그 · v1" });
    await s.user.type(screen.getByLabelText("이슈 제목"), "실제 오류");
    await s.user.click(screen.getByRole("button", { name: "이슈 만들기" }));
    assert.ok(screen.getByText("재현 절차: 필수 항목입니다."));
    assert.ok(screen.getByText("발견 버전: 필수 항목입니다."));
    await s.user.type(screen.getByLabelText("재현 절차 *"), "버튼 누름");
    await s.user.type(screen.getByLabelText("기대 결과 *"), "저장됨");
    await s.user.type(screen.getByLabelText("실제 결과 *"), "오류");
    await s.user.selectOptions(
      screen.getByLabelText("발견 버전 *"),
      s.version.id,
    );
    await s.user.clear(screen.getByLabelText("설명"));
    await s.user.type(screen.getByLabelText("설명"), "편집한 본문");
    const oldConfirm = window.confirm.bind(window);
    window.confirm = () => false;
    await s.user.selectOptions(screen.getByLabelText("이슈 템플릿"), "");
    assert.equal(
      screen.getByLabelText<HTMLTextAreaElement>("설명").value,
      "편집한 본문",
    );
    window.confirm = oldConfirm;
    assert.match(
      screen.getByRole("region", { name: "이슈 미리보기" }).textContent,
      /편집한 본문.*재현 절차.*버튼 누름/s,
    );
    await s.user.click(screen.getByRole("button", { name: "이슈 만들기" }));
    await waitFor(() => {
      assert.ok(saved);
    });
    const issue = s.f.instance.store.getIssue(sessionOwner, saved).issue;
    assert.equal(issue.templateVersion, 1);
    assert.equal(issue.templateId, s.template.template.id);
    assert.match(issue.description, /편집한 본문/);
  } finally {
    await s.close();
  }
});
void test("template manager exposes examples, version history, CAS draft retention and confirmed save despite refresh failure", async () => {
  const s = await setup();
  try {
    let selected = "";
    const data = s.f.instance.store.bootstrap(sessionOwner);
    const props = {
      projectId: s.f.project.id,
      data,
      onSelect: (id: string) => {
        selected = id;
      },
      onBack: () => undefined,
    };
    const view = render(
      <TemplateWorkspace {...props} templateId={s.template.template.id} />,
    );
    await screen.findByDisplayValue("버그");
    await s.user.type(screen.getByLabelText("템플릿 본문"), " 내 초안");
    s.f.instance.store.templates.update(sessionOwner, s.template.template.id, {
      name: "다른 수정",
      body: "외부 변경",
      requiredFields: ["problem"],
      defaults: {},
      revision: 1,
    });
    await s.user.click(screen.getByRole("button", { name: "템플릿 저장" }));
    await screen.findByText("충돌 · 초안 보존됨");
    await s.user.click(
      screen.getByRole("button", { name: "최신 템플릿 확인" }),
    );
    await screen.findByText("다른 수정 · v2 · r2");
    assert.match(
      screen.getByLabelText<HTMLTextAreaElement>("템플릿 본문").value,
      /내 초안/,
    );
    await s.user.click(
      screen.getByRole("button", { name: "최신 버전 기준으로 초안 유지" }),
    );
    s.setFailGet(true);
    await s.user.click(screen.getByRole("button", { name: "템플릿 저장" }));
    await screen.findByText("저장됨 · v3 · r3");
    assert.equal(
      screen.queryByRole("button", { name: "최신 버전 기준으로 초안 유지" }),
      null,
    );
    await s.user.type(screen.getByLabelText("템플릿 본문"), " 다음 초안");
    s.setFailGet(false);
    await s.user.click(screen.getByRole("button", { name: "템플릿 저장" }));
    await screen.findByText("저장됨 · v4 · r4");
    assert.equal(
      s.f.instance.store.templates.get(sessionOwner, s.template.template.id)
        .template.revision,
      4,
    );
    await s.user.selectOptions(screen.getByLabelText("템플릿 버전 기록"), "1");
    assert.match(
      screen.getByRole("region", { name: "저장된 버전 미리보기" }).textContent,
      /버그/,
    );
    await s.user.type(screen.getByLabelText("기본 라벨"), "복제, 새라벨");
    window.confirm = () => true;
    await s.user.click(screen.getByRole("button", { name: "템플릿 복제" }));
    assert.equal(selected, "new");
    view.rerender(<TemplateWorkspace {...props} templateId="new" />);
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("기본 라벨").value,
      "복제, 새라벨",
    );
    view.rerender(<TemplateWorkspace {...props} templateId="" />);
    await screen.findByRole("heading", { name: "예시 템플릿" });
    assert.ok(
      screen.getByRole("button", { name: "에이전트 작업 예시로 만들기" }),
    );
  } finally {
    await s.close();
  }
});
void test("template manager dirty cancel and same-document departure preserve draft, explicit delete is revisioned", async () => {
  const s = await setup();
  try {
    let selected = "";
    render(
      <TemplateWorkspace
        projectId={s.f.project.id}
        data={s.f.instance.store.bootstrap(sessionOwner)}
        templateId={s.template.template.id}
        onSelect={(id) => {
          selected = id;
        }}
        onBack={() => undefined}
      />,
    );
    await screen.findByDisplayValue("버그");
    await s.user.type(screen.getByLabelText("템플릿 본문"), " 미저장");
    const oldConfirm = window.confirm.bind(window);
    window.confirm = () => false;
    await s.user.click(screen.getByRole("button", { name: "템플릿 목록" }));
    assert.equal(selected, "");
    assert.match(
      screen.getByLabelText<HTMLTextAreaElement>("템플릿 본문").value,
      /미저장/,
    );
    const { navigate } = await import("../../client/router.js");
    act(() => {
      navigate({ section: "projects" });
    });
    assert.equal(window.location.hash, "");
    window.confirm = () => true;
    selected = "pending";
    await s.user.click(screen.getByRole("button", { name: "템플릿 삭제" }));
    await waitFor(() => {
      assert.equal(selected, "");
    });
    assert.throws(
      () =>
        s.f.instance.store.templates.get(sessionOwner, s.template.template.id),
      /삭제된 템플릿/,
    );
    window.confirm = oldConfirm;
  } finally {
    await s.close();
  }
});
void test("template picker retry, stale version rejection, retained fields and explicit overwrite cancellation", async () => {
  const s = await setup();
  try {
    s.setFailGet(true);
    render(
      <IssueEditor
        data={s.f.instance.store.bootstrap(sessionOwner)}
        projectId={s.f.project.id}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );
    await screen.findByRole("button", { name: "템플릿 목록 재시도" });
    s.setFailGet(false);
    await s.user.click(
      screen.getByRole("button", { name: "템플릿 목록 재시도" }),
    );
    await screen.findByRole("option", { name: "버그 · v1" });
    await s.user.selectOptions(
      screen.getByLabelText("이슈 템플릿"),
      s.template.template.id,
    );
    await screen.findByRole("heading", { name: "버그 · v1" });
    await s.user.type(screen.getByLabelText("이슈 제목"), "변경 중 오류");
    for (const label of ["재현 절차 *", "기대 결과 *", "실제 결과 *"])
      await s.user.type(screen.getByLabelText(label), "보존할 필드");
    await s.user.selectOptions(
      screen.getByLabelText("발견 버전 *"),
      s.version.id,
    );
    s.f.instance.store.templates.update(sessionOwner, s.template.template.id, {
      name: "버그 변경",
      body: "새 양식",
      requiredFields: ["problem"],
      defaults: { priority: "urgent" },
      revision: 1,
    });
    await s.user.click(screen.getByRole("button", { name: "이슈 만들기" }));
    await screen.findByText("템플릿 변경됨 · 초안 보존됨");
    assert.equal(
      screen.getByLabelText<HTMLTextAreaElement>("실제 결과 *").value,
      "보존할 필드",
    );
    const restore = window.confirm.bind(window);
    window.confirm = () => false;
    await s.user.click(
      screen.getByRole("button", { name: "최신 템플릿 적용" }),
    );
    assert.equal(
      screen.getByLabelText<HTMLTextAreaElement>("실제 결과 *").value,
      "보존할 필드",
    );
    window.confirm = () => true;
    await s.user.click(
      screen.getByRole("button", { name: "최신 템플릿 적용" }),
    );
    await screen.findByRole("heading", { name: "버그 변경 · v2" });
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>("우선순위").value,
      "urgent",
    );
    assert.equal(
      screen.getByLabelText<HTMLTextAreaElement>("설명").value,
      "새 양식",
    );
    window.confirm = restore;
  } finally {
    await s.close();
  }
});
void test("empty template list, example creation and editable comma-separated default labels", async () => {
  const s = await setup();
  try {
    const project = s.f.instance.store.createProject(sessionOwner, {
      name: "빈 프로젝트",
      key: "EMPTY",
    });
    let id = "";
    const props = {
      projectId: project.id,
      data: s.f.instance.store.bootstrap(sessionOwner),
      onSelect: (value: string) => {
        id = value;
      },
      onBack: () => undefined,
    };
    const view = render(<TemplateWorkspace {...props} templateId="" />);
    await screen.findByText("저장된 템플릿 없음");
    await s.user.click(
      screen.getByRole("button", { name: "기능 예시로 만들기" }),
    );
    assert.equal(id, "new");
    view.rerender(<TemplateWorkspace {...props} templateId="new" />);
    await s.user.type(screen.getByLabelText("기본 라벨"), "first, second");
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("기본 라벨").value,
      "first, second",
    );
    await s.user.click(screen.getByRole("button", { name: "템플릿 저장" }));
    await waitFor(() => {
      assert.notEqual(id, "new");
    });
    const saved = s.f.instance.store.templates.get(sessionOwner, id);
    assert.deepEqual(saved.selectedVersion.defaults.labels, [
      "first",
      "second",
    ]);
    assert.deepEqual(saved.selectedVersion.requiredFields, [
      "problem",
      "scope",
      "acceptance",
    ]);
  } finally {
    await s.close();
  }
});
void test("unknown create response retains templated draft and operation UUID, double retry creates only one issue", async () => {
  const s = await setup();
  try {
    const template = s.f.instance.store.templates.create(sessionOwner, {
      projectId: s.f.project.id,
      name: "간단한 양식",
      body: "안전한 초안",
      requiredFields: [],
      defaults: { priority: "low" },
      operationId: crypto.randomUUID(),
    });
    let calls = 0;
    const before = s.f.instance.store.bootstrap(sessionOwner).issues.length;
    render(
      <IssueEditor
        data={s.f.instance.store.bootstrap(sessionOwner)}
        projectId={s.f.project.id}
        onClose={() => undefined}
        onSaved={() => {
          calls++;
        }}
      />,
    );
    await screen.findByRole("option", { name: "간단한 양식 · v1" });
    await s.user.selectOptions(
      screen.getByLabelText("이슈 템플릿"),
      template.template.id,
    );
    await screen.findByRole("heading", { name: "간단한 양식 · v1" });
    await s.user.type(screen.getByLabelText("이슈 제목"), "한 번만 생성");
    s.dropNextCreateResponse();
    await s.user.click(screen.getByRole("button", { name: "이슈 만들기" }));
    await screen.findByText("unknown create response fixture");
    assert.equal(
      screen.getByLabelText<HTMLTextAreaElement>("설명").value,
      "안전한 초안",
    );
    assert.equal(
      s.f.instance.store.bootstrap(sessionOwner).issues.length,
      before + 1,
    );
    await s.user.dblClick(screen.getByRole("button", { name: "이슈 만들기" }));
    await waitFor(() => {
      assert.ok(calls >= 1);
    });
    assert.equal(
      s.f.instance.store.bootstrap(sessionOwner).issues.length,
      before + 1,
    );
  } finally {
    await s.close();
  }
});
void test("project and content controls stay stable while a selected template is loading", async () => {
  const s = await setup();
  let release: () => void = () => undefined;
  try {
    const forward = globalThis.fetch;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async (input, init) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (path === `/api/templates/${s.template.template.id}`) await barrier;
      return forward(input, init);
    };
    render(
      <IssueEditor
        data={s.f.instance.store.bootstrap(sessionOwner)}
        projectId={s.f.project.id}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );
    await screen.findByRole("option", { name: "버그 · v1" });
    await s.user.selectOptions(
      screen.getByLabelText("이슈 템플릿"),
      s.template.template.id,
    );
    await screen.findByText("템플릿 적용 중…");
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>("프로젝트").matches(":disabled"),
      true,
    );
    assert.equal(
      screen.getByLabelText<HTMLTextAreaElement>("설명").matches(":disabled"),
      true,
    );
    release();
    await screen.findByRole("heading", { name: "버그 · v1" });
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>("프로젝트").matches(":disabled"),
      false,
    );
  } finally {
    release();
    await s.close();
  }
});
void test("template manager rejects a mismatched project deep link instead of presenting foreign defaults", async () => {
  const s = await setup();
  try {
    render(
      <TemplateWorkspace
        projectId={s.f.other.id}
        templateId={s.template.template.id}
        data={s.f.instance.store.bootstrap(sessionOwner)}
        onSelect={() => undefined}
        onBack={() => undefined}
      />,
    );
    await screen.findByText("다른 프로젝트의 템플릿입니다.");
    assert.equal(screen.queryByLabelText("템플릿 본문"), null);
  } finally {
    await s.close();
  }
});
void test("first template selection confirms changed default attributes even with an empty body and preserves canceled values", async () => {
  const s = await setup();
  try {
    render(
      <IssueEditor
        data={s.f.instance.store.bootstrap(sessionOwner)}
        projectId={s.f.project.id}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );
    await screen.findByRole("option", { name: "버그 · v1" });
    await s.user.type(screen.getByLabelText("이슈 제목"), "보존 제목");
    await s.user.selectOptions(screen.getByLabelText("우선순위"), "urgent");
    await s.user.type(screen.getByLabelText("담당자"), "수동 담당");
    await s.user.type(screen.getByLabelText("라벨"), "수동 라벨");
    let prompts = 0;
    window.confirm = () => {
      prompts++;
      return false;
    };
    await s.user.selectOptions(
      screen.getByLabelText("이슈 템플릿"),
      s.template.template.id,
    );
    assert.equal(prompts, 1);
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>("이슈 템플릿").value,
      "",
    );
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>("우선순위").value,
      "urgent",
    );
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("라벨").value,
      "수동 라벨",
    );
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("담당자").value,
      "수동 담당",
    );
    window.confirm = () => true;
    await s.user.selectOptions(
      screen.getByLabelText("이슈 템플릿"),
      s.template.template.id,
    );
    await screen.findByRole("heading", { name: "버그 · v1" });
    assert.equal(
      screen.getByLabelText<HTMLInputElement>("이슈 제목").value,
      "보존 제목",
    );
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>("우선순위").value,
      "medium",
    );
  } finally {
    await s.close();
  }
});

for (const field of [
  "이슈 제목",
  "설명",
  "상태",
  "우선순위",
  "담당자",
  "라벨",
  "목표 버전",
  "발견 버전",
  "수정 버전",
  "프로젝트",
]) {
  void test(`ordinary issue draft: changing ${field} requires discard consent before cancel`, async () => {
    const s = await setup();
    try {
      let closed = 0;
      render(
        <IssueEditor
          data={s.f.instance.store.bootstrap(sessionOwner)}
          projectId={s.f.project.id}
          onClose={() => {
            closed++;
          }}
          onSaved={() => undefined}
        />,
      );
      await screen.findByRole("option", { name: "버그 · v1" });
      const input = screen.getByLabelText<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >(field);
      const initialValue = input.value;
      if (input instanceof HTMLSelectElement) {
        const value =
          field === "프로젝트"
            ? s.f.other.id
            : field === "상태"
              ? "ready"
              : field === "우선순위"
                ? "high"
                : s.version.id;
        await s.user.selectOptions(input, value);
      } else await s.user.type(input, "합성 미저장 초안");
      const value = input.value;
      let prompts = 0;
      window.confirm = () => {
        prompts++;
        return false;
      };
      await s.user.click(screen.getByRole("button", { name: "취소" }));
      assert.equal(closed, 0, "declining discard keeps the editor open");
      assert.equal(prompts, 1);
      assert.equal(input.value, value);
      const unload = new dom.window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      assert.equal(unload.defaultPrevented, true);
      if (input instanceof HTMLSelectElement)
        await s.user.selectOptions(input, initialValue);
      else await s.user.clear(input);
      await s.user.click(screen.getByRole("button", { name: "취소" }));
      assert.equal(
        closed,
        1,
        "restoring the original field value needs no discard consent",
      );
      assert.equal(prompts, 1);
      const cleanUnload = new dom.window.Event("beforeunload", {
        cancelable: true,
      });
      window.dispatchEvent(cleanUnload);
      assert.equal(cleanUnload.defaultPrevented, false);
      if (input instanceof HTMLSelectElement)
        await s.user.selectOptions(input, value);
      else await s.user.type(input, value);
      window.confirm = () => true;
      await s.user.click(screen.getByRole("button", { name: "취소" }));
      assert.equal(closed, 2, "explicit discard may close the editor");
    } finally {
      await s.close();
    }
  });
}

for (const departure of ["issue", "project"] as const) {
  for (const field of ["이슈 제목", "설명", "우선순위"]) {
    void test(`ordinary edited issue retains ${field} when ${departure} navigation is declined`, async () => {
      const s = await setup();
      try {
        const { navigate } = await import("../../client/router.js");
        window.history.replaceState(
          {},
          "",
          `/#project=${s.f.project.id}&issue=${s.f.issue.id}`,
        );
        render(
          <IssueEditor
            issue={s.f.issue}
            data={s.f.instance.store.bootstrap(sessionOwner)}
            onClose={() => undefined}
            onSaved={() => undefined}
          />,
        );
        const input = screen.getByLabelText<
          HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        >(field);
        if (input instanceof HTMLSelectElement)
          await s.user.selectOptions(input, "high");
        else await s.user.type(input, " 합성 미저장 변경");
        const value = input.value,
          hash = window.location.hash;
        let prompts = 0;
        window.confirm = () => {
          prompts++;
          return false;
        };
        const next =
          departure === "issue"
            ? { issue: s.f.foreign.id }
            : { project: s.f.other.id, issue: "" };
        act(() => {
          navigate(next);
        });
        assert.equal(
          window.location.hash,
          hash,
          "declining navigation keeps the current issue route",
        );
        assert.equal(prompts, 1);
        assert.equal(input.value, value);
        window.confirm = () => true;
        act(() => {
          navigate(next);
        });
        assert.notEqual(window.location.hash, hash);
      } finally {
        await s.close();
        window.history.replaceState({}, "", "/");
      }
    });
  }
}

void test("untouched or reverted ordinary issue drafts close without discard prompts", async () => {
  const s = await setup();
  try {
    let closed = 0,
      prompts = 0;
    window.confirm = () => {
      prompts++;
      return false;
    };
    const props = {
      data: s.f.instance.store.bootstrap(sessionOwner),
      projectId: s.f.project.id,
      onClose: () => {
        closed++;
      },
      onSaved: () => undefined,
    };
    const view = render(<IssueEditor {...props} />);
    await screen.findByRole("option", { name: "버그 · v1" });
    await s.user.click(screen.getByRole("button", { name: "취소" }));
    assert.equal(closed, 1);
    await s.user.type(screen.getByLabelText("이슈 제목"), "되돌릴 제목");
    await s.user.clear(screen.getByLabelText("이슈 제목"));
    await s.user.click(screen.getByRole("button", { name: "취소" }));
    assert.equal(closed, 2);
    view.unmount();
    render(<IssueEditor {...props} issue={s.f.issue} />);
    await s.user.click(screen.getByRole("button", { name: "취소" }));
    assert.equal(closed, 3);
    assert.equal(prompts, 0);
    const unload = new dom.window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    assert.equal(unload.defaultPrevented, false);
  } finally {
    await s.close();
  }
});

void test("project prop refresh does not redefine the editor's initial project", async () => {
  const s = await setup();
  try {
    let closed = 0,
      prompts = 0;
    window.confirm = () => {
      prompts++;
      return false;
    };
    const data = s.f.instance.store.bootstrap(sessionOwner);
    const props = {
      data,
      onClose: () => {
        closed++;
      },
      onSaved: () => undefined,
    };
    const view = render(<IssueEditor {...props} projectId={s.f.project.id} />);
    await screen.findByRole("option", { name: "버그 · v1" });
    view.rerender(<IssueEditor {...props} projectId={s.f.other.id} />);
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>("프로젝트").value,
      s.f.project.id,
    );
    await s.user.click(screen.getByRole("button", { name: "취소" }));
    assert.equal(closed, 1);
    assert.equal(prompts, 0);
    await s.user.selectOptions(screen.getByLabelText("프로젝트"), s.f.other.id);
    view.rerender(<IssueEditor {...props} projectId={s.f.other.id} />);
    await s.user.click(screen.getByRole("button", { name: "취소" }));
    assert.equal(
      closed,
      1,
      "matching a new prop cannot hide a user project change",
    );
    assert.equal(prompts, 1);
  } finally {
    await s.close();
  }
});

void test("selecting a template still requires discard consent before any title input", async () => {
  const s = await setup();
  try {
    let closed = 0,
      prompts = 0;
    render(
      <IssueEditor
        data={s.f.instance.store.bootstrap(sessionOwner)}
        projectId={s.f.project.id}
        onClose={() => {
          closed++;
        }}
        onSaved={() => undefined}
      />,
    );
    await screen.findByRole("option", { name: "버그 · v1" });
    await s.user.selectOptions(
      screen.getByLabelText("이슈 템플릿"),
      s.template.template.id,
    );
    await screen.findByRole("heading", { name: "버그 · v1" });
    window.confirm = () => {
      prompts++;
      return false;
    };
    await s.user.click(screen.getByRole("button", { name: "취소" }));
    assert.equal(closed, 0);
    assert.equal(prompts, 1);
    assert.equal(
      screen.getByLabelText<HTMLSelectElement>("이슈 템플릿").value,
      s.template.template.id,
    );
  } finally {
    await s.close();
  }
});
