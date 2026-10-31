import { test, expect } from "@playwright/test";
const password =
  process.env.STICKER_TEST_PASSWORD || "ephemeral-sticker-test-password";
async function openProjectEditor(page: import("@playwright/test").Page) {
  await page
    .getByRole("navigation", { name: "작업 공간 메뉴" })
    .getByRole("button", { name: "프로젝트", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "프로젝트", exact: true, level: 1 }),
  ).toBeVisible();
  const trigger = page
    .getByRole("main")
    .getByRole("button", { name: "새 프로젝트", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  return trigger;
}
test("owner can build a project, track an issue, attach context and retain it after refresh", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "나의 작업 공간으로", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("소유자 비밀번호").fill(password);
  await page.getByRole("button", { name: "작업 공간 열기" }).click();
  await expect(
    page.getByRole("heading", { name: "내 작업 공간" }),
  ).toBeVisible();
  await openProjectEditor(page);
  const key = `T${Date.now().toString().slice(-7)}`;
  await page.getByLabel("프로젝트 이름").fill("스티커 테스트");
  await page.getByLabel("프로젝트 키").fill(key);
  await page
    .getByRole("button", { name: "프로젝트 만들기", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "스티커 테스트", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "새 이슈", exact: true })
    .first()
    .click();
  await page.getByLabel("이슈 제목").fill("첫 번째 스티커");
  await page
    .getByRole("textbox", { name: "설명", exact: true })
    .fill("실제 저장되는 작업입니다.");
  await page.getByRole("button", { name: "이슈 만들기", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "첫 번째 스티커",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "댓글 작성", exact: true })
    .fill("검증한 내용을 기록합니다.");
  await page.getByRole("button", { name: "댓글 남기기", exact: true }).click();
  await expect(
    page.getByText("검증한 내용을 기록합니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "링크 추가", exact: true }).click();
  await page.getByLabel("링크 이름").fill("참고 문서");
  await page.getByLabel("링크 주소").fill("https://example.com/document");
  await page.getByRole("button", { name: "링크 저장", exact: true }).click();
  await expect(page.getByRole("link", { name: /참고 문서/ })).toBeVisible();
  await page.getByRole("button", { name: "이슈 편집", exact: true }).click();
  await page.getByLabel("상태", { exact: true }).selectOption("done");
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "첫 번째 스티커",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "첫 번째 스티커",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("검증한 내용을 기록합니다.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "상세 닫기", exact: true }).click();
  await page.getByRole("button", { name: "리스트", exact: true }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`${key}-1`) }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "새 이슈", exact: true })
    .first()
    .click();
  await page.getByLabel("이슈 제목").fill("취소될 이슈");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "새로운 스티커" })).toHaveCount(
    0,
  );
  await expect(page.locator("body")).not.toHaveJSProperty("scrollWidth", 0);
});

test("login errors are visible and dialogs can be dismissed with Escape", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("소유자 비밀번호").fill("wrong-password");
  await page.getByRole("button", { name: "작업 공간 열기" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("소유자 비밀번호").fill(password);
  await page.getByRole("button", { name: "작업 공간 열기" }).click();
  await expect(
    page.getByRole("heading", { name: "내 작업 공간" }),
  ).toBeVisible();
  const trigger = await openProjectEditor(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
