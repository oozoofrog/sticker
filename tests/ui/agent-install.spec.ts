import { test, expect } from "@playwright/test";
test("owner prepares reviewed installer without claiming local execution on desktop and 375px", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "iphone")
    await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page
    .getByLabel("소유자 비밀번호")
    .fill(
      process.env.STICKER_TEST_PASSWORD || "ephemeral-sticker-test-password",
    );
  await page.getByRole("button", { name: "작업 공간 열기" }).click();
  const trigger = page.getByRole("button", {
    name: "에이전트 설치",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "에이전트 설치",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  // Skill-only preparation does not require a configured live credential or grant.
  await dialog.getByRole("checkbox", { name: "MCP", exact: true }).uncheck();
  await dialog.getByRole("checkbox", { name: "변경 계획 확인" }).check();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "설치 파일 준비" }).click();
  expect((await download).suggestedFilename()).toBe(
    "sticker-agent-install-1.0.0.zip",
  );
  await expect(
    dialog.getByText("다운로드 요청됨", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("설치 완료", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
