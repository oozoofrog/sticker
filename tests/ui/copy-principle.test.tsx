import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import React from "react";
import { sessionHttpFixture, sessionOwner } from "../session-fixture.js";
import { versionStateNames } from "../../client/format.js";
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
const { render, screen, cleanup, within } =
  await import("@testing-library/react");
const { userEvent } = await import("@testing-library/user-event");
const App = (await import("../../client/App.js")).default;
const nativeFetch = globalThis.fetch;
const password = "disposable-session-owner-password";
async function setup(authenticated = false) {
  const f = await sessionHttpFixture();
  let cookie = "";
  if (authenticated) {
    const response = await nativeFetch(`${f.base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(cookie);
  }
  globalThis.fetch = async (input, init = {}) => {
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
    const response = await nativeFetch(new URL(path, f.base), {
      ...init,
      headers,
    });
    const received = response.headers.get("set-cookie");
    if (received) cookie = received.split(";")[0];
    return response;
  };
  return {
    f,
    user: userEvent.setup({ document: dom.window.document }),
    renderAt(hash = "") {
      dom.window.history.replaceState({}, "", `/${hash}`);
      render(<App />);
    },
    async close() {
      cleanup();
      globalThis.fetch = nativeFetch;
      await f.close();
    },
  };
}
void test("released is labeled as an explicit release record, never evidence of deployment", () => {
  assert.equal(versionStateNames.released, "출시 확정");
  assert.deepEqual(Object.keys(versionStateNames), [
    "planned",
    "released",
    "archived",
  ]);
});
void test("login omits promotional self-introduction while retaining title, private identity, password semantics and real error recovery", async () => {
  const s = await setup();
  try {
    s.renderAt();
    const input = await screen.findByLabelText("소유자 비밀번호");
    assert.equal(
      screen.queryByRole("heading", { name: /생각을 붙이고/ }) === null,
      true,
    );
    assert.equal(
      screen.queryByText("SMALL NOTES. CLEAR DIRECTION.") === null,
      true,
    );
    assert.equal(
      screen.queryByText("붙여 두면, 잊지 않으니까.") === null,
      true,
    );
    assert.equal(
      screen.queryByText("STICKER — FOR YOUR NEXT LITTLE BIG THING.") === null,
      true,
    );
    assert.ok(
      screen.getByRole("heading", { name: "나의 작업 공간으로", level: 1 }),
    );
    assert.ok(screen.getByText("비공개 · 소유자 인증"));
    assert.match(document.querySelector(".logo")?.textContent ?? "", /스티커/);
    assert.equal(input.getAttribute("type"), "password");
    assert.equal(input.getAttribute("autocomplete"), "current-password");
    await s.user.type(input, "incorrect");
    await s.user.click(screen.getByRole("button", { name: "작업 공간 열기" }));
    assert.ok(await screen.findByRole("alert"));
    await s.user.clear(input);
    await s.user.type(input, password);
    await s.user.click(screen.getByRole("button", { name: "작업 공간 열기" }));
    await screen.findByRole("heading", { name: "내 작업 공간" });
  } finally {
    await s.close();
  }
});
void test("empty versions expose their state and create action without a how-to paragraph", async () => {
  const s = await setup(true);
  try {
    s.renderAt(`#section=versions&project=${s.f.project.id}`);
    await screen.findByRole("heading", { name: "버전과 릴리스", level: 1 });
    assert.equal(
      screen.queryByText(/버전을 만들고 목표 이슈를 연결해 보세요/) === null,
      true,
    );
    assert.ok(screen.getByRole("heading", { name: "버전 없음" }));
    await s.user.click(screen.getByRole("button", { name: "첫 버전 만들기" }));
    const dialog = await screen.findByRole("dialog", { name: "새로운 버전" });
    assert.ok(within(dialog).getByLabelText("버전 이름"));
    assert.ok(within(dialog).getByRole("button", { name: "버전 만들기" }));
  } finally {
    await s.close();
  }
});
void test("version cards, detail and owner review use the truthful released label without changing stored state", async () => {
  const s = await setup(true);
  try {
    const version = s.f.instance.store.createVersion(sessionOwner, {
      projectId: s.f.project.id,
      name: "Recorded release",
    });
    s.f.instance.store.releases.release(sessionOwner, version.id, {
      revision: version.revision,
      confirm: true,
      operationId: randomUUID(),
    });
    s.renderAt(`#section=versions&project=${s.f.project.id}`);
    await screen.findByText("출시 확정");
    assert.equal(screen.queryByText("배포됨") === null, true);
    await s.user.click(
      screen.getByRole("button", { name: `${version.name} 버전 상세` }),
    );
    await screen.findByText(/출시 확정 · r/);
    await s.user.click(screen.getByRole("button", { name: "출시 검토" }));
    const review = await screen.findByRole("dialog", {
      name: `${version.name} 출시 검토`,
    });
    assert.ok(within(review).getByRole("option", { name: "출시 확정" }));
    assert.equal(within(review).queryByText("배포됨") === null, true);
    const readiness = s.f.instance.store.releases.readiness(
      sessionOwner,
      version.id,
    );
    assert.equal(readiness.version.state, "released");
    assert.equal(readiness.releaseHistory.length, 1);
  } finally {
    await s.close();
  }
});
