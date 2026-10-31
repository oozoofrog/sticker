import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type {
  ClientGrantService,
  ManagedPrincipal,
} from "./features/client-grants.js";
import type { Actor } from "./types.js";
export interface AgentConfig {
  id: string;
  name: string;
  tokenHash: string;
  projectIds: string[] | null;
  canWrite: boolean;
}
export interface AuthOptions {
  ownerPassword: string;
  ownerPasswordEnabled?: boolean;
  agents?: AgentConfig[];
  sessionTtlMs?: number;
}
const agentSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .refine((v) => v !== "owner"),
    name: z.string().trim().min(1).max(80),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    projectIds: z.array(z.string().min(1).max(100)).max(1000).nullable(),
    canWrite: z.boolean(),
  })
  .strict();
export const agentsSchema = z.array(agentSchema).max(100);
const sha = (v: string) => createHash("sha256").update(v).digest();
const owner: Actor = {
  id: "owner",
  name: "나",
  role: "owner",
  canWrite: true,
  projectIds: null,
};
export interface AuthenticatedPrincipal {
  actor: Actor;
  access?: ManagedPrincipal["access"];
}
export class AuthManager {
  private registry?: ClientGrantService;
  attachManagedRegistry(registry: ClientGrantService) {
    if (this.registry) throw new Error("Managed registry already attached");
    registry.attachStatic(
      this.agents.map(({ id, tokenHash }) => ({ id, tokenHash })),
    );
    this.registry = registry;
  }
  private salt = randomBytes(32);
  private passwordHash?: Buffer;
  private sessions = new Map<string, number>();
  private failures = new Map<string, { count: number; until: number }>();
  private agents: AgentConfig[];
  private sessionTtlMs: number;
  constructor(options: AuthOptions) {
    if (
      options.ownerPasswordEnabled !== false &&
      (typeof options.ownerPassword !== "string" ||
        options.ownerPassword.length < 12 ||
        options.ownerPassword.length > 1024)
    )
      throw new Error(
        "OWNER_PASSWORD must be 12–1024 characters; no default credential is provided.",
      );
    this.agents = agentsSchema.parse(options.agents ?? []);
    if (
      new Set(this.agents.map((a) => a.id)).size !== this.agents.length ||
      new Set(this.agents.map((a) => a.tokenHash)).size !== this.agents.length
    )
      throw new Error("Agent IDs and token hashes must be unique.");
    if (options.ownerPasswordEnabled !== false)
      this.passwordHash = scryptSync(options.ownerPassword, this.salt, 32);
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  }
  directory(): Actor[] {
    return [
      { ...owner },
      ...(this.registry?.directory() ?? []),
      ...this.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: "agent" as const,
        canWrite: agent.canWrite,
        projectIds: agent.projectIds === null ? null : [...agent.projectIds],
      })),
    ];
  }
  private cookieToken(cookie?: string) {
    return cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("sticker_session="))
      ?.slice(16);
  }
  resolve(
    authorization?: string,
    cookie?: string,
  ): AuthenticatedPrincipal | null {
    if (authorization !== undefined) {
      if (!authorization.startsWith("Bearer ") || authorization.length > 4096)
        return null;
      const hash = sha(authorization.slice(7));
      const agent = this.agents.find((a) =>
        timingSafeEqual(hash, Buffer.from(a.tokenHash, "hex")),
      );
      return agent
        ? {
            actor: {
              id: agent.id,
              name: agent.name,
              role: "agent",
              canWrite: agent.canWrite,
              projectIds:
                agent.projectIds === null ? null : [...agent.projectIds],
            },
          }
        : (this.registry?.resolveHash(hash.toString("hex")) ?? null);
    }
    const token = this.cookieToken(cookie);
    if (!token || token.length > 128) return null;
    const key = sha(token).toString("hex");
    const expires = this.sessions.get(key);
    if (!expires) return null;
    if (expires <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return { actor: { ...owner } };
  }
  authenticate(authorization?: string, cookie?: string): Actor | null {
    return this.resolve(authorization, cookie)?.actor ?? null;
  }
  login(password: unknown, ip: string): string | null {
    if (!this.passwordHash) return null;
    const now = Date.now();
    for (const [key, value] of this.failures)
      if (value.until <= now) this.failures.delete(key);
    for (const [key, expires] of this.sessions)
      if (expires <= now) this.sessions.delete(key);
    const fail = this.failures.get(ip);
    if (fail && fail.count >= 10) return null;
    if (
      typeof password !== "string" ||
      password.length > 1024 ||
      !timingSafeEqual(scryptSync(password, this.salt, 32), this.passwordHash)
    ) {
      if (this.failures.size > 10000) this.failures.clear();
      this.failures.set(ip, {
        count: (fail?.count ?? 0) + 1,
        until: fail?.until ?? now + 15 * 60 * 1000,
      });
      return null;
    }
    this.failures.delete(ip);
    if (this.sessions.size >= 1000) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(sha(token).toString("hex"), now + this.sessionTtlMs);
    return token;
  }
  logout(cookie?: string): void {
    const token = this.cookieToken(cookie);
    if (token) this.sessions.delete(sha(token).toString("hex"));
  }
}
