import { z } from "zod";
import type { StoreContext, IssueMutationMetadata } from "../store-context.js";
import { DomainError } from "../domain-error.js";
import { canonicalJson } from "../canonical-json.js";
import type { Actor, Issue } from "../types.js";
import {
  HISTORY_FIELDS,
  historyDetailSchema,
  historyFieldChangeSchema,
  historySummarySchema,
  restoreInputSchema,
  restorePreviewInputSchema,
  type HistoryDetail,
  type HistorySummary,
  type IssueFieldPatch,
  type RestorePreviewInput,
  type RestorePreview,
} from "../contracts/history.js";
import { diffIssueFields, selectedHistoryPatch } from "./history-values.js";

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new DomainError(
      400,
      "VALIDATION",
      "변경 이력과 복원 필드를 확인하세요.",
    );
  return result.data;
}
const revisionOnly = new Set([
  "relation_added",
  "relation_removed",
  "relation_target_deleted",
  "resource_linked",
  "resource_unlinked",
]);

export class HistoryService {
  constructor(
    private readonly ctx: StoreContext,
    private readonly patch: (
      actor: Actor,
      id: string,
      input: unknown,
      metadata: IssueMutationMetadata,
    ) => Issue,
    private readonly validateReferences: (
      projectId: string,
      patch: IssueFieldPatch,
    ) => void,
  ) {}
  /** Internal same-transaction observer; activity ID and snapshots are server-owned. */
  record(
    actor: Actor,
    before: Issue | null,
    after: Issue,
    activityId: string,
    sourceChangeId: string | null = null,
  ) {
    if (!this.ctx.db.isTransaction)
      throw new Error("Issue history requires the mutation transaction.");
    const activity = this.ctx.get("activity", activityId);
    if (
      activity.issueId !== after.id ||
      activity.authorId !== actor.id ||
      (before &&
        (before.id !== after.id || before.projectId !== after.projectId)) ||
      after.revision !== (before?.revision ?? 0) + 1
    )
      throw new Error("Invalid issue history mutation boundary.");
    const changes = before ? diffIssueFields(before, after) : [];
    const action = z.string().parse(activity.action);
    const unavailableReason = !before
      ? "creation"
      : changes.length
        ? null
        : revisionOnly.has(action)
          ? "revision_only"
          : "unchanged";
    if (sourceChangeId) {
      const source = this.ctx.db
        .prepare("SELECT issueId FROM issue_changes WHERE id=?")
        .get(sourceChangeId);
      if (source?.issueId !== after.id)
        throw new Error("Invalid history source issue.");
    }
    this.ctx.db
      .prepare(
        `INSERT INTO issue_changes
      (id,issueId,revisionBefore,revisionAfter,authorId,authorName,createdAt,action,sourceChangeId,unavailableReason)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        activityId,
        after.id,
        before?.revision ?? 0,
        after.revision,
        actor.id,
        actor.name,
        z.string().parse(activity.createdAt),
        action,
        sourceChangeId,
        unavailableReason,
      );
    const insert = this.ctx.db.prepare(
      "INSERT INTO issue_field_changes (changeId,field,beforeJson,afterJson) VALUES (?,?,?,?)",
    );
    for (const change of changes)
      insert.run(
        activityId,
        change.field,
        JSON.stringify(change.before),
        JSON.stringify(change.after),
      );
  }
  private summary(
    row: Record<string, unknown>,
    fields: unknown[],
  ): HistorySummary {
    return historySummarySchema.parse({
      ...row,
      fields: HISTORY_FIELDS.filter((field) => fields.includes(field)),
      comparisonAvailable: row.unavailableReason === null,
    });
  }
  list(actor: Actor, issueId: string): HistorySummary[] {
    this.ctx.issue(actor, issueId);
    const fieldsByChange = new Map<string, unknown[]>();
    for (const row of this.ctx.db
      .prepare(
        "SELECT f.changeId,f.field FROM issue_field_changes f JOIN issue_changes c ON c.id=f.changeId WHERE c.issueId=?",
      )
      .all(issueId)) {
      const id = z.string().parse(row.changeId);
      const fields = fieldsByChange.get(id) ?? [];
      fields.push(row.field);
      fieldsByChange.set(id, fields);
    }
    return this.ctx.db
      .prepare(
        `SELECT a.id,a.issueId,a.authorId,a.authorName,a.createdAt,a.action,
      c.revisionBefore,c.revisionAfter,c.sourceChangeId,
      CASE WHEN c.id IS NULL THEN 'legacy' ELSE c.unavailableReason END AS unavailableReason
      FROM activity a LEFT JOIN issue_changes c ON c.id=a.id
      WHERE a.issueId=? ORDER BY a.createdAt DESC,a.rowid DESC`,
      )
      .all(issueId)
      .map((row) =>
        this.summary(row, fieldsByChange.get(z.string().parse(row.id)) ?? []),
      );
  }
  get(actor: Actor, issueId: string, changeId: string): HistoryDetail {
    this.ctx.issue(actor, issueId);
    const row = this.ctx.db
      .prepare(
        `SELECT a.id,a.issueId,a.authorId,a.authorName,a.createdAt,a.action,
      c.revisionBefore,c.revisionAfter,c.sourceChangeId,
      CASE WHEN c.id IS NULL THEN 'legacy' ELSE c.unavailableReason END AS unavailableReason
      FROM activity a LEFT JOIN issue_changes c ON c.id=a.id WHERE a.issueId=? AND a.id=?`,
      )
      .get(issueId, changeId);
    if (!row)
      throw new DomainError(
        404,
        "HISTORY_NOT_FOUND",
        "이 이슈의 변경 이력을 찾을 수 없습니다.",
      );
    const fields = this.ctx.db
      .prepare(
        "SELECT field,beforeJson,afterJson FROM issue_field_changes WHERE changeId=?",
      )
      .all(changeId);
    const changes = HISTORY_FIELDS.flatMap((field) => {
      const value = fields.find((item) => item.field === field);
      if (!value) return [];
      const before: unknown = JSON.parse(z.string().parse(value.beforeJson));
      const after: unknown = JSON.parse(z.string().parse(value.afterJson));
      return [historyFieldChangeSchema.parse({ field, before, after })];
    });
    return historyDetailSchema.parse({
      ...this.summary(
        row,
        fields.map((field) => field.field),
      ),
      changes,
    });
  }
  private selection(actor: Actor, issueId: string, data: RestorePreviewInput) {
    const current = this.ctx.writableIssue(actor, issueId);
    if (current.revision !== data.revision)
      throw new DomainError(
        409,
        "REVISION_CONFLICT",
        "이슈가 변경되었습니다. 최신 값으로 복원 내용을 다시 확인하세요.",
      );
    const source = this.get(actor, issueId, data.changeId);
    if (!source.comparisonAvailable)
      throw new DomainError(
        400,
        "COMPARISON_UNAVAILABLE",
        "복원할 이전·이후 값이 없는 이력입니다.",
      );
    let patch: IssueFieldPatch;
    try {
      patch = selectedHistoryPatch(source.changes, data.fields, data.side);
    } catch {
      throw new DomainError(
        400,
        "INVALID_HISTORY_FIELDS",
        "이 변경에 기록된 필드만 선택하세요.",
      );
    }
    this.validateReferences(current.projectId, patch);
    return { current, patch };
  }
  preview(actor: Actor, issueId: string, input: unknown): RestorePreview {
    this.ctx.owner(actor);
    const data = parse(restorePreviewInputSchema, input);
    return this.ctx.tx(() => {
      const { current, patch } = this.selection(actor, issueId, data);
      return {
        issueId,
        changeId: data.changeId,
        side: data.side,
        revision: current.revision,
        changes: HISTORY_FIELDS.flatMap((field) =>
          Object.hasOwn(patch, field)
            ? [
                historyFieldChangeSchema.parse({
                  field,
                  before: current[field],
                  after: patch[field],
                }),
              ]
            : [],
        ),
      };
    });
  }
  restore(
    actor: Actor,
    issueId: string,
    input: unknown,
  ): { issue: Issue; change: HistoryDetail } {
    this.ctx.owner(actor);
    const data = parse(restoreInputSchema, input);
    const payload = canonicalJson({
      issueId,
      changeId: data.changeId,
      side: data.side,
      fields: HISTORY_FIELDS.filter((field) => data.fields.includes(field)),
      revision: data.revision,
    });
    return this.ctx.tx(() => {
      this.ctx.issue(actor, issueId);
      const prior = this.ctx.db
        .prepare(
          "SELECT payload,changeId FROM issue_restore_operations WHERE actorId=? AND operationId=?",
        )
        .get(actor.id, data.operationId);
      if (prior) {
        if (prior.payload !== payload)
          throw new DomainError(
            409,
            "OPERATION_CONFLICT",
            "같은 작업 ID의 복원 선택이 다릅니다.",
          );
        return {
          issue: this.ctx.issue(actor, issueId),
          change: this.get(actor, issueId, z.string().parse(prior.changeId)),
        };
      }
      const { patch } = this.selection(actor, issueId, data);
      const issue = this.patch(
        actor,
        issueId,
        { revision: data.revision, ...patch },
        {
          action: "restored",
          detail: "선택 필드 복원",
          sourceChangeId: data.changeId,
        },
      );
      const row = this.ctx.db
        .prepare(
          "SELECT id FROM issue_changes WHERE issueId=? AND revisionAfter=?",
        )
        .get(issueId, issue.revision);
      const changeId = z.string().parse(row?.id);
      this.ctx.db
        .prepare(
          "INSERT INTO issue_restore_operations (actorId,operationId,issueId,payload,changeId) VALUES (?,?,?,?,?)",
        )
        .run(actor.id, data.operationId, issueId, payload, changeId);
      return { issue, change: this.get(actor, issueId, changeId) };
    });
  }
}
