import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ordinaryMcpFixture } from "./mcp-product-fixture.js";
import { sessionOwner as owner } from "./session-fixture.js";
import { carryoverPreviewSchema } from "../server/contracts/releases.js";
function payload(result: unknown) {
  const envelope = z
    .object({
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    })
    .parse(result);
  return JSON.parse(envelope.content[0].text) as unknown;
}
void test("no-content mutations reject unexpected200/202 without claiming completion or retrying", async (t) => {
  const f = await ordinaryMcpFixture(),
    realFetch = globalThis.fetch;
  const cases = [
    {
      name: "sticker_delete_project",
      args: { projectId: f.project.id },
      path: `/api/projects/${f.project.id}`,
      readback: "sticker_list_projects",
    },
    {
      name: "sticker_delete_version",
      args: { versionId: "synthetic-version" },
      path: "/api/versions/synthetic-version",
      readback: "sticker_list_versions",
    },
    {
      name: "sticker_delete_issue",
      args: { issueId: f.issue.id },
      path: `/api/issues/${f.issue.id}`,
      readback: "sticker_get_issue",
    },
    {
      name: "sticker_delete_comment",
      args: { commentId: "synthetic-comment" },
      path: "/api/comments/synthetic-comment",
      readback: "sticker_get_issue",
    },
    {
      name: "sticker_delete_attachment",
      args: { attachmentId: "synthetic-attachment" },
      path: "/api/attachments/synthetic-attachment",
      readback: "sticker_get_issue",
    },
    {
      name: "sticker_delete_issue_template",
      args: { templateId: "synthetic-template", revision: 1 },
      path: "/api/templates/synthetic-template",
      readback: "sticker_list_issue_templates",
    },
    {
      name: "sticker_delete_saved_view",
      args: { viewId: "synthetic-view", revision: 1 },
      path: "/api/views/synthetic-view",
      readback: "sticker_list_saved_views",
    },
    {
      name: "sticker_remove_issue_relation",
      args: {
        relationId: "synthetic-relation",
        sourceRevision: 1,
        targetRevision: 1,
      },
      path: "/api/relations/synthetic-relation",
      readback: "sticker_get_issue_relations",
    },
    {
      name: "sticker_end_owner_session",
      args: { confirm: true },
      path: "/api/session",
      readback: "sticker_get_capabilities",
    },
  ];
  let interceptedPath = "",
    status = 200,
    attempts = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (init?.method === "DELETE" && url.pathname === interceptedPath) {
        attempts++;
        return new Response(
          JSON.stringify(
            status === 202
              ? { accepted: true }
              : { ok: true, removed: true, ended: true },
          ),
          { status, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input, init);
    },
  );
  try {
    const client = f.clients.find((p) => p.who === "owner")?.client;
    assert.ok(client);
    for (status of [200, 202])
      for (const candidate of cases)
        await t.test(
          `${candidate.name} unexpected${String(status)}`,
          async () => {
            interceptedPath = candidate.path;
            attempts = 0;
            const result = await client.callTool({
              name: candidate.name,
              arguments: candidate.args,
            });
            assert.equal(attempts, 1, "one dispatch, no automatic retry");
            assert.equal(
              result.isError,
              true,
              "unexpected success does not establish completion",
            );
            const error = z
              .object({
                status: z.literal(502),
                code: z.literal("api_response_invalid"),
                outcome: z.literal("uncertain"),
                retryable: z.literal(false),
                retry: z.literal("readback"),
                phase: z.literal("after_dispatch"),
                readback: z.literal(candidate.readback),
              })
              .parse(payload(result));
            assert.equal(error.readback, candidate.readback);
            assert.ok(!("removed" in error) && !("ended" in error));
          },
        );
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).issue.id,
      f.issue.id,
      "intercepted202 never deleted actual issue",
    );
    await f.ok("owner", "sticker_list_projects", {}, z.array(z.unknown()));
    interceptedPath = "";
    await f.ok(
      "owner",
      "sticker_delete_issue",
      { issueId: f.issue.id },
      z.object({ removed: z.literal(true) }),
    );
    assert.throws(() => f.instance.store.getIssue(owner, f.issue.id));
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
void test("carryover preview help separates writer authority from safe nonmutating read effect", async (t) => {
  const f = await ordinaryMcpFixture();
  try {
    const source = f.instance.store.createVersion(owner, {
        projectId: f.project.id,
        name: "source",
      }),
      destination = f.instance.store.createVersion(owner, {
        projectId: f.project.id,
        name: "destination",
      });
    const issue = f.instance.store.updateIssue(owner, f.issue.id, {
      revision: 1,
      targetVersionId: source.id,
    });
    const input = {
      versionId: source.id,
      revision: source.revision,
      destinationVersionId: destination.id,
      destinationRevision: destination.revision,
      operationId: randomUUID(),
      issues: [{ issueId: issue.id, revision: issue.revision }],
    };
    const help = z.object({
      actions: z.array(
        z.object({
          tool: z.string(),
          authority: z.string(),
          effect: z.string(),
          retry: z.string(),
          availability: z.string(),
          reason: z.string().optional(),
        }),
      ),
    });
    const before = f.instance.store.getIssue(owner, issue.id);
    await t.test(
      "read-only help and capabilities report required write permission",
      async () => {
        for (const name of ["sticker_get_help", "sticker_get_capabilities"]) {
          const result = await f.ok(
            "read",
            name,
            name === "sticker_get_help"
              ? { tool: "sticker_preview_version_carryover" }
              : {},
            help,
          );
          const action = result.actions.find(
            (a) => a.tool === "sticker_preview_version_carryover",
          );
          assert.ok(action);
          assert.equal(action.authority, "writer");
          assert.equal(action.effect, "read");
          assert.equal(action.retry, "read");
          assert.equal(action.availability, "permission_needed");
          assert.equal(action.reason, "write_permission_required");
        }
      },
    );
    await t.test(
      "read-only actual HTTP403 leaves state unchanged, writable preview succeeds",
      async () => {
        await f.denied("read", "sticker_preview_version_carryover", input, 403);
        const writable = await f.ok(
          "agent",
          "sticker_get_help",
          { tool: "sticker_preview_version_carryover" },
          help,
        );
        assert.equal(writable.actions[0].availability, "conditional");
        assert.equal(writable.actions[0].reason, undefined);
        await f.ok(
          "agent",
          "sticker_preview_version_carryover",
          input,
          carryoverPreviewSchema,
        );
        assert.deepEqual(f.instance.store.getIssue(owner, issue.id), before);
      },
    );
    await t.test(
      "failed POST preview retains safe-read recovery and sends once",
      async () => {
        const realFetch = globalThis.fetch;
        let attempts = 0;
        t.mock.method(
          globalThis,
          "fetch",
          async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(
              typeof input === "string" || input instanceof URL
                ? input
                : input.url,
            );
            if (
              init?.method === "POST" &&
              url.pathname === `/api/versions/${source.id}/carryover/preview`
            ) {
              attempts++;
              return new Response(
                JSON.stringify({
                  error: "synthetic unavailable",
                  code: "UNAVAILABLE",
                }),
                {
                  status: 503,
                  headers: { "content-type": "application/json" },
                },
              );
            }
            return realFetch(input, init);
          },
        );
        const client = f.clients.find((p) => p.who === "agent")?.client;
        assert.ok(client);
        const result = await client.callTool({
          name: "sticker_preview_version_carryover",
          arguments: input,
        });
        assert.equal(result.isError, true);
        const error = z
          .object({
            status: z.literal(503),
            retry: z.literal("safe_read"),
            retryable: z.literal(true),
            outcome: z.undefined().optional(),
          })
          .parse(payload(result));
        assert.equal(error.outcome, undefined);
        assert.equal(attempts, 1);
        assert.deepEqual(f.instance.store.getIssue(owner, issue.id), before);
      },
    );
  } finally {
    await f.close();
  }
});

void test("known trusted-local-owner mode reports logout authentication requirement before its actual denial", async (t) => {
  const f = await ordinaryMcpFixture("trusted-local-owner"),
    realFetch = globalThis.fetch;
  let deletes = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") deletes++;
      return realFetch(input, init);
    },
  );
  try {
    const help = z.object({
      actions: z.array(
        z.object({
          tool: z.string(),
          availability: z.string(),
          reason: z.string().optional(),
          authenticationMode: z.string().optional(),
        }),
      ),
    });
    for (const name of ["sticker_get_help", "sticker_get_capabilities"]) {
      const result = await f.ok(
        "owner",
        name,
        name === "sticker_get_help"
          ? { tool: "sticker_end_owner_session" }
          : {},
        help,
      );
      const action = result.actions.find(
        (a) => a.tool === "sticker_end_owner_session",
      );
      assert.ok(action);
      assert.equal(action.availability, "permission_needed");
      assert.equal(action.reason, "authentication_mode_required");
      assert.equal(action.authenticationMode, "owner-session");
    }
    await f.denied(
      "owner",
      "sticker_end_owner_session",
      { confirm: true },
      403,
    );
    assert.equal(deletes, 0);
    await f.ok("owner", "sticker_list_projects", {}, z.array(z.unknown()));
  } finally {
    await f.close();
  }
});
