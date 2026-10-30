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

const sourceId = "11111111-1111-4111-8111-111111111111",
  selectionId = "22222222-2222-4222-8222-222222222222",
  otherId = "33333333-3333-4333-8333-333333333333";
const connection = {
  projectId: "p",
  repository: null,
  mode: "public" as const,
  connected: false,
  revision: 0,
  principalLabel: "공개 조회",
  credentialConfigured: false,
  providerEnabled: true,
  permissionsVerified: false as const,
  lastVerifiedAt: null,
  lastErrorCode: null,
};
const sources = {
  revision: 0,
  providerEnabled: true,
  sources: [
    { id: sourceId, label: "octocat · 공개 저장소", mode: "public" },
    { id: otherId, label: "설정된 계정", mode: "authenticated" },
  ],
};
const repository = {
  selectionId,
  id: 42,
  repository: { owner: "octocat", name: "sticker" },
  visibility: "public",
  archived: false,
  disabled: false,
};
const page = {
  sourceId,
  revision: 0,
  repositories: [repository],
  nextCursor: null,
  limitReached: false,
};
void test("selector connects without typing identifiers and preserves explicit consent and uncertain-save requery", async () => {
  const { GithubConnectionEditor } =
    await import("../../client/features/github/GithubConnectionEditor.js");
  const original = globalThis.fetch;
  let saved = 0,
    resolved = 0;
  globalThis.fetch = () => Promise.resolve(Response.json(sources));
  const user = userEvent.setup({ document: dom.window.document });
  try {
    render(
      <GithubConnectionEditor
        connection={connection}
        onClose={() => {}}
        onConnect={() => {
          saved++;
          return Promise.reject(new Error("response lost"));
        }}
        onResolved={() => {
          resolved++;
        }}
      />,
    );
    await screen.findByRole("option", { name: /octocat · 공개 저장소/ });
    globalThis.fetch = () => Promise.resolve(Response.json(page));
    await user.selectOptions(screen.getByLabelText("조회 주체"), sourceId);
    await screen.findByRole("option", { name: /octocat\/sticker/ });
    await user.selectOptions(screen.getByLabelText("저장소"), selectionId);
    assert.equal(screen.queryByLabelText("저장소 소유자"), null);
    assert.equal(screen.queryByLabelText("자격증명 설정 참조"), null);
    assert.equal(
      screen.getByRole<HTMLButtonElement>("button", { name: "저장소 연결" })
        .disabled,
      true,
    );
    await user.click(screen.getByLabelText("이 저장소의 읽기 조회 허용"));
    await user.click(screen.getByRole("button", { name: "저장소 연결" }));
    await screen.findByText("response lost");
    assert.equal(saved, 1);
    assert.equal(
      screen.getByRole<HTMLButtonElement>("button", { name: "저장소 연결" })
        .disabled,
      true,
    );
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json({
          matches: true,
          connection: {
            ...connection,
            repository: repository.repository,
            connected: true,
            revision: 1,
          },
        }),
      );
    await user.click(screen.getByRole("button", { name: "저장 결과 확인" }));
    assert.equal(resolved, 1);
  } finally {
    cleanup();
    globalThis.fetch = original;
  }
});
void test("source change ignores late private results", async () => {
  const { GithubConnectionEditor } =
    await import("../../client/features/github/GithubConnectionEditor.js");
  const { act } = await import("@testing-library/react");
  const original = globalThis.fetch;
  let release: (r: Response) => void = () => {};
  globalThis.fetch = () => Promise.resolve(Response.json(sources));
  const user = userEvent.setup({ document: dom.window.document });
  try {
    const view = render(
      <GithubConnectionEditor
        connection={connection}
        onClose={() => {}}
        onConnect={() => Promise.resolve()}
      />,
    );
    await screen.findByRole("option", { name: /설정된 계정/ });
    globalThis.fetch = () =>
      new Promise<Response>((r) => {
        release = r;
      });
    await user.selectOptions(screen.getByLabelText("조회 주체"), otherId);
    globalThis.fetch = () => Promise.resolve(Response.json(page));
    await user.selectOptions(screen.getByLabelText("조회 주체"), sourceId);
    await screen.findByRole("option", { name: /octocat\/sticker/ });
    await act(async () => {
      release(
        Response.json({
          ...page,
          sourceId: otherId,
          repositories: [
            {
              ...repository,
              visibility: "private",
              repository: { owner: "secret", name: "private" },
            },
          ],
        }),
      );
      await Promise.resolve();
    });
    assert.equal(screen.queryByText(/secret\/private/), null);
    view.unmount();
  } finally {
    cleanup();
    globalThis.fetch = original;
  }
});
void test("denied source refresh removes private choices rather than leaving reusable cached metadata", async () => {
  const { GithubConnectionEditor } =
    await import("../../client/features/github/GithubConnectionEditor.js");
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json(sources));
  const user = userEvent.setup({ document: dom.window.document });
  try {
    render(
      <GithubConnectionEditor
        connection={connection}
        onClose={() => {}}
        onConnect={() => Promise.resolve()}
      />,
    );
    await screen.findByRole("option", { name: /설정된 계정/ });
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json({
          ...page,
          sourceId: otherId,
          repositories: [
            {
              ...repository,
              visibility: "private",
              repository: { owner: "secret", name: "private" },
            },
          ],
        }),
      );
    await user.selectOptions(screen.getByLabelText("조회 주체"), otherId);
    await screen.findByRole("option", { name: /secret\/private/ });
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json(
          { error: "권한 없음", code: "OWNER_REQUIRED" },
          { status: 403 },
        ),
      );
    await user.selectOptions(screen.getByLabelText("조회 주체"), sourceId);
    await screen.findByText("권한 없음");
    assert.equal(screen.queryByText(/secret\/private/), null);
    assert.equal(
      Boolean(screen.queryByRole("option", { name: /설정된 계정/ })),
      false,
    );
  } finally {
    cleanup();
    globalThis.fetch = original;
  }
});
void test("closing a pending private request cannot populate a newly opened picker", async () => {
  const { GithubConnectionEditor } =
    await import("../../client/features/github/GithubConnectionEditor.js");
  const { act } = await import("@testing-library/react");
  const original = globalThis.fetch;
  let release: (r: Response) => void = () => {};
  globalThis.fetch = () => Promise.resolve(Response.json(sources));
  const user = userEvent.setup({ document: dom.window.document });
  try {
    const view = render(
      <GithubConnectionEditor
        connection={connection}
        onClose={() => {}}
        onConnect={() => Promise.resolve()}
      />,
    );
    await screen.findByRole("option", { name: /설정된 계정/ });
    globalThis.fetch = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    await user.selectOptions(screen.getByLabelText("조회 주체"), otherId);
    view.unmount();
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json({ revision: 0, providerEnabled: true, sources: [] }),
      );
    render(
      <GithubConnectionEditor
        connection={connection}
        onClose={() => {}}
        onConnect={() => Promise.resolve()}
      />,
    );
    await screen.findByText(/선택 가능한 계정 없음/);
    await act(async () => {
      release(
        Response.json({
          ...page,
          sourceId: otherId,
          repositories: [
            {
              ...repository,
              visibility: "private",
              repository: { owner: "secret", name: "private" },
            },
          ],
        }),
      );
      await Promise.resolve();
    });
    assert.equal(Boolean(screen.queryByText(/secret\/private/)), false);
    assert.equal(
      Boolean(screen.queryByRole("option", { name: /설정된 계정/ })),
      false,
    );
    assert.ok(screen.getByText(/선택 가능한 계정 없음/));
  } finally {
    cleanup();
    globalThis.fetch = original;
  }
});
void test("denied conflict requery clears the previously loaded private connection comparison", async () => {
  const { GithubConnectionEditor } =
    await import("../../client/features/github/GithubConnectionEditor.js");
  const { ApiError } = await import("../../client/api.js");
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json(sources));
  const user = userEvent.setup({ document: dom.window.document });
  let deny = false;
  try {
    render(
      <GithubConnectionEditor
        connection={connection}
        onClose={() => {}}
        onConnect={() =>
          Promise.reject(new ApiError("conflict", 409, "REVISION_CONFLICT"))
        }
        onReload={() =>
          deny
            ? Promise.reject(new ApiError("권한 상실", 403, "OWNER_REQUIRED"))
            : Promise.resolve({
                ...connection,
                repository: { owner: "private-owner", name: "private-repo" },
                mode: "authenticated",
                principalLabel: "SecretPrincipal",
                revision: 1,
              })
        }
      />,
    );
    await screen.findByRole("option", { name: /octocat · 공개 저장소/ });
    globalThis.fetch = () => Promise.resolve(Response.json(page));
    await user.selectOptions(screen.getByLabelText("조회 주체"), sourceId);
    await screen.findByRole("option", { name: /octocat\/sticker/ });
    await user.selectOptions(screen.getByLabelText("저장소"), selectionId);
    await user.click(screen.getByLabelText("이 저장소의 읽기 조회 허용"));
    await user.click(screen.getByRole("button", { name: "저장소 연결" }));
    await screen.findByRole("button", { name: "최신 연결 확인" });
    await user.click(screen.getByRole("button", { name: "최신 연결 확인" }));
    await screen.findByText("private-owner/private-repo");
    await screen.findByText("SecretPrincipal");
    deny = true;
    await user.click(screen.getByRole("button", { name: "최신 연결 확인" }));
    await screen.findByText("권한 상실");
    assert.equal(
      Boolean(screen.queryByText("private-owner/private-repo")),
      false,
    );
    assert.equal(Boolean(screen.queryByText("SecretPrincipal")), false);
  } finally {
    cleanup();
    globalThis.fetch = original;
  }
});
