import { test, expect } from "@playwright/test";
import { createDocumentJourneyProject } from "../document-journey-fixture.js";
import { issueDetailSchema } from "../../server/response-schemas.js";

test("issue source survives preview, save, comments and reload with inert narrow-layout Markdown", async ({
  page,
  request,
}, info) => {
  const origin = new URL(info.project.use.baseURL || "http://127.0.0.1:8788")
    .origin;
  expect(
    (
      await request.post("/api/session", {
        data: { password: "ephemeral-sticker-test-password" },
      })
    ).ok(),
  ).toBe(true);
  const call = async (path: string, method: string, body?: unknown) => {
    const response = await request.fetch(`/api${path}`, {
      method,
      headers: { origin },
      data: body,
    });
    return {
      status: response.status(),
      body: (await response.json()) as unknown,
    };
  };
  const { project, issue } = await createDocumentJourneyProject(
    call,
    info.project.name,
  );
  await page.context().addCookies((await request.storageState()).cookies);
  await page.setViewportSize(
    info.project.name === "iphone"
      ? { width: 375, height: 812 }
      : { width: 1440, height: 960 },
  );
  const remoteRequests: string[] = [];
  await page.route("https://markdown-external.test/**", async (route) => {
    remoteRequests.push(route.request().url());
    await route.abort();
  });
  const source =
    "# 구현 계획\n\n첫 줄\n둘째 줄\n\n1. **분석**\n2. *검증*\n\n- [x] 완료\n\n| 항목 | 결과 |\n|---|---|\n| " +
    "long".repeat(90) +
    " | 통과 |\n\n```html\n<script>literal</script>\n" +
    "code".repeat(110) +
    "\n```\n\n![원격](https://markdown-external.test/image)\n<script>alert(1)</script>\n[위험](javascript:alert)\n";
  await page.goto(`/#project=${project.id}&issue=${issue.id}`);
  const panel = page.getByRole("dialog", { name: "이슈 상세", exact: true });
  await panel.getByRole("button", { name: "이슈 편집", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: `${issue.key} 편집`,
    exact: true,
  });
  await editor.getByRole("textbox", { name: "설명", exact: true }).fill(source);
  await editor
    .getByRole("button", { name: "설명 미리보기", exact: true })
    .click();
  await expect(
    editor.getByRole("heading", { name: "구현 계획", exact: true }),
  ).toBeVisible();
  expect(await editor.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  expect(
    await editor
      .locator(".markdown-preview")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await expect(
    editor.getByRole("textbox", { name: "설명", exact: true }),
  ).toBeHidden();
  await page.screenshot({
    path: info.outputPath("issue-markdown-preview.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "설명 작성", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "설명", exact: true }),
  ).toHaveValue(source);
  await expect(
    editor.getByRole("textbox", { name: "설명", exact: true }),
  ).toBeFocused();
  await editor.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(
    panel.getByRole("heading", { name: "구현 계획", exact: true }),
  ).toBeVisible();
  expect(
    issueDetailSchema.parse((await call(`/issues/${issue.id}`, "GET")).body)
      .issue.description,
  ).toBe(source);
  const comment = "## 검증 결과\n\n- **통과**\n\n```ts\nconst ok = true;\n```";
  await panel
    .getByRole("textbox", { name: "댓글 작성", exact: true })
    .fill(comment);
  await panel
    .getByRole("button", { name: "댓글 작성 미리보기", exact: true })
    .click();
  await expect(
    panel.getByRole("heading", { name: "검증 결과", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "댓글 남기기", exact: true }).click();
  await expect(
    panel
      .locator(".comment")
      .getByRole("heading", { name: "검증 결과", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    panel.getByRole("heading", { name: "구현 계획", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "검증 결과", exact: true }),
  ).toBeVisible();
  await expect(
    panel.locator(
      ".issue-markdown img,.issue-markdown script,.issue-markdown iframe",
    ),
  ).toHaveCount(0);
  expect(remoteRequests).toEqual([]);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("issue-markdown-saved.png"),
    fullPage: true,
  });
  await panel.locator(".comment").first().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("issue-markdown-comment.png"),
    fullPage: true,
  });
  await panel.getByRole("button", { name: "이슈 편집", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "설명", exact: true }),
  ).toHaveValue(source);
});
