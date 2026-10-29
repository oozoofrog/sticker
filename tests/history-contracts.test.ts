import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  historyFieldChangeSchema,
  historyDetailSchema,
  restorePreviewInputSchema,
  restoreInputSchema,
} from "../server/contracts/history.js";

const selection = {
  changeId: "change-1",
  side: "before",
  fields: ["description", "targetVersionId"],
  revision: 4,
};
void test("restore selection accepts only bounded distinct mutable fields, current CAS and a commit UUID", () => {
  assert.equal(restorePreviewInputSchema.safeParse(selection).success, true);
  assert.equal(
    restoreInputSchema.safeParse({ ...selection, operationId: randomUUID() })
      .success,
    true,
  );
  for (const invalid of [
    { ...selection, fields: [] },
    { ...selection, fields: ["title", "title"] },
    { ...selection, fields: ["projectId"] },
    { ...selection, fields: ["templateId"] },
    { ...selection, fields: ["revision"] },
    { ...selection, revision: 0 },
    { ...selection, revision: 1.5 },
    { ...selection, side: "current" },
    { ...selection, values: { status: "closed" } },
    { ...selection, authorId: "owner" },
    { ...selection, authorization: "secret" },
  ])
    assert.equal(restorePreviewInputSchema.safeParse(invalid).success, false);
  assert.equal(restoreInputSchema.safeParse(selection).success, false);
  assert.equal(
    restoreInputSchema.safeParse({ ...selection, operationId: "retry" })
      .success,
    false,
  );
});

void test("history field values are discriminated by their allowlisted field and preserve inert long and empty text", () => {
  for (const value of [
    {
      field: "description",
      before: "",
      after: "<script>inert</script>\n" + "x".repeat(99_000),
    },
    { field: "title", before: "old", after: "new" },
    { field: "status", before: "ready", after: "closed" },
    { field: "priority", before: "none", after: "urgent" },
    { field: "assignee", before: "", after: "agent-1" },
    { field: "labels", before: [], after: ["red", "blue"] },
    ...["targetVersionId", "foundVersionId", "fixedVersionId"].map((field) => ({
      field,
      before: null,
      after: "deleted-version",
    })),
  ])
    assert.deepEqual(historyFieldChangeSchema.parse(value), value);
  for (const value of [
    { field: "status", before: "ready", after: "released" },
    { field: "priority", before: "none", after: "critical" },
    { field: "labels", before: [], after: "red" },
    { field: "labels", before: [], after: ["red", "red"] },
    { field: "title", before: "old", after: "x".repeat(301) },
    { field: "description", before: "old", after: "x".repeat(100_001) },
    { field: "targetVersionId", before: null, after: 3 },
    { field: "templateVersion", before: 1, after: 2 },
    { field: "title", before: "old", after: "new", token: "secret" },
  ])
    assert.equal(historyFieldChangeSchema.safeParse(value).success, false);
});

void test("legacy, creation, unchanged and revision-only history cannot pretend to have restorable field values", () => {
  const base = {
    id: "activity-1",
    issueId: "issue-1",
    authorId: "owner",
    authorName: "나",
    createdAt: "2026-10-28T00:00:00.000Z",
    action: "updated",
    sourceChangeId: null,
    revisionBefore: null,
    revisionAfter: null,
    comparisonAvailable: false,
    unavailableReason: "legacy",
    fields: [],
    changes: [],
  };
  assert.deepEqual(historyDetailSchema.parse(base), base);
  for (const reason of ["creation", "unchanged", "revision_only"]) {
    assert.equal(
      historyDetailSchema.safeParse({
        ...base,
        revisionBefore: 2,
        revisionAfter: 3,
        unavailableReason: reason,
      }).success,
      true,
    );
  }
  for (const invalid of [
    { ...base, comparisonAvailable: true },
    { ...base, unavailableReason: null },
    { ...base, fields: ["title"] },
    {
      ...base,
      changes: [{ field: "title", before: "invented", after: "current" }],
    },
    { ...base, authorization: "secret" },
  ])
    assert.equal(historyDetailSchema.safeParse(invalid).success, false);
  const real = {
    ...base,
    comparisonAvailable: true,
    unavailableReason: null,
    revisionBefore: 2,
    revisionAfter: 3,
    fields: ["title"],
    changes: [{ field: "title", before: "old", after: "new" }],
  };
  assert.equal(historyDetailSchema.safeParse(real).success, true);
  assert.equal(
    historyDetailSchema.safeParse({ ...real, fields: ["description"] }).success,
    false,
  );
});
