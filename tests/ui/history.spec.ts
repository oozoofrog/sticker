import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  projectSchema,
  issueSchema,
  issueDetailSchema,
  versionSchema,
} from "../../server/response-schemas.js";
import { historyListSchema } from "../../server/contracts/history.js";
async function fixture(page: Page, request: APIRequestContext, info: TestInfo) {
  const origin = new URL(info.project.use.baseURL || "http://127.0.0.1:8788")
    .origin;
  await request.post("/api/session", {
    data: { password: "ephemeral-sticker-test-password" },
  });
  const project = projectSchema.parse(
    await (
      await request.post("/api/projects", {
        headers: { origin },
        data: {
          key: `H${Date.now().toString().slice(-7)}`,
          name: `변경 이력 ${info.project.name}`,
        },
      })
    ).json(),
  );
  const issue = issueSchema.parse(
    await (
      await request.post("/api/issues", {
        headers: { origin },
        data: {
          projectId: project.id,
          title: "처음 제목",
          description: "처음 본문",
        },
      })
    ).json(),
  );
  await page.context().addCookies((await request.storageState()).cookies);
  await page.setViewportSize(
    info.project.name === "iphone"
      ? { width: 375, height: 812 }
      : { width: 1440, height: 960 },
  );
  return { project, issue, origin };
}
async function openHistory(page: Page) {
  const panel = page.getByRole("dialog", { name: "이슈 상세", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /^변경 기록/ }).click();
  const trigger = panel.getByRole("button", {
    name: "r1 → r2 비교",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  if (page.viewportSize()?.width === 375) await trigger.tap();
  else await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "변경 비교 · r1 → r2",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return { panel, dialog, trigger };
}
test("field comparison and selected owner restore remain explicit through a concurrent edit on desktop and 375px", async ({
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  const f = await fixture(page, request, info);
  const version = versionSchema.parse(
    await (
      await request.post("/api/versions", {
        headers: { origin: f.origin },
        data: { projectId: f.project.id, name: "삭제할 버전" },
      })
    ).json(),
  );
  const long =
    "![외부 이미지](https://example.invalid/image.png) <script>inert</script>\n" +
    "긴 본문 검토 ".repeat(1200);
  expect(
    (
      await request.patch(`/api/issues/${f.issue.id}`, {
        headers: { origin: f.origin },
        data: {
          revision: 1,
          title: "수정 제목",
          description: long,
          foundVersionId: version.id,
        },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.delete(`/api/versions/${version.id}`, {
        headers: { origin: f.origin },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/#project=${f.project.id}&issue=${f.issue.id}`);
  let opened = await openHistory(page);
  await expect(
    opened.dialog.getByText(`사용 불가 · ${version.id}`, { exact: true }),
  ).toBeVisible();
  await expect(opened.dialog.locator("img,script")).toHaveCount(0);
  const values = opened.dialog
    .getByRole("region", { name: "본문", exact: true })
    .locator(".history-values > div");
  const [before, after] = await Promise.all([
    values.nth(0).boundingBox(),
    values.nth(1).boundingBox(),
  ]);
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  if (before && after) {
    if (info.project.name === "iphone")
      expect(after.y).toBeGreaterThan(before.y);
    else expect(after.x).toBeGreaterThan(before.x);
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: info.outputPath("history-comparison.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(opened.dialog).toBeHidden();
  await expect(opened.trigger).toBeFocused();
  await opened.trigger.press("Enter");
  opened = {
    ...opened,
    dialog: page.getByRole("dialog", {
      name: "변경 비교 · r1 → r2",
      exact: true,
    }),
  };
  await opened.dialog
    .getByRole("checkbox", { name: "본문 복원 선택", exact: true })
    .check();
  await opened.dialog
    .getByRole("button", { name: "복원 검토", exact: true })
    .click();
  await expect(
    opened.dialog.getByRole("heading", { name: "복원 검토 · r3", exact: true }),
  ).toBeVisible();
  expect(
    (
      await request.patch(`/api/issues/${f.issue.id}`, {
        headers: { origin: f.origin },
        data: {
          revision: 3,
          title: "동시 수정 유지",
          description: "동시 수정 본문",
        },
      })
    ).ok(),
  ).toBeTruthy();
  await opened.dialog
    .getByRole("button", { name: "선택 필드 복원", exact: true })
    .click();
  await expect(
    opened.dialog.getByText("동시 수정 본문", { exact: true }),
  ).toBeVisible();
  await expect(
    opened.dialog.getByRole("button", { name: "선택 필드 복원", exact: true }),
  ).toHaveCount(0);
  await opened.dialog
    .getByRole("button", { name: "최신 값으로 다시 검토", exact: true })
    .click();
  await expect(
    opened.dialog.getByRole("heading", { name: "복원 검토 · r4", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("history-restore-review.png"),
    fullPage: true,
  });
  await opened.dialog
    .getByRole("button", { name: "선택 필드 복원", exact: true })
    .click();
  await expect(opened.dialog).toBeHidden();
  await expect(opened.trigger).toBeFocused();
  await expect(
    opened.panel.getByRole("heading", { name: "동시 수정 유지", exact: true }),
  ).toBeVisible();
  const current = issueDetailSchema.parse(
    await (await request.get(`/api/issues/${f.issue.id}`)).json(),
  ).issue;
  expect(current.description).toBe("처음 본문");
  expect(current.title).toBe("동시 수정 유지");
  expect(current.revision).toBe(5);
  const history = historyListSchema.parse(
    await (await request.get(`/api/issues/${f.issue.id}/history`)).json(),
  );
  const restored = history.filter((entry) => entry.action === "restored");
  expect(restored).toHaveLength(1);
  expect(restored[0].fields).toEqual(["description"]);
});
test("Back dismissal preserves selection and a lost restore reply retries one operation without a second revision", async ({
  page,
  request,
}, info) => {
  test.setTimeout(60_000);
  const f = await fixture(page, request, info);
  expect(
    (
      await request.patch(`/api/issues/${f.issue.id}`, {
        headers: { origin: f.origin },
        data: {
          revision: 1,
          title: "복원 재시도 대상",
          description: "변경 본문",
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/#project=${f.project.id}`);
  const card = page
    .getByRole("main")
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: "복원 재시도 대상", exact: true }),
    });
  await expect(card).toBeVisible();
  await card.click();
  let opened = await openHistory(page);
  await opened.dialog
    .getByRole("checkbox", { name: "본문 복원 선택", exact: true })
    .check();
  const rejected = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toBe("선택한 복원 내용을 버릴까요?");
    await dialog.dismiss();
  });
  await page.evaluate(() => {
    window.history.back();
  });
  await rejected;
  await expect(page).toHaveURL(new RegExp(`issue=${f.issue.id}`));
  await expect(
    opened.dialog.getByRole("checkbox", {
      name: "본문 복원 선택",
      exact: true,
    }),
  ).toBeChecked();
  const accepted = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.message()).toBe("선택한 복원 내용을 버릴까요?");
    await dialog.accept();
  });
  await page.evaluate(() => {
    window.history.back();
  });
  await accepted;
  await expect(opened.panel).toBeHidden();
  await expect(page).not.toHaveURL(new RegExp(`issue=${f.issue.id}`));
  await page.evaluate(() => {
    window.history.forward();
  });
  opened = await openHistory(page);
  await expect(
    opened.dialog.getByRole("checkbox", {
      name: "본문 복원 선택",
      exact: true,
    }),
  ).not.toBeChecked();
  await opened.dialog
    .getByRole("checkbox", { name: "본문 복원 선택", exact: true })
    .check();
  await opened.dialog
    .getByRole("button", { name: "복원 검토", exact: true })
    .click();
  await expect(
    opened.dialog.getByRole("heading", { name: "복원 검토 · r2", exact: true }),
  ).toBeVisible();
  let lost = false;
  const bodies: string[] = [];
  await page.route(`**/api/issues/${f.issue.id}/restore`, async (route) => {
    bodies.push(route.request().postData() ?? "");
    if (!lost) {
      lost = true;
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await opened.dialog
    .getByRole("button", { name: "선택 필드 복원", exact: true })
    .click();
  const retry = opened.dialog.getByRole("button", {
    name: "복원 결과 다시 확인",
    exact: true,
  });
  await expect(retry).toBeVisible();
  expect(
    issueDetailSchema.parse(
      await (await request.get(`/api/issues/${f.issue.id}`)).json(),
    ).issue.revision,
  ).toBe(3);
  await retry.dblclick();
  await expect(opened.dialog).toBeHidden();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  const current = issueDetailSchema.parse(
    await (await request.get(`/api/issues/${f.issue.id}`)).json(),
  ).issue;
  expect(current.revision).toBe(3);
  expect(current.description).toBe("처음 본문");
  expect(current.title).toBe("복원 재시도 대상");
  expect(
    historyListSchema
      .parse(
        await (await request.get(`/api/issues/${f.issue.id}/history`)).json(),
      )
      .filter((entry) => entry.action === "restored"),
  ).toHaveLength(1);
});
