import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import {
  HISTORY_FIELDS,
  historyDetailSchema,
  historyFieldChangeSchema,
  restorePreviewInputSchema,
  type HistoryDetail,
} from "./contracts/history.js";
const payloadSchema = restorePreviewInputSchema
  .extend({ issueId: z.string().min(1).max(128) })
  .strict();
function json(value: unknown): unknown {
  return JSON.parse(z.string().max(600_002).parse(value));
}
/** Read-only integrity checks; never backfill absent legacy history from today's issue. */
export function validateHistory(db: DatabaseSync) {
  try {
    const details = new Map<string, HistoryDetail>();
    const fieldsByChange = new Map<string, Record<string, SQLOutputValue>[]>();
    for (const field of db.prepare("SELECT * FROM issue_field_changes").all()) {
      const id = z.string().parse(field.changeId);
      const fields = fieldsByChange.get(id) ?? [];
      fields.push(field);
      fieldsByChange.set(id, fields);
    }
    for (const row of db.prepare("SELECT * FROM issue_changes").all()) {
      const changes = (fieldsByChange.get(z.string().parse(row.id)) ?? []).map(
        (field) =>
          historyFieldChangeSchema.parse({
            field: field.field,
            before: json(field.beforeJson),
            after: json(field.afterJson),
          }),
      );
      if (
        changes.some(
          (change) =>
            JSON.stringify(change.before) === JSON.stringify(change.after),
        )
      )
        throw new Error("Unchanged history field");
      changes.sort(
        (a, b) =>
          HISTORY_FIELDS.indexOf(a.field) - HISTORY_FIELDS.indexOf(b.field),
      );
      const detail = historyDetailSchema.parse({
        ...row,
        comparisonAvailable: row.unavailableReason === null,
        fields: changes.map((change) => change.field),
        changes,
      });
      const activity = db
        .prepare("SELECT * FROM activity WHERE id=?")
        .get(detail.id);
      const issue = db
        .prepare("SELECT revision FROM issues WHERE id=?")
        .get(detail.issueId);
      if (
        !activity ||
        !issue ||
        detail.revisionBefore === null ||
        detail.revisionAfter === null ||
        detail.revisionAfter !== detail.revisionBefore + 1 ||
        detail.revisionAfter >
          z.number().int().positive().parse(issue.revision) ||
        (detail.unavailableReason === "creation") !==
          (detail.revisionBefore === 0) ||
        ["issueId", "action", "authorId", "authorName", "createdAt"].some(
          (key) => activity[key] !== row[key],
        )
      )
        throw new Error("Inconsistent history metadata");
      details.set(detail.id, detail);
    }
    for (const changeId of fieldsByChange.keys())
      if (!details.has(changeId)) throw new Error("Orphan history field");
    for (const detail of details.values()) {
      if (detail.sourceChangeId !== null) {
        const source = details.get(detail.sourceChangeId);
        if (
          detail.action !== "restored" ||
          !source?.comparisonAvailable ||
          source.issueId !== detail.issueId ||
          source.revisionAfter === null ||
          detail.revisionAfter === null ||
          source.revisionAfter >= detail.revisionAfter
        )
          throw new Error("Invalid history source");
      } else if (detail.action === "restored")
        throw new Error("Missing history source");
    }
    for (const row of db
      .prepare("SELECT * FROM issue_restore_operations")
      .all()) {
      z.uuid().parse(row.operationId);
      const payload = payloadSchema.parse(json(row.payload));
      const change = details.get(z.string().parse(row.changeId));
      if (
        !change ||
        change.action !== "restored" ||
        change.issueId !== row.issueId ||
        change.authorId !== row.actorId ||
        payload.issueId !== row.issueId ||
        payload.changeId !== change.sourceChangeId ||
        payload.revision !== change.revisionBefore
      )
        throw new Error("Invalid history operation");
      const source = details.get(payload.changeId);
      if (
        !source ||
        payload.fields.some((field) => !source.fields.includes(field))
      )
        throw new Error("Invalid history operation selection");
    }
  } catch {
    throw new Error("Invalid issue history data in backup.");
  }
}
