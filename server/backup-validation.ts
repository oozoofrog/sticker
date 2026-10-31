import { validateManagedGrants } from "./client-grants-validation.js";
import { validateAttachmentOperations } from "./attachment-operations.js";
import { validateHistory } from "./history-validation.js";
import { validateResourceVersionFiles } from "./resource-files.js";
import {
  issueTemplateSchema,
  templateVersionSchema,
} from "./contracts/templates.js";
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  schemaManifests,
  isSchemaVersion,
  type SchemaVersion,
} from "./schema-manifest.js";

function requireRegularFile(path: string, label: string) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label}: required file is missing.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label}: must be a regular file, not a link.`);
  return stat;
}

/** Validate extracted bytes before restore replaces anything. This function only opens SQLite read-only. */
export function validateBackup(stageDir: string): {
  schemaVersion: SchemaVersion;
  fileCount: number;
} {
  const root = resolve(stageDir),
    path = join(root, "sticker.sqlite");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Backup stage must be a real directory, not a link.");
  const file = requireRegularFile(path, "Sticker database");
  if (file.size === 0)
    throw new Error(
      "Sticker database is empty (zero-byte), not a valid backup.",
    );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // Do not trust user_version alone: unrelated SQLite databases may also use 1.
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (!isSchemaVersion(version))
      throw new Error(
        `Unsupported Sticker schema version: ${String(version)}. Expected ${Object.keys(schemaManifests).join(", ")}.`,
      );
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((row) => String(row.name)),
    );
    for (const [table, columns] of Object.entries(schemaManifests[version])) {
      if (!tables.has(table))
        throw new Error(
          `Invalid Sticker schema: required table ${table} is missing.`,
        );
      // Table identifiers come only from the fixed schema manifest above, never from the archive.
      const present = new Set(
        db
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((row) => String(row.name)),
      );
      for (const column of columns)
        if (!present.has(column))
          throw new Error(
            `Invalid Sticker schema: required column ${table}.${column} is missing.`,
          );
    }
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      throw new Error("Sticker database integrity_check failed.");
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error("Sticker database foreign_key_check failed.");
    if (version >= 6) {
      try {
        const templates = issueTemplateSchema
          .array()
          .parse(db.prepare("SELECT * FROM issue_templates").all());
        const versions = db
          .prepare("SELECT * FROM template_versions")
          .all()
          .map((row) => {
            const requiredFields: unknown = JSON.parse(
                z.string().parse(row.requiredFields),
              ),
              defaults: unknown = JSON.parse(z.string().parse(row.defaults));
            return templateVersionSchema.parse({
              ...row,
              requiredFields,
              defaults,
            });
          });
        for (const template of templates)
          if (
            !versions.some(
              (item) =>
                item.templateId === template.id &&
                item.version === template.currentVersion,
            )
          )
            throw new Error("Invalid current version");
        for (const table of [
          "template_operations",
          "issue_creation_operations",
        ] as const)
          for (const row of db.prepare(`SELECT payload FROM ${table}`).all()) {
            const payload: unknown = JSON.parse(z.string().parse(row.payload));
            z.record(z.string(), z.unknown()).parse(payload);
          }
      } catch {
        throw new Error("Invalid template version data in backup.");
      }
      if (
        db
          .prepare(
            "SELECT i.id FROM issues i LEFT JOIN issue_templates t ON t.id=i.templateId LEFT JOIN template_versions v ON v.templateId=i.templateId AND v.version=i.templateVersion WHERE i.templateId IS NOT NULL AND (v.version IS NULL OR t.projectId<>i.projectId) LIMIT 1",
          )
          .get()
      )
        throw new Error("Invalid template provenance in backup.");
    }
    if (version >= 9) validateHistory(db);
    const attachments = db
      .prepare("SELECT storageKey,size FROM attachments WHERE kind='file'")
      .all();
    if (attachments.length) {
      let directory;
      try {
        directory = lstatSync(join(root, "uploads"));
      } catch {
        throw new Error("Attachment uploads directory is missing.");
      }
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error(
          "Attachment uploads must be a real directory, not a link.",
        );
    } else {
      // Even empty workspaces must not carry a link in place of their uploads directory.
      try {
        const uploads = lstatSync(join(root, "uploads"));
        if (!uploads.isDirectory() || uploads.isSymbolicLink())
          throw new Error(
            "Attachment uploads must be a real directory, not a link.",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const row of attachments) {
      if (
        typeof row.storageKey !== "string" ||
        !z.uuid().safeParse(row.storageKey).success
      )
        throw new Error("Attachment storageKey is not a valid UUID.");
      const size = Number(row.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > 20 * 1024 * 1024)
        throw new Error("Attachment recorded size is invalid.");
      const attachment = requireRegularFile(
        join(root, "uploads", row.storageKey),
        "Attachment",
      );
      if (attachment.size !== size)
        throw new Error(`Attachment size mismatch for ${row.storageKey}.`);
    }
    if (version >= 10) validateAttachmentOperations(root, db);
    if (version >= 11) validateManagedGrants(db);
    const resourceFileCount =
      version >= 7 ? validateResourceVersionFiles(root, db) : 0;
    return {
      schemaVersion: version,
      fileCount: attachments.length + resourceFileCount,
    };
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3)
      throw new Error(
        "Usage: node dist/server/backup-validation.js <stageDir>",
      );
    const result = validateBackup(process.argv[2]);
    process.stdout.write(
      `Validated Sticker schema ${String(result.schemaVersion)}, ${String(result.fileCount)} file attachments.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Backup validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
