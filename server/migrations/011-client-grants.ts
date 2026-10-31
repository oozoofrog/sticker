import type { DatabaseSync } from "node:sqlite";
/** Historical project identity is retained without blocking legitimate project deletion. */
export function clientGrants(db: DatabaseSync) {
  db.exec(`CREATE TABLE managed_client_grants (
    grantId TEXT PRIMARY KEY, agentId TEXT NOT NULL UNIQUE, installationId TEXT NOT NULL, connectionId TEXT NOT NULL, clientId TEXT NOT NULL CHECK(clientId='codex-local'), approvalDigest TEXT NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE, projectId TEXT NOT NULL, requestedCanWrite INTEGER NOT NULL CHECK(requestedCanWrite IN (0,1)), ownerId TEXT NOT NULL CHECK(ownerId='owner'), planExpiresAt TEXT NOT NULL,
    provisionOperationId TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL CHECK(revision>0), provisionalUntil TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('provisional','active','revoked')), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('provision','activate','revoke','project_deleted','restore')));
    CREATE TABLE client_grant_operations (ownerId TEXT NOT NULL, operationId TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('provision','activate','revoke')), grantId TEXT NOT NULL REFERENCES managed_client_grants(grantId), fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY(ownerId,operationId,phase));
    CREATE TABLE client_grant_audit (id TEXT PRIMARY KEY, grantId TEXT NOT NULL REFERENCES managed_client_grants(grantId), authorId TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('provision','activate','revoke','project_deleted','restore')), revision INTEGER NOT NULL, createdAt TEXT NOT NULL);
    CREATE INDEX managed_grant_project ON managed_client_grants(projectId);
  `);
}
