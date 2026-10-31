export type McpAuthority =
  "authenticated" | "writer" | "owner" | "agent-writer";
export interface McpCatalogueEntry {
  action: string;
  tool: string;
  route: readonly string[];
  authority: McpAuthority;
  confirm: "none" | "literal-true" | "conditional";
  retry:
    | "read"
    | "readback"
    | "exact-operation"
    | "conditional-operation"
    | "event-id";
  effect: "read" | "write";
  conditions: readonly string[];
  readback?: string;
  destructive?: boolean;
  externalEffect?: "conditional_github_issue_create";
  authenticationMode?: "owner-session";
}
type EntryOptions = Partial<
  Pick<
    McpCatalogueEntry,
    | "conditions"
    | "readback"
    | "destructive"
    | "authority"
    | "retry"
    | "externalEffect"
    | "authenticationMode"
    | "confirm"
  >
>;
function entry(
  action: string,
  route: string[],
  effect: "read" | "write",
  options: EntryOptions = {},
): McpCatalogueEntry {
  return {
    action,
    tool: `sticker_${action}`,
    route,
    authority: effect === "read" ? "authenticated" : "writer",
    confirm: "none",
    retry: effect === "read" ? "read" : "readback",
    effect,
    conditions: ["project_scope_and_target_access"],
    ...options,
  };
}
// A catalogue of shipped tools, not a claim that all product HTTP actions are exposed.
export const MCP_CATALOGUE: readonly McpCatalogueEntry[] = [
  entry(
    "get_capabilities",
    ["GET /api/session", "GET /api/maintenance"],
    "read",
    { conditions: [] },
  ),
  entry("get_help", ["GET /api/session"], "read", { conditions: [] }),
  entry("get_bootstrap", ["GET /api/bootstrap"], "read", { conditions: [] }),
  entry("list_projects", ["GET /api/bootstrap"], "read", { conditions: [] }),
  entry("create_project", ["POST /api/projects"], "write", {
    authority: "owner",
    conditions: [],
    readback: "sticker_list_projects",
  }),
  entry("update_project", ["PATCH /api/projects/:projectId"], "write", {
    conditions: ["project_scope", "key_locked_after_issue_numbering"],
    readback: "sticker_list_projects",
  }),
  entry("list_versions", ["GET /api/bootstrap"], "read"),
  entry("create_version", ["POST /api/versions"], "write", {
    readback: "sticker_list_versions",
  }),
  entry("update_version", ["PATCH /api/versions/:versionId"], "write", {
    readback: "sticker_list_versions",
    conditions: ["project_scope", "revision", "release_is_owner_domain_action"],
  }),
  entry("get_issue", ["GET /api/issues/:issueId"], "read"),
  entry("create_issue", ["POST /api/issues"], "write", {
    readback: "sticker_list_issues",
    retry: "conditional-operation",
    conditions: [
      "project_scope",
      "operationId_for_replay",
      "current_template_version_when_used",
      "owner_only_closed_status",
    ],
  }),
  entry("update_issue", ["PATCH /api/issues/:issueId"], "write", {
    readback: "sticker_get_issue",
    conditions: [
      "project_scope",
      "revision",
      "agent_cannot_modify_closed_issue",
      "owner_only_close_or_reopen",
    ],
  }),
  entry("add_comment", ["POST /api/issues/:issueId/comments"], "write", {
    readback: "sticker_get_issue",
  }),
  entry("add_link", ["POST /api/issues/:issueId/links"], "write", {
    readback: "sticker_get_issue",
  }),
  entry("report_status", ["POST /api/reports"], "write", {
    readback: "sticker_list_reports",
    authority: "agent-writer",
    conditions: ["project_scope", "self_report_not_execution_proof"],
  }),
  entry("list_reports", ["GET /api/bootstrap"], "read"),
  entry("upload_file", ["POST /api/issues/:issueId/attachments"], "write", {
    readback: "sticker_get_issue",
    conditions: ["project_scope", "maximum_5_MiB"],
  }),
  entry("read_file", ["GET /api/attachments/:attachmentId/file"], "read", {
    conditions: ["project_scope", "maximum_5_MiB"],
  }),
  entry("create_document", ["POST /api/resources"], "write", {
    readback: "sticker_list_resources",
    retry: "exact-operation",
  }),
  entry("update_document", ["PATCH /api/resources/:resourceId"], "write", {
    readback: "sticker_get_resource",
    retry: "exact-operation",
    conditions: [
      "project_scope",
      "revision",
      "owner_only_if_designated_guidance",
    ],
  }),
  entry("list_resources", ["POST /api/resources/query"], "read"),
  entry(
    "get_resource",
    [
      "GET /api/resources/:resourceId",
      "GET /api/resources/:resourceId/versions/:resourceVersion",
    ],
    "read",
  ),
  entry(
    "get_project_guidance",
    ["GET /api/projects/:projectId/guidance"],
    "read",
  ),
  entry("link_resource", ["POST /api/issues/:issueId/resources"], "write", {
    readback: "sticker_list_issue_resources",
    retry: "exact-operation",
    conditions: ["project_scope", "issue_revision", "exact_resource_version"],
  }),
  entry(
    "record_resource_reference",
    ["POST /api/resource-references"],
    "write",
    {
      readback: "sticker_list_session_resource_references",
      retry: "exact-operation",
      conditions: [
        "project_scope",
        "recorded_result_event_access",
        "exact_resource_version",
      ],
    },
  ),
  entry(
    "upload_resource_file",
    ["POST /api/projects/:projectId/resources/files"],
    "write",
    {
      readback: "sticker_list_resources",
      retry: "exact-operation",
      conditions: ["project_scope", "maximum_5_MiB"],
    },
  ),
  entry(
    "read_resource_file",
    [
      "GET /api/resources/:resourceId/versions/:resourceVersion",
      "GET /api/resources/:resourceId/versions/:resourceVersion/file",
    ],
    "read",
    {
      conditions: ["project_scope", "exact_resource_version", "maximum_5_MiB"],
    },
  ),
  entry("list_issue_history", ["GET /api/issues/:issueId/history"], "read"),
  entry(
    "get_issue_change",
    ["GET /api/issues/:issueId/history/:changeId"],
    "read",
  ),
  entry(
    "get_github_evidence",
    ["GET /api/issues/:issueId/github-evidence"],
    "read",
    { conditions: ["project_scope", "stored_evidence_only_no_provider_fetch"] },
  ),
  entry(
    "list_issue_templates",
    ["GET /api/projects/:projectId/templates"],
    "read",
  ),
  entry("get_issue_template", ["GET /api/templates/:templateId"], "read"),
  entry(
    "preview_issue_template",
    ["POST /api/templates/:templateId/preview"],
    "read",
  ),
  entry("list_sessions", ["GET /api/sessions"], "read"),
  entry("get_session", ["GET /api/sessions/:sessionId"], "read"),
  entry("report_session_event", ["POST /api/sessions/events"], "write", {
    authority: "agent-writer",
    readback: "sticker_list_sessions",
    retry: "event-id",
    conditions: [
      "project_scope",
      "own_session",
      "self_report_not_execution_proof",
    ],
  }),
  entry("list_pending_requests", ["GET /api/inbox"], "read", {
    conditions: [
      "project_scope",
      "agent_creator_inbox_only",
      "responses_do_not_authorize_execution",
    ],
  }),
  entry("get_issue_relations", ["GET /api/issues/:issueId/relations"], "read"),
  entry(
    "add_issue_relation",
    ["POST /api/issues/:issueId/relations"],
    "write",
    {
      readback: "sticker_get_issue_relations",
      conditions: [
        "project_scope",
        "both_issue_revisions",
        "same_project_no_cycle",
      ],
    },
  ),
  entry(
    "remove_issue_relation",
    ["DELETE /api/relations/:relationId"],
    "write",
    {
      readback: "sticker_get_issue_relations",
      destructive: true,
      conditions: ["project_scope", "both_issue_revisions"],
    },
  ),
  entry("query_issues", ["POST /api/issues/query"], "read"),
  entry("list_issues", ["POST /api/issues/query"], "read"),
  entry("list_saved_views", ["GET /api/views"], "read", {
    conditions: ["project_scope", "personal_actor"],
  }),
  entry("get_saved_view", ["GET /api/views/:viewId"], "read", {
    conditions: ["project_scope", "personal_actor"],
  }),
  entry(
    "get_version_readiness",
    ["GET /api/versions/:versionId/readiness"],
    "read",
  ),
  entry(
    "get_version_changelog",
    ["GET /api/versions/:versionId/changelog"],
    "read",
  ),
  entry("delete_project", ["DELETE /api/projects/:projectId"], "write", {
    authority: "owner",
    readback: "sticker_list_projects",
    conditions: ["empty_project"],
    destructive: true,
  }),
  entry("delete_version", ["DELETE /api/versions/:versionId"], "write", {
    authority: "writer",
    readback: "sticker_list_versions",
    conditions: ["project_scope", "owner_if_released_audited_or_closed_issues"],
    destructive: true,
  }),
  entry("delete_issue", ["DELETE /api/issues/:issueId"], "write", {
    authority: "owner",
    readback: "sticker_get_issue",
    conditions: ["project_scope", "no_remote_delete"],
    destructive: true,
  }),
  entry("delete_comment", ["DELETE /api/comments/:commentId"], "write", {
    authority: "writer",
    readback: "sticker_get_issue",
    conditions: ["project_scope", "writable_issue", "owner_or_author"],
    destructive: true,
  }),
  entry(
    "delete_attachment",
    ["DELETE /api/attachments/:attachmentId"],
    "write",
    {
      authority: "writer",
      readback: "sticker_get_issue",
      conditions: ["project_scope", "writable_issue", "owner_or_author"],
      destructive: true,
    },
  ),
  entry("create_resource_link", ["POST /api/resources"], "write", {
    authority: "writer",
    retry: "exact-operation",
    readback: "sticker_list_resources",
    conditions: ["project_scope", "http_https_link_no_fetch"],
  }),
  entry("update_resource", ["PATCH /api/resources/:resourceId"], "write", {
    authority: "writer",
    retry: "exact-operation",
    readback: "sticker_get_resource",
    conditions: [
      "project_scope",
      "revision",
      "owner_only_if_designated_guidance",
      "same_kind",
    ],
  }),
  entry("delete_resource", ["DELETE /api/resources/:resourceId"], "write", {
    authority: "writer",
    retry: "exact-operation",
    readback: "sticker_get_resource",
    conditions: [
      "project_scope",
      "revision",
      "owner_only_if_designated_guidance",
      "tombstone_retains_history",
    ],
    destructive: true,
  }),
  entry(
    "set_resource_guidance",
    ["PATCH /api/resources/:resourceId/guidance"],
    "write",
    {
      authority: "owner",
      retry: "exact-operation",
      readback: "sticker_get_resource",
      conditions: ["project_scope", "revision"],
    },
  ),
  entry(
    "unlink_resource",
    ["DELETE /api/issues/:issueId/resources/:linkId"],
    "write",
    {
      authority: "writer",
      retry: "exact-operation",
      readback: "sticker_list_issue_resources",
      conditions: ["project_scope", "issue_revision", "link_id"],
      destructive: true,
    },
  ),
  entry(
    "list_issue_resources",
    ["GET /api/issues/:issueId/resources"],
    "read",
    {},
  ),
  entry(
    "list_session_resource_references",
    ["GET /api/sessions/:sessionId/resources"],
    "read",
    {},
  ),
  entry(
    "create_issue_template",
    ["POST /api/projects/:projectId/templates"],
    "write",
    {
      authority: "owner",
      retry: "exact-operation",
      readback: "sticker_list_issue_templates",
    },
  ),
  entry(
    "update_issue_template",
    ["PATCH /api/templates/:templateId"],
    "write",
    {
      authority: "owner",
      readback: "sticker_get_issue_template",
      conditions: ["project_scope", "revision", "full_definition"],
    },
  ),
  entry(
    "delete_issue_template",
    ["DELETE /api/templates/:templateId"],
    "write",
    {
      authority: "owner",
      readback: "sticker_list_issue_templates",
      conditions: ["project_scope", "revision"],
      destructive: true,
    },
  ),
  entry(
    "list_template_assignees",
    ["GET /api/projects/:projectId/template-assignees"],
    "read",
    {},
  ),
  entry("create_saved_view", ["POST /api/views"], "write", {
    readback: "sticker_list_saved_views",
    conditions: ["project_scope", "personal_actor"],
  }),
  entry("update_saved_view", ["PATCH /api/views/:viewId"], "write", {
    readback: "sticker_get_saved_view",
    conditions: ["project_scope", "personal_actor", "revision"],
  }),
  entry("delete_saved_view", ["DELETE /api/views/:viewId"], "write", {
    readback: "sticker_list_saved_views",
    conditions: ["project_scope", "personal_actor", "revision"],
    destructive: true,
  }),
  entry(
    "get_view_preferences",
    ["GET /api/view-preferences/:projectId"],
    "read",
    { conditions: ["project_scope", "personal_actor"] },
  ),
  entry(
    "set_view_preferences",
    ["PUT /api/view-preferences/:projectId"],
    "write",
    {
      readback: "sticker_get_view_preferences",
      conditions: ["project_scope", "personal_actor", "revision"],
    },
  ),
  entry("get_relation_summaries", ["GET /api/relations/summary"], "read", {}),
  entry("list_completed_requests", ["GET /api/inbox"], "read", {
    conditions: [
      "project_scope",
      "completed_true",
      "agent_creator_inbox_only",
      "responses_do_not_authorize_execution",
    ],
  }),
  entry("get_request", ["GET /api/requests/:requestId"], "read", {
    conditions: [
      "project_scope",
      "not_creator_filtered",
      "responses_do_not_authorize_execution",
    ],
  }),
  entry(
    "respond_to_request",
    ["POST /api/requests/:requestId/responses"],
    "write",
    {
      authority: "owner",
      retry: "exact-operation",
      readback: "sticker_get_request",
      conditions: ["project_scope", "revision", "record_only_no_execution"],
    },
  ),
  entry("close_request", ["POST /api/requests/:requestId/close"], "write", {
    authority: "owner",
    retry: "exact-operation",
    readback: "sticker_get_request",
    conditions: ["project_scope", "revision", "record_only_no_execution"],
  }),
  entry("close_session", ["POST /api/sessions/:sessionId/close"], "write", {
    authority: "owner",
    retry: "exact-operation",
    readback: "sticker_get_session",
    conditions: ["project_scope", "revision", "record_only_no_execution"],
  }),
  entry(
    "preview_version_carryover",
    ["POST /api/versions/:versionId/carryover/preview"],
    "read",
    {
      authority: "writer",
      conditions: [
        "project_scope",
        "both_version_and_issue_revisions",
        "owner_if_closed_issues",
        "no_mutation",
      ],
    },
  ),
  entry(
    "apply_version_carryover",
    ["POST /api/versions/:versionId/carryover"],
    "write",
    {
      retry: "exact-operation",
      readback: "sticker_get_version_readiness",
      conditions: [
        "project_scope",
        "both_version_and_issue_revisions",
        "owner_if_closed_issues",
        "per_item_results",
      ],
    },
  ),
  entry(
    "save_version_changelog",
    ["PUT /api/versions/:versionId/changelog"],
    "write",
    {
      readback: "sticker_get_version_changelog",
      conditions: ["project_scope", "draft_revision", "persists_draft"],
    },
  ),
  entry(
    "generate_version_changelog",
    ["POST /api/versions/:versionId/changelog/generate"],
    "write",
    {
      readback: "sticker_get_version_changelog",
      conditions: ["project_scope", "draft_revision", "persists_draft"],
    },
  ),
  entry("release_version", ["POST /api/versions/:versionId/release"], "write", {
    authority: "owner",
    retry: "exact-operation",
    readback: "sticker_get_version_readiness",
    conditions: [
      "project_scope",
      "revision",
      "audit_record",
      "no_external_publish",
    ],
    confirm: "literal-true",
  }),
  entry(
    "preview_issue_restore",
    ["POST /api/issues/:issueId/restore/preview"],
    "read",
    {
      authority: "owner",
      conditions: [
        "project_scope",
        "revision",
        "selected_fields",
        "no_mutation",
      ],
    },
  ),
  entry(
    "restore_issue_fields",
    ["POST /api/issues/:issueId/restore"],
    "write",
    {
      destructive: true,
      authority: "owner",
      retry: "exact-operation",
      readback: "sticker_get_issue",
      conditions: [
        "project_scope",
        "revision",
        "selected_fields",
        "new_history_record",
      ],
    },
  ),
  entry("get_mcp_settings", ["GET /api/mcp/settings"], "read", {
    authority: "owner",
    conditions: ["verified_actor"],
  }),
  entry("get_access_mode", ["GET /api/access-mode"], "read", {
    authority: "authenticated",
    conditions: ["verified_actor"],
  }),
  entry("get_server_health", ["GET /healthz"], "read", {
    authority: "authenticated",
    conditions: ["verified_actor"],
  }),
  entry("get_server_readiness", ["GET /readyz"], "read", {
    authority: "authenticated",
    conditions: ["verified_actor", "maintenance_503_is_observation"],
  }),
  entry("get_maintenance", ["GET /api/maintenance"], "read", {
    authority: "authenticated",
    conditions: ["verified_actor"],
  }),
  entry("begin_maintenance", ["POST /api/maintenance/begin"], "write", {
    authority: "owner",
    readback: "sticker_get_maintenance",
    conditions: ["instance_id", "revision", "no_process_operation"],
    confirm: "literal-true",
  }),
  entry("resume_maintenance", ["POST /api/maintenance/resume"], "write", {
    authority: "owner",
    readback: "sticker_get_maintenance",
    conditions: ["instance_id", "revision", "no_process_operation"],
    confirm: "literal-true",
  }),
  entry("end_owner_session", ["DELETE /api/session"], "write", {
    authenticationMode: "owner-session",
    authority: "owner",
    readback: "sticker_get_capabilities",
    conditions: [
      "owner_session_mode_only",
      "ends_current_session_only",
      "no_token_revocation_or_file_deletion",
    ],
    destructive: true,
    confirm: "literal-true",
  }),
];
export function catalogueEntry(tool: string): McpCatalogueEntry {
  const value = MCP_CATALOGUE.find((entry) => entry.tool === tool);
  if (!value)
    throw new Error("MCP tool is missing from the supported catalogue.");
  return value;
}
