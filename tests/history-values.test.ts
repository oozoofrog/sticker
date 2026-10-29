import test from "node:test";
import assert from "node:assert/strict";
import {
  snapshotIssueFields,
  diffIssueFields,
  selectedHistoryPatch,
} from "../server/features/history-values.js";
import type { Issue } from "../server/types.js";

function issue(): Issue {
  return {
    id: "issue-1",
    projectId: "project-1",
    key: "HIST-1",
    title: "old",
    description: "",
    status: "ready",
    priority: "none",
    assignee: "",
    labels: ["red", "blue"],
    targetVersionId: "target-old",
    foundVersionId: null,
    fixedVersionId: "fixed-old",
    revision: 1,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    templateId: "template-1",
    templateVersion: 1,
  };
}
void test("normalized snapshots omit immutable metadata and copy labels without changing Store order", () => {
  const input = {
    ...issue(),
    authorization: "Bearer sentinel",
    token: "sentinel",
  };
  const snapshot = snapshotIssueFields(input);
  assert.deepEqual(snapshot, {
    title: "old",
    description: "",
    status: "ready",
    priority: "none",
    assignee: "",
    labels: ["red", "blue"],
    targetVersionId: "target-old",
    foundVersionId: null,
    fixedVersionId: "fixed-old",
  });
  snapshot.labels.push("green");
  assert.deepEqual(input.labels, ["red", "blue"]);
  assert.equal(JSON.stringify(snapshot).includes("sentinel"), false);
});
void test("all nine changed fields have exact normalized before/after values in stable allowlist order", () => {
  const before = issue();
  const after: Issue = {
    ...before,
    title: "new",
    description: "body\n".repeat(1000),
    status: "done",
    priority: "urgent",
    assignee: "agent",
    labels: ["blue", "red"],
    targetVersionId: null,
    foundVersionId: "found-new",
    fixedVersionId: "fixed-new",
    revision: 2,
  };
  assert.deepEqual(diffIssueFields(before, after), [
    { field: "title", before: "old", after: "new" },
    { field: "description", before: "", after: "body\n".repeat(1000) },
    { field: "status", before: "ready", after: "done" },
    { field: "priority", before: "none", after: "urgent" },
    { field: "assignee", before: "", after: "agent" },
    { field: "labels", before: ["red", "blue"], after: ["blue", "red"] },
    { field: "targetVersionId", before: "target-old", after: null },
    { field: "foundVersionId", before: null, after: "found-new" },
    { field: "fixedVersionId", before: "fixed-old", after: "fixed-new" },
  ]);
});
void test("no-op and revision-only changes never fabricate restorable differences", () => {
  const before = issue();
  const after = {
    ...before,
    labels: [...before.labels],
    revision: 42,
    updatedAt: "2026-11-01T00:00:00.000Z",
    templateVersion: 9,
  };
  assert.deepEqual(diffIssueFields(before, after), []);
  assert.deepEqual(diffIssueFields(before, { ...after, description: " \n" }), [
    { field: "description", before: "", after: " \n" },
  ]);
});
void test("selected historic patch uses only recorded selected values, clones arrays and rejects missing or duplicate selections", () => {
  const changes = diffIssueFields(issue(), {
    ...issue(),
    title: "new",
    labels: [],
    targetVersionId: null,
  });
  assert.deepEqual(
    selectedHistoryPatch(changes, ["targetVersionId", "title"], "before"),
    { title: "old", targetVersionId: "target-old" },
  );
  assert.deepEqual(selectedHistoryPatch(changes, ["title"], "after"), {
    title: "new",
  });
  const patch = selectedHistoryPatch(changes, ["labels"], "before");
  patch.labels?.push("new");
  assert.deepEqual(
    changes.find((change) => change.field === "labels")?.before,
    ["red", "blue"],
  );
  assert.throws(() => selectedHistoryPatch(changes, [], "before"));
  assert.throws(() =>
    selectedHistoryPatch(changes, ["title", "title"], "before"),
  );
  assert.throws(() => selectedHistoryPatch(changes, ["description"], "before"));
});

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/domain.js";
import type { Actor } from "../server/types.js";
void test("diff follows the current Store normalization: trimmed labels deduplicate in insertion order without sorting", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-history-values-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const owner: Actor = {
    id: "owner",
    name: "나",
    role: "owner",
    canWrite: true,
    projectIds: null,
  };
  const project = store.createProject(owner, { key: "HV", name: "이력" });
  const before = store.createIssue(owner, {
    projectId: project.id,
    title: " title ",
    labels: [" red ", "blue", "red"],
  });
  const same = store.updateIssue(owner, before.id, {
    revision: 1,
    title: "title",
    labels: ["red", " blue ", "red"],
  });
  assert.deepEqual(diffIssueFields(before, same), []);
  const reordered = store.updateIssue(owner, before.id, {
    revision: 2,
    labels: [" blue ", "red", "blue"],
  });
  assert.deepEqual(diffIssueFields(same, reordered), [
    { field: "labels", before: ["red", "blue"], after: ["blue", "red"] },
  ]);
});
