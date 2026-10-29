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
  for (const name of ["MCP", "Sticker 스킬", "변경 계획 확인"]) {
    const checkbox = dialog.getByRole("checkbox", { name, exact: true });
    const input = await checkbox.boundingBox();
    const label = await checkbox.locator("..").locator("span").boundingBox();
    expect(input).not.toBeNull();
    expect(label).not.toBeNull();
    if (!input || !label) throw new Error("Checkbox layout missing");
    expect(input.width).toBeLessThanOrEqual(22);
    expect(
      Math.abs(input.y + input.height / 2 - label.y - label.height / 2),
    ).toBeLessThanOrEqual(2);
    expect(label.x - input.x - input.width).toBeGreaterThanOrEqual(4);
    expect(label.x - input.x - input.width).toBeLessThanOrEqual(12);
  }
  await expect(dialog.getByRole("combobox", { name: "설치 대상" })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByText("로컬 실행 시 선택", { exact: true }),
  ).toBeVisible();
  expect(
    await dialog
      .locator(".agent-install-targets")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
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
  const screenshot = testInfo.outputPath(
    "agent-install-download-requested.png",
  );
  await dialog.screenshot({ path: screenshot });
  await testInfo.attach(
    "Agent installer: download requested, local execution unverified",
    { path: screenshot, contentType: "image/png" },
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
