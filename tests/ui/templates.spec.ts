import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import {
  projectSchema,
  versionSchema,
  issueDetailSchema,
} from "../../server/response-schemas.js";
import { templateDetailSchema } from "../../server/contracts/templates.js";
async function fixture(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
  name: string,
) {
  const origin = new URL(baseURL || "http://127.0.0.1:8788").origin;
  await request.post("/api/session", {
    data: {
      password:
        process.env.STICKER_TEST_PASSWORD || "ephemeral-sticker-test-password",
    },
  });
  const response = await request.post("/api/projects", {
    headers: { origin },
    data: { key: `T${Date.now().toString().slice(-7)}`, name },
  });
  expect(response.status()).toBe(201);
  const project = projectSchema.parse(await response.json());
  const version = versionSchema.parse(
    await (
      await request.post("/api/versions", {
        headers: { origin },
        data: { projectId: project.id, name: "1.0" },
      })
    ).json(),
  );
  await page.context().addCookies((await request.storageState()).cookies);
  return { origin, project, version };
}
test("project examples become revisioned templates and create validated immutable issues on desktop/mobile", async ({
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  const f = await fixture(
    page,
    request,
    info.project.use.baseURL,
    `템플릿 ${info.project.name}`,
  );
  if (info.project.name === "iphone")
    await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#section=projects");
  await page
    .getByRole("button", { name: `${f.project.name} 템플릿 관리`, exact: true })
    .click();
  await expect(
    page.getByText("저장된 템플릿 없음", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "버그 예시로 만들기", exact: true })
    .click();
  const form = page.getByRole("textbox", { name: "템플릿 이름", exact: true });
  await expect(form).toHaveValue("버그");
  await form.fill("우리 버그 양식");
  await page
    .getByLabel("템플릿 본문", { exact: true })
    .fill("수정 가능한 기본 본문");
  await page.getByLabel("기본 우선순위", { exact: true }).selectOption("high");
  await page.getByLabel("기본 라벨", { exact: true }).fill("버그, 검증");
  await page.getByRole("button", { name: "템플릿 저장", exact: true }).click();
  await expect(page).toHaveURL(/template=(?!new)[^&]+/);
  await expect(
    page.getByRole("heading", { name: "우리 버그 양식 · v1", exact: true }),
  ).toBeVisible();
  const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
    "template",
  );
  if (!id) throw new Error("Template route ID missing");
  await page
    .getByLabel("템플릿 본문", { exact: true })
    .fill("버전 2 기본 본문");
  await page.getByRole("button", { name: "템플릿 저장", exact: true }).click();
  await expect(
    page.getByText("저장됨 · v2 · r2", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("템플릿 버전 기록", { exact: true }).selectOption("1");
  await expect(
    page.getByRole("region", { name: "저장된 버전 미리보기", exact: true }),
  ).toContainText("수정 가능한 기본 본문");
  await page
    .getByRole("button", { name: "프로젝트 목록", exact: true })
    .click();
  await page
    .getByRole("button", { name: new RegExp(`^${f.project.name}`) })
    .filter({
      has: page.getByRole("heading", { name: f.project.name, exact: true }),
    })
    .click();
  await page
    .locator(".heading-actions")
    .getByRole("button", { name: "새 이슈", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "새로운 스티커",
    exact: true,
  });
  await editor.getByLabel("이슈 템플릿", { exact: true }).selectOption(id);
  await expect(
    editor.getByRole("heading", { name: "우리 버그 양식 · v2", exact: true }),
  ).toBeVisible();
  await editor
    .getByLabel("이슈 제목", { exact: true })
    .fill("템플릿으로 등록한 오류");
  await editor
    .getByRole("button", { name: "이슈 만들기", exact: true })
    .click();
  await expect(
    editor.getByText("재현 절차: 필수 항목입니다.", { exact: true }),
  ).toBeVisible();
  const reproduction = editor.getByLabel("재현 절차 *", { exact: true });
  await expect(reproduction).toHaveAttribute("aria-invalid", "true");
  await reproduction.fill("화면을 열고 저장");
  await reproduction.focus();
  await page.keyboard.press("Tab");
  await expect(editor.getByLabel("기대 결과 *", { exact: true })).toBeFocused();
  await editor.getByLabel("기대 결과 *", { exact: true }).fill("한 번 저장");
  await editor.getByLabel("실제 결과 *", { exact: true }).fill("오류 발생");
  await editor
    .getByLabel("발견 버전 *", { exact: true })
    .selectOption(f.version.id);
  await editor
    .getByRole("textbox", { name: "설명", exact: true })
    .fill("이슈에서 편집한 본문");
  page.once("dialog", (dialog) => {
    void dialog.dismiss();
  });
  await editor.getByLabel("이슈 템플릿", { exact: true }).selectOption("");
  await expect(
    editor.getByRole("textbox", { name: "설명", exact: true }),
  ).toHaveValue("이슈에서 편집한 본문");
  await expect(
    editor.getByRole("region", { name: "이슈 미리보기", exact: true }),
  ).toContainText("화면을 열고 저장");
  await expect(editor.getByLabel("우선순위", { exact: true })).toHaveValue(
    "high",
  );
  await editor
    .getByRole("button", { name: "이슈 만들기", exact: true })
    .click();
  await expect(editor).toBeHidden();
  const detail = page.getByRole("dialog", { name: "이슈 상세", exact: true });
  await expect(
    detail.getByRole("heading", {
      name: "템플릿으로 등록한 오류",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  await expect(detail.locator(".template-provenance")).toContainText(
    `${id} · v2`,
  );
  const issueId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
    "issue",
  );
  if (!issueId) throw new Error("Issue route ID missing");
  const before = issueDetailSchema.parse(
    await (await request.get(`/api/issues/${issueId}`)).json(),
  );
  const current = templateDetailSchema.parse(
    await (await request.get(`/api/templates/${id}`)).json(),
  );
  await request.patch(`/api/templates/${id}`, {
    headers: { origin: f.origin },
    data: {
      name: "우리 버그 양식 변경",
      body: "기존 이슈를 바꾸지 않는 본문",
      requiredFields: [],
      defaults: {},
      revision: current.template.revision,
    },
  });
  await request.delete(`/api/templates/${id}`, {
    headers: { origin: f.origin },
    data: { revision: current.template.revision + 1 },
  });
  await page.reload();
  const after = issueDetailSchema.parse(
    await (await request.get(`/api/issues/${issueId}`)).json(),
  );
  // A deleted/updated template must not rewrite the original issue or source.
  expect(after.issue).toEqual(before.issue);
  const description = detail.locator(".description-text");
  await expect(
    description.getByText("이슈에서 편집한 본문", { exact: true }),
  ).toBeVisible();
  for (const [heading, body] of [
    ["재현 절차", "화면을 열고 저장"],
    ["기대 결과", "한 번 저장"],
    ["실제 결과", "오류 발생"],
  ]) {
    await expect(
      description.getByRole("heading", {
        name: heading,
        exact: true,
        level: 2,
      }),
    ).toBeVisible();
    await expect(description.getByText(body, { exact: true })).toBeVisible();
  }
  await detail.getByRole("button", { name: "이슈 편집", exact: true }).click();
  const savedEditor = page.getByRole("dialog", {
    name: `${before.issue.key} 편집`,
    exact: true,
  });
  await expect(
    savedEditor.getByRole("textbox", { name: "설명", exact: true }),
  ).toHaveValue(before.issue.description);
  await savedEditor.getByRole("button", { name: "취소", exact: true }).click();
  await expect(savedEditor).toBeHidden();
  await expect(detail.locator(".template-provenance")).toContainText("v2");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("template-issue.png"),
    fullPage: true,
  });
});
test("template drafts survive canceled browser Back, explicit cancel and conflict review on desktop/mobile", async ({
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  const f = await fixture(
    page,
    request,
    info.project.use.baseURL,
    `초안 ${info.project.name}`,
  );
  const create = await request.post(`/api/projects/${f.project.id}/templates`, {
    headers: { origin: f.origin },
    data: {
      name: "편집 양식",
      body: "원본",
      requiredFields: ["problem"],
      defaults: {},
      operationId: crypto.randomUUID(),
    },
  });
  expect(create.status()).toBe(201);
  const template = templateDetailSchema.parse(await create.json());
  if (info.project.name === "iphone")
    await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/#section=templates&project=${f.project.id}`);
  await page
    .getByRole("button", { name: "편집 양식 템플릿 열기", exact: true })
    .click();
  await page.getByLabel("템플릿 본문", { exact: true }).fill("보존할 초안");
  const hash = new URL(page.url()).hash;
  const backDialog = page.waitForEvent("dialog");
  await page.evaluate(() => {
    history.back();
  });
  await (await backDialog).dismiss();
  await expect(page).toHaveURL(
    new RegExp(hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  await expect(page.getByLabel("템플릿 본문", { exact: true })).toHaveValue(
    "보존할 초안",
  );
  page.once("dialog", (dialog) => {
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("템플릿 본문", { exact: true })).toHaveValue(
    "보존할 초안",
  );
  await request.patch(`/api/templates/${template.template.id}`, {
    headers: { origin: f.origin },
    data: {
      name: "외부 수정",
      body: "다른 본문",
      requiredFields: ["verification"],
      defaults: { priority: "urgent" },
      revision: 1,
    },
  });
  await page.getByRole("button", { name: "템플릿 저장", exact: true }).click();
  await expect(
    page.getByText("충돌 · 초안 보존됨", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "최신 템플릿 확인", exact: true })
    .click();
  await expect(
    page.getByText("외부 수정 · v2 · r2", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("템플릿 본문", { exact: true })).toHaveValue(
    "보존할 초안",
  );
  await page
    .getByRole("button", { name: "최신 버전 기준으로 초안 유지", exact: true })
    .click();
  await page.getByRole("button", { name: "템플릿 저장", exact: true }).click();
  await expect(
    page.getByText("저장됨 · v3 · r3", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("template-manager.png"),
    fullPage: true,
  });
});
