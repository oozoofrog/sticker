export const STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "waiting",
  "done",
  "closed",
] as const;
export type Status = (typeof STATUSES)[number];
export interface Actor {
  id: string;
  name: string;
  role: "owner" | "agent";
  canWrite: boolean;
  projectIds: string[] | null;
}
export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}
export interface Version {
  revision: number;
  id: string;
  projectId: string;
  name: string;
  description: string;
  state: "planned" | "released" | "archived";
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Issue {
  templateId?: string | null;
  templateVersion?: number | null;
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string;
  status: Status;
  priority: "none" | "low" | "medium" | "high" | "urgent";
  assignee: string;
  targetVersionId: string | null;
  foundVersionId: string | null;
  fixedVersionId: string | null;
  labels: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface Comment {
  id: string;
  issueId: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}
export interface Activity {
  id: string;
  issueId: string;
  action: string;
  detail: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}
export interface Attachment {
  id: string;
  issueId: string;
  kind: "file" | "link";
  name: string;
  url: string | null;
  storageKey: string | null;
  mimeType: string | null;
  size: number;
  authorId: string;
  authorName: string;
  createdAt: string;
}
export interface AgentReport {
  id: string;
  agentId: string;
  agentName: string;
  projectId: string;
  issueId: string | null;
  state: "idle" | "working" | "blocked" | "done";
  message: string;
  reportedAt: string;
  stale: boolean;
}
export interface Bootstrap {
  actor: Actor;
  projects: Project[];
  versions: Version[];
  issues: Issue[];
  reports: AgentReport[];
}
export interface IssueDetail {
  issue: Issue;
  comments: Comment[];
  activity: Activity[];
  attachments: Attachment[];
}

export type {
  AgentSession,
  SessionEvent,
  SessionRequest,
  SessionDetail,
} from "./contracts/sessions.js";

export type {
  VersionReadiness,
  Changelog,
  CarryoverInput,
  CarryoverResult,
  CarryoverPreview,
  ReleaseResult,
} from "./contracts/releases.js";

export type {
  IssueTemplate,
  TemplateVersion,
  TemplateDetail,
  TemplateValues,
  TemplateDefaults,
  TemplateField,
} from "./contracts/templates.js";

export type {
  HistorySummary,
  HistoryDetail,
  HistoryField,
  HistoryFieldChange,
  RestorePreview,
} from "./contracts/history.js";
