import { maintenanceSnapshotSchema } from "./contracts/maintenance.js";
import { historyDetailSchema } from "./contracts/history.js";
/** Runtime validation for values crossing JSON and SQLite boundaries. */
import { z } from "zod";
import { STATUSES } from "./types.js";

export const actorSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["owner", "agent"]),
  canWrite: z.boolean(),
  projectIds: z.array(z.string()).nullable(),
});
export const projectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  color: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const versionSchema = z.object({
  revision: z.number().int().positive(),
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string(),
  state: z.enum(["planned", "released", "archived"]),
  dueDate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const issueSchema = z.object({
  templateId: z.string().nullable().optional(),
  templateVersion: z.number().int().positive().nullable().optional(),
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(STATUSES),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]),
  assignee: z.string(),
  targetVersionId: z.string().nullable(),
  foundVersionId: z.string().nullable(),
  fixedVersionId: z.string().nullable(),
  labels: z.array(z.string()),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const commentSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  body: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});
export const activitySchema = z.object({
  id: z.string(),
  issueId: z.string(),
  action: z.string(),
  detail: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});
export const attachmentSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  kind: z.enum(["file", "link"]),
  name: z.string(),
  url: z.string().nullable(),
  storageKey: z.string().nullable(),
  mimeType: z.string().nullable(),
  size: z.number(),
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
});
export const reportSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  projectId: z.string(),
  issueId: z.string().nullable(),
  state: z.enum(["idle", "working", "blocked", "done"]),
  message: z.string(),
  reportedAt: z.string(),
  stale: z.boolean(),
});
export const bootstrapSchema = z.object({
  actor: actorSchema,
  projects: z.array(projectSchema),
  versions: z.array(versionSchema),
  issues: z.array(issueSchema),
  reports: z.array(reportSchema),
});
export const issueDetailSchema = z.object({
  issue: issueSchema,
  comments: z.array(commentSchema),
  activity: z.array(activitySchema),
  attachments: z.array(attachmentSchema),
});
export const apiErrorSchema = z.object({
  maintenance: maintenanceSnapshotSchema.optional().catch(undefined),
  retryAfterSeconds: z.literal(5).optional().catch(undefined),
  fields: z.record(z.string(), z.string()).optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});

export {
  sessionSchema,
  sessionEventSchema,
  sessionRequestSchema,
  sessionDetailSchema,
  sessionEventResultSchema,
} from "./contracts/sessions.js";

export {
  issueTemplateSchema,
  templateDetailSchema,
  templateVersionSchema,
  templateAssigneeSchema,
  templatePreviewSchema,
} from "./contracts/templates.js";

export {
  historyListSchema,
  historySummarySchema,
  historyDetailSchema,
  restorePreviewSchema,
} from "./contracts/history.js";
export const restoreResultSchema = z
  .object({ issue: issueSchema, change: historyDetailSchema })
  .strict();
