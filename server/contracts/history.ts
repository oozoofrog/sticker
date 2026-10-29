import { z } from "zod";
import { STATUSES } from "../types.js";

export const HISTORY_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "assignee",
  "labels",
  "targetVersionId",
  "foundVersionId",
  "fixedVersionId",
] as const;
export const historyFieldSchema = z.enum(HISTORY_FIELDS);
const id = z.string().min(1).max(128);
const revision = z.number().int().positive();
const values = {
  title: z.string().min(1).max(300),
  description: z.string().max(100000),
  status: z.enum(STATUSES),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]),
  assignee: z.string().max(160),
  labels: z
    .array(z.string().min(1).max(40))
    .max(20)
    .refine((labels) => new Set(labels).size === labels.length),
  targetVersionId: id.nullable(),
  foundVersionId: id.nullable(),
  fixedVersionId: id.nullable(),
};
export const issueFieldSnapshotSchema = z.object(values).strict();
export const issueFieldPatchSchema = issueFieldSnapshotSchema.partial();
function fieldChange<const F extends HistoryField, S extends z.ZodType>(
  field: F,
  value: S,
) {
  return z
    .object({ field: z.literal(field), before: value, after: value })
    .strict();
}
export const historyFieldChangeSchema = z.discriminatedUnion("field", [
  fieldChange("title", values.title),
  fieldChange("description", values.description),
  fieldChange("status", values.status),
  fieldChange("priority", values.priority),
  fieldChange("assignee", values.assignee),
  fieldChange("labels", values.labels),
  fieldChange("targetVersionId", values.targetVersionId),
  fieldChange("foundVersionId", values.foundVersionId),
  fieldChange("fixedVersionId", values.fixedVersionId),
]);
export const historyFieldChangesSchema = historyFieldChangeSchema
  .array()
  .max(9)
  .refine(
    (changes) =>
      new Set(changes.map((change) => change.field)).size === changes.length,
    "변경 필드가 중복되었습니다.",
  );
export const historySelectionSchema = historyFieldSchema
  .array()
  .min(1)
  .max(9)
  .refine(
    (fields) => new Set(fields).size === fields.length,
    "복원 필드를 중복 선택할 수 없습니다.",
  );
export const restoreSideSchema = z.enum(["before", "after"]);
export const restorePreviewInputSchema = z
  .object({
    changeId: id,
    side: restoreSideSchema,
    fields: historySelectionSchema,
    revision,
  })
  .strict();
export const restoreInputSchema = restorePreviewInputSchema
  .extend({ operationId: z.uuid() })
  .strict();
const summary = z
  .object({
    id,
    issueId: id,
    revisionBefore: z.number().int().nonnegative().nullable(),
    revisionAfter: revision.nullable(),
    authorId: id,
    authorName: z.string(),
    createdAt: z.string(),
    action: z.string().min(1).max(64),
    sourceChangeId: id.nullable(),
    comparisonAvailable: z.boolean(),
    unavailableReason: z
      .enum(["legacy", "creation", "revision_only", "unchanged"])
      .nullable(),
    fields: historyFieldSchema.array().max(9),
  })
  .strict();
function validSummary(value: z.infer<typeof summary>) {
  if (new Set(value.fields).size !== value.fields.length) return false;
  if (value.comparisonAvailable)
    return (
      value.fields.length > 0 &&
      value.unavailableReason === null &&
      value.revisionBefore !== null &&
      value.revisionAfter !== null
    );
  return value.fields.length === 0 && value.unavailableReason !== null;
}
export const historySummarySchema = summary.refine(
  validSummary,
  "이력의 비교 가능 여부와 필드가 일치하지 않습니다.",
);
export const historyListSchema = historySummarySchema.array();
export const historyDetailSchema = summary
  .extend({ changes: historyFieldChangesSchema })
  .refine(
    (value) =>
      validSummary(value) &&
      value.fields.length === value.changes.length &&
      value.fields.every(
        (field, index) => field === value.changes[index]?.field,
      ),
    "이력의 비교 가능 여부와 변경 값이 일치하지 않습니다.",
  );
export const restorePreviewSchema = z
  .object({
    issueId: id,
    changeId: id,
    side: restoreSideSchema,
    revision,
    changes: historyFieldChangesSchema.refine((changes) => changes.length > 0),
  })
  .strict();
export type HistoryField = z.infer<typeof historyFieldSchema>;
export type IssueFieldSnapshot = z.infer<typeof issueFieldSnapshotSchema>;
export type IssueFieldPatch = z.infer<typeof issueFieldPatchSchema>;
export type HistoryFieldChange = z.infer<typeof historyFieldChangeSchema>;
export type HistorySummary = z.infer<typeof historySummarySchema>;
export type HistoryDetail = z.infer<typeof historyDetailSchema>;
export type RestorePreviewInput = z.infer<typeof restorePreviewInputSchema>;
export type RestoreInput = z.infer<typeof restoreInputSchema>;
export type RestorePreview = z.infer<typeof restorePreviewSchema>;
