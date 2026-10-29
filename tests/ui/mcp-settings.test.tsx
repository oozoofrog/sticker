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
const { render, screen, cleanup, within, waitFor, act } =
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
        await user.click(screen.getByRole("button", { name: "MCP 연결" }));
        return screen.findByRole("dialog", { name: "MCP 연결" });
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

void test("failed initial setup releases its fixture, DOM and fetch override", async () => {
  const failure = new Error("forced initial heading failure");
  let fixture: Awaited<ReturnType<typeof mcpSettingsFixture>> | undefined;
  let closeCalls = 0;
  try {
    await assert.rejects(
      setup(true, true, async (f) => {
        fixture = f;
        const close = f.close.bind(f);
        f.close = async () => {
          closeCalls += 1;
          await close();
        };
        assert.notEqual(globalThis.fetch, nativeFetch);
        assert.notEqual(document.body.childElementCount, 0);
        await Promise.resolve();
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(closeCalls, 1);
    assert.equal(globalThis.fetch, nativeFetch);
    assert.equal(document.body.childElementCount, 0);
    assert.ok(fixture);
    await assert.rejects(nativeFetch(`${fixture.base}/api/health`));
  } finally {
    // Keep the red regression itself from leaving a listening server behind.
    cleanup();
    globalThis.fetch = nativeFetch;
    if (closeCalls === 0) await fixture?.close();
  }
});

void test("failed setup retains both initialization and teardown failures", async () => {
  const failure = new Error("forced initial heading failure");
  const teardownFailure = new Error("forced fixture close failure");
  let fixture: Awaited<ReturnType<typeof mcpSettingsFixture>> | undefined;
  let closeCalls = 0;
  try {
    await assert.rejects(
      setup(true, true, async (f) => {
        fixture = f;
        const close = f.close.bind(f);
        f.close = async () => {
          closeCalls += 1;
          await close();
          throw teardownFailure;
        };
        await Promise.resolve();
        throw failure;
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, failure);
        assert.deepEqual(error.errors, [failure, teardownFailure]);
        return true;
      },
    );
    assert.equal(closeCalls, 1);
    assert.equal(globalThis.fetch, nativeFetch);
    assert.equal(document.body.childElementCount, 0);
    assert.ok(fixture);
    await assert.rejects(nativeFetch(`${fixture.base}/api/health`));
  } finally {
    cleanup();
    globalThis.fetch = nativeFetch;
    if (closeCalls === 0) await fixture?.close();
  }
});

void test("owner discovers MCP settings with actual grant scopes, not automatic setup or verified client claims", async () => {
  const s = await setup();
  try {
    const dialog = await s.open();
    await within(dialog).findByText("설정됨", { exact: true });
    assert.equal(
      within(dialog).getByText("Codex 연결", { exact: true }).nextElementSibling
        ?.textContent,
      "확인 안 됨",
    );
    assert.ok(within(dialog).getByText("수동", { exact: true }));
    assert.ok(within(dialog).getByText("토큰 환경변수 필요", { exact: true }));
    assert.ok(
      within(dialog).getByText("권장 권한: 읽기 전용", { exact: true }),
    );
    for (const [name, permission, scope] of [
      ["설정 read 권한", "읽기 전용", "읽기 범위"],
      ["설정 write 권한", "읽기·쓰기", "읽기 범위"],
      ["설정 all 권한", "읽기·쓰기", "모든 프로젝트"],
      ["설정 none 권한", "읽기 전용", "허용 프로젝트 없음"],
      ["설정 missing 권한", "읽기 전용", "사용 불가 · deleted-project-id"],
    ]) {
      const grant = within(dialog).getByRole("listitem", { name });
      assert.ok(within(grant).getByText(permission, { exact: true }));
      assert.ok(within(grant).getByText(scope, { exact: true }));
    }
    for (const secret of [
      ...Object.values(s.f.tokens),
      ...s.f.agents.map((grant) => grant.tokenHash),
    ])
      assert.ok(!dialog.textContent.includes(secret));
    assert.equal(
      within(dialog).queryByText("연결됨", { exact: true }) === null,
      true,
    );
  } finally {
    await s.close();
  }
});

void test("unconfigured credentials stay distinct from unverified connectivity and non-owners have no setup entrypoint", async () => {
  const s = await setup(false);
  try {
    const dialog = await s.open();
    await within(dialog).findByText("미설정", { exact: true });
    assert.equal(
      within(dialog).getByText("Codex 연결", { exact: true }).nextElementSibling
        ?.textContent,
      "확인 안 됨",
    );
    assert.ok(
      within(dialog).getByText("설정된 에이전트 없음", { exact: true }),
    );
  } finally {
    await s.close();
  }
  const agent = await setup(true, false);
  try {
    assert.equal(
      screen.queryByRole("button", { name: "MCP 연결" }) === null,
      true,
    );
  } finally {
    await agent.close();
  }
});

void test("path validation prevents copying invalid output and successful copy remains manual and unverified", async () => {
  const s = await setup();
  try {
    const dialog = await s.open();
    await within(dialog).findByText("설정됨", { exact: true });
    const copied: string[] = [];
    s.clipboard({
      writeText: (value) => {
        copied.push(value);
        return Promise.resolve();
      },
    });
    const input = within(dialog).getByLabelText("소스 설치 위치 (cwd)");
    await s.user.type(input, "relative/sticker");
    assert.match(
      (await within(dialog).findByRole("alert")).textContent,
      /절대 경로/,
    );
    assert.equal(
      within(dialog)
        .getByRole("button", { name: "Codex 설정 복사" })
        .hasAttribute("disabled"),
      true,
    );
    assert.equal(copied.length, 0);
    await s.user.clear(input);
    await s.user.type(input, '/Volumes/Team "A"/스티커');
    const output =
      within(dialog).getByLabelText<HTMLTextAreaElement>("Codex MCP 설정");
    assert.equal(output.readOnly, true);
    assert.ok(
      output.value.includes(String.raw`cwd = "/Volumes/Team \"A\"/스티커"`),
    );
    assert.ok(output.value.includes('env_vars = ["STICKER_AGENT_TOKEN"]'));
    await s.user.click(
      within(dialog).getByRole("button", { name: "Codex 설정 복사" }),
    );
    await within(dialog).findByText("설정 복사됨", { exact: true });
    assert.deepEqual(copied, [output.value]);
    assert.equal(
      within(dialog).getByText("Codex 연결", { exact: true }).nextElementSibling
        ?.textContent,
      "확인 안 됨",
    );
    await s.user.type(input, "-other");
    assert.equal(
      within(dialog).queryByText("설정 복사됨", { exact: true }) === null,
      true,
    );
  } finally {
    await s.close();
  }
});

void test("clipboard absence or rejection retains selectable output with a truthful recoverable error", async () => {
  for (const available of [false, true]) {
    const s = await setup();
    try {
      const dialog = await s.open();
      await within(dialog).findByText("설정됨", { exact: true });
      s.clipboard(
        available
          ? {
              writeText: () =>
                Promise.reject(new Error("fixture clipboard denied")),
            }
          : undefined,
      );
      await s.user.type(
        within(dialog).getByLabelText("소스 설치 위치 (cwd)"),
        "/tmp/sticker",
      );
      const output =
        within(dialog).getByLabelText<HTMLTextAreaElement>("Codex MCP 설정");
      const retained = output.value;
      await s.user.click(
        within(dialog).getByRole("button", { name: "Codex 설정 복사" }),
      );
      assert.match(
        (await within(dialog).findByRole("alert")).textContent,
        /복사/,
      );
      assert.equal(output.value, retained);
      assert.equal(
        within(dialog).queryByText("설정 복사됨", { exact: true }) === null,
        true,
      );
      await s.user.click(output);
      await s.user.keyboard("{Control>}a{/Control}");
      assert.equal(output.selectionStart, 0);
      assert.equal(output.selectionEnd, output.value.length);
    } finally {
      await s.close();
    }
  }
});

void test("settings refresh failure stays unverified, and Escape/reopen restores focus without stale copy feedback", async () => {
  const s = await setup();
  try {
    const trigger = screen.getByRole("button", {
      name: "MCP 연결",
    });
    const dialog = await s.open();
    await within(dialog).findByText("설정됨", { exact: true });
    s.state.failSettings = true;
    await s.user.click(
      within(dialog).getByRole("button", { name: "서버 설정 새로고침" }),
    );
    await within(dialog).findByRole("alert");
    assert.equal(
      within(dialog).getByText("Codex 연결", { exact: true }).nextElementSibling
        ?.textContent,
      "확인 안 됨",
    );
    await s.user.keyboard("{Escape}");
    await waitFor(() => {
      assert.equal(
        screen.queryByRole("dialog", { name: "MCP 연결" }) === null,
        true,
      );
    });
    assert.equal(document.activeElement === trigger, true);
    s.state.failSettings = false;
    const reopened = await s.open();
    await within(reopened).findByText("설정됨", { exact: true });
    assert.equal(
      within(reopened).getByLabelText<HTMLInputElement>("소스 설치 위치 (cwd)")
        .value,
      "",
    );
    assert.equal(
      within(reopened).queryByText("설정 복사됨", { exact: true }) === null,
      true,
    );
  } finally {
    await s.close();
  }
});

void test("late clipboard completion never marks a newer path as copied", async () => {
  const s = await setup();
  let complete = () => {};
  try {
    const dialog = await s.open();
    await within(dialog).findByText("설정됨", { exact: true });
    s.clipboard({
      writeText: () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    });
    const input = within(dialog).getByLabelText("소스 설치 위치 (cwd)");
    await s.user.type(input, "/tmp/sticker");
    await s.user.click(
      within(dialog).getByRole("button", { name: "Codex 설정 복사" }),
    );
    assert.ok(
      within(dialog)
        .getByRole("button", { name: "복사 중…" })
        .hasAttribute("disabled"),
    );
    await s.user.type(input, "-newer");
    await act(async () => {
      complete();
      await Promise.resolve();
    });
    assert.equal(
      within(dialog).queryByText("설정 복사됨", { exact: true }) === null,
      true,
    );
    assert.ok(
      within(dialog)
        .getByLabelText<HTMLTextAreaElement>("Codex MCP 설정")
        .value.includes('cwd = "/tmp/sticker-newer"'),
    );
  } finally {
    complete();
    await s.close();
  }
});
