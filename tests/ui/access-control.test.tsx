import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<html><body></body></html>", {
  url: "http://localhost:8787",
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
const { render, screen, cleanup, fireEvent } =
  await import("@testing-library/react");
void test("access control distinguishes password logout, local owner and unknown mode without implying a credential", async () => {
  const { AccessControl } =
    await import("../../client/features/access/AccessControl.js");
  let logout = 0,
    reload = 0;
  try {
    const props = {
      owner: true,
      className: "fixture",
      onLogout: () => {
        logout++;
      },
      onRefresh: () => {
        reload++;
      },
    };
    const view = render(
      <AccessControl {...props} mode="password">
        로그아웃
      </AccessControl>,
    );
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    assert.equal(logout, 1);
    view.rerender(
      <AccessControl {...props} mode="trusted-loopback">
        로그아웃
      </AccessControl>,
    );
    assert.ok(screen.getByText("로컬 소유자"));
    assert.ok(screen.queryByRole("button", { name: "로그아웃" }) === null);
    view.rerender(
      <AccessControl {...props} mode={null}>
        로그아웃
      </AccessControl>,
    );
    assert.ok(screen.getByText("접속 모드 미확인"));
    fireEvent.click(screen.getByRole("button", { name: "접속 모드 새로고침" }));
    assert.equal(reload, 1);
    view.rerender(
      <AccessControl {...props} owner={false} mode="trusted-loopback">
        로그아웃
      </AccessControl>,
    );
    assert.ok(screen.getByText("에이전트"));
    assert.ok(screen.queryByText("로컬 소유자") === null);
  } finally {
    cleanup();
  }
});
