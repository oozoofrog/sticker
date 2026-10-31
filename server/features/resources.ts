import { createHash, randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { DomainError } from "../domain-error.js";
import type { StoreContext } from "../store-context.js";
import type { Actor, Issue } from "../types.js";
import type { StoredFile } from "../file-storage.js";
import {
  resourceCreateInputSchema,
  resourceUploadInputSchema,
  resourcePatchInputSchema,
  resourceMutationInputSchema,
  resourceGuidanceInputSchema,
  resourceQuerySchema,
  resourceLinkInputSchema,
  resourceUnlinkInputSchema,
  resourceReferenceInputSchema,
  resourceSchema,
  resourceVersionSchema,
  resourceVersionSummarySchema,
  resourceUsageSchema,
  resourceDetailSchema,
  resourceEventSchema,
  issueResourceLinkSchema,
  resourceReferenceSchema,
  type Resource,
  type ResourceVersion,
  type ResourceDetail,
  type IssueResourceLink,
  type ResourceReference,
} from "../contracts/resources.js";
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const out = schema.safeParse(input);
  if (!out.success)
    throw new DomainError(400, "INVALID_INPUT", "자료 입력을 확인하세요.");
  return out.data;
}
const versionColumns =
  "resourceId,version,kind,title,markdown,url,fileName,mimeType,size,checksum,authorId,authorName,createdAt";
const storedFileSchema = z.object({
  storageKey: z.uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
type VersionContent = {
  kind: Resource["kind"];
  markdown: string | null;
  url: string | null;
  fileName: string | null;
  storageKey: string | null;
  mimeType: string | null;
  size: number;
  checksum: string | null;
};
const sessionRowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  projectId: z.string(),
  issueId: z.string().nullable(),
  closedAt: z.string().nullable(),
});
/** Local project data only: URLs and Markdown never confer authority or trigger fetches. */
export class ResourceService {
  constructor(private readonly ctx: StoreContext) {}
  authorizeProjectWrite(actor: Actor, projectId: string) {
    this.ctx.write(actor);
    this.ctx.project(actor, projectId);
  }
  authorizeFileUpdate(actor: Actor, id: string) {
    const resource = this.header(actor, id);
    this.writable(actor, resource);
    this.active(resource);
    if (resource.kind !== "file")
      throw new DomainError(
        400,
        "RESOURCE_KIND",
        "파일 자료만 교체할 수 있습니다.",
      );
    return resource;
  }
  private header(actor: Actor, id: string): Resource {
    const row = this.ctx.db
      .prepare("SELECT * FROM resources WHERE id=?")
      .get(id);
    if (!row)
      throw new DomainError(
        404,
        "RESOURCE_NOT_FOUND",
        "자료가 없거나 삭제되었습니다.",
      );
    const projectId = z.string().parse(row.projectId);
    this.ctx.project(actor, projectId);
    const versionId = z.string().nullable().parse(row.versionId);
    return resourceSchema.parse({
      ...row,
      isGuidance: row.isGuidance === 1,
      versionAvailable:
        versionId === null ||
        !!this.ctx.db
          .prepare("SELECT 1 FROM versions WHERE id=? AND projectId=?")
          .get(versionId, projectId),
    });
  }
  private active(resource: Resource) {
    if (resource.deletedAt)
      throw new DomainError(
        409,
        "RESOURCE_DELETED",
        "삭제된 자료는 변경하거나 새로 연결할 수 없습니다.",
      );
  }
  private writable(actor: Actor, resource: Resource) {
    this.ctx.write(actor);
    if (resource.isGuidance) this.ctx.owner(actor);
  }
  private revision(actual: number, expected: number) {
    if (actual !== expected)
      throw new DomainError(
        409,
        "REVISION_CONFLICT",
        "자료 또는 이슈가 변경되었습니다. 새로고침 후 다시 확인하세요.",
      );
  }
  private owningVersion(
    actor: Actor,
    projectId: string,
    versionId: string | null,
  ) {
    if (versionId === null) return;
    const row = this.ctx.get("versions", versionId);
    this.ctx.scope(actor, z.string().parse(row.projectId));
    if (row.projectId !== projectId)
      throw new DomainError(
        400,
        "PROJECT_MISMATCH",
        "같은 프로젝트의 버전만 선택할 수 있습니다.",
      );
  }
  private event(actor: Actor, resource: Resource, action: string) {
    this.ctx.db
      .prepare("INSERT INTO resource_events VALUES (?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        resource.id,
        action,
        resource.revision,
        actor.id,
        actor.name,
        this.ctx.now(),
      );
  }
  private operation<T>(
    actor: Actor,
    kind: string,
    operationId: string,
    projectId: string,
    payload: unknown,
    schema: z.ZodType<T>,
    run: () => T,
  ): T {
    const hash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    const previous = this.ctx.db
      .prepare(
        "SELECT projectId,payloadHash,result FROM resource_operations WHERE actorId=? AND kind=? AND operationId=?",
      )
      .get(actor.id, kind, operationId);
    if (previous) {
      this.ctx.project(actor, z.string().parse(previous.projectId));
      if (previous.projectId !== projectId || previous.payloadHash !== hash)
        throw new DomainError(
          409,
          "OPERATION_CONFLICT",
          "같은 작업 식별자의 입력이 다릅니다.",
        );
      const result: unknown = JSON.parse(z.string().parse(previous.result));
      return schema.parse(result);
    }
    const result = run();
    this.ctx.db
      .prepare("INSERT INTO resource_operations VALUES (?,?,?,?,?,?)")
      .run(
        actor.id,
        kind,
        operationId,
        projectId,
        hash,
        JSON.stringify(result),
      );
    return result;
  }
  private content(row: Record<string, SQLOutputValue>): VersionContent {
    return z
      .object({
        kind: z.enum(["markdown", "file", "link"]),
        markdown: z.string().nullable(),
        url: z.string().nullable(),
        fileName: z.string().nullable(),
        storageKey: z.string().nullable(),
        mimeType: z.string().nullable(),
        size: z.number(),
        checksum: z.string().nullable(),
      })
      .parse(row);
  }
  private append(
    actor: Actor,
    resourceId: string,
    version: number,
    title: string,
    content: VersionContent,
  ) {
    this.ctx.db
      .prepare(
        "INSERT INTO resource_versions (resourceId,version,kind,title,markdown,url,fileName,storageKey,mimeType,size,checksum,authorId,authorName,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        resourceId,
        version,
        content.kind,
        title,
        content.markdown,
        content.url,
        content.fileName,
        content.storageKey,
        content.mimeType,
        content.size,
        content.checksum,
        actor.id,
        actor.name,
        this.ctx.now(),
      );
  }
  private fileContent(file: StoredFile): VersionContent {
    const stored = storedFileSchema.parse(file);
    return { kind: "file", markdown: null, url: null, ...stored };
  }
  private fileFingerprint(file: StoredFile) {
    return {
      fileName: file.fileName,
      mimeType: file.mimeType,
      size: file.size,
      checksum: file.checksum,
    };
  }
  private createValue(
    actor: Actor,
    data: z.infer<typeof resourceUploadInputSchema>,
    content: VersionContent,
  ): ResourceDetail {
    const id = randomUUID(),
      now = this.ctx.now();
    this.ctx.db
      .prepare(
        "INSERT INTO resources (id,projectId,versionId,kind,title,currentVersion,revision,isGuidance,guidanceBy,guidanceAt,deletedAt,createdAt,updatedAt) VALUES (?,?,?,?,?,1,1,0,NULL,NULL,NULL,?,?)",
      )
      .run(
        id,
        data.projectId,
        data.versionId,
        content.kind,
        data.title,
        now,
        now,
      );
    this.append(actor, id, 1, data.title, content);
    const resource = this.header(actor, id);
    this.event(actor, resource, "created");
    return this.get(actor, id);
  }
  create(actor: Actor, input: unknown): ResourceDetail {
    const data = parse(resourceCreateInputSchema, input);
    this.ctx.write(actor);
    return this.ctx.tx(() => {
      this.ctx.project(actor, data.projectId);
      this.owningVersion(actor, data.projectId, data.versionId);
      return this.operation(
        actor,
        "create",
        data.operationId,
        data.projectId,
        data,
        resourceDetailSchema,
        () =>
          this.createValue(actor, data, {
            kind: data.kind,
            markdown: data.kind === "markdown" ? data.markdown : null,
            url: data.kind === "link" ? data.url : null,
            fileName: null,
            storageKey: null,
            mimeType: null,
            size: 0,
            checksum: null,
          }),
      );
    });
  }
  createFile(actor: Actor, input: unknown, file: StoredFile): ResourceDetail {
    const data = parse(resourceUploadInputSchema, input),
      content = this.fileContent(file);
    this.ctx.write(actor);
    return this.ctx.tx(() => {
      this.ctx.project(actor, data.projectId);
      this.owningVersion(actor, data.projectId, data.versionId);
      return this.operation(
        actor,
        "create_file",
        data.operationId,
        data.projectId,
        { ...data, file: this.fileFingerprint(file) },
        resourceDetailSchema,
        () => this.createValue(actor, data, content),
      );
    });
  }
  private updated(
    actor: Actor,
    resource: Resource,
    data: z.infer<typeof resourcePatchInputSchema>,
    content: VersionContent,
  ): ResourceDetail {
    this.active(resource);
    this.revision(resource.revision, data.revision);
    const versionId =
      data.versionId === undefined ? resource.versionId : data.versionId;
    this.owningVersion(actor, resource.projectId, versionId);
    const title = data.title ?? resource.title,
      version = resource.currentVersion + 1;
    this.append(actor, resource.id, version, title, content);
    this.ctx.db
      .prepare(
        "UPDATE resources SET title=?,versionId=?,currentVersion=?,revision=revision+1,updatedAt=? WHERE id=?",
      )
      .run(title, versionId, version, this.ctx.now(), resource.id);
    this.event(actor, this.header(actor, resource.id), "updated");
    return this.get(actor, resource.id);
  }
  update(actor: Actor, id: string, input: unknown): ResourceDetail {
    const data = parse(resourcePatchInputSchema, input);
    this.ctx.write(actor);
    return this.ctx.tx(() => {
      const resource = this.header(actor, id);
      this.writable(actor, resource);
      return this.operation(
        actor,
        "update",
        data.operationId,
        resource.projectId,
        { id, ...data },
        resourceDetailSchema,
        () => {
          const row = this.ctx.db
            .prepare(
              "SELECT * FROM resource_versions WHERE resourceId=? AND version=?",
            )
            .get(id, resource.currentVersion);
          if (!row) throw new Error("Missing resource version");
          const content = this.content(row);
          if (
            (data.markdown !== undefined && resource.kind !== "markdown") ||
            (data.url !== undefined && resource.kind !== "link")
          )
            throw new DomainError(
              400,
              "RESOURCE_KIND",
              "자료 종류를 변경할 수 없습니다.",
            );
          return this.updated(actor, resource, data, {
            ...content,
            markdown: data.markdown ?? content.markdown,
            url: data.url ?? content.url,
          });
        },
      );
    });
  }
  updateFile(
    actor: Actor,
    id: string,
    input: unknown,
    file: StoredFile,
  ): ResourceDetail {
    const data = parse(resourcePatchInputSchema, input),
      content = this.fileContent(file);
    this.ctx.write(actor);
    return this.ctx.tx(() => {
      const resource = this.header(actor, id);
      this.writable(actor, resource);
      if (
        resource.kind !== "file" ||
        data.markdown !== undefined ||
        data.url !== undefined
      )
        throw new DomainError(
          400,
          "RESOURCE_KIND",
          "파일 자료만 교체할 수 있습니다.",
        );
      return this.operation(
        actor,
        "update_file",
        data.operationId,
        resource.projectId,
        { id, ...data, file: this.fileFingerprint(file) },
        resourceDetailSchema,
        () => this.updated(actor, resource, data, content),
      );
    });
  }
  guidance(actor: Actor, id: string, input: unknown): ResourceDetail {
    const data = parse(resourceGuidanceInputSchema, input);
    this.ctx.owner(actor);
    return this.ctx.tx(() => {
      const resource = this.header(actor, id);
      return this.operation(
        actor,
        "guidance",
        data.operationId,
        resource.projectId,
        { id, ...data },
        resourceDetailSchema,
        () => {
          this.active(resource);
          this.revision(resource.revision, data.revision);
          this.ctx.db
            .prepare(
              "UPDATE resources SET isGuidance=?,guidanceBy=?,guidanceAt=?,revision=revision+1,updatedAt=? WHERE id=?",
            )
            .run(
              Number(data.isGuidance),
              data.isGuidance ? actor.id : null,
              data.isGuidance ? this.ctx.now() : null,
              this.ctx.now(),
              id,
            );
          this.event(
            actor,
            this.header(actor, id),
            data.isGuidance ? "guidance_designated" : "guidance_removed",
          );
          return this.get(actor, id);
        },
      );
    });
  }
  remove(actor: Actor, id: string, input: unknown): ResourceDetail {
    const data = parse(resourceMutationInputSchema, input);
    this.ctx.write(actor);
    return this.ctx.tx(() => {
      const resource = this.header(actor, id);
      this.writable(actor, resource);
      return this.operation(
        actor,
        "delete",
        data.operationId,
        resource.projectId,
        { id, ...data },
        resourceDetailSchema,
        () => {
          this.active(resource);
          this.revision(resource.revision, data.revision);
          this.ctx.db
            .prepare(
              "UPDATE resources SET deletedAt=?,isGuidance=0,revision=revision+1,updatedAt=? WHERE id=?",
            )
            .run(this.ctx.now(), this.ctx.now(), id);
          this.event(actor, this.header(actor, id), "deleted");
          return this.get(actor, id);
        },
      );
    });
  }
  version(actor: Actor, id: string, version: number): ResourceVersion {
    this.header(actor, id);
    const number = parse(z.number().int().positive(), version),
      row = this.ctx.db
        .prepare(
          `SELECT ${versionColumns} FROM resource_versions WHERE resourceId=? AND version=?`,
        )
        .get(id, number);
    if (!row)
      throw new DomainError(
        404,
        "RESOURCE_VERSION_NOT_FOUND",
        "자료 버전이 없거나 삭제되었습니다.",
      );
    return resourceVersionSchema.parse(row);
  }
  get(actor: Actor, id: string): ResourceDetail {
    const resource = this.header(actor, id);
    const issues = this.ctx.db
      .prepare(
        "SELECT l.issueId,i.key,i.title,l.resourceVersion FROM issue_resource_links l JOIN issues i ON i.id=l.issueId WHERE l.resourceId=? ORDER BY l.createdAt,l.id",
      )
      .all(id)
      .map((row) => {
        this.ctx.issue(actor, z.string().parse(row.issueId));
        return row;
      });
    const results = this.ctx.db
      .prepare(
        "SELECT r.sessionId,r.eventId,s.agentName,r.resourceVersion FROM session_resource_refs r JOIN agent_sessions s ON s.id=r.sessionId WHERE r.resourceId=? ORDER BY r.createdAt,r.id",
      )
      .all(id)
      .map((row) => {
        this.session(actor, z.string().parse(row.sessionId));
        return row;
      });
    const history = resourceVersionSummarySchema
      .array()
      .parse(
        this.ctx.db
          .prepare(
            "SELECT resourceId,version,kind,title,fileName,mimeType,size,authorId,authorName,createdAt FROM resource_versions WHERE resourceId=? ORDER BY version DESC",
          )
          .all(id),
      );
    return {
      resource,
      current: resource.deletedAt
        ? null
        : this.version(actor, id, resource.currentVersion),
      history,
      events: resourceEventSchema
        .array()
        .parse(
          this.ctx.db
            .prepare(
              "SELECT * FROM resource_events WHERE resourceId=? ORDER BY revision,id",
            )
            .all(id),
        ),
      usage: resourceUsageSchema.parse({ issues, results }),
    };
  }
  list(actor: Actor, input: unknown = {}): Resource[] {
    const query = parse(resourceQuerySchema, input);
    if (query.projectId) this.ctx.project(actor, query.projectId);
    if (query.versionId) {
      const row = this.ctx.get("versions", query.versionId);
      const projectId = z.string().parse(row.projectId);
      this.ctx.project(actor, projectId);
      if (query.projectId && projectId !== query.projectId)
        throw new DomainError(
          400,
          "PROJECT_MISMATCH",
          "같은 프로젝트의 버전만 선택할 수 있습니다.",
        );
    }
    const rows = this.ctx.db
      .prepare(
        "SELECT id,projectId FROM resources WHERE deletedAt IS NULL ORDER BY updatedAt DESC,id",
      )
      .all();
    return rows
      .filter(
        (row) =>
          actor.role === "owner" ||
          actor.projectIds === null ||
          actor.projectIds.includes(z.string().parse(row.projectId)),
      )
      .map((row) => this.header(actor, z.string().parse(row.id)))
      .filter((resource) => {
        if (query.projectId && resource.projectId !== query.projectId)
          return false;
        if (
          query.versionId !== undefined &&
          resource.versionId !== query.versionId
        )
          return false;
        if (query.kind && resource.kind !== query.kind) return false;
        if (!query.query) return true;
        const current = this.version(
          actor,
          resource.id,
          resource.currentVersion,
        );
        return [
          resource.title,
          current.markdown ?? "",
          current.url ?? "",
          current.fileName ?? "",
        ]
          .join("\n")
          .toLocaleLowerCase()
          .includes(query.query.toLocaleLowerCase());
      });
  }
  projectGuidance(actor: Actor, projectId: string) {
    return this.list(actor, { projectId })
      .filter((resource) => resource.isGuidance)
      .map((resource) => this.get(actor, resource.id));
  }
  fileRecord(actor: Actor, id: string, version: number): StoredFile {
    const value = this.version(actor, id, version);
    if (value.kind !== "file")
      throw new DomainError(400, "RESOURCE_KIND", "파일 자료가 아닙니다.");
    const row = this.ctx.db
      .prepare(
        "SELECT storageKey,fileName,mimeType,size,checksum FROM resource_versions WHERE resourceId=? AND version=?",
      )
      .get(id, version);
    return storedFileSchema.parse(row);
  }
  private changedIssue(
    actor: Actor,
    issue: Issue,
    action: string,
    title: string,
  ) {
    this.ctx.changeIssue(actor, issue, {}, { action, detail: title });
  }
  private linkValue(
    actor: Actor,
    row: Record<string, SQLOutputValue>,
  ): IssueResourceLink {
    const id = z.string().parse(row.resourceId),
      version = z.number().parse(row.resourceVersion);
    return issueResourceLinkSchema.parse({
      id: row.id,
      issueId: row.issueId,
      resource: this.header(actor, id),
      version: this.version(actor, id, version),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    });
  }
  issueLinks(actor: Actor, issueId: string): IssueResourceLink[] {
    this.ctx.issue(actor, issueId);
    return this.ctx.db
      .prepare(
        "SELECT * FROM issue_resource_links WHERE issueId=? ORDER BY createdAt,id",
      )
      .all(issueId)
      .map((row) => this.linkValue(actor, row));
  }
  link(actor: Actor, issueId: string, input: unknown): IssueResourceLink {
    const data = parse(resourceLinkInputSchema, input);
    this.ctx.write(actor);
    return this.ctx.tx(() => {
      const issue = this.ctx.writableIssue(actor, issueId),
        resource = this.header(actor, data.resourceId);
      if (issue.projectId !== resource.projectId)
        throw new DomainError(
          400,
          "PROJECT_MISMATCH",
          "같은 프로젝트의 자료만 연결할 수 있습니다.",
        );
      return this.operation(
        actor,
        "link",
        data.operationId,
        issue.projectId,
        { issueId, ...data },
        issueResourceLinkSchema,
        () => {
          this.active(resource);
          this.revision(issue.revision, data.issueRevision);
          const version = data.resourceVersion ?? resource.currentVersion;
          this.version(actor, resource.id, version);
          if (
            this.ctx.db
              .prepare(
                "SELECT 1 FROM issue_resource_links WHERE issueId=? AND resourceId=? AND resourceVersion=?",
              )
              .get(issueId, resource.id, version)
          )
            throw new DomainError(
              409,
              "RESOURCE_LINK_EXISTS",
              "이미 연결된 자료 버전입니다.",
            );
          const id = randomUUID();
          this.ctx.db
            .prepare("INSERT INTO issue_resource_links VALUES (?,?,?,?,?,?)")
            .run(id, issueId, resource.id, version, actor.id, this.ctx.now());
          this.changedIssue(actor, issue, "resource_linked", resource.title);
          const row = this.ctx.db
            .prepare("SELECT * FROM issue_resource_links WHERE id=?")
            .get(id);
          if (!row) throw new Error("Missing resource link");
          return this.linkValue(actor, row);
        },
      );
    });
  }
  unlink(actor: Actor, issueId: string, linkId: string, input: unknown) {
    const data = parse(resourceUnlinkInputSchema, input);
    this.ctx.write(actor);
    return this.ctx.tx(() => {
      const issue = this.ctx.writableIssue(actor, issueId);
      return this.operation(
        actor,
        "unlink",
        data.operationId,
        issue.projectId,
        { issueId, linkId, ...data },
        z.object({ removed: z.literal(true) }),
        () => {
          this.revision(issue.revision, data.issueRevision);
          const row = this.ctx.db
            .prepare(
              "SELECT * FROM issue_resource_links WHERE id=? AND issueId=?",
            )
            .get(linkId, issueId);
          if (!row)
            throw new DomainError(
              404,
              "RESOURCE_LINK_NOT_FOUND",
              "연결을 찾을 수 없습니다.",
            );
          const resource = this.header(actor, z.string().parse(row.resourceId));
          this.ctx.db
            .prepare("DELETE FROM issue_resource_links WHERE id=?")
            .run(linkId);
          this.changedIssue(actor, issue, "resource_unlinked", resource.title);
          return { removed: true };
        },
      );
    });
  }
  private session(actor: Actor, id: string) {
    const raw = this.ctx.db
      .prepare(
        "SELECT id,agentId,projectId,issueId,closedAt FROM agent_sessions WHERE id=?",
      )
      .get(id);
    if (!raw)
      throw new DomainError(
        404,
        "SESSION_NOT_FOUND",
        "세션이 없거나 삭제되었습니다.",
      );
    const session = sessionRowSchema.parse(raw);
    this.ctx.project(actor, session.projectId);
    if (session.issueId) this.ctx.issue(actor, session.issueId);
    return session;
  }
  private referenceValue(
    actor: Actor,
    row: Record<string, SQLOutputValue>,
  ): ResourceReference {
    const id = z.string().parse(row.resourceId),
      version = z.number().parse(row.resourceVersion);
    return resourceReferenceSchema.parse({
      id: row.id,
      sessionId: row.sessionId,
      eventId: row.eventId,
      resource: this.header(actor, id),
      version: this.version(actor, id, version),
      recordedBy: row.recordedBy,
      createdAt: row.createdAt,
    });
  }
  sessionReferences(actor: Actor, sessionId: string): ResourceReference[] {
    this.session(actor, sessionId);
    return this.ctx.db
      .prepare(
        "SELECT * FROM session_resource_refs WHERE sessionId=? ORDER BY createdAt,id",
      )
      .all(sessionId)
      .map((row) => this.referenceValue(actor, row));
  }
  recordReference(actor: Actor, input: unknown): ResourceReference {
    const data = parse(resourceReferenceInputSchema, input);
    this.ctx.write(actor);
    return this.ctx.tx(() => {
      const session = this.session(actor, data.sessionId);
      if (actor.role !== "owner" && session.agentId !== actor.id)
        throw new DomainError(
          403,
          "SESSION_OWNER_REQUIRED",
          "자신의 세션 결과에만 자료를 기록할 수 있습니다.",
        );
      if (session.closedAt)
        throw new DomainError(
          409,
          "SESSION_CLOSED",
          "종료된 세션은 변경할 수 없습니다.",
        );
      if (session.issueId) this.ctx.writableIssue(actor, session.issueId);
      const resource = this.header(actor, data.resourceId);
      if (resource.projectId !== session.projectId)
        throw new DomainError(
          400,
          "PROJECT_MISMATCH",
          "같은 프로젝트의 자료만 기록할 수 있습니다.",
        );
      if (
        !this.ctx.db
          .prepare(
            "SELECT 1 FROM session_events WHERE sessionId=? AND eventId=? AND kind='result'",
          )
          .get(session.id, data.eventId)
      )
        throw new DomainError(
          400,
          "RESULT_EVENT_REQUIRED",
          "기록된 결과 이벤트를 선택하세요.",
        );
      return this.operation(
        actor,
        "reference",
        data.operationId,
        session.projectId,
        data,
        resourceReferenceSchema,
        () => {
          this.active(resource);
          this.version(actor, resource.id, data.resourceVersion);
          if (
            this.ctx.db
              .prepare(
                "SELECT 1 FROM session_resource_refs WHERE sessionId=? AND eventId=? AND resourceId=? AND resourceVersion=?",
              )
              .get(session.id, data.eventId, resource.id, data.resourceVersion)
          )
            throw new DomainError(
              409,
              "RESOURCE_REFERENCE_EXISTS",
              "이미 기록된 자료 버전입니다.",
            );
          const id = randomUUID();
          this.ctx.db
            .prepare("INSERT INTO session_resource_refs VALUES (?,?,?,?,?,?,?)")
            .run(
              id,
              session.id,
              data.eventId,
              resource.id,
              data.resourceVersion,
              actor.id,
              this.ctx.now(),
            );
          this.ctx.db
            .prepare("UPDATE agent_sessions SET revision=revision+1 WHERE id=?")
            .run(session.id);
          const row = this.ctx.db
            .prepare("SELECT * FROM session_resource_refs WHERE id=?")
            .get(id);
          if (!row) throw new Error("Missing resource reference");
          return this.referenceValue(actor, row);
        },
      );
    });
  }
}
