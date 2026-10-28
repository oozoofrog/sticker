import { test, expect } from "@playwright/test";
import { projectSchema, issueSchema } from "../../server/response-schemas.js";
import { githubEvidenceSchema } from "../../server/contracts/github.js";
test("GitHub explicit connection, readonly evidence states, head mismatch and disconnect at desktop/mobile widths", async ({
  page,
  request,
}, testInfo) => {
  const origin = new URL(
    testInfo.project.use.baseURL || "http://127.0.0.1:8788",
  ).origin;
  await request.post("/api/session", {
    data: { password: "ephemeral-sticker-test-password" },
  });
  const project = projectSchema.parse(
    await (
      await request.post("/api/projects", {
        headers: { origin },
        data: {
          key: `G${Date.now().toString().slice(-7)}`,
          name: `GitHub ${testInfo.project.name}`,
        },
      })
    ).json(),
  );
  const repository = `project-${project.key.toLowerCase()}`;
  const issue = issueSchema.parse(
    await (
      await request.post("/api/issues", {
        headers: { origin },
        data: { projectId: project.id, title: "커밋 근거 확인" },
      })
    ).json(),
  );
  await page.context().addCookies((await request.storageState()).cookies);
  await page.setViewportSize(
    testInfo.project.name === "iphone"
      ? { width: 375, height: 812 }
      : { width: 1440, height: 960 },
  );
  await page.goto(`/#project=${project.id}`);
  await page.getByRole("button", { name: "GitHub 연결", exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "GitHub 연결",
    exact: true,
  });
  await expect(settings.getByText("연결 안 됨", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "저장소 설정" }).click();
  const editor = page.getByRole("dialog", { name: "GitHub 저장소 연결" });
  await editor.getByLabel("저장소 소유자").fill("octocat");
  await editor.getByLabel("저장소 이름").fill(repository);
  await expect(
    editor.getByRole("button", { name: "저장소 연결", exact: true }),
  ).toBeDisabled();
  await editor.getByLabel("이 저장소의 읽기 조회 허용").check();
  await editor
    .getByRole("button", { name: "저장소 연결", exact: true })
    .click();
  await expect(settings.getByText("연결됨", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "저장소 설정" }).click();
  await expect(editor.getByLabel("저장소 이름")).toHaveValue(repository);
  const concurrent = await request.put(`/api/projects/${project.id}/github`, {
    headers: { origin },
    data: {
      repository: { owner: "octocat", name: `${repository}-remote` },
      mode: "public",
      revision: 1,
      confirm: true,
    },
  });
  expect(concurrent.ok()).toBe(true);
  await editor.getByLabel("이 저장소의 읽기 조회 허용").check();
  await editor
    .getByRole("button", { name: "저장소 연결", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText(
    "연결 또는 근거가 변경되었습니다",
  );
  await editor.getByRole("button", { name: "최신 연결 확인" }).click();
  await expect(
    editor.getByText(`octocat/${repository}-remote`, { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("github-connection-conflict.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "이 버전 기준으로 검토" }).click();
  await expect(editor.getByLabel("저장소 이름")).toHaveValue(repository);
  await expect(
    editor.getByRole("button", { name: "저장소 연결", exact: true }),
  ).toBeDisabled();
  await editor.getByLabel("이 저장소의 읽기 조회 허용").check();
  await editor
    .getByRole("button", { name: "저장소 연결", exact: true })
    .click();
  await expect(
    settings.getByText(`octocat/${repository}`, { exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(settings).toBeHidden();
  for (const number of [1, 2, 3, 4, 5, 6, 7]) {
    const evidence = githubEvidenceSchema.parse(
      await (
        await request.post(`/api/issues/${issue.id}/github-evidence`, {
          headers: { origin },
          data: {
            url: `https://github.com/octocat/${repository}/pull/${String(number)}`,
            issueRevision: issue.revision,
          },
        })
      ).json(),
    );
    const fresh = githubEvidenceSchema.parse(
      await (
        await request.post(`/api/github-evidence/${evidence.id}/refresh`, {
          headers: { origin },
          data: { revision: evidence.revision },
        })
      ).json(),
    );
    if (number === 7)
      await request.post(`/api/github-evidence/${evidence.id}/refresh`, {
        headers: { origin },
        data: { revision: fresh.revision },
      });
  }
  await page.goto(`/#project=${project.id}&issue=${issue.id}`);
  const panel = page.getByRole("dialog", { name: "이슈 상세" });
  const card = (number: number) =>
    panel.getByRole("article", {
      name: `octocat/${repository} PR ${String(number)}`,
      exact: true,
    });
  for (const [number, state] of [
    [1, "성공"],
    [2, "실패"],
    [3, "대기"],
    [4, "미확인"],
  ] as const)
    await expect(
      card(number).getByText(`현재 CI · ${state}`, { exact: true }),
    ).toBeVisible();
  await expect(
    card(5).getByText("현재 CI · 미확인", { exact: true }),
  ).toBeVisible();
  await expect(
    card(5).getByText("이전 검증 · 성공", { exact: true }),
  ).toBeVisible();
  await expect(
    card(5).getByText("b".repeat(40), { exact: true }),
  ).toBeVisible();
  await expect(
    card(6).getByText("GitHub 요청 제한", { exact: true }),
  ).toBeVisible();
  await expect(
    card(7).getByText("이전 검증 · 성공", { exact: true }),
  ).toBeVisible();
  await expect(
    card(7).getByText("네트워크 확인 실패", { exact: true }),
  ).toBeVisible();
  await card(5).scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("github-evidence.png"),
    fullPage: true,
  });
  await panel.getByRole("button", { name: "상세 닫기", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "GitHub 연결", exact: true }).click();
  await settings
    .getByRole("button", { name: "연결 해제", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "GitHub 연결 해제",
    exact: true,
  });
  await confirmation.getByRole("button", { name: "해제하기" }).click();
  await expect(settings.getByText("연결 안 됨", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(settings).toBeHidden();
  await page.goto(`/#project=${project.id}&issue=${issue.id}`);
  await expect(
    card(1).getByText("현재 CI · 미확인", { exact: true }),
  ).toBeVisible();
  await expect(
    card(1).getByRole("button", { name: "다시 확인" }),
  ).toBeDisabled();
  await card(1).getByRole("link", { name: "GitHub 원문" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
