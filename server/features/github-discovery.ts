import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoreContext } from "../store-context.js";
import type { Actor } from "../types.js";
import { DomainError } from "../domain-error.js";
import { GithubReadClient, GithubReadError } from "../github-read-client.js";
import type { GithubProvider, ReadClient } from "./github.js";
import {
  githubRepositorySchema,
  type GithubConnection,
} from "../contracts/github.js";
import {
  githubDiscoveryQuerySchema,
  githubSelectionConnectSchema,
  githubRepositoryOptionSchema,
  type GithubRepositoryOption,
} from "../contracts/github-discovery.js";
interface Source {
  key: string;
  label: string;
  mode: "public" | "authenticated";
  fingerprint: string;
  owner?: string;
  ref?: string;
}
interface Scope {
  actorId: string;
  projectId: string;
  revision: number;
  expires: number;
}
type Ticket = Scope &
  (
    | { kind: "source"; source: Source }
    | { kind: "cursor"; sourceId: string; page: number }
    | { kind: "selection"; sourceId: string; option: GithubRepositoryOption }
  );
interface ConnectionAccess {
  connection: (actor: Actor, projectId: string) => GithubConnection;
  connect: (
    actor: Actor,
    projectId: string,
    input: unknown,
  ) => GithubConnection;
  currentRef: (projectId: string) => string | null;
}
const lifetime = 15 * 60 * 1000,
  capacity = 4096;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new DomainError(
      400,
      "INVALID_INPUT",
      "저장소 선택 입력을 확인하세요.",
    );
  return result.data;
}
function invalid(): never {
  throw new DomainError(
    409,
    "GITHUB_DISCOVERY_EXPIRED",
    "저장소 선택이 만료되었거나 변경되었습니다. 목록을 다시 확인하세요.",
  );
}
/** Ephemeral owner-only capabilities, never persisted or populated from arbitrary URLs. */
export class GithubDiscovery {
  private readonly tickets = new Map<string, Ticket>();
  constructor(
    private readonly ctx: StoreContext,
    private readonly provider: GithubProvider,
    private readonly access: ConnectionAccess,
  ) {}
  private authorize(actor: Actor, projectId: string) {
    this.ctx.owner(actor);
    this.ctx.project(actor, projectId);
  }
  private prune() {
    for (const [key, value] of this.tickets)
      if (value.expires <= Date.now()) this.tickets.delete(key);
  }
  private put(ticket: Ticket) {
    this.prune();
    if (this.tickets.size >= capacity)
      throw new DomainError(
        429,
        "GITHUB_DISCOVERY_LIMIT",
        "선택 목록이 많습니다. 잠시 후 다시 시도하세요.",
      );
    const id = randomUUID();
    this.tickets.set(id, ticket);
    return id;
  }
  private get(actor: Actor, projectId: string, id: string) {
    this.authorize(actor, projectId);
    this.prune();
    const ticket = this.tickets.get(id);
    if (
      !ticket ||
      ticket.actorId !== actor.id ||
      ticket.projectId !== projectId
    )
      return invalid();
    return ticket;
  }
  private candidates(projectId: string): Source[] {
    const rows = z
      .array(z.object({ repositoryOwner: z.string(), connected: z.number() }))
      .parse(
        this.ctx.db
          .prepare(
            "SELECT repositoryOwner, MAX(connected) AS connected FROM github_connections WHERE mode='public' AND (connected=1 OR projectId=?) GROUP BY repositoryOwner ORDER BY repositoryOwner LIMIT 100",
          )
          .all(projectId),
      );
    const sources: Source[] = rows.map((row) => {
      const owner = githubRepositorySchema.parse({
        owner: row.repositoryOwner,
        name: "placeholder",
      }).owner;
      return {
        key: `public:${owner}`,
        label: `${owner} · ${row.connected ? "공개 저장소" : "이전 공개 연결"}`,
        mode: "public",
        fingerprint: owner,
        owner,
      };
    });
    for (const [ref, value] of Object.entries(
      this.provider.credentials ?? {},
    ).slice(0, 100)) {
      let token: string | undefined;
      try {
        token = value.resolve();
      } catch {
        token = undefined;
      }
      // The digest remains in server memory. Detect rotation even if the resolver is the same function.
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([value.label, token ?? null]))
        .digest("hex");
      sources.push({
        key: `credential:${ref}`,
        label: value.label,
        mode: "authenticated",
        fingerprint,
        ref,
      });
    }
    return sources;
  }
  private currentSource(source: Source, projectId: string) {
    if (!this.provider.enabled)
      throw new DomainError(
        503,
        "PROVIDER_DISABLED",
        "GitHub 조회 공급자가 비활성 상태입니다.",
      );
    const current = this.candidates(projectId).find(
      (item) => item.key === source.key,
    );
    if (!current || current.fingerprint !== source.fingerprint)
      return invalid();
    return current;
  }
  private source(
    actor: Actor,
    projectId: string,
    id: string,
    checkRevision = true,
  ) {
    const ticket = this.get(actor, projectId, id);
    if (ticket.kind !== "source") return invalid();
    this.currentSource(ticket.source, projectId);
    if (
      checkRevision &&
      this.access.connection(actor, projectId).revision !== ticket.revision
    )
      return invalid();
    return ticket;
  }
  private client(source: Source): ReadClient {
    if (this.provider.client)
      return this.provider.client({
        mode: source.mode,
        credentialRef: source.ref ?? null,
      });
    const credentials = this.provider.credentials;
    const credential =
      source.ref && credentials && Object.hasOwn(credentials, source.ref)
        ? credentials[source.ref]
        : undefined;
    return new GithubReadClient({
      enabled: this.provider.enabled,
      authenticated: source.mode === "authenticated",
      credential: credential?.resolve,
    });
  }
  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code = error instanceof GithubReadError ? error.code : "NETWORK";
      throw new DomainError(
        code === "RATE_LIMIT" ? 429 : 502,
        code,
        "GitHub 저장소를 확인하지 못했습니다. 잠시 후 다시 확인하세요.",
      );
    }
  }
  sources(actor: Actor, projectId: string) {
    this.authorize(actor, projectId);
    this.prune();
    const revision = this.access.connection(actor, projectId).revision;
    const sources = this.provider.enabled
      ? this.candidates(projectId).map((source) => ({
          id: this.put({
            kind: "source",
            source,
            actorId: actor.id,
            projectId,
            revision,
            expires: Date.now() + lifetime,
          }),
          label: source.label,
          mode: source.mode,
        }))
      : [];
    return { revision, providerEnabled: this.provider.enabled, sources };
  }
  async repositories(actor: Actor, projectId: string, input: unknown) {
    this.authorize(actor, projectId);
    const data = parse(githubDiscoveryQuerySchema, input),
      source = this.source(actor, projectId, data.sourceId);
    let page = 1;
    if (data.cursor) {
      const cursor = this.get(actor, projectId, data.cursor);
      if (
        cursor.kind !== "cursor" ||
        cursor.sourceId !== data.sourceId ||
        cursor.revision !== source.revision
      )
        return invalid();
      page = cursor.page;
    }
    const client = this.client(source.source);
    const listRepositories = client.listRepositories?.bind(client);
    if (!listRepositories)
      throw new DomainError(
        503,
        "GITHUB_DISCOVERY_UNAVAILABLE",
        "이 조회 공급자는 저장소 목록을 지원하지 않습니다.",
      );
    const result = await this.read(() =>
      listRepositories({
        ...(source.source.owner ? { publicOwner: source.source.owner } : {}),
        page,
      }),
    );
    this.source(actor, projectId, data.sourceId);
    const parsed = z
      .object({
        items: githubRepositoryOptionSchema.array().max(30),
        hasMore: z.boolean(),
      })
      .parse(result);
    const seen = new Set<number>();
    const repositories = parsed.items
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .map((option) => {
        if (
          source.source.mode === "public" &&
          (option.visibility !== "public" ||
            option.repository.owner.toLowerCase() !==
              source.source.owner?.toLowerCase())
        )
          return invalid();
        const selectionId = this.put({
          kind: "selection",
          sourceId: data.sourceId,
          option,
          actorId: actor.id,
          projectId,
          revision: source.revision,
          expires: source.expires,
        });
        return { ...option, selectionId };
      });
    return {
      sourceId: data.sourceId,
      revision: source.revision,
      repositories,
      nextCursor:
        parsed.hasMore && page < 100
          ? this.put({
              kind: "cursor",
              sourceId: data.sourceId,
              page: page + 1,
              actorId: actor.id,
              projectId,
              revision: source.revision,
              expires: source.expires,
            })
          : null,
      limitReached: parsed.hasMore && page >= 100,
    };
  }
  private selection(
    actor: Actor,
    projectId: string,
    input: unknown,
    checkRevision = true,
  ) {
    this.authorize(actor, projectId);
    const data = parse(githubSelectionConnectSchema, input),
      source = this.source(actor, projectId, data.sourceId, checkRevision),
      selection = this.get(actor, projectId, data.selectionId);
    if (
      selection.kind !== "selection" ||
      selection.sourceId !== data.sourceId ||
      data.revision !== source.revision ||
      selection.revision !== source.revision ||
      selection.option.disabled
    )
      return invalid();
    return { data, source, selection };
  }
  async connect(actor: Actor, projectId: string, input: unknown) {
    const { data, source, selection } = this.selection(actor, projectId, input);
    const client = this.client(source.source);
    const verifySelection = client.verifySelection?.bind(client);
    if (!verifySelection)
      throw new DomainError(
        503,
        "GITHUB_DISCOVERY_UNAVAILABLE",
        "이 조회 공급자는 저장소 선택 확인을 지원하지 않습니다.",
      );
    await this.read(() => verifySelection(selection.option));
    this.selection(actor, projectId, input);
    return this.access.connect(actor, projectId, {
      repository: selection.option.repository,
      mode: source.source.mode,
      ...(source.source.ref ? { credentialRef: source.source.ref } : {}),
      revision: data.revision,
      confirm: true,
    });
  }
  status(actor: Actor, projectId: string, input: unknown) {
    const { source, selection } = this.selection(
        actor,
        projectId,
        input,
        false,
      ),
      connection = this.access.connection(actor, projectId);
    const expected = selection.option.repository;
    return {
      connection,
      matches:
        connection.connected &&
        connection.revision === source.revision + 1 &&
        connection.mode === source.source.mode &&
        this.access.currentRef(projectId) === (source.source.ref ?? null) &&
        connection.repository?.owner.toLowerCase() ===
          expected.owner.toLowerCase() &&
        connection.repository.name.toLowerCase() ===
          expected.name.toLowerCase(),
    };
  }
}
