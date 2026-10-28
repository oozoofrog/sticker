import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../domain-error.js";
import type { StoreContext } from "../store-context.js";
import type { Actor, Issue } from "../types.js";
import {
  relationSchema,
  relationInputSchema,
  relationRevisionSchema,
  relatedIssueSchema,
  type IssueRelation,
  type RelationDetail,
  type RelationSummary,
  type RelatedIssue,
} from "../contracts/relations.js";
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new DomainError(400, "INVALID_INPUT", "관계 입력을 확인하세요.");
  return result.data;
}
function blank(): RelationDetail {
  return {
    parent: null,
    children: [],
    related: [],
    blockerRelations: [],
    blocking: [],
    blocked: false,
    blockers: [],
    childCounts: {
      backlog: 0,
      ready: 0,
      in_progress: 0,
      waiting: 0,
      done: 0,
      closed: 0,
    },
  };
}
export class RelationService {
  constructor(private readonly ctx: StoreContext) {}
  private edges() {
    return relationSchema
      .array()
      .parse(
        this.ctx.db
          .prepare("SELECT * FROM issue_relations ORDER BY createdAt,id")
          .all(),
      );
  }
  private checkRevision(issue: Issue, revision: number) {
    if (issue.revision !== revision)
      throw new DomainError(
        409,
        "REVISION_CONFLICT",
        "이슈가 변경되었습니다. 새로고침 후 다시 확인하세요.",
      );
  }
  private changed(
    actor: Actor,
    source: Issue,
    target: Issue,
    action: string,
    edge: IssueRelation,
  ) {
    for (const issue of [source, target]) {
      this.ctx.changeIssue(
        actor,
        issue,
        {},
        {
          action,
          detail: `${edge.kind}: ${source.key} → ${target.key}`,
        },
      );
    }
  }
  private assertNoCycle(kind: string, source: string, target: string) {
    const found = this.ctx.db
      .prepare(
        `WITH RECURSIVE reachable(id) AS (SELECT targetIssueId FROM issue_relations WHERE kind=? AND sourceIssueId=? UNION SELECT r.targetIssueId FROM issue_relations r JOIN reachable v ON r.sourceIssueId=v.id WHERE r.kind=?) SELECT 1 FROM reachable WHERE id=? LIMIT 1`,
      )
      .get(kind, target, kind, source);
    if (found)
      throw new DomainError(
        409,
        "RELATION_CYCLE",
        "순환하는 부모 또는 차단 관계는 만들 수 없습니다.",
      );
  }
  add(actor: Actor, issueId: string, input: unknown): IssueRelation {
    const data = parse(relationInputSchema, input);
    this.ctx.write(actor);
    return this.ctx.tx(() => {
      let source = this.ctx.writableIssue(actor, issueId),
        target = this.ctx.writableIssue(actor, data.targetIssueId);
      this.checkRevision(source, data.sourceRevision);
      this.checkRevision(target, data.targetRevision);
      if (source.id === target.id)
        throw new DomainError(
          400,
          "SELF_RELATION",
          "자기 자신과 관계를 만들 수 없습니다.",
        );
      if (source.projectId !== target.projectId)
        throw new DomainError(
          400,
          "PROJECT_MISMATCH",
          "같은 프로젝트의 이슈만 연결할 수 있습니다.",
        );
      if (data.kind === "related" && source.id > target.id)
        [source, target] = [target, source];
      if (
        this.ctx.db
          .prepare(
            "SELECT 1 FROM issue_relations WHERE kind=? AND sourceIssueId=? AND targetIssueId=?",
          )
          .get(data.kind, source.id, target.id)
      )
        throw new DomainError(
          409,
          "RELATION_EXISTS",
          "이미 연결된 관계입니다.",
        );
      if (
        data.kind === "parent" &&
        this.ctx.db
          .prepare(
            "SELECT 1 FROM issue_relations WHERE kind='parent' AND targetIssueId=?",
          )
          .get(target.id)
      )
        throw new DomainError(
          409,
          "PARENT_EXISTS",
          "하위 이슈는 한 부모만 가질 수 있습니다.",
        );
      if (data.kind !== "related")
        this.assertNoCycle(data.kind, source.id, target.id);
      const edge: IssueRelation = {
        id: randomUUID(),
        projectId: source.projectId,
        kind: data.kind,
        sourceIssueId: source.id,
        targetIssueId: target.id,
        createdBy: actor.id,
        createdAt: this.ctx.now(),
      };
      this.ctx.db
        .prepare("INSERT INTO issue_relations VALUES (?,?,?,?,?,?,?)")
        .run(
          edge.id,
          edge.projectId,
          edge.kind,
          edge.sourceIssueId,
          edge.targetIssueId,
          edge.createdBy,
          edge.createdAt,
        );
      this.changed(actor, source, target, "relation_added", edge);
      return edge;
    });
  }
  remove(actor: Actor, id: string, input: unknown) {
    const data = parse(relationRevisionSchema, input);
    this.ctx.write(actor);
    this.ctx.tx(() => {
      const row = this.ctx.db
        .prepare("SELECT * FROM issue_relations WHERE id=?")
        .get(id);
      if (!row)
        throw new DomainError(404, "NOT_FOUND", "관계를 찾을 수 없습니다.");
      const edge = relationSchema.parse(row),
        source = this.ctx.writableIssue(actor, edge.sourceIssueId),
        target = this.ctx.writableIssue(actor, edge.targetIssueId);
      this.checkRevision(source, data.sourceRevision);
      this.checkRevision(target, data.targetRevision);
      this.ctx.db.prepare("DELETE FROM issue_relations WHERE id=?").run(id);
      this.changed(actor, source, target, "relation_removed", edge);
    });
  }
  /** Called inside the existing owner deletion transaction, before FK cascade. */
  beforeIssueDelete(actor: Actor, id: string) {
    const issue = this.ctx.issue(actor, id);
    for (const edge of this.edges().filter(
      (e) => e.sourceIssueId === id || e.targetIssueId === id,
    )) {
      const other = this.ctx.issue(
        actor,
        edge.sourceIssueId === id ? edge.targetIssueId : edge.sourceIssueId,
      );
      this.ctx.changeIssue(
        actor,
        other,
        {},
        {
          action: "relation_target_deleted",
          detail: `${edge.kind}: ${issue.key} 삭제로 관계 해제`,
        },
      );
    }
  }
  private details(
    actor: Actor,
    projectId?: string,
  ): Map<string, RelationDetail> {
    if (projectId) this.ctx.project(actor, projectId);
    const rows = relatedIssueSchema
      .array()
      .parse(
        this.ctx.db
          .prepare(
            "SELECT id,projectId,key,title,status,revision FROM issues ORDER BY key",
          )
          .all(),
      );
    const allowed = rows.filter(
      (i) =>
        (!projectId || i.projectId === projectId) &&
        (actor.role === "owner" ||
          actor.projectIds === null ||
          actor.projectIds.includes(i.projectId)),
    );
    const issues = new Map<string, RelatedIssue>(allowed.map((i) => [i.id, i])),
      result = new Map<string, RelationDetail>(
        allowed.map((i) => [i.id, blank()]),
      );
    for (const edge of this.edges()) {
      const source = issues.get(edge.sourceIssueId),
        target = issues.get(edge.targetIssueId),
        a = result.get(edge.sourceIssueId),
        b = result.get(edge.targetIssueId);
      if (!source || !target || !a || !b) continue;
      if (edge.kind === "parent") {
        a.children.push({ relation: edge, issue: target });
        a.childCounts[target.status]++;
        b.parent = { relation: edge, issue: source };
      } else if (edge.kind === "related") {
        a.related.push({ relation: edge, issue: target });
        b.related.push({ relation: edge, issue: source });
      } else {
        a.blocking.push({ relation: edge, issue: target });
        b.blockerRelations.push({ relation: edge, issue: source });
        if (source.status !== "closed") {
          b.blocked = true;
          b.blockers.push(source);
        }
      }
    }
    return result;
  }
  get(actor: Actor, id: string): RelationDetail {
    const issue = this.ctx.issue(actor, id);
    return this.details(actor, issue.projectId).get(id) ?? blank();
  }
  summaries(actor: Actor, projectId?: string): Record<string, RelationSummary> {
    return Object.fromEntries(
      [...this.details(actor, projectId)].map(([id, d]) => [
        id,
        {
          blocked: d.blocked,
          blockers: d.blockers,
          childCounts: d.childCounts,
        },
      ]),
    );
  }
}
