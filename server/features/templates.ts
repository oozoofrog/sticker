import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoreContext } from "../store-context.js";
import { DomainError } from "../domain-error.js";
import type { Actor } from "../types.js";
import {
  issueTemplateSchema,
  templateVersionSchema,
  templateCreateSchema,
  templateUpdateSchema,
  templateDeleteSchema,
  templateAssigneeSchema,
  TEMPLATE_EXAMPLES,
  type TemplateDefaults,
  templateValuesSchema,
  templatePreviewInputSchema,
  validateTemplateValues,
  renderTemplate,
  type TemplateValues,
  type TemplateDetail,
  type IssueTemplate,
} from "../contracts/templates.js";
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success)
    throw new DomainError(
      400,
      "VALIDATION",
      value.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  return value.data;
}
export class TemplateService {
  constructor(
    private readonly context: StoreContext,
    private readonly actors: readonly Actor[] | (() => readonly Actor[]),
  ) {}
  examples() {
    return structuredClone(TEMPLATE_EXAMPLES);
  }
  private eligible(projectId: string) {
    return (typeof this.actors === "function" ? this.actors() : this.actors)
      .filter(
        (actor) =>
          actor.role === "owner" ||
          actor.projectIds === null ||
          actor.projectIds.includes(projectId),
      )
      .map((actor) =>
        templateAssigneeSchema.parse({
          id: actor.id,
          name: actor.name,
          role: actor.role,
        }),
      );
  }
  assignees(actor: Actor, projectId: string) {
    this.context.project(actor, projectId);
    return this.eligible(projectId);
  }
  private template(actor: Actor, id: string): IssueTemplate {
    const raw = this.context.db
      .prepare("SELECT * FROM issue_templates WHERE id=?")
      .get(id);
    if (!raw)
      throw new DomainError(
        404,
        "TEMPLATE_NOT_FOUND",
        "템플릿을 찾을 수 없습니다.",
      );
    const template = issueTemplateSchema.parse(raw);
    this.context.scope(actor, template.projectId);
    if (template.deletedAt)
      throw new DomainError(404, "TEMPLATE_NOT_FOUND", "삭제된 템플릿입니다.");
    return template;
  }
  private defaults(projectId: string, defaults: TemplateDefaults) {
    if (
      defaults.assignee &&
      !this.eligible(projectId).some((actor) => actor.id === defaults.assignee)
    )
      throw new DomainError(
        400,
        "TEMPLATE_ASSIGNEE",
        "담당자는 이 프로젝트의 구성된 사용자 또는 에이전트 ID여야 합니다.",
      );
    for (const field of [
      "targetVersionId",
      "foundVersionId",
      "fixedVersionId",
    ] as const) {
      const id = defaults[field];
      if (id) {
        const version = this.context.db
          .prepare("SELECT projectId FROM versions WHERE id=?")
          .get(id);
        if (!version || version.projectId !== projectId)
          throw new DomainError(
            400,
            "TEMPLATE_VERSION_REFERENCE",
            `${field}: 같은 프로젝트의 현재 버전이 필요합니다.`,
          );
      }
    }
  }
  list(actor: Actor, projectId: string) {
    this.context.project(actor, projectId);
    return issueTemplateSchema
      .array()
      .parse(
        this.context.db
          .prepare(
            "SELECT * FROM issue_templates WHERE projectId=? AND deletedAt IS NULL ORDER BY name,id",
          )
          .all(projectId),
      );
  }
  get(actor: Actor, id: string, version?: number): TemplateDetail {
    const template = this.template(actor, id);
    const versions = this.context.db
      .prepare(
        "SELECT * FROM template_versions WHERE templateId=? ORDER BY version",
      )
      .all(id)
      .map((row) => {
        const requiredFields: unknown = JSON.parse(
            z.string().parse(row.requiredFields),
          ),
          defaults: unknown = JSON.parse(z.string().parse(row.defaults));
        return templateVersionSchema.parse({
          ...row,
          requiredFields,
          defaults,
        });
      });
    const selectedVersion = versions.find(
      (value) => value.version === (version ?? template.currentVersion),
    );
    if (!selectedVersion)
      throw new DomainError(
        404,
        "TEMPLATE_VERSION_NOT_FOUND",
        "템플릿 버전을 찾을 수 없습니다.",
      );
    return { template, versions, selectedVersion };
  }
  create(actor: Actor, input: unknown): TemplateDetail {
    const c = this.context;
    c.owner(actor);
    const data = parse(templateCreateSchema, input);
    const payload = JSON.stringify(data);
    return c.tx(() => {
      c.project(actor, data.projectId);
      this.defaults(data.projectId, data.defaults);
      const prior = c.db
        .prepare(
          "SELECT payload,templateId FROM template_operations WHERE actorId=? AND operationId=?",
        )
        .get(actor.id, data.operationId);
      if (prior) {
        if (prior.payload !== payload)
          throw new DomainError(
            409,
            "OPERATION_CONFLICT",
            "동일 operationId의 템플릿 내용이 다릅니다.",
          );
        return this.get(actor, z.string().parse(prior.templateId));
      }
      const id = randomUUID(),
        stamp = c.now();
      c.insert("issue_templates", {
        id,
        projectId: data.projectId,
        name: data.name,
        currentVersion: 1,
        revision: 1,
        deletedAt: null,
        createdAt: stamp,
        updatedAt: stamp,
      });
      c.insert("template_versions", {
        templateId: id,
        version: 1,
        body: data.body,
        requiredFields: JSON.stringify(data.requiredFields),
        defaults: JSON.stringify(data.defaults),
        authorId: actor.id,
        authorName: actor.name,
        createdAt: stamp,
      });
      c.insert("template_operations", {
        actorId: actor.id,
        operationId: data.operationId,
        payload,
        templateId: id,
      });
      return this.get(actor, id);
    });
  }
  update(actor: Actor, id: string, input: unknown): TemplateDetail {
    const c = this.context;
    c.owner(actor);
    const data = parse(templateUpdateSchema, input);
    return c.tx(() => {
      const current = this.template(actor, id);
      if (current.revision !== data.revision)
        throw new DomainError(
          409,
          "REVISION_CONFLICT",
          "템플릿이 변경되었습니다.",
        );
      this.defaults(current.projectId, data.defaults);
      const version = current.currentVersion + 1,
        stamp = c.now();
      c.insert("template_versions", {
        templateId: id,
        version,
        body: data.body,
        requiredFields: JSON.stringify(data.requiredFields),
        defaults: JSON.stringify(data.defaults),
        authorId: actor.id,
        authorName: actor.name,
        createdAt: stamp,
      });
      c.update("issue_templates", id, {
        name: data.name,
        currentVersion: version,
        revision: current.revision + 1,
        updatedAt: stamp,
      });
      return this.get(actor, id);
    });
  }
  preview(actor: Actor, id: string, input: unknown) {
    const data = parse(templatePreviewInputSchema, input),
      detail = this.get(actor, id, data.version);
    this.defaults(detail.template.projectId, detail.selectedVersion.defaults);
    let foundVersionName: string | undefined;
    if (data.values.foundVersionId) {
      this.defaults(detail.template.projectId, {
        foundVersionId: data.values.foundVersionId,
      });
      foundVersionName = z
        .string()
        .parse(
          this.context.db
            .prepare("SELECT name FROM versions WHERE id=?")
            .get(data.values.foundVersionId)?.name,
        );
    }
    return {
      templateId: id,
      templateVersion: detail.selectedVersion.version,
      description: renderTemplate(
        data.body ?? detail.selectedVersion.body,
        data.values,
        foundVersionName,
      ),
      errors: validateTemplateValues(
        detail.selectedVersion.requiredFields,
        data.values,
      ),
      defaults: detail.selectedVersion.defaults,
    };
  }
  apply(
    actor: Actor,
    projectId: string,
    input: {
      templateId: string;
      templateVersion: number;
      templateValues?: TemplateValues;
      body?: string;
      overrides: TemplateDefaults;
    },
  ) {
    this.context.write(actor);
    this.context.project(actor, projectId);
    const detail = this.get(actor, input.templateId);
    if (detail.template.projectId !== projectId)
      throw new DomainError(
        400,
        "TEMPLATE_PROJECT",
        "템플릿은 이슈와 같은 프로젝트에 있어야 합니다.",
      );
    if (detail.template.currentVersion !== input.templateVersion)
      throw new DomainError(
        409,
        "TEMPLATE_VERSION_CONFLICT",
        "템플릿 버전이 변경되었습니다.",
      );
    const values = parse(templateValuesSchema, input.templateValues ?? {}),
      errors = validateTemplateValues(
        detail.selectedVersion.requiredFields,
        values,
      );
    if (Object.keys(errors).length)
      throw new DomainError(
        400,
        "TEMPLATE_REQUIRED",
        "필수 항목이 누락되었습니다.",
        errors,
      );
    const preview = this.preview(actor, input.templateId, {
      version: input.templateVersion,
      values,
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    const defaults = { ...detail.selectedVersion.defaults, ...input.overrides };
    if (values.foundVersionId) {
      if (
        input.overrides.foundVersionId !== undefined &&
        input.overrides.foundVersionId !== values.foundVersionId
      )
        throw new DomainError(
          400,
          "TEMPLATE_FIELD_CONFLICT",
          "발견 버전 값이 서로 다릅니다.",
          { foundVersionId: "발견 버전 값이 서로 다릅니다." },
        );
      defaults.foundVersionId = values.foundVersionId;
    }
    this.defaults(projectId, defaults);
    return {
      defaults,
      description: preview.description,
      templateId: detail.template.id,
      templateVersion: detail.selectedVersion.version,
    };
  }
  remove(actor: Actor, id: string, input: unknown): void {
    const c = this.context;
    c.owner(actor);
    const data = parse(templateDeleteSchema, input);
    c.tx(() => {
      const current = this.template(actor, id);
      if (current.revision !== data.revision)
        throw new DomainError(
          409,
          "REVISION_CONFLICT",
          "템플릿이 변경되었습니다.",
        );
      c.update("issue_templates", id, {
        deletedAt: c.now(),
        updatedAt: c.now(),
        revision: current.revision + 1,
      });
    });
  }
}
