import { test, expect } from "@playwright/test";

test("owner config copy stays manual and unverified with keyboard and clipboard recovery on desktop/375px", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(60_000);
  if (testInfo.project.name === "iphone") {
    await page.setViewportSize({ width: 375, height: 812 });
    expect(page.viewportSize()?.width).toBe(375);
  }
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page
    .getByLabel("소유자 비밀번호")
    .fill(
      process.env.STICKER_TEST_PASSWORD || "ephemeral-sticker-test-password",
    );
  await page.getByRole("button", { name: "작업 공간 열기" }).click();
  const trigger = page.getByRole("button", { name: "MCP 연결", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "MCP 연결", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("설정됨", { exact: true })).toBeVisible();
  await expect(dialog.getByText("수동", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("토큰 환경변수 필요", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("권장 권한: 읽기 전용", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("읽기·쓰기", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("모든 프로젝트", { exact: true }),
  ).toBeVisible();
  const cwd = dialog.getByLabel("소스 설치 위치 (cwd)");
  await cwd.focus();
  await expect(cwd).toBeFocused();
  await cwd.fill("relative/sticker");
  await expect(dialog.getByRole("alert")).toContainText("절대 경로");
  await expect(
    dialog.getByRole("button", { name: "Codex 설정 복사", exact: true }),
  ).toBeDisabled();
  await cwd.fill('/Volumes/팀 "A"/스티커');
  const output = dialog.getByLabel("Codex MCP 설정");
  await expect(output).toHaveAttribute("readonly", "");
  await expect(output).toHaveValue(/env_vars = \["STICKER_AGENT_TOKEN"\]/);
  await dialog
    .getByRole("button", { name: "Codex 설정 복사", exact: true })
    .click();
  await expect(dialog.getByText("설정 복사됨", { exact: true })).toBeVisible();
  const expected = await output.inputValue();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    expected,
  );
  expect(expected).toContain(String.raw`cwd = "/Volumes/팀 \"A\"/스티커"`);
  expect(expected).not.toContain("tokenHash");
  await cwd.fill("/Volumes/다른 위치/sticker");
  await expect(dialog.getByText("설정 복사됨", { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          Promise.reject(new Error("fixture clipboard rejected")),
      },
    });
  });
  await dialog
    .getByRole("button", { name: "Codex 설정 복사", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("복사 실패");
  await expect(output).toHaveValue(/cwd = "\/Volumes\/다른 위치\/sticker"/);
  await output.focus();
  await page.keyboard.press("ControlOrMeta+A");
  expect(
    await output.evaluate(
      (element) =>
        (element as HTMLTextAreaElement).selectionEnd -
        (element as HTMLTextAreaElement).selectionStart,
    ),
  ).toBe((await output.inputValue()).length);
  await expect(dialog.getByText("연결됨", { exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath("mcp-settings-copy-recovery.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(cwd).toHaveValue("");
  await expect(dialog.getByText("설정 복사됨", { exact: true })).toHaveCount(0);
});
