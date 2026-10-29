import type { DatabaseSync } from "node:sqlite";

export function history(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE issue_changes (
      id TEXT PRIMARY KEY REFERENCES activity(id) ON DELETE CASCADE,
      issueId TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      revisionBefore INTEGER NOT NULL CHECK(revisionBefore >= 0),
      revisionAfter INTEGER NOT NULL CHECK(revisionAfter = revisionBefore + 1),
      authorId TEXT NOT NULL, authorName TEXT NOT NULL, createdAt TEXT NOT NULL,
      action TEXT NOT NULL,
      sourceChangeId TEXT REFERENCES issue_changes(id) ON DELETE SET NULL,
      unavailableReason TEXT CHECK(unavailableReason IN ('creation','revision_only','unchanged')),
      UNIQUE(issueId, revisionAfter)
    );
    CREATE INDEX issue_changes_issue ON issue_changes(issueId, revisionAfter DESC);
    CREATE TABLE issue_field_changes (
      changeId TEXT NOT NULL REFERENCES issue_changes(id) ON DELETE CASCADE,
      field TEXT NOT NULL CHECK(field IN ('title','description','status','priority','assignee','labels','targetVersionId','foundVersionId','fixedVersionId')),
      beforeJson TEXT NOT NULL, afterJson TEXT NOT NULL,
      PRIMARY KEY(changeId, field)
    );
    CREATE TABLE issue_restore_operations (
      actorId TEXT NOT NULL, operationId TEXT NOT NULL,
      issueId TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      changeId TEXT NOT NULL REFERENCES issue_changes(id) ON DELETE CASCADE,
      PRIMARY KEY(actorId, operationId)
    );
  `);
}
