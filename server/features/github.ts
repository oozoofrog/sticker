import { GithubDiscovery } from "./github-discovery.js";
import type {
  GithubRepositoryPage,
  GithubRepositoryOption,
} from "../contracts/github-discovery.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoreContext } from "../store-context.js";
import type { Actor } from "../types.js";
import { DomainError } from "../domain-error.js";
import { GithubReadClient, GithubReadError } from "../github-read-client.js";
import {
  githubConnectSchema,
  githubConnectionMutationSchema,
  githubEvidenceCreateSchema,
  githubEvidenceMutationSchema,
  githubConnectionSchema,
  githubEvidenceSchema,
  githubSnapshotSchema,
  githubErrorSchema,
  parseGithubUrl,
  type GithubConnection,
  type GithubEvidence,
  type GithubSnapshot,
  type GithubRepository,
} from "../contracts/github.js";
export interface ReadClient {
  listRepositories?: (input: {
    publicOwner?: string;
    page: number;
  }) => Promise<GithubRepositoryPage>;
  verifySelection?: (selected: GithubRepositoryOption) => Promise<void>;
  verify(repository: GithubRepository): Promise<void>;
  inspect(target: ReturnType<typeof parseGithubUrl>): Promise<GithubSnapshot>;
}
export interface GithubProvider {
  enabled: boolean;
  credentials?: Record<
    string,
    { label: string; resolve: () => string | undefined }
  >;
  client?: (connection: {
    mode: "public" | "authenticated";
    credentialRef: string | null;
  }) => ReadClient;
}
const connectionRow = z.object({
  projectId: z.string(),
  repositoryOwner: z.string(),
  repositoryName: z.string(),
  mode: z.enum(["public", "authenticated"]),
  credentialRef: z.string().nullable(),
  connected: z.number(),
  revision: z.number(),
  lastVerifiedAt: z.string().nullable(),
  lastErrorCode: githubErrorSchema.nullable(),
});
type ConnectionRow = z.infer<typeof connectionRow>;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success)
    throw new DomainError(
      400,
      "INVALID_INPUT",
      "GitHub 근거 입력을 확인하세요.",
    );
  return value.data;
}
export class GithubService {
  readonly discovery: GithubDiscovery;
  constructor(
    private readonly ctx: StoreContext,
    private readonly provider: GithubProvider = { enabled: false },
  ) {
    this.discovery = new GithubDiscovery(ctx, provider, {
      connection: (actor, projectId) => this.connection(actor, projectId),
      connect: (actor, projectId, input) =>
        this.connect(actor, projectId, input),
      currentRef: (projectId) =>
        this.connectionRow(projectId)?.credentialRef ?? null,
    });
  }
  private credential(ref: string) {
    const credentials = this.provider.credentials;
    return credentials && Object.hasOwn(credentials, ref)
      ? credentials[ref]
      : undefined;
  }
  private connectionRow(projectId: string) {
    const row = this.ctx.db
      .prepare("SELECT * FROM github_connections WHERE projectId=?")
      .get(projectId);
    return row ? connectionRow.parse(row) : null;
  }
  private checkRevision(actual: number, expected: number) {
    if (actual !== expected)
      throw new DomainError(
        409,
        "REVISION_CONFLICT",
        "연결 또는 근거가 변경되었습니다. 최신 상태를 확인하세요.",
      );
  }
  private settings(
    row: ConnectionRow | null,
    projectId: string,
  ): GithubConnection {
    const credential = row?.credentialRef
      ? this.credential(row.credentialRef)
      : undefined;
    return githubConnectionSchema.parse({
      projectId,
      repository: row
        ? { owner: row.repositoryOwner, name: row.repositoryName }
        : null,
      mode: row?.mode ?? "public",
      connected: !!row?.connected,
      revision: row?.revision ?? 0,
      principalLabel:
        row?.mode === "authenticated"
          ? (credential?.label ?? "미설정")
          : "공개 조회",
      credentialConfigured:
        row?.mode === "authenticated" ? !!credential : false,
      providerEnabled: this.provider.enabled,
      permissionsVerified: false,
      lastVerifiedAt: row?.lastVerifiedAt ?? null,
      lastErrorCode: row?.lastErrorCode ?? null,
    });
  }
  connection(actor: Actor, projectId: string) {
    this.ctx.owner(actor);
    this.ctx.project(actor, projectId);
    return this.settings(this.connectionRow(projectId), projectId);
  }
  connect(actor: Actor, projectId: string, input: unknown) {
    const data = parse(githubConnectSchema, input);
    return this.ctx.tx(() => {
      this.ctx.owner(actor);
      this.ctx.project(actor, projectId);
      const old = this.connectionRow(projectId);
      this.checkRevision(old?.revision ?? 0, data.revision);
      this.ctx.db
        .prepare(
          `INSERT INTO github_connections(projectId,repositoryOwner,repositoryName,mode,credentialRef,connected,revision,lastVerifiedAt,lastErrorCode) VALUES(?,?,?,?,?,1,?,NULL,NULL) ON CONFLICT(projectId) DO UPDATE SET repositoryOwner=excluded.repositoryOwner,repositoryName=excluded.repositoryName,mode=excluded.mode,credentialRef=excluded.credentialRef,connected=1,revision=excluded.revision,lastVerifiedAt=NULL,lastErrorCode=NULL`,
        )
        .run(
          projectId,
          data.repository.owner.toLowerCase(),
          data.repository.name.toLowerCase(),
          data.mode,
          data.credentialRef ?? null,
          data.revision + 1,
        );
      return this.connection(actor, projectId);
    });
  }
  disconnect(actor: Actor, projectId: string, input: unknown) {
    const data = parse(githubConnectionMutationSchema, input);
    return this.ctx.tx(() => {
      this.ctx.owner(actor);
      this.ctx.project(actor, projectId);
      const old = this.connectionRow(projectId);
      this.checkRevision(old?.revision ?? 0, data.revision);
      if (old)
        this.ctx.db
          .prepare(
            "UPDATE github_connections SET connected=0,revision=revision+1,lastErrorCode=NULL WHERE projectId=?",
          )
          .run(projectId);
      return this.connection(actor, projectId);
    });
  }
  private connected(projectId: string): ConnectionRow {
    const row = this.connectionRow(projectId);
    if (!row?.connected)
      throw new DomainError(
        409,
        "GITHUB_DISCONNECTED",
        "GitHub 연결이 해제되어 있습니다.",
      );
    return row;
  }
  private client(row: ConnectionRow): ReadClient {
    if (!this.provider.enabled) throw new GithubReadError("PROVIDER_DISABLED");
    if (this.provider.client) return this.provider.client(row);
    const credential = row.credentialRef
      ? this.credential(row.credentialRef)
      : undefined;
    return new GithubReadClient({
      enabled: true,
      authenticated: row.mode === "authenticated",
      credential: credential?.resolve,
    });
  }
  private sameConnection(projectId: string, revision: number) {
    const current = this.connected(projectId);
    this.checkRevision(current.revision, revision);
    return current;
  }
  async verify(actor: Actor, projectId: string, input: unknown) {
    const data = parse(githubConnectionMutationSchema, input);
    this.ctx.owner(actor);
    this.ctx.project(actor, projectId);
    const row = this.connected(projectId);
    this.checkRevision(row.revision, data.revision);
    let failure: null | GithubReadError = null;
    try {
      await this.client(row).verify({
        owner: row.repositoryOwner,
        name: row.repositoryName,
      });
    } catch (e) {
      failure =
        e instanceof GithubReadError ? e : new GithubReadError("NETWORK");
    }
    return this.ctx.tx(() => {
      this.ctx.owner(actor);
      this.ctx.project(actor, projectId);
      this.sameConnection(projectId, row.revision);
      this.ctx.db
        .prepare(
          "UPDATE github_connections SET lastVerifiedAt=?,lastErrorCode=?,revision=revision+1 WHERE projectId=?",
        )
        .run(
          failure ? row.lastVerifiedAt : this.ctx.now(),
          failure?.code ?? null,
          projectId,
        );
      return this.connection(actor, projectId);
    });
  }
  private row(actor: Actor, id: string) {
    const row = this.ctx.db
      .prepare("SELECT * FROM github_evidence WHERE id=?")
      .get(id);
    if (!row)
      throw new DomainError(404, "NOT_FOUND", "근거를 찾을 수 없습니다.");
    if (typeof row.issueId !== "string") throw new Error("Invalid evidence");
    const issue = this.ctx.issue(actor, row.issueId);
    if (row.projectId !== issue.projectId)
      throw new DomainError(
        403,
        "PROJECT_SCOPE",
        "프로젝트 범위가 변경되었습니다.",
      );
    return row;
  }
  private decode(actor: Actor, id: string): GithubEvidence {
    const row = this.row(actor, id);
    const snapshot: unknown =
      typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : null;
    const conn = this.connectionRow(String(row.projectId));
    const disconnected =
      !conn?.connected ||
      !this.provider.enabled ||
      conn.repositoryOwner !== row.repositoryOwner ||
      conn.repositoryName !== row.repositoryName;
    return githubEvidenceSchema.parse({
      ...row,
      repository: { owner: row.repositoryOwner, name: row.repositoryName },
      snapshot,
      disconnected,
      stale:
        disconnected ||
        !!row.errorCode ||
        !snapshot ||
        githubSnapshotSchema.parse(snapshot).stale,
    });
  }
  get(actor: Actor, id: string) {
    return this.decode(actor, id);
  }
  list(actor: Actor, issueId: string) {
    this.ctx.issue(actor, issueId);
    return this.ctx.db
      .prepare(
        "SELECT id FROM github_evidence WHERE issueId=? ORDER BY createdAt,id",
      )
      .all(issueId)
      .map((row) => {
        if (typeof row.id !== "string") throw new Error("Invalid evidence");
        return this.decode(actor, row.id);
      });
  }
  add(actor: Actor, issueId: string, input: unknown) {
    const data = parse(githubEvidenceCreateSchema, input),
      target = parseGithubUrl(data.url);
    return this.ctx.tx(() => {
      const issue = this.ctx.writableIssue(actor, issueId);
      this.checkRevision(issue.revision, data.issueRevision);
      const connection = this.connected(issue.projectId);
      if (
        connection.repositoryOwner !== target.owner.toLowerCase() ||
        connection.repositoryName !== target.name.toLowerCase()
      )
        throw new DomainError(
          400,
          "REPOSITORY_MISMATCH",
          "연결한 저장소의 근거만 추가할 수 있습니다.",
        );
      const url = target.url.toLowerCase();
      const existing = this.ctx.db
        .prepare("SELECT id FROM github_evidence WHERE issueId=? AND url=?")
        .get(issueId, url);
      if (existing) {
        if (typeof existing.id !== "string")
          throw new Error("Invalid evidence");
        return this.decode(actor, existing.id);
      }
      const id = randomUUID();
      this.ctx.db
        .prepare(
          `INSERT INTO github_evidence(id,issueId,projectId,url,kind,repositoryOwner,repositoryName,number,revision,headSha,snapshot,checkedAt,lastAttemptAt,errorCode,createdBy,createdAt) VALUES(?,?,?,?,?,?,?,?,1,?,NULL,NULL,NULL,NULL,?,?)`,
        )
        .run(
          id,
          issueId,
          issue.projectId,
          url,
          target.kind,
          connection.repositoryOwner,
          connection.repositoryName,
          target.number ?? null,
          target.sha ?? null,
          actor.id,
          this.ctx.now(),
        );
      this.ctx.activity(actor, issueId, "github_evidence_added", url);
      return this.decode(actor, id);
    });
  }
  remove(actor: Actor, id: string, input: unknown) {
    const data = parse(githubEvidenceMutationSchema, input);
    return this.ctx.tx(() => {
      const item = this.decode(actor, id);
      this.ctx.writableIssue(actor, item.issueId);
      this.checkRevision(item.revision, data.revision);
      this.ctx.db.prepare("DELETE FROM github_evidence WHERE id=?").run(id);
      this.ctx.activity(
        actor,
        item.issueId,
        "github_evidence_removed",
        item.url,
      );
      return { ok: true };
    });
  }
  async refresh(actor: Actor, id: string, input: unknown) {
    const data = parse(githubEvidenceMutationSchema, input),
      item = this.decode(actor, id);
    this.ctx.writableIssue(actor, item.issueId);
    this.checkRevision(item.revision, data.revision);
    const connection = this.connected(item.projectId);
    if (
      connection.repositoryOwner !== item.repository.owner ||
      connection.repositoryName !== item.repository.name
    )
      throw new DomainError(
        409,
        "REPOSITORY_MISMATCH",
        "연결된 저장소가 변경되었습니다.",
      );
    let snapshot: GithubSnapshot | null = null,
      failure: GithubReadError | null = null;
    try {
      snapshot = githubSnapshotSchema.parse(
        await this.client(connection).inspect(parseGithubUrl(item.url)),
      );
    } catch (e) {
      failure =
        e instanceof GithubReadError ? e : new GithubReadError("NETWORK");
    }
    return this.ctx.tx(() => {
      const current = this.decode(actor, id);
      this.ctx.writableIssue(actor, current.issueId);
      this.sameConnection(item.projectId, connection.revision);
      this.checkRevision(current.revision, item.revision);
      const now = this.ctx.now();
      this.ctx.db
        .prepare(
          "UPDATE github_evidence SET revision=revision+1,headSha=?,snapshot=?,checkedAt=?,lastAttemptAt=?,errorCode=? WHERE id=?",
        )
        .run(
          snapshot?.headSha ?? current.headSha,
          snapshot
            ? JSON.stringify(snapshot)
            : current.snapshot
              ? JSON.stringify(current.snapshot)
              : null,
          snapshot ? now : current.checkedAt,
          now,
          failure?.code ?? null,
          id,
        );
      return this.decode(actor, id);
    });
  }
}
