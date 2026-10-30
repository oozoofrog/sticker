import { test, expect } from "@playwright/test";
import { projectSchema, issueSchema } from "../../server/response-schemas.js";
import { resourceDetailSchema } from "../../server/contracts/resources.js";
import {
  prepareDocumentJourney,
  journeyTitle,
  journeyV1,
  journeyV2,
} from "../document-journey-fixture.js";

test("HTTP-authored planning document pin stays historical through keyboard, history and narrow-layout navigation", async ({
  page,
  request,
}, info) => {
  const origin = new URL(info.project.use.baseURL || "http://127.0.0.1:8788")
    .origin;
  const login = await request.post("/api/session", {
    data: { password: "ephemeral-sticker-test-password" },
  });
  expect(login.ok()).toBe(true);
  const project = projectSchema.parse(
    await (
      await request.post("/api/projects", {
        headers: { origin },
        data: {
          key: `J${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
          name: `Planning journey ${info.project.name}`,
        },
      })
    ).json(),
  );
  const issue = issueSchema.parse(
    await (
      await request.post("/api/issues", {
        headers: { origin },
        data: { projectId: project.id, title: "기획 근거 검토" },
      })
    ).json(),
  );
  const journey = await prepareDocumentJourney(
    async (path, method, body) => {
      const response = await request.fetch(`/api${path}`, {
        method,
        headers: { origin },
        data: body,
      });
      return {
        status: response.status(),
        body: (await response.json()) as unknown,
      };
    },
    project.id,
    issue,
  );
  await page.context().addCookies((await request.storageState()).cookies);
  await page.setViewportSize(
    info.project.name === "iphone"
      ? { width: 375, height: 812 }
      : { width: 1440, height: 960 },
  );
  await page.goto(`/#project=${project.id}&issue=${issue.id}`);
  const panel = page.getByRole("dialog", { name: "이슈 상세", exact: true });
  await expect(panel.getByText("고정 버전 1", { exact: true })).toBeVisible();
  const pinned = panel.getByRole("button", { name: journeyTitle, exact: true });
  await pinned.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("region", { name: "자료 상세", exact: true });
  await expect(page).toHaveURL(
    new RegExp(`resource=${journey.current.resource.id}.*resourceVersion=1`),
  );
  await expect(
    detail.getByRole("heading", { name: "최초 기획 v1", exact: true }),
  ).toBeVisible();
  await expect(detail.getByLabel("내용 이력")).toHaveValue("1");
  await detail.getByLabel("내용 이력").selectOption("2");
  await expect(
    detail.getByRole("heading", { name: "현재 기획 v2", exact: true }),
  ).toBeVisible();
  const editButton = detail.getByRole("button", {
    name: "자료 편집",
    exact: true,
  });
  await editButton.focus();
  await page.keyboard.press("Enter");
  const edit = page.getByRole("dialog", { name: "자료 편집", exact: true });
  await expect(edit.getByLabel("Markdown 내용")).toHaveValue(journeyV2);
  await edit.getByLabel("자료 제목").focus();
  await page.keyboard.press("Tab");
  // Keyboard must remain within the active editor; exact tab order is not invented.
  await expect
    .poll(() =>
      edit.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(edit.getByLabel("자료 제목")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden();
  await expect(editButton).toBeFocused();
  const unchanged = resourceDetailSchema.parse(
    await (
      await request.get(`/api/resources/${journey.current.resource.id}`)
    ).json(),
  );
  expect(unchanged.history).toHaveLength(2);
  expect(unchanged.resource.revision).toBe(2);
  await page.goBack();
  await expect(panel).toBeVisible();
  await expect(panel.getByText("고정 버전 1", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(
    detail.getByRole("heading", { name: "최초 기획 v1", exact: true }),
  ).toBeVisible();
  await expect(detail.getByLabel("내용 이력")).toHaveValue("1");
  // CSS zoom is a layout stress proxy, not native browser chrome zoom or Safari.
  for (const zoom of [1, 2]) {
    await page.evaluate((value) => {
      document.documentElement.style.zoom = String(value);
    }, zoom);
    await detail.getByLabel("내용 이력").scrollIntoViewIfNeeded();
    await expect(detail.getByLabel("내용 이력")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath(`document-journey-css-zoom-${String(zoom)}.png`),
      fullPage: true,
    });
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  const historical = await request.get(
    `/api/resources/${journey.current.resource.id}/versions/1`,
  );
  expect(historical.ok()).toBe(true);
  expect((await historical.json()) as { markdown: string }).toMatchObject({
    markdown: journeyV1,
  });
});
