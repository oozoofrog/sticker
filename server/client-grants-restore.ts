import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateBackup } from "./backup-validation.js";
/** Fixed operator restore-stage action only. Never called by startup or ordinary backup validation. */
export function invalidateRestoredClientGrants(stageDir: string) {
  const before = validateBackup(stageDir);
  if (before.schemaVersion < 11)
    return { schemaVersion: before.schemaVersion, invalidated: 0 };
  const db = new DatabaseSync(join(stageDir, "sticker.sqlite"));
  let invalidated: number;
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE",
    );
    try {
      const stamp = new Date().toISOString();
      const rows = db
        .prepare(
          "SELECT grantId FROM managed_client_grants WHERE state<>'revoked'",
        )
        .all();
      for (const row of rows) {
        if (typeof row.grantId !== "string")
          throw new Error("Invalid restore grant identity");
        db.prepare(
          "UPDATE managed_client_grants SET state='revoked',revision=revision+1,updatedAt=?,reason='restore' WHERE grantId=?",
        ).run(stamp, row.grantId);
        db.prepare(
          "INSERT INTO client_grant_audit SELECT ?,grantId,'restore','restore',revision,? FROM managed_client_grants WHERE grantId=?",
        ).run(randomUUID(), stamp, row.grantId);
      }
      invalidated = rows.length;
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  validateBackup(stageDir);
  return { schemaVersion: before.schemaVersion, invalidated };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3) throw new Error();
    const result = invalidateRestoredClientGrants(process.argv[2]);
    process.stdout.write(
      `Restore managed authority invalidated: ${String(result.invalidated)}.\n`,
    );
  } catch {
    process.stderr.write(
      "Restore managed-authority invalidation failed; replacement must remain stopped.\n",
    );
    process.exitCode = 1;
  }
}
