import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { TestContext } from "node:test";
import { migrations } from "../../../server/migrations/index.js";

export const stamp = "2026-10-31T12:00:00.000Z";
export const excludedCanary = "EXCLUDED-SESSION-CREDENTIAL-CANARY";
export const contentCanary = "USER-AUTHORED-SECRET-LOOKING-CONTENT";
export const fileOne = "11111111-1111-4111-8111-111111111111";
export const fileTwo = "22222222-2222-4222-8222-222222222222";
export const resourceId = "33333333-3333-4333-8333-333333333333";
export const templateId = "44444444-4444-4444-8444-444444444444";
export const snapshotId = "55555555-5555-4555-8555-555555555555";
export function digest(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function insert(
  db: DatabaseSync,
  table: string,
  row: Record<string, SQLInputValue>,
) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
  ).run(...keys.map((k) => row[k]));
}
export function fixture(t: TestContext) {
  const root = fs.mkdtempSync(
    join(fs.realpathSync(tmpdir()), "sticker-archive-fixture-"),
  );
  const sourceRoot = join(root, "source"),
    outputParent = join(root, "output");
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.mkdirSync(outputParent, { mode: 0o700 });
  fs.mkdirSync(join(sourceRoot, "uploads"), { mode: 0o700 });
  const database = join(sourceRoot, "sticker.sqlite");
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=OFF;",
  );
  for (const migration of migrations) migration.run(db);
  db.exec("PRAGMA user_version=10");
  const project = (id: string, key: string, nextIssue: number) => {
    insert(db, "projects", {
      id,
      key,
      name: id,
      description: "",
      color: "#abcdef",
      nextIssue,
      createdAt: stamp,
      updatedAt: stamp,
    });
  };
  project("p", "PR", 3);
  project("q", "QZ", 2);
  insert(db, "versions", {
    id: "v",
    projectId: "p",
    name: "1.0",
    description: "history",
    state: "released",
    dueDate: null,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 2,
  });
  insert(db, "issue_templates", {
    id: templateId,
    projectId: "p",
    name: "Template",
    currentVersion: 2,
    revision: 2,
    deletedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  });
  for (const version of [1, 2])
    insert(db, "template_versions", {
      templateId,
      version,
      body: `# version ${String(version)}`,
      requiredFields: '["problem"]',
      defaults: '{ "status" : "ready" }',
      authorId: "removed-agent",
      authorName: "Historical actor",
      createdAt: stamp,
    });
  for (const [id, projectId, key] of [
    ["i", "p", "PR-1"],
    ["j", "p", "PR-2"],
    ["k", "q", "QZ-1"],
  ])
    insert(db, "issues", {
      id,
      projectId,
      key,
      title: "Original",
      description: contentCanary,
      status: "closed",
      priority: "high",
      assignee: "reused-agent",
      targetVersionId: id === "i" ? "v" : null,
      foundVersionId: null,
      fixedVersionId: null,
      labels: '[ "kept" ]',
      revision: id === "i" ? 3 : 1,
      createdAt: stamp,
      updatedAt: stamp,
      templateId: id === "i" ? templateId : null,
      templateVersion: id === "i" ? 1 : null,
    });
  insert(db, "comments", {
    id: "c",
    issueId: "i",
    body: contentCanary,
    authorId: "reused-agent",
    authorName: "Old name",
    createdAt: stamp,
  });
  for (const [id, before, after, action, unavailableReason, sourceChangeId] of [
    ["h1", 0, 1, "created", "creation", null],
    ["h2", 1, 2, "edited", null, null],
    ["h3", 2, 3, "restored", null, "h2"],
  ] as const) {
    insert(db, "activity", {
      id,
      issueId: "i",
      action,
      detail: "history",
      authorId: "owner",
      authorName: "Historical owner",
      createdAt: stamp,
    });
    insert(db, "issue_changes", {
      id,
      issueId: "i",
      revisionBefore: before,
      revisionAfter: after,
      authorId: "owner",
      authorName: "Historical owner",
      createdAt: stamp,
      action,
      sourceChangeId,
      unavailableReason,
    });
    if (id !== "h1")
      insert(db, "issue_field_changes", {
        changeId: id,
        field: "title",
        beforeJson: JSON.stringify(id === "h2" ? "Original" : "Changed"),
        afterJson: JSON.stringify(id === "h2" ? "Changed" : "Original"),
      });
  }
  const bytes1 = Buffer.from(contentCanary),
    bytes2 = Buffer.from("historical version two");
  fs.writeFileSync(join(sourceRoot, "uploads", fileOne), bytes1, {
    mode: 0o600,
  });
  fs.writeFileSync(join(sourceRoot, "uploads", fileTwo), bytes2, {
    mode: 0o600,
  });
  fs.writeFileSync(
    join(sourceRoot, "uploads", "orphan-secret"),
    excludedCanary,
    { mode: 0o600 },
  );
  fs.writeFileSync(join(sourceRoot, ".env"), excludedCanary, { mode: 0o600 });
  insert(db, "attachments", {
    id: "a",
    issueId: "i",
    kind: "file",
    name: "display-only.txt",
    url: null,
    storageKey: fileOne,
    mimeType: "text/plain",
    size: bytes1.length,
    authorId: "reused-agent",
    authorName: "Old name",
    createdAt: stamp,
  });
  insert(db, "attachments", {
    id: "link",
    issueId: "i",
    kind: "link",
    name: "Reference",
    url: "https://example.invalid/reference",
    storageKey: null,
    mimeType: null,
    size: 0,
    authorId: "owner",
    authorName: "Historical owner",
    createdAt: stamp,
  });
  insert(db, "issue_relations", {
    id: "edge",
    projectId: "p",
    kind: "related",
    sourceIssueId: "i",
    targetIssueId: "j",
    createdBy: "removed-agent",
    createdAt: stamp,
  });
  db.exec("BEGIN; PRAGMA defer_foreign_keys=ON;");
  insert(db, "resources", {
    id: resourceId,
    projectId: "p",
    versionId: "missing-historical-version",
    kind: "markdown",
    title: "Current",
    currentVersion: 3,
    revision: 4,
    isGuidance: 1,
    guidanceBy: "owner",
    guidanceAt: stamp,
    deletedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
  });
  for (const [version, key, bytes] of [
    [1, fileOne, bytes1],
    [2, fileTwo, bytes2],
  ] as const)
    insert(db, "resource_versions", {
      resourceId,
      version,
      kind: "file",
      title: "Old",
      markdown: null,
      url: null,
      fileName: "history.txt",
      storageKey: key,
      mimeType: "text/plain",
      size: bytes.length,
      checksum: digest(bytes),
      authorId: "removed-agent",
      authorName: "Historical actor",
      createdAt: stamp,
    });
  insert(db, "resource_versions", {
    resourceId,
    version: 3,
    kind: "markdown",
    title: "Current",
    markdown: "# Kept",
    url: null,
    fileName: null,
    storageKey: null,
    mimeType: null,
    size: 0,
    checksum: null,
    authorId: "owner",
    authorName: "Historical owner",
    createdAt: stamp,
  });
  insert(db, "issue_resource_links", {
    id: "pin",
    issueId: "i",
    resourceId,
    resourceVersion: 1,
    createdBy: "removed-agent",
    createdAt: stamp,
  });
  insert(db, "resource_events", {
    id: "event",
    resourceId,
    action: "created",
    revision: 1,
    authorId: "owner",
    authorName: "Historical owner",
    createdAt: stamp,
  });
  db.exec("COMMIT");
  const log = {
    versionId: "v",
    markdown: "# Released",
    selectedIssueIds: '["i","deleted-old-issue"]',
    revision: 1,
    authorId: "owner",
    authorName: "Historical owner",
    updatedAt: stamp,
  };
  insert(db, "version_changelogs", log);
  insert(db, "version_changelog_history", { id: "log", ...log });
  insert(db, "version_release_audit", {
    id: "release",
    versionId: "v",
    authorId: "owner",
    authorName: "Historical owner",
    fromState: "planned",
    toState: "released",
    reviewedRevision: 1,
    operationId: snapshotId,
    createdAt: stamp,
  });
  insert(db, "github_evidence", {
    id: "evidence",
    issueId: "i",
    projectId: "p",
    url: "https://github.com/example/repo/pull/1",
    kind: "pr",
    repositoryOwner: "example",
    repositoryName: "repo",
    number: 1,
    revision: 1,
    headSha: "a".repeat(40),
    snapshot: JSON.stringify({
      headSha: "a".repeat(40),
      snapshotSha: "a".repeat(40),
      ci: "unknown",
      snapshotCi: "unknown",
      stale: true,
      complete: false,
      checkCount: 0,
      statusCount: 0,
    }),
    checkedAt: stamp,
    lastAttemptAt: stamp,
    errorCode: null,
    createdBy: "owner",
    createdAt: stamp,
  });
  insert(db, "agent_reports", {
    id: "report",
    agentId: "agent",
    agentName: "Agent",
    projectId: "p",
    issueId: "i",
    state: "working",
    message: excludedCanary,
    reportedAt: stamp,
  });
  insert(db, "agent_sessions", {
    id: "session",
    externalSessionId: excludedCanary,
    agentId: "agent",
    agentName: "Agent",
    projectId: "p",
    issueId: "i",
    startedAt: stamp,
    lastReportedAt: stamp,
    endedAt: null,
    closedAt: null,
    revision: 1,
    legacy: 0,
    closeOperationId: null,
    closeRevision: null,
  });
  insert(db, "session_events", {
    sessionId: "session",
    eventId: "event",
    kind: "request",
    occurredAt: stamp,
    receivedAt: stamp,
    message: excludedCanary,
    payload: excludedCanary,
    fingerprint: excludedCanary,
  });
  insert(db, "session_requests", {
    id: "request",
    sessionId: "session",
    eventId: "event",
    kind: "input",
    prompt: excludedCanary,
    createdAt: stamp,
    revision: 1,
    status: "pending",
    closeOperationId: null,
    closeRevision: null,
  });
  insert(db, "session_responses", {
    id: "response",
    requestId: "request",
    authorId: "owner",
    operationId: "operation",
    body: excludedCanary,
    revision: 1,
    createdAt: stamp,
  });
  insert(db, "session_resource_refs", {
    id: "ref",
    sessionId: "session",
    eventId: "event",
    resourceId,
    resourceVersion: 1,
    recordedBy: excludedCanary,
    createdAt: stamp,
  });
  insert(db, "saved_views", {
    id: "view",
    actorId: "owner",
    projectId: "p",
    name: "view",
    query: excludedCanary,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  });
  insert(db, "view_preferences", {
    actorId: "owner",
    projectId: "p",
    revision: 1,
    defaultViewId: "view",
    favoriteIds: excludedCanary,
  });
  insert(db, "github_connections", {
    projectId: "p",
    repositoryOwner: "example",
    repositoryName: "repo",
    mode: "private",
    credentialRef: excludedCanary,
    connected: 1,
    revision: 1,
    lastVerifiedAt: stamp,
    lastErrorCode: null,
  });
  insert(db, "release_operations", {
    actorId: "owner",
    kind: "release",
    operationId: "op",
    versionId: "v",
    payload: excludedCanary,
    result: excludedCanary,
    createdAt: stamp,
  });
  insert(db, "template_operations", {
    actorId: "owner",
    operationId: "op",
    payload: excludedCanary,
    templateId,
  });
  insert(db, "issue_creation_operations", {
    actorId: "owner",
    operationId: "op",
    payload: excludedCanary,
    issueId: "i",
  });
  insert(db, "resource_operations", {
    actorId: "owner",
    kind: "create",
    operationId: "op",
    projectId: "p",
    payloadHash: excludedCanary,
    result: excludedCanary,
  });
  insert(db, "issue_restore_operations", {
    actorId: "owner",
    operationId: "op",
    issueId: "i",
    payload: excludedCanary,
    changeId: "h3",
  });
  insert(db, "attachment_operations", {
    actorId: "owner",
    kind: "issue_file_create",
    operationId: "op",
    projectId: "p",
    issueId: "i",
    attachmentId: "a",
    payload: excludedCanary,
    payloadHash: excludedCanary,
    result: excludedCanary,
    createdAt: stamp,
  });
  let closed = false;
  const close = () => {
    if (!closed) {
      db.close();
      closed = true;
    }
  };
  t.after(() => {
    close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    sourceRoot,
    outputParent,
    database,
    db,
    close,
    input: () => ({
      sourceRoot,
      outputParent,
      snapshotId,
      datasetId: resourceId,
      generation: templateId,
      capturedAt: stamp,
      availableBytes: 4 * 1024 ** 3,
    }),
  };
}

/** SQL generates history without a whole-content JS array. */
export function addHistory(db: DatabaseSync, count: number): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000)
    throw new Error("fixture count");
  const end = String(count + 1);
  db.exec(`BEGIN; UPDATE issues SET revision=${end} WHERE id='j';
    WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<${end})
    INSERT INTO activity SELECT 'bulk-'||x,'j','edited','history','owner','Historical owner','2026-10-31' FROM n;
    WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<${end})
    INSERT INTO issue_changes SELECT 'bulk-'||x,'j',x-1,x,'owner','Historical owner','2026-10-31','edited',NULL,NULL FROM n;
    WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<${end})
    INSERT INTO issue_field_changes SELECT 'bulk-'||x,'title','"before"','"after"' FROM n; COMMIT;`);
}
