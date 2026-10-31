import { attachmentFileReceipt } from "./file-transfer-receipts.js";
import { attachmentOperationStatusSchema } from "./contracts/file-transfers.js";
import type { StoredFile } from "./file-storage.js";
import {
  attachmentPayloadHash,
  boundedAttachmentJson,
} from "./attachment-operations.js";
import {
  attachmentOperationPayloadSchema,
  attachmentOperationReceiptSchema,
} from "./contracts/attachment-operations.js";
import { HistoryService } from "./features/history.js";
import type { IssueMutationMetadata } from "./store-context.js";
import type { IssueFieldPatch } from "./contracts/history.js";
import { GithubService, type GithubProvider } from "./features/github.js";
import {
  projectSchema,
  versionSchema,
  issueSchema,
  reportSchema,
  commentSchema,
  activitySchema,
  attachmentSchema as attachmentResponseSchema,
} from "./response-schemas.js";
import { randomUUID } from "node:crypto";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import {
  STATUSES,
  type Actor,
  type Project,
  type Version,
  type Issue,
  type Comment,
  type Attachment,
  type AgentReport,
  type Bootstrap,
  type IssueDetail,
} from "./types.js";

export { DomainError } from "./domain-error.js";
import { DomainError } from "./domain-error.js";
import { StoreContext } from "./store-context.js";
import { canonicalJson } from "./canonical-json.js";
import {
  templateCreateHints,
  type TemplateDefaults,
} from "./contracts/templates.js";
import { ResourceService } from "./features/resources.js";
import { TemplateService } from "./features/templates.js";
import { ReleaseService } from "./features/releases.js";
import { ViewService } from "./features/views.js";
import { RelationService } from "./features/relations.js";
import { SessionService } from "./features/sessions.js";
const id = z.string().min(1).max(128);
const name = z.string().trim().min(1).max(160);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "올바른 날짜를 입력하세요.");
const projectFields = {
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{1,7}$/),
  name,
  description: z.string().max(20000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
};
const projectCreate = z
  .object({
    ...projectFields,
    description: projectFields.description.default(""),
    color: projectFields.color.default("#d6ed61"),
  })
  .strict();
const projectUpdate = z.object(projectFields).partial().strict();
const versionFields = {
  name,
  description: z.string().max(20000),
  state: z.enum(["planned", "released", "archived"]),
  dueDate: date.nullable(),
};
const versionCreate = z
  .object({
    projectId: id,
    ...versionFields,
    description: versionFields.description.default(""),
    state: versionFields.state.default("planned"),
    dueDate: versionFields.dueDate.default(null),
  })
  .strict();
const versionUpdate = z
  .object(versionFields)
  .partial()
  .extend({ revision: z.number().int().positive() })
  .strict();
const issueFields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100000),
  status: z.enum(STATUSES),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]),
  assignee: z.string().trim().max(160),
  targetVersionId: id.nullable(),
  foundVersionId: id.nullable(),
  fixedVersionId: id.nullable(),
  labels: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .transform((v) => [...new Set(v)]),
};
const issueCreate = z
  .object({
    projectId: id,
    ...issueFields,
    description: issueFields.description.default(""),
    status: issueFields.status.default("backlog"),
    priority: issueFields.priority.default("none"),
    assignee: issueFields.assignee.default(""),
    targetVersionId: issueFields.targetVersionId.default(null),
    foundVersionId: issueFields.foundVersionId.default(null),
    fixedVersionId: issueFields.fixedVersionId.default(null),
    labels: issueFields.labels.default([]),
  })
  .strict();
const templateIssueCreate = issueCreate.extend(templateCreateHints).strict();
const issueUpdate = z
  .object({ ...issueFields })
  .partial()
  .extend({ revision: z.number().int().positive() })
  .strict();
const attachmentName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (v) =>
      !Array.from(v).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ),
    "파일 이름에 제어 문자를 사용할 수 없습니다.",
  );
const attachmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("link"),
      name: attachmentName,
      url: z
        .url()
        .max(4096)
        .refine((v) => {
          const u = new URL(v);
          return (
            ["http:", "https:"].includes(u.protocol) &&
            !u.username &&
            !u.password
          );
        }, "http/https 링크만 지원합니다."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      name: attachmentName,
      storageKey: z.uuid(),
      mimeType: z
        .string()
        .min(1)
        .max(150)
        .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
      size: z
        .number()
        .int()
        .min(0)
        .max(20 * 1024 * 1024),
    })
    .strict(),
]);
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const out = schema.safeParse(input);
  if (!out.success)
    throw new DomainError(
      400,
      "VALIDATION",
      out.error.issues
        .map((i) => `${i.path.join(".") || "입력"}: ${i.message}`)
        .join("; "),
    );
  return out.data;
}
function now() {
  return new Date().toISOString();
}
type Row = Record<string, SQLOutputValue>;
function textColumn(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Invalid stored text column: ${key}`);
  return value;
}
function issueRow(row: Row): Issue {
  const labels: unknown = JSON.parse(textColumn(row, "labels"));
  return issueSchema.parse({ ...row, labels });
}
function reportRow(row: Row): AgentReport {
  const elapsed = Date.now() - Date.parse(textColumn(row, "reportedAt"));
  return reportSchema.parse({
    ...row,
    stale: !Number.isFinite(elapsed) || elapsed > 300_000 || elapsed < -60_000,
  });
}

/** All authorization and business rules shared by HTTP and MCP live here. */
export class Store {
  private context: StoreContext;
  readonly history: HistoryService;
  readonly github: GithubService;
  readonly resources: ResourceService;
  readonly templates: TemplateService;
  readonly sessions: SessionService;
  readonly relations: RelationService;
  readonly views: ViewService;
  readonly releases: ReleaseService;
  private get db() {
    return this.context.db;
  }
  constructor(
    dataDir: string,
    clock: () => number = Date.now,
    origin = "http://localhost:8787",
    actors: readonly Actor[] = [
      {
        id: "owner",
        name: "나",
        role: "owner",
        canWrite: true,
        projectIds: null,
      },
    ],
    githubProvider: GithubProvider = { enabled: false },
  ) {
    this.context = new StoreContext(dataDir, clock);
    this.history = new HistoryService(
      this.context,
      (actor, id, input, metadata) =>
        this.patchIssue(actor, id, input, metadata),
      (projectId, patch) => {
        this.versionsBelong(projectId, patch);
      },
    );
    this.context.onIssueMutation = (
      actor,
      before,
      after,
      activityId,
      sourceChangeId,
    ) => {
      this.history.record(actor, before, after, activityId, sourceChangeId);
    };
    this.resources = new ResourceService(this.context);
    this.github = new GithubService(this.context, githubProvider);
    this.templates = new TemplateService(this.context, actors);
    this.sessions = new SessionService(this.context);
    this.relations = new RelationService(this.context);
    this.views = new ViewService(this.context, this.relations);
    this.releases = new ReleaseService(
      this.context,
      this.relations,
      (actor, id, input) =>
        this.patchIssue(actor, id, input, {
          action: "carryover",
          detail: "목표 버전 이월",
        }),
      origin,
    );
  }
  close() {
    this.context.db.close();
  }
  private tx<T>(fn: () => T): T {
    return this.context.tx(fn);
  }
  private get(table: string, idValue: string): Row {
    return this.context.get(table, idValue);
  }
  private insert(table: string, obj: Record<string, SQLInputValue>) {
    this.context.insert(table, obj);
  }
  private update(
    table: string,
    idValue: string,
    obj: Record<string, SQLInputValue>,
  ) {
    this.context.update(table, idValue, obj);
  }
  private write(actor: Actor) {
    this.context.write(actor);
  }
  private owner(actor: Actor) {
    this.context.owner(actor);
  }
  private scope(actor: Actor, projectId: string) {
    this.context.scope(actor, projectId);
  }
  private project(actor: Actor, projectId: string): Project {
    return this.context.project(actor, projectId);
  }
  private issue(actor: Actor, issueId: string): Issue {
    return this.context.issue(actor, issueId);
  }
  private writableIssue(actor: Actor, issueId: string): Issue {
    return this.context.writableIssue(actor, issueId);
  }
  private activity(
    actor: Actor,
    issueId: string,
    action: string,
    detail: string,
  ) {
    this.context.activity(actor, issueId, action, detail);
  }
  private versionsBelong(
    projectId: string,
    input: {
      targetVersionId?: string | null;
      foundVersionId?: string | null;
      fixedVersionId?: string | null;
    },
  ) {
    for (const key of [
      "targetVersionId",
      "foundVersionId",
      "fixedVersionId",
    ] as const) {
      const value = input[key];
      if (value) {
        const v = this.db
          .prepare("SELECT projectId FROM versions WHERE id=?")
          .get(value);
        if (!v || v.projectId !== projectId)
          throw new DomainError(
            400,
            "VERSION_PROJECT",
            "버전은 이슈와 같은 프로젝트에 있어야 합니다.",
          );
      }
    }
  }

  bootstrap(actor: Actor): Bootstrap {
    const allProjects = projectSchema
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT id,key,name,description,color,createdAt,updatedAt FROM projects ORDER BY createdAt,id",
          )
          .all(),
      );
    const projects = allProjects.filter(
      (p) =>
        actor.role === "owner" ||
        actor.projectIds === null ||
        actor.projectIds.includes(p.id),
    );
    const allowed = new Set(projects.map((p) => p.id));
    const versions = versionSchema
      .array()
      .parse(
        this.db.prepare("SELECT * FROM versions ORDER BY createdAt,id").all(),
      )
      .filter((v) => allowed.has(v.projectId));
    const issues = this.db
      .prepare("SELECT * FROM issues ORDER BY updatedAt DESC,rowid DESC")
      .all()
      .map(issueRow)
      .filter((v) => allowed.has(v.projectId));
    const reports = this.db
      .prepare("SELECT * FROM agent_reports ORDER BY reportedAt DESC")
      .all()
      .map(reportRow)
      .filter((v) => allowed.has(v.projectId));
    return { actor, projects, versions, issues, reports };
  }
  getIssue(actor: Actor, issueId: string): IssueDetail {
    const issue = this.issue(actor, issueId);
    return {
      issue,
      comments: commentSchema
        .array()
        .parse(
          this.db
            .prepare(
              "SELECT * FROM comments WHERE issueId=? ORDER BY createdAt,rowid",
            )
            .all(issueId),
        ),
      activity: activitySchema
        .array()
        .parse(
          this.db
            .prepare(
              "SELECT * FROM activity WHERE issueId=? ORDER BY createdAt,rowid",
            )
            .all(issueId),
        ),
      attachments: attachmentResponseSchema
        .array()
        .parse(
          this.db
            .prepare(
              "SELECT * FROM attachments WHERE issueId=? ORDER BY createdAt,rowid",
            )
            .all(issueId),
        ),
    };
  }
  createProject(actor: Actor, input: unknown): Project {
    this.owner(actor);
    const data = parse(projectCreate, input);
    return this.tx(() => {
      const stamp = now(),
        p = { id: randomUUID(), ...data, createdAt: stamp, updatedAt: stamp };
      this.insert("projects", p);
      return p;
    });
  }
  updateProject(actor: Actor, projectId: string, input: unknown): Project {
    this.write(actor);
    const data = parse(projectUpdate, input);
    return this.tx(() => {
      const current = this.project(actor, projectId);
      if (
        data.key &&
        data.key !== current.key &&
        Number(this.get("projects", projectId).nextIssue) > 1
      )
        throw new DomainError(
          409,
          "PROJECT_KEY_LOCKED",
          "이슈 번호가 발급된 프로젝트의 키는 바꿀 수 없습니다.",
        );
      this.update("projects", projectId, { ...data, updatedAt: now() });
      return this.project(actor, projectId);
    });
  }
  deleteProject(actor: Actor, projectId: string): void {
    this.owner(actor);
    this.tx(() => {
      this.project(actor, projectId);
      const count = this.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM issues WHERE projectId=?) + (SELECT COUNT(*) FROM versions WHERE projectId=?) + (SELECT COUNT(*) FROM issue_templates WHERE projectId=? AND deletedAt IS NULL) + (SELECT COUNT(*) FROM resources WHERE projectId=? AND deletedAt IS NULL) AS n",
        )
        .get(projectId, projectId, projectId, projectId);
      if (Number(count?.n) > 0)
        throw new DomainError(
          409,
          "PROJECT_NOT_EMPTY",
          "프로젝트의 이슈·버전·템플릿·자료를 먼저 삭제하세요.",
        );
      this.db.prepare("DELETE FROM projects WHERE id=?").run(projectId);
    });
  }
  createVersion(actor: Actor, input: unknown): Version {
    this.write(actor);
    const data = parse(versionCreate, input);
    if (data.state === "released")
      throw new DomainError(
        409,
        "RELEASE_CONFIRMATION_REQUIRED",
        "출시 검토에서 소유자가 명시적으로 확인하세요.",
      );
    return this.tx(() => {
      this.project(actor, data.projectId);
      const stamp = now(),
        v = {
          id: randomUUID(),
          ...data,
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        };
      this.insert("versions", v);
      return v;
    });
  }
  updateVersion(actor: Actor, versionId: string, input: unknown): Version {
    this.write(actor);
    const { revision, ...data } = parse(versionUpdate, input);
    return this.tx(() => {
      const old = this.get("versions", versionId);
      this.scope(actor, textColumn(old, "projectId"));
      if (old.revision !== revision)
        throw new DomainError(
          409,
          "REVISION_CONFLICT",
          "버전이 변경되었습니다. 최신 내용을 확인하세요.",
        );
      if (
        data.state !== undefined &&
        (data.state === "released" || old.state === "released")
      )
        throw new DomainError(
          409,
          "RELEASE_CONFIRMATION_REQUIRED",
          "출시 상태 변경은 소유자의 명시적 검토가 필요합니다.",
        );
      this.update("versions", versionId, {
        ...data,
        revision: revision + 1,
        updatedAt: now(),
      });
      return versionSchema.parse(this.get("versions", versionId));
    });
  }
  deleteVersion(actor: Actor, versionId: string): void {
    this.write(actor);
    this.tx(() => {
      const v = this.get("versions", versionId);
      if (
        v.state === "released" ||
        this.db
          .prepare("SELECT 1 FROM version_release_audit WHERE versionId=?")
          .get(versionId)
      )
        this.owner(actor);
      this.scope(actor, textColumn(v, "projectId"));
      const affected = this.db
        .prepare(
          "SELECT * FROM issues WHERE targetVersionId=? OR foundVersionId=? OR fixedVersionId=?",
        )
        .all(versionId, versionId, versionId);
      for (const row of affected) {
        const before = this.writableIssue(actor, textColumn(row, "id"));
        const change: IssueFieldPatch = {};
        for (const key of [
          "targetVersionId",
          "foundVersionId",
          "fixedVersionId",
        ] as const)
          if (row[key] === versionId) change[key] = null;
        this.context.changeIssue(actor, before, change, {
          action: "version_removed",
          detail: `버전 삭제: ${textColumn(v, "name")}`,
        });
      }
      this.db.prepare("DELETE FROM versions WHERE id=?").run(versionId);
    });
  }
  createIssue(actor: Actor, input: unknown): Issue {
    this.write(actor);
    const envelope = parse(templateIssueCreate, input),
      raw = z.record(z.string(), z.unknown()).parse(input);
    if (
      (envelope.templateId && !envelope.templateVersion) ||
      (!envelope.templateId &&
        (envelope.templateVersion !== undefined ||
          envelope.templateValues !== undefined))
    )
      throw new DomainError(
        400,
        "VALIDATION",
        "templateId와 templateVersion을 함께 보내세요.",
      );
    const metadata = new Set([
      "templateId",
      "templateVersion",
      "templateValues",
      "operationId",
    ]);
    const explicit: Record<string, unknown> = {},
      fingerprintValues: Record<string, unknown> = {};
    for (const key of Object.keys(envelope) as (keyof typeof envelope)[]) {
      if (!(key in raw) || envelope[key] === undefined) continue;
      if (key !== "operationId") fingerprintValues[key] = envelope[key];
      if (!metadata.has(key)) explicit[key] = envelope[key];
    }
    const payload = canonicalJson(fingerprintValues);
    return this.tx(() => {
      const p = this.project(actor, envelope.projectId);
      if (envelope.operationId) {
        const prior = this.db
          .prepare(
            "SELECT payload,issueId FROM issue_creation_operations WHERE actorId=? AND operationId=?",
          )
          .get(actor.id, envelope.operationId);
        if (prior) {
          if (prior.payload !== payload)
            throw new DomainError(
              409,
              "OPERATION_CONFLICT",
              "동일 operationId의 이슈 내용이 다릅니다.",
            );
          if (prior.issueId === null)
            throw new DomainError(
              409,
              "OPERATION_TARGET_GONE",
              "이미 삭제된 이슈 생성 작업입니다.",
            );
          return this.issue(actor, z.string().parse(prior.issueId));
        }
      }
      let description = envelope.description,
        templateId: string | null = null,
        templateVersion: number | null = null,
        defaults: TemplateDefaults = {};
      if (envelope.templateId && envelope.templateVersion) {
        const overrides: TemplateDefaults = {};
        for (const field of [
          "assignee",
          "targetVersionId",
          "foundVersionId",
          "fixedVersionId",
        ] as const) {
          if (field in raw) {
            const value = envelope[field];
            if (field === "assignee")
              overrides.assignee = z.string().parse(value);
            else overrides[field] = value;
          }
        }
        const applied = this.templates.apply(actor, p.id, {
          templateId: envelope.templateId,
          templateVersion: envelope.templateVersion,
          templateValues: envelope.templateValues,
          ...("description" in raw ? { body: envelope.description } : {}),
          overrides,
        });
        defaults = applied.defaults;
        description = applied.description;
        templateId = applied.templateId;
        templateVersion = applied.templateVersion;
      }
      const data = parse(issueCreate, {
        ...defaults,
        ...explicit,
        description,
      });
      if (data.status === "closed" && actor.role !== "owner")
        throw new DomainError(
          403,
          "OWNER_REQUIRED",
          "소유자만 이슈를 종료할 수 있습니다.",
        );
      this.versionsBelong(p.id, data);
      if (templateId && !envelope.operationId)
        throw new DomainError(
          400,
          "OPERATION_REQUIRED",
          "템플릿 이슈 생성에는 operationId UUID가 필요합니다.",
        );
      const internal = this.get("projects", p.id),
        stamp = now();
      const issue: Issue = {
        id: randomUUID(),
        key: `${p.key}-${String(z.number().int().positive().parse(internal.nextIssue))}`,
        ...data,
        templateId,
        templateVersion,
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      this.insert("issues", { ...issue, labels: JSON.stringify(issue.labels) });
      this.db
        .prepare("UPDATE projects SET nextIssue=nextIssue+1 WHERE id=?")
        .run(p.id);
      this.context.issueActivity(actor, null, issue, {
        action: "created",
        detail: "이슈 생성",
      });
      if (envelope.operationId)
        this.context.insert("issue_creation_operations", {
          actorId: actor.id,
          operationId: envelope.operationId,
          payload,
          issueId: issue.id,
        });
      return issue;
    });
  }
  updateIssue(actor: Actor, issueId: string, input: unknown): Issue {
    return this.tx(() => this.patchIssue(actor, issueId, input));
  }
  private patchIssue(
    actor: Actor,
    issueId: string,
    input: unknown,
    metadata?: IssueMutationMetadata,
  ): Issue {
    this.write(actor);
    if (
      !input ||
      typeof input !== "object" ||
      !("revision" in input) ||
      !Number.isInteger(input.revision) ||
      Number(input.revision) < 1
    )
      throw new DomainError(
        422,
        "REVISION_REQUIRED",
        "최신 이슈 revision을 함께 보내세요.",
      );
    const { revision, ...data } = parse(issueUpdate, input);
    const current = this.writableIssue(actor, issueId);
    if (current.revision !== revision)
      throw new DomainError(
        409,
        "REVISION_CONFLICT",
        "다른 사용자가 변경했습니다. 최신 이슈를 불러온 뒤 다시 시도하세요.",
      );
    if (data.status === "closed" && actor.role !== "owner")
      throw new DomainError(
        403,
        "OWNER_REQUIRED",
        "소유자만 이슈를 종료할 수 있습니다.",
      );
    this.versionsBelong(current.projectId, data);
    return this.context.changeIssue(
      actor,
      current,
      data,
      metadata ?? {
        action: "updated",
        detail: Object.keys(data).length
          ? `변경: ${Object.keys(data).join(", ")}`
          : "이슈 확인",
      },
    );
  }
  deleteIssue(actor: Actor, issueId: string): void {
    this.owner(actor);
    this.tx(() => {
      this.issue(actor, issueId);
      this.relations.beforeIssueDelete(actor, issueId);
      this.db.prepare("DELETE FROM issues WHERE id=?").run(issueId);
    });
  }
  addComment(actor: Actor, issueId: string, input: unknown): Comment {
    this.write(actor);
    const data = parse(
      z.object({ body: z.string().trim().min(1).max(20000) }).strict(),
      input,
    );
    return this.tx(() => {
      this.writableIssue(actor, issueId);
      const c = {
        id: randomUUID(),
        issueId,
        ...data,
        authorId: actor.id,
        authorName: actor.name,
        createdAt: now(),
      };
      this.insert("comments", c);
      this.activity(actor, issueId, "commented", "댓글 작성");
      return c;
    });
  }
  deleteComment(actor: Actor, commentId: string): void {
    this.write(actor);
    this.tx(() => {
      const c = this.get("comments", commentId);
      this.writableIssue(actor, textColumn(c, "issueId"));
      if (actor.role !== "owner" && c.authorId !== actor.id)
        throw new DomainError(
          403,
          "AUTHOR_REQUIRED",
          "작성자 또는 소유자만 삭제할 수 있습니다.",
        );
      this.db.prepare("DELETE FROM comments WHERE id=?").run(commentId);
      this.activity(
        actor,
        textColumn(c, "issueId"),
        "comment_removed",
        "댓글 삭제",
      );
    });
  }
  authorizeAttachmentWrite(actor: Actor, issueId: string) {
    this.write(actor);
    return this.writableIssue(actor, issueId);
  }
  private insertAttachment(
    actor: Actor,
    issueId: string,
    data: z.infer<typeof attachmentSchema>,
  ): Attachment {
    const a: Attachment = {
      id: randomUUID(),
      issueId,
      kind: data.kind,
      name: data.name,
      url: data.kind === "link" ? data.url : null,
      storageKey: data.kind === "file" ? data.storageKey : null,
      mimeType: data.kind === "file" ? data.mimeType : null,
      size: data.kind === "file" ? data.size : 0,
      authorId: actor.id,
      authorName: actor.name,
      createdAt: now(),
    };
    this.insert("attachments", { ...a });
    this.activity(actor, issueId, "attachment_added", `자료 추가: ${a.name}`);
    return a;
  }
  addAttachment(actor: Actor, issueId: string, input: unknown): Attachment {
    this.write(actor);
    const data = parse(attachmentSchema, input);
    return this.tx(() => {
      this.authorizeAttachmentWrite(actor, issueId);
      return this.insertAttachment(actor, issueId, data);
    });
  }
  addFileAttachment(
    actor: Actor,
    issueId: string,
    file: StoredFile,
    operationId?: string,
  ): Attachment {
    const payload = attachmentOperationPayloadSchema.parse({
      contractVersion: 1,
      kind: "issue_file_create",
      issueId,
      file: {
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: file.size,
        checksum: file.checksum,
      },
    });
    const data = parse(attachmentSchema, {
      kind: "file",
      name: file.fileName,
      storageKey: file.storageKey,
      mimeType: file.mimeType,
      size: file.size,
    });
    if (operationId !== undefined) z.uuid().parse(operationId);
    return this.tx(() => {
      const issue = this.authorizeAttachmentWrite(actor, issueId);
      const hash = attachmentPayloadHash(payload);
      if (operationId) {
        const previous = this.db
          .prepare(
            "SELECT projectId,payloadHash,result FROM attachment_operations WHERE actorId=? AND kind='issue_file_create' AND operationId=?",
          )
          .get(actor.id, operationId);
        if (previous) {
          if (
            previous.projectId !== issue.projectId ||
            previous.payloadHash !== hash
          )
            throw new DomainError(
              409,
              "OPERATION_CONFLICT",
              "같은 작업 식별자의 입력이 다릅니다.",
            );
          const raw: unknown = boundedAttachmentJson(previous.result);
          return attachmentOperationReceiptSchema.parse(raw);
        }
      }
      const receipt = attachmentOperationReceiptSchema.parse(
        this.insertAttachment(actor, issueId, data),
      );
      if (operationId)
        this.db
          .prepare(
            "INSERT INTO attachment_operations VALUES (?,'issue_file_create',?,?,?,?,?,?,?,?)",
          )
          .run(
            actor.id,
            operationId,
            issue.projectId,
            issueId,
            receipt.id,
            canonicalJson(payload),
            hash,
            JSON.stringify(receipt),
            receipt.createdAt,
          );
      return receipt;
    });
  }
  attachmentFileScope(actor: Actor, attachmentId: string) {
    const attachment = this.getAttachment(actor, attachmentId),
      projectId = this.issue(actor, attachment.issueId).projectId;
    const operation = this.db
      .prepare(
        "SELECT payload FROM attachment_operations WHERE attachmentId=? LIMIT 1",
      )
      .get(attachmentId);
    const raw: unknown = operation
      ? boundedAttachmentJson(operation.payload)
      : null;
    return {
      attachment,
      projectId,
      expectedChecksum:
        raw === null
          ? null
          : attachmentOperationPayloadSchema.parse(raw).file.checksum,
    };
  }
  getAttachmentOperation(actor: Actor, projectId: string, operationId: string) {
    this.project(actor, projectId);
    z.uuid().parse(operationId);
    const row = this.db
      .prepare(
        "SELECT payload,result FROM attachment_operations WHERE actorId=? AND kind='issue_file_create' AND projectId=? AND operationId=?",
      )
      .get(actor.id, projectId, operationId);
    if (!row) return { status: { recorded: false as const }, storageKey: null };
    const rawPayload: unknown = boundedAttachmentJson(row.payload),
      rawReceipt: unknown = boundedAttachmentJson(row.result);
    const payload = attachmentOperationPayloadSchema.parse(rawPayload),
      receipt = attachmentOperationReceiptSchema.parse(rawReceipt),
      current = this.db
        .prepare("SELECT id FROM attachments WHERE id=?")
        .get(receipt.id);
    return {
      storageKey: receipt.storageKey,
      status: attachmentOperationStatusSchema.parse({
        recorded: true,
        operationId,
        payload,
        receipt: attachmentFileReceipt(
          receipt,
          projectId,
          operationId,
          payload.file.checksum,
          Boolean(current),
        ),
      }),
    };
  }
  getAttachment(actor: Actor, attachmentId: string): Attachment {
    const a = attachmentResponseSchema.parse(
      this.get("attachments", attachmentId),
    );
    this.issue(actor, a.issueId);
    return a;
  }
  deleteAttachment(actor: Actor, attachmentId: string): Attachment {
    this.write(actor);
    return this.tx(() => {
      const a = this.getAttachment(actor, attachmentId);
      this.writableIssue(actor, a.issueId);
      if (actor.role !== "owner" && a.authorId !== actor.id)
        throw new DomainError(
          403,
          "AUTHOR_REQUIRED",
          "작성자 또는 소유자만 삭제할 수 있습니다.",
        );
      this.db.prepare("DELETE FROM attachments WHERE id=?").run(attachmentId);
      this.activity(
        actor,
        a.issueId,
        "attachment_removed",
        `자료 삭제: ${a.name}`,
      );
      return a;
    });
  }
  reportAgent(actor: Actor, input: unknown): AgentReport {
    this.write(actor);
    if (actor.role !== "agent")
      throw new DomainError(
        403,
        "AGENT_REQUIRED",
        "에이전트 인증으로만 상태를 보고할 수 있습니다.",
      );
    const data = parse(
      z
        .object({
          projectId: id,
          issueId: id.nullable().optional().default(null),
          state: z.enum(["idle", "working", "blocked", "done"]),
          message: z.string().trim().max(2000),
          externalSessionId: id.optional(),
          eventId: id.optional(),
        })
        .strict(),
      input,
    );
    if (Boolean(data.externalSessionId) !== Boolean(data.eventId))
      throw new DomainError(
        400,
        "VALIDATION",
        "externalSessionId와 eventId를 함께 보내세요.",
      );
    const projection: { value: AgentReport | null } = { value: null };
    const event = this.sessions.report(
      actor,
      {
        projectId: data.projectId,
        issueId: data.issueId,
        externalSessionId:
          data.externalSessionId ?? `legacy:${data.issueId ?? "project"}`,
        eventId: data.eventId ?? randomUUID(),
        message: data.message || "상세 메시지 없는 이전 보고",
        ...(data.state === "done"
          ? { kind: "end" }
          : { kind: "report", state: data.state }),
      },
      !data.externalSessionId,
      (receivedAt) => {
        const old = this.db
          .prepare(
            "SELECT id FROM agent_reports WHERE agentId=? AND projectId=?",
          )
          .get(actor.id, data.projectId);
        const record = {
          id: old ? String(old.id) : randomUUID(),
          agentId: actor.id,
          agentName: actor.name,
          projectId: data.projectId,
          issueId: data.issueId,
          state: data.state,
          message: data.message,
          reportedAt: receivedAt,
        };
        if (old) this.update("agent_reports", record.id, record);
        else this.insert("agent_reports", record);
        projection.value = { ...record, stale: false };
      },
    );
    if (projection.value) return projection.value;
    // A deduplicated event must not roll the compatibility snapshot backward or refresh its clock.
    const current = this.db
      .prepare("SELECT * FROM agent_reports WHERE agentId=? AND projectId=?")
      .get(actor.id, data.projectId);
    if (current) return reportRow(current);
    // A new-API event can predate the first compatibility call; return its original receipt without fabricating a newer snapshot.
    return reportRow({
      id: event.session.id,
      agentId: actor.id,
      agentName: actor.name,
      projectId: data.projectId,
      issueId: data.issueId,
      state: data.state,
      message: data.message,
      reportedAt: event.event.receivedAt,
    });
  }
}
