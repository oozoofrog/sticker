import type { DatabaseSync } from "node:sqlite";
export function attachmentOperations(db: DatabaseSync) {
  db.exec(`CREATE TABLE attachment_operations (
 actorId TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind='issue_file_create'),
 operationId TEXT NOT NULL,
 projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 issueId TEXT NOT NULL,
 attachmentId TEXT REFERENCES attachments(id) ON DELETE SET NULL,
 payload TEXT NOT NULL,
 payloadHash TEXT NOT NULL,
 result TEXT NOT NULL,
 createdAt TEXT NOT NULL,
 PRIMARY KEY(actorId,kind,operationId));
 CREATE INDEX attachment_operations_project ON attachment_operations(projectId,actorId);`);
}
