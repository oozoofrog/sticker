import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { initial } from "../migrations/001-initial.js";
import { sessions } from "../migrations/002-sessions.js";
import { relations } from "../migrations/003-relations.js";
import { releases } from "../migrations/004-releases.js";
import { views } from "../migrations/005-views.js";
import { templates } from "../migrations/006-templates.js";
import { resources } from "../migrations/007-resources.js";
import { github } from "../migrations/008-github.js";
import { history } from "../migrations/009-history.js";
import { attachmentOperations } from "../migrations/010-attachment-operations.js";
import {
  issueSchema,
  projectSchema,
  versionSchema,
  commentSchema,
  activitySchema,
  attachmentSchema,
} from "../response-schemas.js";
import {
  templateDefaultsSchema,
  requiredTemplateFieldsSchema,
  issueTemplateSchema,
  templateVersionSchema,
} from "../contracts/templates.js";
import {
  resourceSchema,
  resourceEventSchema,
  resourceVersionSchema,
  resourceUrlSchema,
} from "../contracts/resources.js";
import {
  HISTORY_FIELDS,
  historyDetailSchema,
  historyFieldChangeSchema,
} from "../contracts/history.js";
import { changelogSchema, releaseAuditSchema } from "../contracts/releases.js";
import {
  githubSnapshotSchema,
  githubErrorSchema,
  parseGithubUrl,
} from "../contracts/github.js";

/** Unmounted closed-fixture profile; never use a mutable migration registry. */
export const ARCHIVE_PROFILE = "attachment10-aec60c2";
export const ARCHIVE_SCHEMA_HASH =
  "4ed3190be8f9660e4b87dda8e3c3f86f8515a4f9bd05df6eb02911d713ec5886";
export const ARCHIVE_TABLES = {
  projects: {
    copy: true,
    columns: [
      "id",
      "key",
      "name",
      "description",
      "color",
      "nextIssue",
      "createdAt",
      "updatedAt",
    ],
  },
  versions: {
    copy: true,
    columns: [
      "id",
      "projectId",
      "name",
      "description",
      "state",
      "dueDate",
      "createdAt",
      "updatedAt",
      "revision",
    ],
  },
  issues: {
    copy: true,
    columns: [
      "id",
      "projectId",
      "key",
      "title",
      "description",
      "status",
      "priority",
      "assignee",
      "targetVersionId",
      "foundVersionId",
      "fixedVersionId",
      "labels",
      "revision",
      "createdAt",
      "updatedAt",
      "templateId",
      "templateVersion",
    ],
  },
  comments: {
    copy: true,
    columns: ["id", "issueId", "body", "authorId", "authorName", "createdAt"],
  },
  activity: {
    copy: true,
    columns: [
      "id",
      "issueId",
      "action",
      "detail",
      "authorId",
      "authorName",
      "createdAt",
    ],
  },
  attachments: {
    copy: true,
    columns: [
      "id",
      "issueId",
      "kind",
      "name",
      "url",
      "storageKey",
      "mimeType",
      "size",
      "authorId",
      "authorName",
      "createdAt",
    ],
  },
  agent_reports: {
    copy: false,
    columns: [
      "id",
      "agentId",
      "agentName",
      "projectId",
      "issueId",
      "state",
      "message",
      "reportedAt",
    ],
  },
  agent_sessions: {
    copy: false,
    columns: [
      "id",
      "externalSessionId",
      "agentId",
      "agentName",
      "projectId",
      "issueId",
      "startedAt",
      "lastReportedAt",
      "endedAt",
      "closedAt",
      "revision",
      "legacy",
      "closeOperationId",
      "closeRevision",
    ],
  },
  session_events: {
    copy: false,
    columns: [
      "sessionId",
      "eventId",
      "kind",
      "occurredAt",
      "receivedAt",
      "message",
      "payload",
      "fingerprint",
    ],
  },
  session_requests: {
    copy: false,
    columns: [
      "id",
      "sessionId",
      "eventId",
      "kind",
      "prompt",
      "createdAt",
      "revision",
      "status",
      "closeOperationId",
      "closeRevision",
    ],
  },
  session_responses: {
    copy: false,
    columns: [
      "id",
      "requestId",
      "authorId",
      "operationId",
      "body",
      "revision",
      "createdAt",
    ],
  },
  issue_relations: {
    copy: true,
    columns: [
      "id",
      "projectId",
      "kind",
      "sourceIssueId",
      "targetIssueId",
      "createdBy",
      "createdAt",
    ],
  },
  version_changelogs: {
    copy: true,
    columns: [
      "versionId",
      "markdown",
      "selectedIssueIds",
      "revision",
      "authorId",
      "authorName",
      "updatedAt",
    ],
  },
  version_changelog_history: {
    copy: true,
    columns: [
      "id",
      "versionId",
      "markdown",
      "selectedIssueIds",
      "revision",
      "authorId",
      "authorName",
      "updatedAt",
    ],
  },
  version_release_audit: {
    copy: true,
    columns: [
      "id",
      "versionId",
      "authorId",
      "authorName",
      "fromState",
      "toState",
      "reviewedRevision",
      "operationId",
      "createdAt",
    ],
  },
  release_operations: {
    copy: false,
    columns: [
      "actorId",
      "kind",
      "operationId",
      "versionId",
      "payload",
      "result",
      "createdAt",
    ],
  },
  saved_views: {
    copy: false,
    columns: [
      "id",
      "actorId",
      "projectId",
      "name",
      "query",
      "revision",
      "createdAt",
      "updatedAt",
    ],
  },
  view_preferences: {
    copy: false,
    columns: [
      "actorId",
      "projectId",
      "revision",
      "defaultViewId",
      "favoriteIds",
    ],
  },
  issue_templates: {
    copy: true,
    columns: [
      "id",
      "projectId",
      "name",
      "currentVersion",
      "revision",
      "deletedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  template_versions: {
    copy: true,
    columns: [
      "templateId",
      "version",
      "body",
      "requiredFields",
      "defaults",
      "authorId",
      "authorName",
      "createdAt",
    ],
  },
  template_operations: {
    copy: false,
    columns: ["actorId", "operationId", "payload", "templateId"],
  },
  issue_creation_operations: {
    copy: false,
    columns: ["actorId", "operationId", "payload", "issueId"],
  },
  resources: {
    copy: true,
    columns: [
      "id",
      "projectId",
      "versionId",
      "kind",
      "title",
      "currentVersion",
      "revision",
      "isGuidance",
      "guidanceBy",
      "guidanceAt",
      "deletedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  resource_versions: {
    copy: true,
    columns: [
      "resourceId",
      "version",
      "kind",
      "title",
      "markdown",
      "url",
      "fileName",
      "storageKey",
      "mimeType",
      "size",
      "checksum",
      "authorId",
      "authorName",
      "createdAt",
    ],
  },
  issue_resource_links: {
    copy: true,
    columns: [
      "id",
      "issueId",
      "resourceId",
      "resourceVersion",
      "createdBy",
      "createdAt",
    ],
  },
  session_resource_refs: {
    copy: false,
    columns: [
      "id",
      "sessionId",
      "eventId",
      "resourceId",
      "resourceVersion",
      "recordedBy",
      "createdAt",
    ],
  },
  resource_events: {
    copy: true,
    columns: [
      "id",
      "resourceId",
      "action",
      "revision",
      "authorId",
      "authorName",
      "createdAt",
    ],
  },
  resource_operations: {
    copy: false,
    columns: [
      "actorId",
      "kind",
      "operationId",
      "projectId",
      "payloadHash",
      "result",
    ],
  },
  github_connections: {
    copy: false,
    columns: [
      "projectId",
      "repositoryOwner",
      "repositoryName",
      "mode",
      "credentialRef",
      "connected",
      "revision",
      "lastVerifiedAt",
      "lastErrorCode",
    ],
  },
  github_evidence: {
    copy: true,
    columns: [
      "id",
      "issueId",
      "projectId",
      "url",
      "kind",
      "repositoryOwner",
      "repositoryName",
      "number",
      "revision",
      "headSha",
      "snapshot",
      "checkedAt",
      "lastAttemptAt",
      "errorCode",
      "createdBy",
      "createdAt",
    ],
  },
  issue_changes: {
    copy: true,
    columns: [
      "id",
      "issueId",
      "revisionBefore",
      "revisionAfter",
      "authorId",
      "authorName",
      "createdAt",
      "action",
      "sourceChangeId",
      "unavailableReason",
    ],
  },
  issue_field_changes: {
    copy: true,
    columns: ["changeId", "field", "beforeJson", "afterJson"],
  },
  issue_restore_operations: {
    copy: false,
    columns: ["actorId", "operationId", "issueId", "payload", "changeId"],
  },
  attachment_operations: {
    copy: false,
    columns: [
      "actorId",
      "kind",
      "operationId",
      "projectId",
      "issueId",
      "attachmentId",
      "payload",
      "payloadHash",
      "result",
      "createdAt",
    ],
  },
} as const;
export const ARCHIVE_LIMITS = {
  cellBytes: 1024 ** 2,
  manifestBytes: 1024 ** 2,
  fileBytes: 20 * 1024 ** 2,
  totalBytes: 1024 ** 3,
  fileCount: 50_000,
  reserveBytes: 64 * 1024 ** 2,
  bufferBytes: 64 * 1024,
  structuralEdges: 10_000,
} as const;
export type ArchiveTable = keyof typeof ARCHIVE_TABLES;
export type ArchiveRow = Record<string, SQLOutputValue>;
export type ArchiveErrorCode =
  | "ARCHIVE_SCHEMA_UNSUPPORTED"
  | "ARCHIVE_SCHEMA_MISMATCH"
  | "ARCHIVE_SOURCE_NOT_QUIESCENT"
  | "ARCHIVE_TARGET_UNSAFE"
  | "ARCHIVE_ROW_INVALID"
  | "ARCHIVE_REFERENCE_INVALID"
  | "ARCHIVE_FILE_UNSAFE"
  | "ARCHIVE_FILE_MISSING"
  | "ARCHIVE_FILE_SIZE_MISMATCH"
  | "ARCHIVE_FILE_HASH_MISMATCH"
  | "ARCHIVE_SOURCE_CHANGED"
  | "ARCHIVE_CAPACITY_UNKNOWN"
  | "INSUFFICIENT_LOCAL_SPACE"
  | "BACKUP_TOO_LARGE"
  | "ARCHIVE_IO"
  | "ARCHIVE_VALIDATION_FAILED";
export class ArchiveError extends Error {
  constructor(readonly code: ArchiveErrorCode) {
    super(code);
    this.name = "ArchiveError";
  }
}
export function archiveFail(code: ArchiveErrorCode): never {
  throw new ArchiveError(code);
}
export function initializeArchiveSchema(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get())
    archiveFail("ARCHIVE_TARGET_UNSAFE");
  for (const run of [
    initial,
    sessions,
    relations,
    releases,
    views,
    templates,
    resources,
    github,
    history,
    attachmentOperations,
  ])
    run(db);
  db.exec("PRAGMA user_version=10");
  assertArchiveSchema(db);
}
export function assertArchiveSchema(db: DatabaseSync): void {
  if (db.prepare("PRAGMA user_version").get()?.user_version !== 10)
    archiveFail("ARCHIVE_SCHEMA_UNSUPPORTED");
  const summary = db
    .prepare(
      "SELECT count(*) AS n, max(length(CAST(sql AS BLOB))) AS bytes, max(length(name)) AS nameLength FROM sqlite_schema",
    )
    .get();
  if (
    !summary ||
    Number(summary.n) > 200 ||
    Number(summary.bytes) > 65536 ||
    Number(summary.nameLength) > 128
  )
    archiveFail("ARCHIVE_SCHEMA_MISMATCH");
  const hash = createHash("sha256");
  hash.update("[");
  let first = true;
  for (const row of db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
    )
    .iterate()) {
    if (!first) hash.update(",");
    first = false;
    hash.update(
      JSON.stringify({
        ...row,
        sql:
          typeof row.sql === "string"
            ? row.sql.replace(/\s+/g, " ").trim()
            : null,
      }),
    );
  }
  hash.update("]");
  if (hash.digest("hex") !== ARCHIVE_SCHEMA_HASH)
    archiveFail("ARCHIVE_SCHEMA_MISMATCH");
}

/** Detect duplicate decoded object keys BEFORE JSON.parse may overwrite them. */
export function parseArchiveJson(raw: string): unknown {
  if (Buffer.byteLength(raw) > ARCHIVE_LIMITS.cellBytes)
    archiveFail("ARCHIVE_ROW_INVALID");
  let offset = 0,
    nodes = 0;
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const space = () => {
    while (/[\x20\t\r\n]/.test(raw[offset] ?? "x")) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < raw.length) {
      const char = raw[offset++];
      if (char === "\\") {
        offset++;
        continue;
      }
      if (char === '"') {
        const value: unknown = JSON.parse(raw.slice(start, offset));
        if (typeof value !== "string") archiveFail("ARCHIVE_ROW_INVALID");
        return value;
      }
    }
    return archiveFail("ARCHIVE_ROW_INVALID");
  };
  const scan = (depth: number): void => {
    if (depth > 32 || ++nodes > 100_000) archiveFail("ARCHIVE_ROW_INVALID");
    space();
    const char = raw[offset];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{") {
      offset++;
      space();
      const keys = new Set<string>();
      if (raw[offset] === "}") {
        offset++;
        return;
      }
      for (;;) {
        space();
        if (raw[offset] !== '"') archiveFail("ARCHIVE_ROW_INVALID");
        const key = string();
        if (keys.has(key)) archiveFail("ARCHIVE_ROW_INVALID");
        keys.add(key);
        space();
        if (raw[offset++] !== ":") archiveFail("ARCHIVE_ROW_INVALID");
        scan(depth + 1);
        space();
        const end = raw[offset++];
        if (end === "}") return;
        if (end !== ",") archiveFail("ARCHIVE_ROW_INVALID");
      }
    }
    if (char === "[") {
      offset++;
      space();
      if (raw[offset] === "]") {
        offset++;
        return;
      }
      for (;;) {
        scan(depth + 1);
        space();
        const end = raw[offset++];
        if (end === "]") return;
        if (end !== ",") archiveFail("ARCHIVE_ROW_INVALID");
      }
    }
    for (const literal of ["true", "false", "null"])
      if (raw.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    number.lastIndex = offset;
    const match = number.exec(raw);
    if (!match) archiveFail("ARCHIVE_ROW_INVALID");
    offset = number.lastIndex;
  };
  try {
    scan(0);
    space();
    if (offset !== raw.length) archiveFail("ARCHIVE_ROW_INVALID");
    return JSON.parse(raw) as unknown;
  } catch {
    return archiveFail("ARCHIVE_ROW_INVALID");
  }
}
function ensure<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) archiveFail("ARCHIVE_ROW_INVALID");
  return parsed.data;
}
function structured<T>(
  raw: SQLOutputValue | undefined,
  schema: z.ZodType<T>,
): T {
  if (typeof raw !== "string") archiveFail("ARCHIVE_ROW_INVALID");
  const value = parseArchiveJson(raw),
    parsed = ensure(schema, value);
  if (!isDeepStrictEqual(parsed, value)) archiveFail("ARCHIVE_ROW_INVALID");
  return parsed;
}
const ids = z
  .array(z.string().min(1).max(128))
  .max(200)
  .refine((v) => new Set(v).size === v.length);
const labels = z
  .array(z.string().min(1).max(40))
  .max(20)
  .refine((v) => new Set(v).size === v.length);
const id = z.string().min(1).max(128);
function contentRow(table: ArchiveTable, row: ArchiveRow): void {
  for (const [name, value] of Object.entries(row)) {
    if (typeof value === "number" && !Number.isSafeInteger(value))
      archiveFail("ARCHIVE_ROW_INVALID");
    if ((name === "id" || name.endsWith("Id")) && value !== null)
      ensure(id, value);
  }
  switch (table) {
    case "projects":
      ensure(projectSchema, row);
      ensure(z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/), row.key);
      ensure(
        z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        row.nextIssue,
      );
      break;
    case "versions":
      ensure(versionSchema, row);
      break;
    case "issues":
      ensure(issueSchema, { ...row, labels: structured(row.labels, labels) });
      break;
    case "activity":
      ensure(activitySchema, row);
      break;
    case "comments":
      ensure(commentSchema, row);
      break;
    case "attachments":
      ensure(attachmentSchema, row);
      if (row.kind === "file") {
        ensure(z.uuid(), row.storageKey);
        ensure(
          z.number().int().nonnegative().max(ARCHIVE_LIMITS.fileBytes),
          row.size,
        );
        if (row.url !== null) archiveFail("ARCHIVE_ROW_INVALID");
      } else {
        ensure(resourceUrlSchema, row.url);
        if (row.storageKey !== null || row.size !== 0)
          archiveFail("ARCHIVE_ROW_INVALID");
      }
      break;
    case "issue_templates":
      ensure(issueTemplateSchema, row);
      break;
    case "template_versions":
      ensure(templateVersionSchema, {
        ...row,
        requiredFields: structured(
          row.requiredFields,
          requiredTemplateFieldsSchema,
        ),
        defaults: structured(row.defaults, templateDefaultsSchema),
      });
      break;
    case "resource_events":
      ensure(resourceEventSchema.extend({ id }), row);
      break;
    case "resources":
      ensure(z.union([z.literal(0), z.literal(1)]), row.isGuidance);
      ensure(resourceSchema, {
        ...row,
        isGuidance: row.isGuidance === 1,
        versionAvailable: true,
      });
      break;
    case "resource_versions": {
      const { storageKey, ...content } = row;
      ensure(resourceVersionSchema, content);
      if (row.kind === "file") ensure(z.uuid(), storageKey);
      else if (storageKey !== null) archiveFail("ARCHIVE_ROW_INVALID");
      break;
    }
    case "version_changelogs":
    case "version_changelog_history":
      ensure(changelogSchema, {
        ...row,
        selectedIssueIds: structured(row.selectedIssueIds, ids),
      });
      break;
    case "version_release_audit":
      ensure(releaseAuditSchema, row);
      break;
    case "issue_field_changes": {
      const before =
        typeof row.beforeJson === "string"
          ? parseArchiveJson(row.beforeJson)
          : undefined;
      const after =
        typeof row.afterJson === "string"
          ? parseArchiveJson(row.afterJson)
          : undefined;
      ensure(historyFieldChangeSchema, { field: row.field, before, after });
      if (isDeepStrictEqual(before, after)) archiveFail("ARCHIVE_ROW_INVALID");
      break;
    }
    case "github_evidence": {
      ensure(
        z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        row.revision,
      );
      if (row.snapshot !== null)
        structured(row.snapshot, githubSnapshotSchema.strict());
      if (row.errorCode !== null) ensure(githubErrorSchema, row.errorCode);
      if (row.headSha !== null)
        ensure(z.string().regex(/^[a-f0-9]{40}$/), row.headSha);
      let target;
      try {
        target = parseGithubUrl(String(row.url));
      } catch {
        archiveFail("ARCHIVE_ROW_INVALID");
      }
      if (
        target.owner !== row.repositoryOwner ||
        target.name !== row.repositoryName ||
        target.kind !== row.kind ||
        (target.kind === "pr"
          ? target.number !== row.number
          : row.number !== null || target.sha !== row.headSha)
      )
        archiveFail("ARCHIVE_REFERENCE_INVALID");
      break;
    }
  }
}
/** SQL rejects oversized values before any content projection reaches JS. */
function preflightCells(db: DatabaseSync, table: ArchiveTable): void {
  for (const column of ARCHIVE_TABLES[table].columns) {
    const bad = db
      .prepare(
        `SELECT 1 FROM "${table}" WHERE typeof("${column}")='blob' OR (typeof("${column}")='text' AND length(CAST("${column}" AS BLOB))>?) OR (typeof("${column}") IN ('integer','real') AND ("${column}">9007199254740991 OR "${column}"< -9007199254740991 OR "${column}"!=CAST("${column}" AS INTEGER))) LIMIT 1`,
      )
      .get(ARCHIVE_LIMITS.cellBytes);
    if (bad) archiveFail("ARCHIVE_ROW_INVALID");
  }
}
export function* archiveRows(
  db: DatabaseSync,
  table: ArchiveTable,
): Generator<ArchiveRow> {
  const columns = ARCHIVE_TABLES[table].columns.map((c) => `"${c}"`).join(",");
  for (const row of db.prepare(`SELECT ${columns} FROM "${table}"`).iterate())
    yield row;
}
function reference(db: DatabaseSync, sql: string): void {
  if (db.prepare(sql).get()) archiveFail("ARCHIVE_REFERENCE_INVALID");
}
function checkHistory(db: DatabaseSync): void {
  for (const row of archiveRows(db, "issue_changes")) {
    const changes = [];
    for (const field of db
      .prepare(
        "SELECT field,beforeJson,afterJson FROM issue_field_changes WHERE changeId=?",
      )
      .iterate(row.id)) {
      if (changes.length >= 9) archiveFail("ARCHIVE_REFERENCE_INVALID");
      changes.push(
        ensure(historyFieldChangeSchema, {
          field: field.field,
          before: parseArchiveJson(String(field.beforeJson)),
          after: parseArchiveJson(String(field.afterJson)),
        }),
      );
    }
    changes.sort(
      (a, b) =>
        HISTORY_FIELDS.indexOf(a.field) - HISTORY_FIELDS.indexOf(b.field),
    );
    let detail;
    try {
      detail = historyDetailSchema.parse({
        ...row,
        comparisonAvailable: row.unavailableReason === null,
        fields: changes.map((c) => c.field),
        changes,
      });
    } catch {
      archiveFail("ARCHIVE_REFERENCE_INVALID");
    }
    const activity = db
      .prepare(
        "SELECT issueId,action,authorId,authorName,createdAt FROM activity WHERE id=?",
      )
      .get(row.id);
    const issue = db
      .prepare("SELECT revision FROM issues WHERE id=?")
      .get(row.issueId);
    if (
      !activity ||
      !issue ||
      detail.revisionBefore === null ||
      detail.revisionAfter === null ||
      detail.revisionAfter !== detail.revisionBefore + 1 ||
      detail.revisionAfter > Number(issue.revision) ||
      (detail.unavailableReason === "creation") !==
        (detail.revisionBefore === 0) ||
      ["issueId", "action", "authorId", "authorName", "createdAt"].some(
        (k) => activity[k] !== row[k],
      )
    )
      archiveFail("ARCHIVE_REFERENCE_INVALID");
    if (detail.sourceChangeId !== null) {
      const source = db
        .prepare(
          "SELECT issueId,revisionAfter,unavailableReason FROM issue_changes WHERE id=?",
        )
        .get(detail.sourceChangeId);
      if (
        detail.action !== "restored" ||
        !source ||
        source.unavailableReason !== null ||
        source.issueId !== detail.issueId ||
        Number(source.revisionAfter) >= detail.revisionAfter
      )
        archiveFail("ARCHIVE_REFERENCE_INVALID");
    } else if (detail.action === "restored")
      archiveFail("ARCHIVE_REFERENCE_INVALID");
  }
}
/** Streaming/indexed equivalent; never calls whole-dataset production validators. */
export function validateArchiveDatabase(
  db: DatabaseSync,
  excludedMustBeEmpty = false,
): void {
  assertArchiveSchema(db);
  for (const table of Object.keys(ARCHIVE_TABLES) as ArchiveTable[])
    if (ARCHIVE_TABLES[table].copy) preflightCells(db, table);
  if (db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check !== "ok")
    archiveFail("ARCHIVE_VALIDATION_FAILED");
  if (db.prepare("PRAGMA foreign_key_check").get())
    archiveFail("ARCHIVE_REFERENCE_INVALID");
  for (const table of Object.keys(ARCHIVE_TABLES) as ArchiveTable[]) {
    if (ARCHIVE_TABLES[table].copy)
      for (const row of archiveRows(db, table)) contentRow(table, row);
    else if (
      excludedMustBeEmpty &&
      db.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get()
    )
      archiveFail("ARCHIVE_VALIDATION_FAILED");
  }
  for (const row of db
    .prepare(
      "SELECT i.key,p.key AS prefix,p.nextIssue FROM issues i JOIN projects p ON p.id=i.projectId",
    )
    .iterate()) {
    const key = String(row.key),
      prefix = String(row.prefix) + "-",
      suffix = key.slice(prefix.length);
    if (
      !key.startsWith(prefix) ||
      !/^[1-9][0-9]*$/.test(suffix) ||
      !Number.isSafeInteger(Number(suffix)) ||
      Number(suffix) >= Number(row.nextIssue)
    )
      archiveFail("ARCHIVE_REFERENCE_INVALID");
  }
  for (const field of ["targetVersionId", "foundVersionId", "fixedVersionId"])
    reference(
      db,
      `SELECT 1 FROM issues i JOIN versions v ON v.id=i.${field} WHERE v.projectId<>i.projectId LIMIT 1`,
    );
  reference(
    db,
    "SELECT 1 FROM issues i LEFT JOIN template_versions v ON v.templateId=i.templateId AND v.version=i.templateVersion LEFT JOIN issue_templates t ON t.id=i.templateId WHERE (i.templateId IS NULL)!=(i.templateVersion IS NULL) OR (i.templateId IS NOT NULL AND (v.templateId IS NULL OR t.projectId<>i.projectId)) LIMIT 1",
  );
  reference(
    db,
    "SELECT 1 FROM issue_templates t LEFT JOIN template_versions v ON v.templateId=t.id AND v.version=t.currentVersion WHERE v.templateId IS NULL LIMIT 1",
  );
  reference(
    db,
    "SELECT 1 FROM resources r JOIN versions v ON r.versionId=v.id WHERE r.projectId<>v.projectId LIMIT 1",
  );
  reference(
    db,
    "SELECT 1 FROM issue_resource_links l JOIN issues i ON i.id=l.issueId JOIN resources r ON r.id=l.resourceId WHERE i.projectId<>r.projectId LIMIT 1",
  );
  reference(
    db,
    "SELECT 1 FROM github_evidence e JOIN issues i ON i.id=e.issueId WHERE e.projectId<>i.projectId LIMIT 1",
  );
  reference(
    db,
    "SELECT 1 FROM issue_relations r JOIN issues a ON a.id=r.sourceIssueId JOIN issues b ON b.id=r.targetIssueId WHERE r.projectId<>a.projectId OR r.projectId<>b.projectId LIMIT 1",
  );
  if (
    Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM issue_relations WHERE kind<>'related'",
        )
        .get()?.n,
    ) > ARCHIVE_LIMITS.structuralEdges
  )
    archiveFail("BACKUP_TOO_LARGE");
  for (const edge of db
    .prepare(
      "SELECT kind,sourceIssueId,targetIssueId FROM issue_relations WHERE kind<>'related'",
    )
    .iterate()) {
    if (
      db
        .prepare(
          "WITH RECURSIVE reachable(id) AS (SELECT ? UNION SELECT r.targetIssueId FROM issue_relations r JOIN reachable x ON r.sourceIssueId=x.id WHERE r.kind=?) SELECT 1 FROM reachable WHERE id=? LIMIT 1",
        )
        .get(edge.targetIssueId, edge.kind, edge.sourceIssueId)
    )
      archiveFail("ARCHIVE_REFERENCE_INVALID");
  }
  checkHistory(db);
}
