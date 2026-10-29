import { randomUUID } from "node:crypto";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { openDatabase } from "./db.js";
import { DomainError } from "./domain-error.js";
import { issueSchema, projectSchema } from "./response-schemas.js";
import {
  issueFieldPatchSchema,
  type IssueFieldPatch,
} from "./contracts/history.js";
import type { Actor, Issue } from "./types.js";
const tables = new Set([
  "projects",
  "versions",
  "issues",
  "comments",
  "activity",
  "attachments",
  "agent_reports",
  "agent_sessions",
  "session_requests",
  "session_responses",
  "issue_templates",
  "template_versions",
  "template_operations",
  "issue_creation_operations",
]);
export interface IssueMutationMetadata {
  action: string;
  detail: string;
  sourceChangeId?: string;
}
export class StoreContext {
  onIssueMutation?: (
    actor: Actor,
    before: Issue | null,
    after: Issue,
    activityId: string,
    sourceChangeId?: string,
  ) => void;
  readonly db;
  constructor(
    dataDir: string,
    readonly clock: () => number = Date.now,
  ) {
    this.db = openDatabase(dataDir);
  }
  now() {
    return new Date(this.clock()).toISOString();
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      )
        throw new DomainError(
          409,
          "CONFLICT",
          "이미 같은 식별자 또는 이름이 있습니다.",
        );
      throw error;
    }
  }
  private table(table: string) {
    if (!tables.has(table)) throw new Error("Unknown table");
    return table;
  }
  get(table: string, id: string): Record<string, SQLOutputValue> {
    const row = this.db
      .prepare(`SELECT * FROM ${this.table(table)} WHERE id=?`)
      .get(id);
    if (!row)
      throw new DomainError(404, "NOT_FOUND", "항목을 찾을 수 없습니다.");
    return row;
  }
  insert(table: string, values: Record<string, SQLInputValue>) {
    const keys = Object.keys(values);
    this.db
      .prepare(
        `INSERT INTO ${this.table(table)} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      )
      .run(...Object.values(values));
  }
  update(table: string, id: string, values: Record<string, SQLInputValue>) {
    const keys = Object.keys(values);
    if (keys.length)
      this.db
        .prepare(
          `UPDATE ${this.table(table)} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
        )
        .run(...Object.values(values), id);
  }
  write(actor: Actor) {
    if (!actor.canWrite)
      throw new DomainError(403, "READ_ONLY", "읽기 전용 접근 권한입니다.");
  }
  owner(actor: Actor) {
    this.write(actor);
    if (actor.role !== "owner")
      throw new DomainError(
        403,
        "OWNER_REQUIRED",
        "소유자만 할 수 있는 작업입니다.",
      );
  }
  scope(actor: Actor, projectId: string) {
    if (
      actor.role !== "owner" &&
      actor.projectIds !== null &&
      !actor.projectIds.includes(projectId)
    )
      throw new DomainError(
        403,
        "PROJECT_SCOPE",
        "이 프로젝트에 접근할 권한이 없습니다.",
      );
  }
  project(actor: Actor, projectId: string) {
    this.scope(actor, projectId);
    return projectSchema.parse(this.get("projects", projectId));
  }
  issue(actor: Actor, id: string) {
    const row = this.get("issues", id);
    if (typeof row.labels !== "string")
      throw new Error("Invalid stored labels");
    const labels: unknown = JSON.parse(row.labels);
    const issue = issueSchema.parse({ ...row, labels });
    this.scope(actor, issue.projectId);
    return issue;
  }
  writableIssue(actor: Actor, id: string) {
    this.write(actor);
    const issue = this.issue(actor, id);
    if (issue.status === "closed" && actor.role !== "owner")
      throw new DomainError(
        403,
        "OWNER_REQUIRED",
        "종료된 이슈는 소유자만 변경할 수 있습니다.",
      );
    return issue;
  }
  activity(actor: Actor, issueId: string, action: string, detail: string) {
    const id = randomUUID();
    this.insert("activity", {
      id,
      issueId,
      action,
      detail,
      authorId: actor.id,
      authorName: actor.name,
      createdAt: this.now(),
    });
    return id;
  }
  issueActivity(
    actor: Actor,
    before: Issue | null,
    after: Issue,
    metadata: IssueMutationMetadata,
  ) {
    if (!this.db.isTransaction)
      throw new Error("Issue mutation requires an existing transaction.");
    const id = this.activity(actor, after.id, metadata.action, metadata.detail);
    this.onIssueMutation?.(actor, before, after, id, metadata.sourceChangeId);
  }
  /** Shared write seam, inside the caller's transaction/savepoint; never starts a nested transaction. */
  changeIssue(
    actor: Actor,
    before: Issue,
    patch: IssueFieldPatch,
    metadata: IssueMutationMetadata,
  ): Issue {
    if (!this.db.isTransaction)
      throw new Error("Issue mutation requires an existing transaction.");
    const current = this.writableIssue(actor, before.id);
    if (current.revision !== before.revision)
      throw new DomainError(
        409,
        "REVISION_CONFLICT",
        "이슈가 변경되었습니다. 최신 내용을 확인하세요.",
      );
    const { labels, ...fields } = issueFieldPatchSchema.parse(patch);
    this.update("issues", before.id, {
      ...fields,
      ...(labels ? { labels: JSON.stringify(labels) } : {}),
      revision: before.revision + 1,
      updatedAt: this.now(),
    });
    const after = this.issue(actor, before.id);
    this.issueActivity(actor, before, after, metadata);
    return after;
  }
}
