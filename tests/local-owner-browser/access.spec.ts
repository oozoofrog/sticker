import { test, expect } from "@playwright/test";
test("explicit local-owner fixture opens without password or cookie and reports access truthfully", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize(
    info.project.name === "iphone"
      ? { width: 375, height: 812 }
      : { width: 1440, height: 960 },
  );
  await page.goto("/");
  await expect(
    page.locator('[role="status"]:visible').filter({ hasText: "로컬 소유자" }),
  ).toBeVisible();
  await expect(page.getByLabel("소유자 비밀번호")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "로그아웃" })).toHaveCount(0);
  expect(
    (await page.context().cookies()).filter((cookie) =>
      cookie.name.startsWith("sticker_"),
    ),
  ).toEqual([]);
  const blocked = await request.post("/api/projects", {
    headers: { origin: "http://evil.example.test" },
    data: { key: "BAD", name: "차단" },
  });
  expect(blocked.status()).toBe(403);
  const allowed = await request.post("/api/projects", {
    headers: { origin: "http://127.0.0.1:8790" },
    data: {
      key: `L${info.project.name.toUpperCase()}`,
      name: `격리 ${info.project.name}`,
    },
  });
  expect(allowed.status()).toBe(201);
  await page.getByRole("button", { name: "작업 공간 새로고침" }).click();
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: `격리 ${info.project.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: info.outputPath("local-owner-access.png"),
    fullPage: true,
  });
});
