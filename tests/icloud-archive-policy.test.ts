import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVE_TABLES,
  validateArchiveDatabase,
  parseArchiveJson,
  ArchiveError,
} from "../server/icloud/archive-policy.js";
import { fixture, addHistory } from "./fixtures/icloud/archive-fixtures.js";

function code(expected: string) {
  return (error: unknown) =>
    error instanceof ArchiveError && error.code === expected;
}
void test("attachment10 exact policy covers 34 tables and accepts complete historical content", (t) => {
  const f = fixture(t);
  assert.equal(Object.keys(ARCHIVE_TABLES).length, 34);
  assert.equal(Object.values(ARCHIVE_TABLES).filter((v) => v.copy).length, 19);
  assert.doesNotThrow(() => {
    validateArchiveDatabase(f.db);
  });
});
void test("schema9, unknown table/column and changed index fail closed", (t) => {
  for (const sql of [
    "PRAGMA user_version=9",
    "CREATE TABLE private_tokens(token TEXT)",
    "ALTER TABLE agent_sessions ADD COLUMN privateKey TEXT",
    "DROP INDEX issue_one_parent",
    "CREATE TRIGGER private_trigger AFTER INSERT ON projects BEGIN SELECT 1; END",
  ]) {
    const f = fixture(t);
    f.db.exec(sql);
    assert.throws(
      () => {
        validateArchiveDatabase(f.db);
      },
      code(
        sql.includes("user_version")
          ? "ARCHIVE_SCHEMA_UNSUPPORTED"
          : "ARCHIVE_SCHEMA_MISMATCH",
      ),
    );
  }
});
void test("strict JSON rejects duplicate decoded keys, excessive nesting and malformed syntax", () => {
  for (const raw of [
    '{"headSha":"SECRET","headSha":"valid"}',
    '{"headSha":1,"\\u0068eadSha":2}',
    '{"a":{"b":1,"b":2}}',
    "[1,]",
    "[".repeat(33) + "0" + "]".repeat(33),
  ])
    assert.throws(() => parseArchiveJson(raw), code("ARCHIVE_ROW_INVALID"));
  assert.deepEqual(parseArchiveJson(' { "labels" : ["x"] } '), {
    labels: ["x"],
  });
});
void test("unknown or duplicated structured keys never bless hidden original JSON", (t) => {
  for (const sql of [
    `UPDATE github_evidence SET snapshot='{"headSha":"a","accessToken":"PRIVATE-CANARY"}'`,
    `UPDATE template_versions SET defaults='{"status":"ready","secret":"PRIVATE-CANARY"}'`,
    `UPDATE template_versions SET defaults='{"status":"PRIVATE-CANARY","status":"ready"}'`,
    `UPDATE issues SET labels='{"private":"CANARY"}'`,
    `UPDATE issue_field_changes SET beforeJson='{"role":"owner"}'`,
  ]) {
    const f = fixture(t);
    f.db.exec(sql);
    assert.throws(() => {
      validateArchiveDatabase(f.db);
    }, code("ARCHIVE_ROW_INVALID"));
  }
});
void test("oversized TEXT and BLOB are rejected before row materialization", (t) => {
  for (const expression of [
    "CAST(zeroblob(1048577) AS TEXT)",
    "zeroblob(100)",
  ]) {
    const f = fixture(t);
    f.db.exec(`UPDATE issues SET description=${expression}`);
    assert.throws(() => {
      validateArchiveDatabase(f.db);
    }, code("ARCHIVE_ROW_INVALID"));
  }
});
void test("cross-project references, history metadata and cyclic graph are rejected", (t) => {
  for (const sql of [
    "UPDATE issue_resource_links SET issueId='k'",
    "UPDATE issue_changes SET authorId='forged' WHERE id='h2'",
    "UPDATE issue_changes SET sourceChangeId='h3' WHERE id='h3'",
    "UPDATE issue_relations SET kind='blocks'; INSERT INTO issue_relations VALUES('reverse','p','blocks','j','i','owner','now')",
  ]) {
    const f = fixture(t);
    f.db.exec(sql);
    assert.throws(() => {
      validateArchiveDatabase(f.db);
    }, code("ARCHIVE_REFERENCE_INVALID"));
  }
});
void test("many small history rows validate using bounded indexed lookup", (t) => {
  const f = fixture(t);
  addHistory(f.db, 8000);
  assert.doesNotThrow(() => {
    validateArchiveDatabase(f.db);
  });
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM issue_changes").get()?.n,
    8003,
  );
});

void test("foreign-key orphans and oversized structural graphs fail closed", (t) => {
  const f = fixture(t);
  f.db.exec("PRAGMA foreign_keys=OFF; UPDATE comments SET issueId='missing'");
  assert.throws(() => {
    validateArchiveDatabase(f.db);
  }, code("ARCHIVE_REFERENCE_INVALID"));
  const g = fixture(t);
  g.db.exec(`BEGIN; UPDATE projects SET nextIssue=10004 WHERE id='p';
    WITH RECURSIVE n(x) AS (VALUES(3) UNION ALL SELECT x+1 FROM n WHERE x<10003)
    INSERT INTO issues (id,projectId,key,title,description,status,priority,assignee,labels,revision,createdAt,updatedAt)
    SELECT 'node-'||x,'p','PR-'||x,'Node','','ready','none','','[]',1,'now','now' FROM n;
    WITH RECURSIVE n(x) AS (VALUES(3) UNION ALL SELECT x+1 FROM n WHERE x<10003)
    INSERT INTO issue_relations SELECT 'edge-'||x,'p','blocks','i','node-'||x,'owner','now' FROM n; COMMIT;`);
  assert.throws(() => {
    validateArchiveDatabase(g.db);
  }, code("BACKUP_TOO_LARGE"));
});

void test("stored guidance flags and historical event/evidence revisions must be valid content", (t) => {
  for (const sql of [
    "UPDATE resources SET isGuidance=2",
    "UPDATE resource_events SET revision=-1",
    "UPDATE resource_events SET action='grant_owner'",
    "UPDATE github_evidence SET revision=-1",
  ]) {
    const f = fixture(t);
    f.db.exec(sql);
    assert.throws(() => {
      validateArchiveDatabase(f.db);
    }, code("ARCHIVE_ROW_INVALID"));
  }
});
