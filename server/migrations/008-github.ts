import type { DatabaseSync } from "node:sqlite";
/** Registered only after the preceding migrations are integrated. */
export function github(db: DatabaseSync) {
  db.exec(`
 CREATE TABLE github_connections(projectId TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,repositoryOwner TEXT NOT NULL,repositoryName TEXT NOT NULL,mode TEXT NOT NULL,credentialRef TEXT,connected INTEGER NOT NULL,revision INTEGER NOT NULL,lastVerifiedAt TEXT,lastErrorCode TEXT);
 CREATE TABLE github_evidence(id TEXT PRIMARY KEY,issueId TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,url TEXT NOT NULL,kind TEXT NOT NULL,repositoryOwner TEXT NOT NULL,repositoryName TEXT NOT NULL,number INTEGER,revision INTEGER NOT NULL,headSha TEXT,snapshot TEXT,checkedAt TEXT,lastAttemptAt TEXT,errorCode TEXT,createdBy TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(issueId,url));
 CREATE INDEX github_evidence_issue ON github_evidence(issueId);
`);
}
