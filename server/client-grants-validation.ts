import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  grantRowSchema,
  grantOperationRowSchema,
  grantReceiptSchema,
} from "./contracts/client-grants.js";
import { canonicalJson } from "./canonical-json.js";
/** Query-only and bounded per-row; verifier-bearing validation errors never escape. */
export function validateManagedGrants(db: DatabaseSync) {
  try {
    for (const raw of db
      .prepare("SELECT * FROM managed_client_grants")
      .iterate()) {
      const r = grantRowSchema.parse(raw),
        created = Date.parse(r.createdAt),
        until = Date.parse(r.provisionalUntil);
      if (
        r.agentId !== `client-${r.grantId}` ||
        r.provisionalUntil !== r.planExpiresAt ||
        until <= created ||
        until - created > 300_000 ||
        Date.parse(r.updatedAt) < created ||
        (r.state === "provisional" &&
          (r.revision !== 1 || r.reason !== "provision")) ||
        (r.state === "active" &&
          (r.revision !== 2 || r.reason !== "activate")) ||
        (r.state === "revoked" &&
          (r.revision < 2 ||
            !["revoke", "project_deleted", "restore"].includes(r.reason))) ||
        (r.state !== "revoked" &&
          !db.prepare("SELECT id FROM projects WHERE id=?").get(r.projectId))
      )
        throw new Error();
    }
    for (const raw of db
      .prepare("SELECT * FROM client_grant_operations")
      .iterate()) {
      const r = grantOperationRowSchema.parse(raw),
        receipt = grantReceiptSchema.parse(JSON.parse(r.receipt) as unknown),
        grant = grantRowSchema.parse(
          db
            .prepare("SELECT * FROM managed_client_grants WHERE grantId=?")
            .get(r.grantId),
        );
      if (
        r.receipt !== canonicalJson(receipt) ||
        receipt.grantId !== r.grantId ||
        receipt.phase !== r.phase ||
        receipt.recordedAt !== r.createdAt ||
        receipt.revision > grant.revision ||
        receipt.state !==
          (
            {
              provision: "provisional",
              activate: "active",
              revoke: "revoked",
            } as const
          )[r.phase] ||
        (r.phase !== "revoke" && r.operationId !== grant.provisionOperationId)
      )
        throw new Error();
      if (
        db
          .prepare(
            "SELECT 1 AS n FROM client_grant_operations WHERE ownerId=? AND operationId=? AND grantId<>? LIMIT 1",
          )
          .get(r.ownerId, r.operationId, r.grantId)
      )
        throw new Error();
    }
    for (const raw of db
      .prepare("SELECT * FROM client_grant_audit")
      .iterate()) {
      const r = z
        .object({
          id: z.uuid(),
          grantId: z.uuid(),
          authorId: z.enum(["owner", "restore"]),
          action: z.enum([
            "provision",
            "activate",
            "revoke",
            "project_deleted",
            "restore",
          ]),
          revision: z.number().int().positive(),
          createdAt: z.iso.datetime({ precision: 3 }),
        })
        .strict()
        .parse(raw);
      const grant = grantRowSchema.parse(
        db
          .prepare("SELECT * FROM managed_client_grants WHERE grantId=?")
          .get(r.grantId),
      );
      if (
        r.revision > grant.revision ||
        (r.action === "restore") !== (r.authorId === "restore")
      )
        throw new Error();
    }
    const duplicates = db
      .prepare(
        "SELECT COUNT(*) n FROM (SELECT agentId FROM managed_client_grants GROUP BY agentId HAVING COUNT(*)>1 UNION ALL SELECT tokenHash FROM managed_client_grants GROUP BY tokenHash HAVING COUNT(*)>1)",
      )
      .get();
    if (Number(duplicates?.n) !== 0) throw new Error();
  } catch {
    throw new Error("Invalid managed client grant backup metadata.");
  }
}
