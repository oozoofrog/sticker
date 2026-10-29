import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
import { mcpSettingsFixture } from "../mcp-settings-fixture.js";

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
const { render, screen, cleanup, within, act } =
  await import("@testing-library/react");
const { userEvent } = await import("@testing-library/user-event");
const App = (await import("../../client/App.js")).default;
const nativeFetch = globalThis.fetch;
async function setup(
  configured = true,
  owner = true,
  ready: (
    fixture: Awaited<ReturnType<typeof mcpSettingsFixture>>,
  ) => Promise<unknown> = () =>
    screen.findByRole("heading", { name: "내 작업 공간", level: 1 }),
) {
  const f = await mcpSettingsFixture(configured);
  try {
    const state = { failSettings: false };
    globalThis.fetch = async (input, init = {}) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (
        new URL(path, f.base).pathname === "/api/mcp/settings" &&
        state.failSettings
      )
        return new Response(
          JSON.stringify({ error: "설정 조회 실패", code: "UNAVAILABLE" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      const headers = new Headers(init.headers);
      if (owner) headers.set("cookie", f.cookie);
      else headers.set("authorization", `Bearer ${f.tokens.read}`);
      if (init.method && !["GET", "HEAD"].includes(init.method))
        headers.set("origin", "http://localhost:8787");
      return nativeFetch(new URL(path, f.base), { ...init, headers });
    };
    const user = userEvent.setup({ document: dom.window.document });
    dom.window.history.replaceState({}, "", "/");
    render(<App />);
    await ready(f);
    return {
      f,
      user,
      state,
      clipboard(
        value: { writeText: (value: string) => Promise<void> } | undefined,
      ) {
        Object.defineProperty(dom.window.navigator, "clipboard", {
          configurable: true,
          value,
        });
      },
      async open() {
        await user.click(screen.getByRole("button", { name: "에이전트 설치" }));
        return screen.findByRole("dialog", { name: "에이전트 설치" });
      },
      async close() {
        cleanup();
        globalThis.fetch = nativeFetch;
        await f.close();
      },
    };
  } catch (error) {
    const teardownFailures: unknown[] = [];
    try {
      try {
        cleanup();
      } finally {
        globalThis.fetch = nativeFetch;
        await f.close();
      }
    } catch (teardownError) {
      teardownFailures.push(teardownError);
    }
    if (teardownFailures.length > 0) {
      throw new AggregateError(
        [error, ...teardownFailures],
        "MCP settings setup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

void test("owner install menu exposes reviewed local execution rather than installation success", async () => {
  const f = await setup();
  try {
    const dialog = await f.open();
    const q = within(dialog);
    await q.findByRole("combobox", { name: "기존 에이전트 권한" });
    const prepare = q.getByRole("button", { name: "설치 파일 준비" });
    assert.ok((prepare as HTMLButtonElement).disabled);
    await f.user.selectOptions(
      q.getByRole("combobox", { name: "기존 에이전트 권한" }),
      "read",
    );
    await f.user.click(q.getByRole("checkbox", { name: "변경 계획 확인" }));
    assert.equal((prepare as HTMLButtonElement).disabled, false);
    assert.ok(q.getAllByText(/미확인/).length > 0);
    await f.user.selectOptions(
      q.getByRole("combobox", { name: "기존 에이전트 권한" }),
      "write",
    );
    assert.ok((prepare as HTMLButtonElement).disabled);
    assert.equal(q.queryByText("설치 완료"), null);
  } finally {
    await f.close();
  }
});
void test("agents cannot discover the owner installer navigation", async () => {
  const f = await setup(true, false);
  try {
    assert.ok(screen.queryByRole("button", { name: "에이전트 설치" }) === null);
  } finally {
    await f.close();
  }
});

void test("late preparation responses cannot download after option change or modal cancellation", async () => {
  for (const close of [false, true]) {
    const f = await setup();
    const originalCreate = Object.getOwnPropertyDescriptor(
      URL,
      "createObjectURL",
    );
    assert.ok(originalCreate);
    let created = 0;
    let resolveResponse: (value: Response) => void = () => {
      throw new Error("no pending request");
    };
    try {
      const dialog = await f.open();
      const q = within(dialog);
      await q.findByRole("combobox", { name: "기존 에이전트 권한" });
      await f.user.click(q.getByRole("checkbox", { name: "MCP" }));
      await f.user.click(q.getByRole("checkbox", { name: "변경 계획 확인" }));
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes("/agent-install/bundle")
          ? new Promise<Response>((resolve) => {
              resolveResponse = resolve;
            })
          : original(input, init);
      URL.createObjectURL = () => {
        created++;
        return "blob:fixture";
      };
      await f.user.click(q.getByRole("button", { name: "설치 파일 준비" }));
      if (close) await f.user.keyboard("{Escape}");
      else await f.user.click(q.getByRole("checkbox", { name: "MCP" }));
      const bytes = new Uint8Array(22);
      new DataView(bytes.buffer).setUint32(0, 0x04034b50, true);
      await act(async () => {
        resolveResponse(
          new Response(bytes, {
            headers: {
              "content-type": "application/zip",
              "content-length": "22",
            },
          }),
        );
        await Promise.resolve();
      });
      assert.equal(created, 0);
      assert.ok(screen.queryByText("다운로드 요청됨") === null);
    } finally {
      Object.defineProperty(URL, "createObjectURL", originalCreate);
      await f.close();
    }
  }
});
