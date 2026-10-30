import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React from "react";
const dom = new JSDOM("<html><body></body></html>", {
  url: "http://localhost:8787/",
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
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
const { MarkdownContent } =
  await import("../../client/features/markdown/MarkdownContent.js");
const { MarkdownEditor } =
  await import("../../client/features/markdown/MarkdownEditor.js");
void test("issue Markdown renders GFM structure while URLs, HTML and images stay inert", () => {
  try {
    const view = render(
      <MarkdownContent
        value={
          '# 제목\n\n**굵게** *강조* ~~취소~~\n\n1. 순서\n   - 하위\n\n- [x] 완료\n\n| 열 | 값 |\n|---|---|\n| A | B |\n\n> 인용\n\n```html\n<script>code</script>\n```\n\n<script>alert(1)</script>\n<img src="https://evil.test/raw">\n![원격](https://evil.test/image)\n![참조][img]\n\n[img]: https://evil.test/ref\n\n[정상](https://example.test/docs) [위험](javascript:alert) [상대](//evil.test) [정보](https://user:pass@example.test)'
        }
      />,
    );
    assert.ok(screen.getByRole("heading", { name: "제목" }));
    assert.equal(view.container.querySelectorAll("table").length, 1);
    assert.equal(view.container.querySelectorAll("ol ul").length, 1);
    assert.equal(
      view.container.querySelectorAll("strong,em,del,blockquote").length,
      4,
    );
    assert.equal(
      view.container.querySelectorAll("img,script,iframe,svg,style").length,
      0,
    );
    assert.equal(view.container.querySelectorAll("a").length, 1);
    assert.equal(
      screen.getByRole("link").getAttribute("rel"),
      "noopener noreferrer",
    );
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox");
    assert.equal(checkbox.disabled, true);
    assert.equal(checkbox.checked, true);
    assert.ok(screen.getByText("<script>code</script>"));
  } finally {
    cleanup();
  }
});
void test("preview preserves source, textarea selection and form submission boundaries", async () => {
  const { userEvent } = await import("@testing-library/user-event");
  const user = userEvent.setup({ document: dom.window.document });
  const source = "# 원문\n\n  **띄어쓰기**\n";
  let submissions = 0;
  function Composer() {
    const [value, setValue] = React.useState(source);
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submissions++;
        }}
      >
        <MarkdownEditor
          label="설명"
          value={value}
          onChange={setValue}
          maxLength={100000}
          rows={5}
        />
        <button>저장</button>
      </form>
    );
  }
  try {
    render(<Composer />);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "설명",
    });
    input.setSelectionRange(2, 4);
    await user.click(screen.getByRole("button", { name: "설명 미리보기" }));
    assert.ok(screen.getByRole("heading", { name: "원문" }));
    assert.equal(submissions, 0);
    await user.click(screen.getByRole("button", { name: "설명 작성" }));
    assert.equal(screen.getByRole("textbox"), input);
    assert.equal(input.value, source);
    assert.equal(input.selectionStart, 2);
    assert.equal(input.maxLength, 100000);
    await user.click(screen.getByRole("button", { name: "저장" }));
    assert.equal(submissions, 1);
  } finally {
    cleanup();
  }
});
void test("issue editor previews and saves original Markdown through the real API", async () => {
  const { sessionHttpFixture } = await import("../session-fixture.js");
  const { bootstrapSchema, issueSchema } =
    await import("../../server/response-schemas.js");
  const { IssueEditor } = await import("../../client/editors.js");
  const { userEvent } = await import("@testing-library/user-event");
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const f = await sessionHttpFixture();
  const nativeFetch = globalThis.fetch;
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
      : nativeFetch(input, init);
  try {
    const data = bootstrapSchema.parse(
      await (await f.call("/bootstrap")).json(),
    );
    let saved = false;
    render(
      <IssueEditor
        data={data}
        issue={f.issue}
        onClose={() => {}}
        onSaved={() => {
          saved = true;
        }}
      />,
    );
    const source = "# 편집 원문\n\n**의도**\n\n```ts\n<tag>\n```\n";
    fireEvent.change(screen.getByRole("textbox", { name: "설명" }), {
      target: { value: source },
    });
    const user = userEvent.setup({ document: dom.window.document });
    await user.click(screen.getByRole("button", { name: "설명 미리보기" }));
    assert.ok(screen.getByRole("heading", { name: "편집 원문" }));
    await user.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() => {
      assert.equal(saved, true);
    });
    const response = await f.call(`/issues/${f.issue.id}`);
    const detail = (await response.json()) as { issue: unknown };
    assert.equal(issueSchema.parse(detail.issue).description, source);
    cleanup();
    const { default: IssuePanel } = await import("../../client/IssuePanel.js");
    render(
      <IssuePanel
        id={f.issue.id}
        data={data}
        onClose={() => {}}
        onChanged={async () => {}}
      />,
    );
    await screen.findByRole("heading", { name: "편집 원문" });
    const comment = "  ## 댓글 원문\n\n**결과**\n  ";
    fireEvent.change(screen.getByRole("textbox", { name: "댓글 작성" }), {
      target: { value: comment },
    });
    await user.click(
      screen.getByRole("button", { name: "댓글 작성 미리보기" }),
    );
    assert.ok(screen.getByRole("heading", { name: "댓글 원문" }));
    await user.click(screen.getByRole("button", { name: "댓글 남기기" }));
    await waitFor(() => {
      assert.equal(
        document.querySelectorAll(".comment .issue-markdown h2").length,
        1,
      );
    });
    const { issueDetailSchema } =
      await import("../../server/response-schemas.js");
    const savedDetail = issueDetailSchema.parse(
      await (await f.call(`/issues/${f.issue.id}`)).json(),
    );
    assert.equal(savedDetail.comments[0].body, comment.trim());
    await user.click(screen.getByRole("button", { name: "댓글 작성 작성" }));
    const retained = "## 재시도 초안\n\n**보존**";
    fireEvent.change(screen.getByRole("textbox", { name: "댓글 작성" }), {
      target: { value: retained },
    });
    await user.click(
      screen.getByRole("button", { name: "댓글 작성 미리보기" }),
    );
    const routedFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      typeof input === "string" &&
      input.endsWith("/comments") &&
      init?.method === "POST"
        ? Promise.reject(new Error("fixture offline"))
        : routedFetch(input, init);
    await user.click(screen.getByRole("button", { name: "댓글 남기기" }));
    await screen.findByText("fixture offline");
    await user.click(screen.getByRole("button", { name: "댓글 작성 작성" }));
    assert.equal(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "댓글 작성" })
        .value,
      retained,
    );
    globalThis.fetch = routedFetch;
    cleanup();
    render(
      <IssueEditor
        data={data}
        issue={f.issue}
        onClose={() => {}}
        onSaved={() => {
          throw new Error("stale write must not succeed");
        }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "설명" }), {
      target: { value: retained },
    });
    await user.click(screen.getByRole("button", { name: "설명 미리보기" }));
    await user.click(screen.getByRole("button", { name: "변경 저장" }));
    await screen.findByText("충돌 · 초안 보존됨");
    await user.click(screen.getByRole("button", { name: "설명 작성" }));
    assert.equal(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "설명" }).value,
      retained,
    );
    assert.equal(
      issueDetailSchema.parse(
        await (await f.call(`/issues/${f.issue.id}`)).json(),
      ).issue.description,
      source,
    );
  } finally {
    cleanup();
    globalThis.fetch = nativeFetch;
    await f.close();
  }
});
void test("plain text, malformed links and maximum description remain readable without truncation", () => {
  const source = "첫 줄\n둘째 줄\n\n".padEnd(100000, "x");
  try {
    const view = render(<MarkdownContent value={source} />);
    assert.equal(view.container.querySelectorAll("p").length, 2);
    assert.equal(
      view.container.querySelectorAll("p")[0].textContent,
      "첫 줄\n둘째 줄",
    );
    assert.equal(
      view.container.querySelectorAll("p")[1].textContent.length,
      100000 - "첫 줄\n둘째 줄\n\n".length,
    );
    view.rerender(
      <MarkdownContent
        value={
          '[broken](not-a-url) [file](file:///tmp/a) [data](data:text/html,x) <iframe src="x"></iframe>'
        }
      />,
    );
    assert.equal(view.container.querySelectorAll("a,iframe").length, 0);
  } finally {
    cleanup();
  }
});
void test("returning to writing puts keyboard focus back in the retained source", async () => {
  const { userEvent } = await import("@testing-library/user-event");
  const user = userEvent.setup({ document: dom.window.document });
  try {
    render(
      <MarkdownEditor
        label="댓글 작성"
        value="원문"
        onChange={() => {}}
        maxLength={20000}
        rows={3}
      />,
    );
    const input = screen.getByRole("textbox");
    await user.click(
      screen.getByRole("button", { name: "댓글 작성 미리보기" }),
    );
    await user.click(screen.getByRole("button", { name: "댓글 작성 작성" }));
    assert.ok(
      document.activeElement === input,
      "writing textarea regains focus",
    );
  } finally {
    cleanup();
  }
});
void test("independent composers keep unique labels and disabled controls; empty preview never changes source", async () => {
  const { userEvent } = await import("@testing-library/user-event");
  const user = userEvent.setup({ document: dom.window.document });
  let edits = 0;
  try {
    render(
      <>
        <MarkdownEditor
          label="설명"
          value=""
          onChange={() => {
            edits++;
          }}
          maxLength={100000}
          rows={5}
        />
        <MarkdownEditor
          label="댓글 작성"
          value="**유지**"
          onChange={() => {
            edits++;
          }}
          maxLength={20000}
          rows={3}
          disabled
        />
      </>,
    );
    const fields = screen.getAllByRole<HTMLTextAreaElement>("textbox");
    assert.notEqual(fields[0].id, fields[1].id);
    assert.equal(fields[1].disabled, true);
    assert.equal(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "댓글 작성 미리보기",
      }).disabled,
      true,
    );
    await user.click(screen.getByRole("button", { name: "설명 미리보기" }));
    assert.ok(screen.getByText("내용 없음"));
    await user.click(screen.getByRole("button", { name: "설명 작성" }));
    assert.equal(edits, 0);
    assert.equal(fields[0].value, "");
    assert.equal(
      document.querySelectorAll("label button,label label,p div").length,
      0,
    );
  } finally {
    cleanup();
  }
});
void test("pathological nesting and delimiter floods preserve full source instead of crashing or synchronously parsing", () => {
  for (const source of [
    "> ".repeat(10000) + "text",
    "[".repeat(50000) + "]".repeat(50000),
  ]) {
    try {
      const view = render(<MarkdownContent value={source} />);
      assert.ok(
        view.container.querySelector(".markdown-source-fallback"),
        "complex content uses bounded source fallback",
      );
      assert.ok(
        view.container.querySelector(".markdown-source-fallback")
          ?.textContent === source,
        "all source characters retained",
      );
    } finally {
      cleanup();
    }
  }
});
void test("separate readers do not create duplicate footnote IDs or dangling fragment links", () => {
  try {
    const source = "note[^x]\n\n[^x]: body";
    const view = render(
      <>
        <MarkdownContent value={source} />
        <MarkdownContent value={source} />
      </>,
    );
    assert.equal(
      view.container.querySelectorAll("[id],a[href^='#'],[aria-describedby]")
        .length,
      0,
    );
  } finally {
    cleanup();
  }
});
for (const [name, source] of [
  ["25000 list items", "- a\n".repeat(25000)],
  ["33333 paragraphs", "a\n\n".repeat(33333)],
  ["33333 CR paragraphs", "a\r\r".repeat(33333)],
]) {
  void test(`line budget bounds ${name} without losing content`, () => {
    try {
      const view = render(<MarkdownContent value={source} />);
      const fallback = view.container.querySelector(
        ".markdown-source-fallback",
      );
      assert.ok(fallback, "excessive blocks use full-source fallback");
      assert.ok(fallback.textContent === source);
    } finally {
      cleanup();
    }
  });
}
