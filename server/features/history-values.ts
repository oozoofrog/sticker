import {
  HISTORY_FIELDS,
  historyFieldChangeSchema,
  historyFieldChangesSchema,
  historySelectionSchema,
  issueFieldPatchSchema,
  issueFieldSnapshotSchema,
  restoreSideSchema,
  type HistoryField,
  type HistoryFieldChange,
  type IssueFieldPatch,
  type IssueFieldSnapshot,
} from "../contracts/history.js";

/** Input is the normalized issue, not the request envelope. Metadata is never copied. */
export function snapshotIssueFields(
  issue: IssueFieldSnapshot,
): IssueFieldSnapshot {
  return issueFieldSnapshotSchema.parse({
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    assignee: issue.assignee,
    labels: issue.labels,
    targetVersionId: issue.targetVersionId,
    foundVersionId: issue.foundVersionId,
    fixedVersionId: issue.fixedVersionId,
  });
}

/** Labels retain Store's insertion order; order changes are actual stored changes. */
export function diffIssueFields(
  before: IssueFieldSnapshot,
  after: IssueFieldSnapshot,
): HistoryFieldChange[] {
  const previous = snapshotIssueFields(before),
    next = snapshotIssueFields(after);
  return HISTORY_FIELDS.flatMap((field) =>
    JSON.stringify(previous[field]) === JSON.stringify(next[field])
      ? []
      : [
          historyFieldChangeSchema.parse({
            field,
            before: previous[field],
            after: next[field],
          }),
        ],
  );
}

export function selectedHistoryPatch(
  changes: readonly HistoryFieldChange[],
  fields: readonly HistoryField[],
  side: "before" | "after",
): IssueFieldPatch {
  const valid = historyFieldChangesSchema.parse(changes);
  const selected = new Set(historySelectionSchema.parse(fields));
  const direction = restoreSideSchema.parse(side);
  const patch: Record<string, unknown> = {};
  for (const field of HISTORY_FIELDS) {
    if (!selected.has(field)) continue;
    const change = valid.find((candidate) => candidate.field === field);
    if (!change) throw new Error("선택한 필드에 기록된 변경 값이 없습니다.");
    patch[field] = change[direction];
  }
  return issueFieldPatchSchema.parse(patch);
}
