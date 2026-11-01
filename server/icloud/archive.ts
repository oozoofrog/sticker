import fs from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ARCHIVE_LIMITS,
  ARCHIVE_PROFILE,
  ARCHIVE_SCHEMA_HASH,
  ARCHIVE_TABLES,
  ArchiveError,
  archiveFail,
  archiveRows,
  initializeArchiveSchema,
  validateArchiveDatabase,
  type ArchiveErrorCode,
  type ArchiveTable,
} from "./archive-policy.js";

const inputSchema = z
  .object({
    sourceRoot: z.string().min(1).max(4096),
    outputParent: z.string().min(1).max(4096),
    snapshotId: z.uuid(),
    datasetId: z.uuid(),
    generation: z.uuid(),
    capturedAt: z.iso.datetime({ precision: 3 }).max(24),
    availableBytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  })
  .strict();
export type FixtureExportInput = z.infer<typeof inputSchema>;
type Owned = { path: string; dev: number; ino: number; directory: boolean };
type FileRef = { storageKey: string; size: number; checksum: string | null };
type FileEntry = { storageKey: string; size: number; sha256: string };
export interface FixtureArchiveManifest {
  formatVersion: 1;
  profile: typeof ARCHIVE_PROFILE;
  schemaVersion: 10;
  schemaHash: string;
  scope: "synthetic-fixture-only";
  attribution: "untrusted-historical-content";
  activation: "unsupported";
  snapshotId: string;
  datasetId: string;
  generation: string;
  capturedAt: string;
  database: { size: number; sha256: string };
  rows: Record<string, { count: number; sha256: string }>;
  excludedTables: string[];
  files: FileEntry[];
}
export type FixtureExportResult =
  | { ok: true; outputRoot: string; manifest: FixtureArchiveManifest }
  | { ok: false; error: { code: ArchiveErrorCode } };

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function absent(path: string): boolean {
  try {
    fs.lstatSync(path);
    return false;
  } catch (error) {
    if (missing(error)) return true;
    throw error;
  }
}
function same(record: Owned): boolean {
  try {
    const s = fs.lstatSync(record.path);
    return (
      s.dev === record.dev &&
      s.ino === record.ino &&
      !s.isSymbolicLink() &&
      (record.directory ? s.isDirectory() : s.isFile() && s.nlink === 1)
    );
  } catch {
    return false;
  }
}
function identity(path: string, directory: boolean): Owned {
  const s = fs.lstatSync(path);
  if (
    s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
  )
    archiveFail("ARCHIVE_TARGET_UNSAFE");
  return { path, dev: s.dev, ino: s.ino, directory };
}
function directories(path: string, code: ArchiveErrorCode): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0"))
    archiveFail(code);
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      archiveFail(code);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) archiveFail(code);
  }
}
function contains(a: string, b: string): boolean {
  return a === b || b.startsWith(a + sep);
}
function guard(
  record: Owned,
  code: ArchiveErrorCode = "ARCHIVE_TARGET_UNSAFE",
): void {
  if (!same(record)) archiveFail(code);
}
function fileStat(path: string): fs.Stats {
  let s;
  try {
    s = fs.lstatSync(path);
  } catch (error) {
    if (missing(error)) archiveFail("ARCHIVE_FILE_MISSING");
    throw error;
  }
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
    archiveFail("ARCHIVE_FILE_UNSAFE");
  return s;
}
function createFile(path: string, owned: Owned[]): number {
  const fd = fs.openSync(
    path,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = fs.fstatSync(fd);
    const record: Owned = {
      path,
      dev: opened.dev,
      ino: opened.ino,
      directory: false,
    };
    owned.push(record);
    fs.fchmodSync(fd, 0o600);
    guard(record);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const n = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (n <= 0) archiveFail("ARCHIVE_IO");
    offset += n;
  }
}
function scanFile(
  path: string,
  expectedSize: number,
  writeFd?: number,
): string {
  const before = fileStat(path);
  if (before.size !== expectedSize) archiveFail("ARCHIVE_FILE_SIZE_MISMATCH");
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !opened.isFile() ||
      opened.nlink !== 1
    )
      archiveFail("ARCHIVE_FILE_UNSAFE");
    const buffer = Buffer.alloc(ARCHIVE_LIMITS.bufferBytes),
      hash = createHash("sha256");
    let offset = 0;
    while (offset < expectedSize) {
      const n = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, expectedSize - offset),
        offset,
      );
      if (n <= 0) archiveFail("ARCHIVE_FILE_SIZE_MISMATCH");
      hash.update(buffer.subarray(0, n));
      if (writeFd !== undefined) writeAll(writeFd, buffer.subarray(0, n));
      offset += n;
    }
    const after = fs.fstatSync(fd),
      current = fileStat(path);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs
    )
      archiveFail("ARCHIVE_SOURCE_CHANGED");
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}
function assertClosedSource(root: string): {
  path: string;
  size: number;
  sha256: string;
  owned: Owned;
} {
  directories(root, "ARCHIVE_SOURCE_NOT_QUIESCENT");
  const path = join(root, "sticker.sqlite");
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (!absent(path + suffix)) archiveFail("ARCHIVE_SOURCE_NOT_QUIESCENT");
  const s = fileStat(path);
  if (s.size > ARCHIVE_LIMITS.totalBytes) archiveFail("BACKUP_TOO_LARGE");
  const fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    ),
    header = Buffer.alloc(100);
  try {
    if (
      fs.readSync(fd, header, 0, 100, 0) !== 100 ||
      header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      archiveFail("ARCHIVE_SOURCE_NOT_QUIESCENT");
  } finally {
    fs.closeSync(fd);
  }
  return {
    path,
    size: s.size,
    sha256: scanFile(path, s.size),
    owned: identity(path, false),
  };
}
function references(db: DatabaseSync, baseBytes: number): Map<string, FileRef> {
  const refs = new Map<string, FileRef>();
  let manifestBytes = baseBytes;
  for (const row of db
    .prepare(
      "SELECT storageKey,size,NULL AS checksum FROM attachments WHERE kind='file' UNION ALL SELECT storageKey,size,checksum FROM resource_versions WHERE kind='file'",
    )
    .iterate()) {
    const parsed = z
      .object({
        storageKey: z.uuid(),
        size: z.number().int().nonnegative().max(ARCHIVE_LIMITS.fileBytes),
        checksum: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .safeParse(row);
    if (!parsed.success) archiveFail("ARCHIVE_ROW_INVALID");
    const next = parsed.data,
      previous = refs.get(next.storageKey);
    if (previous) {
      if (
        previous.size !== next.size ||
        (previous.checksum !== null &&
          next.checksum !== null &&
          previous.checksum !== next.checksum)
      )
        archiveFail("ARCHIVE_REFERENCE_INVALID");
      previous.checksum ??= next.checksum;
      continue;
    }
    manifestBytes +=
      Buffer.byteLength(
        JSON.stringify({
          storageKey: next.storageKey,
          size: next.size,
          sha256: "0".repeat(64),
        }),
      ) + (refs.size ? 1 : 0);
    if (
      refs.size >= ARCHIVE_LIMITS.fileCount ||
      manifestBytes > ARCHIVE_LIMITS.manifestBytes
    )
      archiveFail("BACKUP_TOO_LARGE");
    refs.set(next.storageKey, next);
  }
  return refs;
}
function countDigest(
  db: DatabaseSync,
  table: ArchiveTable,
): { count: number; sha256: string } {
  let count = 0;
  const hash = createHash("sha256");
  for (const row of archiveRows(db, table)) {
    hash.update(
      JSON.stringify(ARCHIVE_TABLES[table].columns.map((c) => row[c])),
    );
    hash.update("\n");
    count++;
  }
  return { count, sha256: hash.digest("hex") };
}
function exactDirectory(path: string, names: Set<string>): void {
  const directory = fs.opendirSync(path);
  let count = 0;
  try {
    for (
      let entry = directory.readSync();
      entry !== null;
      entry = directory.readSync()
    ) {
      if (!names.has(entry.name)) archiveFail("ARCHIVE_VALIDATION_FAILED");
      count++;
    }
  } finally {
    directory.closeSync();
  }
  if (count !== names.size) archiveFail("ARCHIVE_VALIDATION_FAILED");
}
function cleanup(owned: Owned[]): void {
  const root = owned[0];
  if (owned.length === 0 || !same(root)) return;
  for (const object of [...owned].reverse()) {
    if (!same(root)) return;
    const parent = owned.find(
      (p) => p.directory && p.path === dirname(object.path),
    );
    if ((parent && !same(parent)) || !same(object)) continue;
    try {
      if (object.directory) fs.rmdirSync(object.path);
      else fs.unlinkSync(object.path);
    } catch {
      /* Preserve foreign/replaced objects and incomplete evidence rather than traverse them. */
    }
  }
}
function safeCode(error: unknown): ArchiveErrorCode {
  if (error instanceof ArchiveError) return error.code;
  if (error instanceof Error && "code" in error && error.code === "ENOSPC")
    return "INSUFFICIENT_LOCAL_SPACE";
  return "ARCHIVE_IO";
}

/** Only exclusively owned, closed synthetic fixture roots are supported. No mount/restore or authority activation. */
export function exportClosedFixtureArchive(
  input: FixtureExportInput,
): FixtureExportResult {
  const owned: Owned[] = [];
  let source: DatabaseSync | undefined, target: DatabaseSync | undefined;
  try {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) archiveFail("ARCHIVE_TARGET_UNSAFE");
    const context = parsed.data;
    if (context.availableBytes === null)
      archiveFail("ARCHIVE_CAPACITY_UNKNOWN");
    if (
      contains(context.sourceRoot, context.outputParent) ||
      contains(context.outputParent, context.sourceRoot)
    )
      archiveFail("ARCHIVE_TARGET_UNSAFE");
    directories(context.outputParent, "ARCHIVE_TARGET_UNSAFE");
    const parent = identity(context.outputParent, true);
    if ((fs.lstatSync(context.outputParent).mode & 0o777) !== 0o700)
      archiveFail("ARCHIVE_TARGET_UNSAFE");
    const outputRoot = join(
      context.outputParent,
      `fixture-archive-${context.snapshotId}`,
    );
    if (!absent(outputRoot)) archiveFail("ARCHIVE_TARGET_UNSAFE");
    const original = assertClosedSource(context.sourceRoot),
      sourceRootIdentity = identity(context.sourceRoot, true);
    if (
      context.availableBytes <
      2 * original.size + ARCHIVE_LIMITS.reserveBytes
    )
      archiveFail("INSUFFICIENT_LOCAL_SPACE");
    const sourceUploads = join(context.sourceRoot, "uploads");
    let sourceUploadIdentity: Owned | undefined;
    if (!absent(sourceUploads)) {
      directories(sourceUploads, "ARCHIVE_FILE_UNSAFE");
      sourceUploadIdentity = identity(sourceUploads, true);
    }
    source = new DatabaseSync(original.path, { readOnly: true });
    source.exec("BEGIN");
    validateArchiveDatabase(source);
    // Bound inventory even before output creation, using a conservative metadata reserve.
    const earlyRefs = references(source, 4096);
    let estimate = original.size + ARCHIVE_LIMITS.manifestBytes;
    for (const file of earlyRefs.values()) estimate += file.size;
    if (context.availableBytes < 2 * estimate + ARCHIVE_LIMITS.reserveBytes)
      archiveFail("INSUFFICIENT_LOCAL_SPACE");
    if (earlyRefs.size && !sourceUploadIdentity)
      archiveFail("ARCHIVE_FILE_MISSING");
    guard(parent);
    fs.mkdirSync(outputRoot, { mode: 0o700 });
    owned.push(identity(outputRoot, true));
    fs.chmodSync(outputRoot, 0o700);
    const uploads = join(outputRoot, "uploads");
    fs.mkdirSync(uploads, { mode: 0o700 });
    owned.push(identity(uploads, true));
    fs.chmodSync(uploads, 0o700);
    const database = join(outputRoot, "sticker.sqlite"),
      dbfd = createFile(database, owned);
    fs.closeSync(dbfd);
    target = new DatabaseSync(database);
    target.exec(
      "PRAGMA journal_mode=MEMORY; PRAGMA foreign_keys=ON; PRAGMA cache_size=-2048; PRAGMA max_page_count=262144;",
    );
    initializeArchiveSchema(target);
    target.exec("BEGIN; PRAGMA defer_foreign_keys=ON");
    const rows: FixtureArchiveManifest["rows"] = {};
    for (const table of Object.keys(ARCHIVE_TABLES) as ArchiveTable[]) {
      const policy = ARCHIVE_TABLES[table];
      if (!policy.copy) continue;
      const keys = policy.columns;
      const insert = target.prepare(
        `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
      );
      let count = 0;
      const hash = createHash("sha256");
      for (const row of archiveRows(source, table)) {
        const values = keys.map((k) => row[k]);
        insert.run(...values);
        hash.update(JSON.stringify(values));
        hash.update("\n");
        count++;
      }
      rows[table] = { count, sha256: hash.digest("hex") };
    }
    target.exec("COMMIT");
    target.close();
    target = undefined;
    for (const object of owned) guard(object);
    const dbSize = fileStat(database).size,
      dbHash = scanFile(database, dbSize);
    const manifest: FixtureArchiveManifest = {
      formatVersion: 1,
      profile: ARCHIVE_PROFILE,
      schemaVersion: 10,
      schemaHash: ARCHIVE_SCHEMA_HASH,
      scope: "synthetic-fixture-only",
      attribution: "untrusted-historical-content",
      activation: "unsupported",
      snapshotId: context.snapshotId,
      datasetId: context.datasetId,
      generation: context.generation,
      capturedAt: context.capturedAt,
      database: { size: dbSize, sha256: dbHash },
      rows,
      excludedTables: (Object.keys(ARCHIVE_TABLES) as ArchiveTable[]).filter(
        (t) => !ARCHIVE_TABLES[t].copy,
      ),
      files: [],
    };
    const refs = references(
      source,
      Buffer.byteLength(JSON.stringify(manifest)),
    );
    let totalBytes = dbSize;
    for (const ref of refs.values()) totalBytes += ref.size;
    if (totalBytes > ARCHIVE_LIMITS.totalBytes) archiveFail("BACKUP_TOO_LARGE");
    for (const ref of [...refs.values()].sort((a, b) =>
      a.storageKey.localeCompare(b.storageKey),
    )) {
      guard(sourceRootIdentity, "ARCHIVE_SOURCE_CHANGED");
      if (sourceUploadIdentity)
        guard(sourceUploadIdentity, "ARCHIVE_SOURCE_CHANGED");
      guard(owned[0]);
      guard(owned[1]);
      const fd = createFile(join(uploads, ref.storageKey), owned);
      let sha256;
      try {
        sha256 = scanFile(join(sourceUploads, ref.storageKey), ref.size, fd);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (ref.checksum !== null && sha256 !== ref.checksum)
        archiveFail("ARCHIVE_FILE_HASH_MISMATCH");
      manifest.files.push({
        storageKey: ref.storageKey,
        size: ref.size,
        sha256,
      });
    }
    source.close();
    source = undefined;
    guard(sourceRootIdentity, "ARCHIVE_SOURCE_CHANGED");
    guard(original.owned, "ARCHIVE_SOURCE_CHANGED");
    const finalSource = assertClosedSource(context.sourceRoot);
    if (
      finalSource.size !== original.size ||
      finalSource.sha256 !== original.sha256
    )
      archiveFail("ARCHIVE_SOURCE_CHANGED");
    // Independent read-only output pass: bounded row validation, counts/digests and streamed files.
    const verify = new DatabaseSync(database, { readOnly: true });
    try {
      verify.exec("BEGIN");
      validateArchiveDatabase(verify, true);
      for (const table of Object.keys(rows) as ArchiveTable[]) {
        const actual = countDigest(verify, table),
          expected = rows[table];
        if (
          actual.count !== expected.count ||
          actual.sha256 !== expected.sha256
        )
          archiveFail("ARCHIVE_VALIDATION_FAILED");
      }
      const outputRefs = references(
        verify,
        Buffer.byteLength(JSON.stringify({ ...manifest, files: [] })),
      );
      if (outputRefs.size !== manifest.files.length)
        archiveFail("ARCHIVE_VALIDATION_FAILED");
      for (const file of manifest.files) {
        const ref = outputRefs.get(file.storageKey);
        if (
          !ref ||
          ref.size !== file.size ||
          (ref.checksum !== null && ref.checksum !== file.sha256) ||
          scanFile(join(uploads, file.storageKey), file.size) !== file.sha256
        )
          archiveFail("ARCHIVE_VALIDATION_FAILED");
      }
    } finally {
      verify.close();
    }
    for (const object of owned) guard(object);
    exactDirectory(uploads, new Set(manifest.files.map((f) => f.storageKey)));
    exactDirectory(outputRoot, new Set(["sticker.sqlite", "uploads"]));
    if (scanFile(database, dbSize) !== dbHash)
      archiveFail("ARCHIVE_VALIDATION_FAILED");
    const serialized = Buffer.from(JSON.stringify(manifest));
    if (
      serialized.length > ARCHIVE_LIMITS.manifestBytes ||
      totalBytes + serialized.length > ARCHIVE_LIMITS.totalBytes
    )
      archiveFail("BACKUP_TOO_LARGE");
    if (
      context.availableBytes <
      2 * (totalBytes + serialized.length) + ARCHIVE_LIMITS.reserveBytes
    )
      archiveFail("INSUFFICIENT_LOCAL_SPACE");
    const syncdb = fs.openSync(
      database,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(syncdb);
    } finally {
      fs.closeSync(syncdb);
    }
    const manifestFd = createFile(join(outputRoot, "manifest.json"), owned);
    try {
      writeAll(manifestFd, serialized);
      fs.fsyncSync(manifestFd);
    } finally {
      fs.closeSync(manifestFd);
    }
    for (const object of owned) guard(object);
    if (
      scanFile(join(outputRoot, "manifest.json"), serialized.length) !==
      createHash("sha256").update(serialized).digest("hex")
    )
      archiveFail("ARCHIVE_VALIDATION_FAILED");
    exactDirectory(
      outputRoot,
      new Set(["sticker.sqlite", "uploads", "manifest.json"]),
    );
    for (const directory of [owned[1], owned[0]]) {
      guard(directory);
      const fd = fs.openSync(
        directory.path,
        fs.constants.O_RDONLY |
          fs.constants.O_DIRECTORY |
          fs.constants.O_NOFOLLOW,
      );
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return { ok: true, outputRoot, manifest };
  } catch (error) {
    try {
      target?.close();
    } catch {
      /* Incomplete owned output is not a successful artifact. */
    }
    try {
      source?.close();
    } catch {
      /* No source writes were authorized. */
    }
    cleanup(owned);
    return { ok: false, error: { code: safeCode(error) } };
  }
}
