import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sessionOwner as owner } from "./session-fixture.js";
import { issueSchema } from "../server/response-schemas.js";
import { resourceDetailSchema } from "../server/contracts/resources.js";
import {
  savedViewSchema,
  viewPreferencesSchema,
} from "../server/contracts/views.js";
import { templateDetailSchema } from "../server/contracts/templates.js";
import {
  sessionEventResultSchema,
  sessionRequestSchema,
  sessionSchema,
} from "../server/contracts/sessions.js";
import {
  changelogSchema,
  carryoverPreviewSchema,
  carryoverResultSchema,
  releaseResultSchema,
} from "../server/contracts/releases.js";
import {
  historyListSchema,
  restorePreviewSchema,
} from "../server/contracts/history.js";
import { maintenanceSnapshotSchema } from "../server/contracts/maintenance.js";

import { ordinaryMcpFixture as fixture } from "./mcp-product-fixture.js";
const removed = z.object({ removed: z.literal(true) });
void test("ordinary lifecycle: owner close/reopen, author restrictions and irreversible deletes use actual HTTP authority", async () => {
  const f = await fixture();
  try {
    const closed = await f.ok(
      "owner",
      "sticker_update_issue",
      { issueId: f.issue.id, revision: 1, status: "closed" },
      issueSchema,
    );
    await f.denied(
      "agent",
      "sticker_update_issue",
      { issueId: f.issue.id, revision: closed.revision, status: "ready" },
      403,
    );
    const open = await f.ok(
      "owner",
      "sticker_update_issue",
      { issueId: f.issue.id, revision: closed.revision, status: "ready" },
      issueSchema,
    );
    assert.equal(open.status, "ready");
    await f.denied(
      "agent",
      "sticker_update_issue",
      { issueId: f.issue.id, revision: open.revision, status: "closed" },
      403,
    );
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).issue.status,
      "ready",
    );
    const comment = await f.ok(
      "agent",
      "sticker_add_comment",
      { issueId: f.issue.id, body: "mine" },
      z.object({ id: z.string() }),
    );
    await f.denied(
      "other",
      "sticker_delete_comment",
      { commentId: comment.id },
      403,
    );
    await f.ok(
      "agent",
      "sticker_delete_comment",
      { commentId: comment.id },
      removed,
    );
    const attachment = await f.ok(
      "agent",
      "sticker_add_link",
      { issueId: f.issue.id, name: "ref", url: "https://example.test/ref" },
      z.object({ id: z.string() }),
    );
    await f.denied(
      "other",
      "sticker_delete_attachment",
      { attachmentId: attachment.id },
      403,
    );
    await f.ok(
      "agent",
      "sticker_delete_attachment",
      { attachmentId: attachment.id },
      removed,
    );
    await f.denied(
      "read",
      "sticker_delete_version",
      { versionId: "missing" },
      403,
    );
    await f.denied(
      "agent",
      "sticker_delete_issue",
      { issueId: f.issue.id },
      403,
    );
    const version = f.instance.store.createVersion(owner, {
      projectId: f.project.id,
      name: "empty",
    });
    await f.ok(
      "agent",
      "sticker_delete_version",
      { versionId: version.id },
      removed,
    );
    await f.ok(
      "owner",
      "sticker_delete_issue",
      { issueId: f.issue.id },
      removed,
    );
    await f.denied("owner", "sticker_get_issue", { issueId: f.issue.id }, 404);
    await f.ok(
      "owner",
      "sticker_delete_project",
      { projectId: f.project.id },
      removed,
    );
  } finally {
    await f.close();
  }
});
void test("ordinary resources: shared link/metadata contracts, guidance, references, unlink and tombstone preserve versions", async () => {
  const f = await fixture();
  try {
    const input = {
      projectId: f.project.id,
      title: "reference",
      url: "https://example.test/original",
      operationId: randomUUID(),
    };
    const created = await f.ok(
      "agent",
      "sticker_create_resource_link",
      input,
      resourceDetailSchema,
    );
    assert.equal(
      (
        await f.ok(
          "agent",
          "sticker_create_resource_link",
          input,
          resourceDetailSchema,
        )
      ).resource.id,
      created.resource.id,
    );
    await f.denied(
      "agent",
      "sticker_create_resource_link",
      { ...input, title: "different" },
      409,
    );
    const id = created.resource.id;
    await f.denied(
      "agent",
      "sticker_update_resource",
      {
        resourceId: id,
        revision: created.resource.revision,
        operationId: randomUUID(),
        url: "https://example.test/",
        markdown: "invalid simultaneous content",
      },
      400,
    );
    const updated = await f.ok(
      "agent",
      "sticker_update_resource",
      {
        resourceId: id,
        revision: created.resource.revision,
        operationId: randomUUID(),
        title: "renamed",
        url: "https://example.test/new",
      },
      resourceDetailSchema,
    );
    assert.equal(updated.history.length, 2);
    const metadata = await f.ok(
      "agent",
      "sticker_update_resource",
      {
        resourceId: id,
        revision: updated.resource.revision,
        operationId: randomUUID(),
        title: "metadata only",
        versionId: null,
      },
      resourceDetailSchema,
    );
    assert.equal(metadata.current?.kind, "link");
    assert.equal(metadata.resource.title, "metadata only");
    await f.denied(
      "agent",
      "sticker_update_resource",
      {
        resourceId: id,
        revision: 1,
        operationId: randomUUID(),
        title: "stale",
      },
      409,
    );
    const linked = await f.ok(
      "agent",
      "sticker_link_resource",
      {
        issueId: f.issue.id,
        resourceId: id,
        resourceVersion: 2,
        issueRevision: 1,
        operationId: randomUUID(),
      },
      z.object({ id: z.string(), resource: z.object({ id: z.string() }) }),
    );
    assert.equal(linked.resource.id, id);
    assert.equal(
      (
        await f.ok(
          "agent",
          "sticker_list_issue_resources",
          { issueId: f.issue.id },
          z.array(z.unknown()),
        )
      ).length,
      1,
    );
    const event = await f.ok(
      "agent",
      "sticker_report_session_event",
      {
        projectId: f.project.id,
        externalSessionId: "result-session",
        eventId: "result-1",
        kind: "result",
        message: "read reference",
      },
      sessionEventResultSchema,
    );
    await f.ok(
      "agent",
      "sticker_record_resource_reference",
      {
        sessionId: event.session.id,
        eventId: "result-1",
        resourceId: id,
        resourceVersion: 2,
        operationId: randomUUID(),
      },
      z.unknown(),
    );
    assert.equal(
      (
        await f.ok(
          "agent",
          "sticker_list_session_resource_references",
          { sessionId: event.session.id },
          z.array(z.unknown()),
        )
      ).length,
      1,
    );
    await f.ok(
      "agent",
      "sticker_unlink_resource",
      {
        issueId: f.issue.id,
        linkId: linked.id,
        issueRevision: 2,
        operationId: randomUUID(),
      },
      removed,
    );
    const guidance = await f.ok(
      "owner",
      "sticker_set_resource_guidance",
      {
        resourceId: id,
        revision: metadata.resource.revision,
        operationId: randomUUID(),
        isGuidance: true,
      },
      resourceDetailSchema,
    );
    await f.denied(
      "agent",
      "sticker_delete_resource",
      {
        resourceId: id,
        revision: guidance.resource.revision,
        operationId: randomUUID(),
      },
      403,
    );
    const deleted = await f.ok(
      "owner",
      "sticker_delete_resource",
      {
        resourceId: id,
        revision: guidance.resource.revision,
        operationId: randomUUID(),
      },
      resourceDetailSchema,
    );
    assert.equal(deleted.current, null);
    assert.equal(deleted.history.length, 3);
  } finally {
    await f.close();
  }
});
void test("ordinary templates, personal views/preferences and batch relations retain owner and actor scope", async () => {
  const f = await fixture();
  try {
    const definition = {
      name: "feature",
      body: "## scope",
      requiredFields: [],
      defaults: {},
    };
    const create = {
      ...definition,
      projectId: f.project.id,
      operationId: randomUUID(),
    };
    await f.denied("agent", "sticker_create_issue_template", create, 403);
    const template = await f.ok(
      "owner",
      "sticker_create_issue_template",
      create,
      templateDetailSchema,
    );
    assert.equal(
      (
        await f.ok(
          "owner",
          "sticker_create_issue_template",
          create,
          templateDetailSchema,
        )
      ).template.id,
      template.template.id,
    );
    const next = await f.ok(
      "owner",
      "sticker_update_issue_template",
      {
        templateId: template.template.id,
        ...definition,
        body: "changed",
        revision: 1,
      },
      templateDetailSchema,
    );
    assert.equal(next.versions.length, 2);
    await f.denied(
      "owner",
      "sticker_update_issue_template",
      { templateId: template.template.id, ...definition, revision: 1 },
      409,
    );
    assert.ok(
      (
        await f.ok(
          "agent",
          "sticker_list_template_assignees",
          { projectId: f.project.id },
          z.array(z.unknown()),
        )
      ).length > 0,
    );
    await f.ok(
      "owner",
      "sticker_delete_issue_template",
      { templateId: template.template.id, revision: 2 },
      removed,
    );
    const view = await f.ok(
      "agent",
      "sticker_create_saved_view",
      { name: "mine", query: { projectId: f.project.id } },
      savedViewSchema,
    );
    await f.denied("other", "sticker_get_saved_view", { viewId: view.id }, 404);
    const prefs = await f.ok(
      "agent",
      "sticker_get_view_preferences",
      { projectId: f.project.id },
      viewPreferencesSchema,
    );
    await f.ok(
      "agent",
      "sticker_set_view_preferences",
      {
        projectId: f.project.id,
        revision: prefs.revision,
        defaultViewId: view.id,
        favoriteIds: [view.id],
      },
      viewPreferencesSchema,
    );
    assert.deepEqual(
      (
        await f.ok(
          "other",
          "sticker_get_view_preferences",
          { projectId: f.project.id },
          viewPreferencesSchema,
        )
      ).favoriteIds,
      [],
    );
    const edited = await f.ok(
      "agent",
      "sticker_update_saved_view",
      {
        viewId: view.id,
        revision: 1,
        name: "renamed",
        query: { projectId: f.project.id },
      },
      savedViewSchema,
    );
    await f.denied(
      "agent",
      "sticker_update_saved_view",
      {
        viewId: view.id,
        revision: 1,
        name: "stale",
        query: { projectId: f.project.id },
      },
      409,
    );
    await f.ok(
      "agent",
      "sticker_get_relation_summaries",
      { projectId: f.project.id },
      z.record(z.string(), z.unknown()),
    );
    await f.ok(
      "agent",
      "sticker_delete_saved_view",
      { viewId: view.id, revision: edited.revision },
      removed,
    );
  } finally {
    await f.close();
  }
});
void test("ordinary requests: completed creator inbox differs from exact scoped getter; owner response/close replay never authorizes execution", async () => {
  const f = await fixture();
  try {
    const event = await f.ok(
      "agent",
      "sticker_report_session_event",
      {
        projectId: f.project.id,
        externalSessionId: "request-session",
        eventId: "request-1",
        kind: "request",
        requestKind: "input",
        message: "question",
      },
      sessionEventResultSchema,
    );
    assert.ok(event.request);
    const requestId = event.request.id;
    await f.ok(
      "other",
      "sticker_get_request",
      { requestId },
      sessionRequestSchema,
    );
    const response = {
      requestId,
      revision: 1,
      operationId: randomUUID(),
      body: "recorded answer",
    };
    await f.denied("agent", "sticker_respond_to_request", response, 403);
    const answered = await f.ok(
      "owner",
      "sticker_respond_to_request",
      response,
      sessionRequestSchema,
    );
    await f.ok(
      "owner",
      "sticker_respond_to_request",
      response,
      sessionRequestSchema,
    );
    assert.equal(
      (
        await f.ok(
          "agent",
          "sticker_list_completed_requests",
          {},
          sessionRequestSchema.array(),
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await f.ok(
          "other",
          "sticker_list_completed_requests",
          {},
          sessionRequestSchema.array(),
        )
      ).length,
      0,
    );
    await f.ok(
      "owner",
      "sticker_close_request",
      { requestId, revision: answered.revision, operationId: randomUUID() },
      sessionRequestSchema,
    );
    await f.ok(
      "owner",
      "sticker_close_session",
      {
        sessionId: event.session.id,
        revision: event.session.revision,
        operationId: randomUUID(),
      },
      sessionSchema,
    );
  } finally {
    await f.close();
  }
});
void test("ordinary release and restore: preview does not mutate, keyed apply/replay, draft writes and literal-confirm audit", async () => {
  const f = await fixture();
  try {
    const source = f.instance.store.createVersion(owner, {
        projectId: f.project.id,
        name: "source",
      }),
      dest = f.instance.store.createVersion(owner, {
        projectId: f.project.id,
        name: "dest",
      });
    const issue = f.instance.store.updateIssue(owner, f.issue.id, {
      revision: 1,
      title: "changed",
      targetVersionId: source.id,
    });
    const stale = f.instance.store.createIssue(owner, {
      projectId: f.project.id,
      title: "stale item",
      targetVersionId: source.id,
    });
    f.instance.store.updateIssue(owner, stale.id, {
      revision: stale.revision,
      title: "concurrently changed",
    });
    const input = {
      versionId: source.id,
      revision: source.revision,
      destinationVersionId: dest.id,
      destinationRevision: dest.revision,
      operationId: randomUUID(),
      issues: [
        { issueId: issue.id, revision: issue.revision },
        { issueId: stale.id, revision: stale.revision },
      ],
    };
    await f.ok(
      "agent",
      "sticker_preview_version_carryover",
      input,
      carryoverPreviewSchema,
    );
    assert.equal(
      f.instance.store.getIssue(owner, issue.id).issue.targetVersionId,
      source.id,
    );
    const applied = await f.ok(
      "agent",
      "sticker_apply_version_carryover",
      input,
      carryoverResultSchema,
    );
    assert.equal(applied.items[0].outcome, "moved");
    assert.equal(applied.items[1].outcome, "conflict");
    await f.ok(
      "agent",
      "sticker_apply_version_carryover",
      input,
      carryoverResultSchema,
    );
    const saved = await f.ok(
      "agent",
      "sticker_save_version_changelog",
      {
        versionId: dest.id,
        revision: 0,
        selectedIssueIds: [issue.id],
        markdown: "draft",
      },
      changelogSchema,
    );
    await f.ok(
      "agent",
      "sticker_generate_version_changelog",
      {
        versionId: dest.id,
        revision: saved.revision,
        selectedIssueIds: [issue.id],
      },
      changelogSchema,
    );
    const history = await f.ok(
      "owner",
      "sticker_list_issue_history",
      { issueId: issue.id },
      historyListSchema,
    );
    const change = history.find((x) => x.fields.includes("title"));
    assert.ok(change);
    const current = f.instance.store.getIssue(owner, issue.id).issue;
    const restore = {
      issueId: issue.id,
      changeId: change.id,
      side: "before",
      fields: ["title"],
      revision: current.revision,
    };
    await f.ok(
      "owner",
      "sticker_preview_issue_restore",
      restore,
      restorePreviewSchema,
    );
    assert.equal(
      f.instance.store.getIssue(owner, issue.id).issue.title,
      "changed",
    );
    const apply = { ...restore, operationId: randomUUID() };
    const restored = await f.ok(
      "owner",
      "sticker_restore_issue_fields",
      apply,
      z.object({ issue: issueSchema }),
    );
    assert.equal(restored.issue.title, "original");
    await f.ok(
      "owner",
      "sticker_restore_issue_fields",
      apply,
      z.object({ issue: issueSchema }),
    );
    const release = {
      versionId: dest.id,
      revision: dest.revision,
      operationId: randomUUID(),
      confirm: true,
    };
    await f.denied("agent", "sticker_release_version", release, 403);
    await f.ok(
      "owner",
      "sticker_release_version",
      release,
      releaseResultSchema,
    );
    await f.ok(
      "owner",
      "sticker_release_version",
      release,
      releaseResultSchema,
    );
  } finally {
    await f.close();
  }
});
void test("ordinary safe observations, maintenance and owner-session teardown preserve auth with no fallback", async () => {
  const f = await fixture();
  try {
    const tools = (await f.clients[0].client.listTools()).tools;
    assert.equal(tools.length, 97);
    const metadata = await f.ok(
      "owner",
      "sticker_get_mcp_settings",
      {},
      z.unknown(),
    );
    assert.ok(!JSON.stringify(metadata).includes(f.tokens.agent));
    await f.denied("agent", "sticker_get_mcp_settings", {}, 403);
    await f.ok(
      "agent",
      "sticker_get_access_mode",
      {},
      z.object({ mode: z.literal("password") }),
    );
    await f.ok(
      "agent",
      "sticker_get_server_health",
      {},
      z.object({ status: z.literal("ok") }),
    );
    await f.ok(
      "agent",
      "sticker_get_server_readiness",
      {},
      z.object({ status: z.literal("ready") }),
    );
    const state = await f.ok(
      "owner",
      "sticker_get_maintenance",
      {},
      maintenanceSnapshotSchema,
    );
    const drain = await f.ok(
      "owner",
      "sticker_begin_maintenance",
      { instanceId: state.instanceId, revision: state.revision, confirm: true },
      maintenanceSnapshotSchema,
    );
    await f.ok(
      "agent",
      "sticker_get_server_readiness",
      {},
      z.object({ status: z.literal("maintenance") }),
    );
    await f.denied(
      "agent",
      "sticker_add_comment",
      { issueId: f.issue.id, body: "blocked" },
      503,
    );
    await f.ok(
      "owner",
      "sticker_resume_maintenance",
      { instanceId: drain.instanceId, revision: drain.revision, confirm: true },
      maintenanceSnapshotSchema,
    );
    await f.denied(
      "agent",
      "sticker_end_owner_session",
      { confirm: true },
      403,
    );
    await f.ok(
      "owner",
      "sticker_end_owner_session",
      { confirm: true },
      z.object({ ended: z.literal(true) }),
    );
    await f.denied("owner", "sticker_list_projects", {}, 401);
  } finally {
    await f.close();
  }
});

void test("new ordinary tools preserve scoped/read-only denials without leaking foreign state", async () => {
  const f = await fixture();
  try {
    await f.denied(
      "agent",
      "sticker_create_resource_link",
      {
        projectId: f.foreignProject.id,
        title: "forbidden",
        url: "https://example.test/",
        operationId: randomUUID(),
      },
      403,
    );
    await f.denied(
      "agent",
      "sticker_list_issue_resources",
      { issueId: f.foreignIssue.id },
      403,
    );
    await f.denied(
      "agent",
      "sticker_get_view_preferences",
      { projectId: f.foreignProject.id },
      403,
    );
    await f.denied(
      "read",
      "sticker_create_saved_view",
      { name: "read only", query: { projectId: f.project.id } },
      403,
    );
    await f.denied(
      "agent",
      "sticker_preview_issue_restore",
      {
        issueId: f.issue.id,
        changeId: "missing",
        revision: 1,
        side: "before",
        fields: ["title"],
      },
      403,
    );
  } finally {
    await f.close();
  }
});
