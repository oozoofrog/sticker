import { test, expect } from "@playwright/test";
import { projectSchema, versionSchema } from "../../server/response-schemas.js";
const password =
  process.env.STICKER_TEST_PASSWORD || "ephemeral-sticker-test-password";
test("direct login and version controls replace promotional/tutorial copy and release labels stay truthful", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  if (testInfo.project.name === "iphone") {
    await page.setViewportSize({ width: 375, height: 812 });
    expect(page.viewportSize()?.width).toBe(375);
  }
  const noOverflow = async () => {
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
  };
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "나의 작업 공간으로", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("비공개 · 소유자 인증", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".login-story")).toHaveCount(0);
  await expect(
    page.getByText("SMALL NOTES. CLEAR DIRECTION.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("STICKER — FOR YOUR NEXT LITTLE BIG THING.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("소유자 비밀번호")).toBeFocused();
  await noOverflow();
  await page.screenshot({
    path: testInfo.outputPath("copy-login.png"),
    fullPage: true,
  });
  await page.getByLabel("소유자 비밀번호").fill("incorrect-fixture-password");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("소유자 비밀번호").fill(password);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "내 작업 공간", level: 1 }),
  ).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "작업 공간 메뉴" });
  await navigation
    .getByRole("button", { name: "프로젝트", exact: true })
    .click();
  await page
    .getByRole("main")
    .getByRole("button", { name: "새 프로젝트", exact: true })
    .click();
  const projectName = `직접 조작 ${testInfo.project.name}`;
  await page.getByLabel("프로젝트 이름").fill(projectName);
  await page
    .getByLabel("프로젝트 키")
    .fill(`C${Date.now().toString().slice(-7)}`);
  const projectResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/projects" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "프로젝트 만들기", exact: true })
    .click();
  const project = projectSchema.parse(await (await projectResponse).json());
  await expect(
    page.getByRole("heading", { name: projectName, exact: true }),
  ).toBeVisible();
  await navigation
    .getByRole("button", { name: "버전과 릴리스", exact: true })
    .click();
  await page.getByLabel("버전 프로젝트 필터").selectOption(project.id);
  await expect(
    page.getByRole("heading", { name: "버전 없음", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/버전을 만들고 목표 이슈를 연결해 보세요/),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "첫 버전 만들기", exact: true }),
  ).toBeVisible();
  await noOverflow();
  await page.screenshot({
    path: testInfo.outputPath("copy-empty-versions.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "첫 버전 만들기", exact: true })
    .click();
  await page.getByLabel("버전 이름").fill("확정 v1");
  const versionResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/versions" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "버전 만들기", exact: true }).click();
  const version = versionSchema.parse(await (await versionResponse).json());
  expect(version.state).toBe("planned");
  await page
    .getByRole("button", { name: "확정 v1 버전 상세", exact: true })
    .click();
  await page.getByRole("button", { name: "출시 검토", exact: true }).click();
  await expect(page.getByLabel("변경할 출시 상태")).toBeVisible();
  await expect(
    page.getByRole("option", { name: "출시 확정", exact: true }),
  ).toHaveCount(1);
  await page.getByLabel("변경할 출시 상태").selectOption("released");
  await page.getByLabel(/상태 기록을 확인합니다/).check();
  const releaseResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/versions/${version.id}/release` &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "출시 상태 확정", exact: true })
    .click();
  expect((await releaseResponse).ok()).toBe(true);
  await expect(
    page.getByText("출시 상태가 기록되었습니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByText(/출시 확정 · r/)).toBeVisible();
  await expect(page.getByText("배포됨", { exact: true })).toHaveCount(0);
  await noOverflow();
  await page.screenshot({
    path: testInfo.outputPath("copy-release-state.png"),
    fullPage: true,
  });
});
