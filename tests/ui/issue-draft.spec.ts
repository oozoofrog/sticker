import { test, expect, type Page } from "@playwright/test";
import { projectSchema, issueSchema } from "../../server/response-schemas.js";

async function answerDiscard(
  page: Page,
  action: () => Promise<unknown>,
  discard: boolean,
) {
  const shown = page.waitForEvent("dialog");
  const triggered = action();
  const dialog = await shown;
  expect(dialog.type()).toBe("confirm");
  expect(dialog.message()).toContain("초안");
  if (discard) await dialog.accept();
  else await dialog.dismiss();
  await triggered;
}

test("ordinary drafts retain input on cancel and issue/project departure; confirmed save exits cleanly", async ({
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
  const prefix = `D${Date.now().toString().slice(-6)}`;
  const createProject = async (suffix: string) =>
    projectSchema.parse(
      await (
        await request.post("/api/projects", {
          headers: { origin },
          data: { key: prefix + suffix, name: `초안 합성 ${suffix}` },
        })
      ).json(),
    );
  const project = await createProject("A"),
    other = await createProject("B");
  const createIssue = async (title: string) =>
    issueSchema.parse(
      await (
        await request.post("/api/issues", {
          headers: { origin },
          data: { projectId: project.id, title },
        })
      ).json(),
    );
  const first = await createIssue("합성 원래 이슈"),
    second = await createIssue("합성 다음 이슈");
  await page.context().addCookies((await request.storageState()).cookies);
  if (info.project.name === "iphone")
    await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/#project=${project.id}`);
  await page
    .getByRole("button", { name: "새 이슈", exact: true })
    .first()
    .click();
  let editor = page.getByRole("dialog", { name: "새로운 스티커" });
  await editor.getByLabel("이슈 제목").fill("합성 미저장 제목");
  await answerDiscard(
    page,
    () => editor.getByRole("button", { name: "취소", exact: true }).click(),
    false,
  );
  await expect(editor.getByLabel("이슈 제목")).toHaveValue("합성 미저장 제목");
  await editor.getByLabel("설명", { exact: true }).fill("합성 미저장 본문");
  await editor.getByLabel("우선순위", { exact: true }).selectOption("high");
  await answerDiscard(page, () => page.keyboard.press("Escape"), false);
  await expect(editor.getByLabel("설명", { exact: true })).toHaveValue(
    "합성 미저장 본문",
  );
  await expect(editor.getByLabel("우선순위", { exact: true })).toHaveValue(
    "high",
  );
  await expect(editor).toBeVisible();
  const bounds = await editor.boundingBox();
  const viewport = page.viewportSize();
  if (!bounds || !viewport) throw new Error("Missing fixture viewport bounds");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({
    path: info.outputPath("retained-draft.png"),
    fullPage: true,
  });
  await answerDiscard(
    page,
    () => editor.getByRole("button", { name: "창 닫기" }).click(),
    true,
  );
  await expect(editor).toHaveCount(0);
  await page
    .getByRole("button", { name: "새 이슈", exact: true })
    .first()
    .click();
  editor = page.getByRole("dialog", { name: "새로운 스티커" });
  let unexpectedDialogs = 0;
  const unexpected = (dialog: import("@playwright/test").Dialog) => {
    unexpectedDialogs++;
    void dialog.dismiss();
  };
  page.on("dialog", unexpected);
  await editor.getByRole("button", { name: "취소", exact: true }).click();
  await expect(editor).toHaveCount(0);
  page.off("dialog", unexpected);
  expect(unexpectedDialogs).toBe(0);

  await page.goto(`/#project=${project.id}&issue=${first.id}`);
  await page.getByRole("button", { name: "이슈 편집", exact: true }).click();
  editor = page.getByRole("dialog", { name: `${first.key} 편집` });
  await editor.getByLabel("이슈 제목").fill("합성 변경 제목");
  await editor.getByLabel("설명", { exact: true }).fill("합성 변경 본문");
  await editor.getByLabel("우선순위", { exact: true }).selectOption("urgent");
  const current = page.url();
  for (const next of [
    `project=${project.id}&issue=${second.id}`,
    `project=${other.id}`,
  ]) {
    await answerDiscard(
      page,
      () =>
        page.evaluate((hash) => {
          window.location.hash = hash;
        }, next),
      false,
    );
    await expect(page).toHaveURL(current);
    await expect(editor.getByLabel("이슈 제목")).toHaveValue("합성 변경 제목");
    await expect(editor.getByLabel("설명", { exact: true })).toHaveValue(
      "합성 변경 본문",
    );
    await expect(editor.getByLabel("우선순위", { exact: true })).toHaveValue(
      "urgent",
    );
  }
  page.on("dialog", unexpected);
  await editor.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "합성 변경 제목",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `project=${project.id}&issue=${second.id}`);
  await expect(
    page.getByRole("heading", {
      name: "합성 다음 이슈",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  expect(unexpectedDialogs).toBe(0);
  page.off("dialog", unexpected);
  const saved = (await (
    await request.get(`/api/issues/${first.id}`)
  ).json()) as {
    issue: { title: string; description: string; priority: string };
  };
  expect(saved.issue).toMatchObject({
    title: "합성 변경 제목",
    description: "합성 변경 본문",
    priority: "urgent",
  });
});
