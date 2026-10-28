import { z } from "zod";
import {
  githubRepositorySchema,
  parseGithubUrl,
  type GithubRepository,
  type GithubTarget,
  type GithubSnapshot,
  type GithubCi,
  type GithubErrorCode,
} from "./contracts/github.js";
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const repoSchema = z.object({ full_name: z.string().max(150) });
const prSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().max(300),
  base: z.object({ repo: repoSchema }),
  head: z.object({ sha: shaSchema }),
});
const commitSchema = z.object({
  sha: shaSchema,
  html_url: z.string().max(300),
});
const checkSchema = z.object({
  id: z.number().int().positive(),
  head_sha: shaSchema,
  status: z.enum([
    "queued",
    "in_progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ]),
  conclusion: z
    .enum([
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "success",
      "skipped",
      "stale",
      "timed_out",
    ])
    .nullable(),
});
const suitesSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_suites: z
    .array(z.object({ id: z.number().int().positive(), head_sha: shaSchema }))
    .max(1),
});
const checksSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: checkSchema.array().max(100),
});
const statusSchema = z.object({
  id: z.number().int().positive(),
  context: z.string().max(200),
  state: z.enum(["error", "failure", "pending", "success"]),
});
const statusesSchema = z.object({
  sha: shaSchema,
  total_count: z.number().int().nonnegative(),
  statuses: statusSchema.array().max(100),
});
type Check = z.infer<typeof checkSchema>;
type Status = z.infer<typeof statusSchema>;
export class GithubReadError extends Error {
  constructor(readonly code: GithubErrorCode) {
    super(code);
    this.name = "GithubReadError";
  }
}
export interface GithubReadOptions {
  enabled?: boolean;
  fetch?: typeof fetch;
  credential?: () => string | undefined;
  authenticated?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
}
/** Opt-in, GET-only fixed-origin provider. It cannot establish a token's granted privileges. */
export class GithubReadClient {
  private readonly transport: typeof fetch;
  constructor(private readonly options: GithubReadOptions = {}) {
    this.transport = options.fetch ?? fetch;
  }
  private repo(input: GithubRepository) {
    const parsed = githubRepositorySchema.safeParse(input);
    if (!parsed.success) throw new GithubReadError("REPOSITORY_MISMATCH");
    return parsed.data;
  }
  private path(repo: GithubRepository) {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  }
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (!this.options.enabled) throw new GithubReadError("PROVIDER_DISABLED");
    let credential: string | undefined;
    try {
      credential = this.options.authenticated
        ? this.options.credential?.()
        : undefined;
    } catch {
      throw new GithubReadError("CREDENTIAL_MISSING");
    }
    if (this.options.authenticated && !credential)
      throw new GithubReadError("CREDENTIAL_MISSING");
    try {
      const response = await this.transport(`https://api.github.com${path}`, {
        method: "GET",
        redirect: "error",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
      });
      if (response.status === 401)
        return await rejectResponse(response, "UNAUTHORIZED");
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      )
        return await rejectResponse(response, "RATE_LIMIT");
      if (response.status === 403) {
        let message = "";
        try {
          const error = z
            .object({ message: z.string().max(4096) })
            .safeParse(await readBoundedJson(response, 4096, signal));
          if (error.success) message = error.data.message;
        } catch {
          /* No untrusted response text escapes this boundary. */
        }
        throw new GithubReadError(
          /rate limit/i.test(message) ? "RATE_LIMIT" : "FORBIDDEN",
        );
      }
      if (response.status === 404)
        return await rejectResponse(response, "NOT_FOUND");
      if (response.status !== 200)
        return await rejectResponse(response, "NETWORK");
      const raw = await readBoundedJson(
        response,
        Math.min(this.options.maxBytes ?? 1048576, 1048576),
        signal,
      );
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new GithubReadError("INVALID_RESPONSE");
      return parsed.data;
    } catch (error) {
      if (error instanceof GithubReadError) throw error;
      throw new GithubReadError(signal.aborted ? "TIMEOUT" : "NETWORK");
    }
  }
  async verify(input: GithubRepository): Promise<void> {
    const repo = this.repo(input),
      signal = AbortSignal.timeout(
        Math.min(this.options.timeoutMs ?? 15000, 30000),
      );
    const data = await this.request(this.path(repo), repoSchema, signal);
    if (
      data.full_name.toLowerCase() !==
      `${repo.owner}/${repo.name}`.toLowerCase()
    )
      throw new GithubReadError("REPOSITORY_MISMATCH");
  }
  private async pull(
    target: GithubTarget & { kind: "pr" },
    signal: AbortSignal,
  ) {
    const data = await this.request(
      `${this.path(target)}/pulls/${String(target.number)}`,
      prSchema,
      signal,
    );
    if (
      data.number !== target.number ||
      data.html_url.toLowerCase() !== target.url.toLowerCase() ||
      data.base.repo.full_name.toLowerCase() !==
        `${target.owner}/${target.name}`.toLowerCase()
    )
      throw new GithubReadError("REPOSITORY_MISMATCH");
    return data.head.sha;
  }
  async inspect(input: GithubTarget): Promise<GithubSnapshot> {
    let target: GithubTarget;
    try {
      target = parseGithubUrl(input.url);
    } catch {
      throw new GithubReadError("INVALID_RESPONSE");
    }
    if (
      target.owner.toLowerCase() !== input.owner.toLowerCase() ||
      target.name.toLowerCase() !== input.name.toLowerCase() ||
      target.kind !== input.kind ||
      target.number !== input.number ||
      target.sha !== input.sha
    )
      throw new GithubReadError("REPOSITORY_MISMATCH");
    input = target;

    const repo = this.repo({ owner: input.owner, name: input.name });
    const signal = AbortSignal.timeout(
      Math.min(this.options.timeoutMs ?? 15000, 30000),
    );
    let sha: string;
    if (input.kind === "pr") sha = await this.pull(input, signal);
    else {
      const data = await this.request(
        `${this.path(repo)}/commits/${input.sha}`,
        commitSchema,
        signal,
      );
      if (data.sha !== input.sha) throw new GithubReadError("SHA_MISMATCH");
      if (data.html_url.toLowerCase() !== input.url.toLowerCase())
        throw new GithubReadError("REPOSITORY_MISMATCH");
      sha = data.sha;
    }
    const suites = await this.request(
      `${this.path(repo)}/commits/${sha}/check-suites?per_page=1&page=1`,
      suitesSchema,
      signal,
    );
    for (const suite of suites.check_suites)
      if (suite.head_sha !== sha) throw new GithubReadError("SHA_MISMATCH");
    const checks: Check[] = [],
      statuses: Status[] = [];
    let complete = suites.total_count < 1000;
    const maxPages = Math.min(this.options.maxPages ?? 10, 10);
    for (const kind of ["checks", "statuses"] as const) {
      let expected: number | null = null;
      const seen = new Set<number>();
      let count = 0,
        finished = false;
      for (let page = 1; page <= maxPages; page++) {
        const suffix =
          kind === "checks"
            ? `check-runs?filter=latest&per_page=100&page=${String(page)}`
            : `status?per_page=100&page=${String(page)}`;
        const path = `${this.path(repo)}/commits/${sha}/${suffix}`;
        if (kind === "checks") {
          const data = await this.request(path, checksSchema, signal);
          if (expected !== null && expected !== data.total_count)
            complete = false;
          expected = data.total_count;
          for (const check of data.check_runs) {
            if (check.head_sha !== sha)
              throw new GithubReadError("SHA_MISMATCH");
            if (seen.has(check.id)) complete = false;
            seen.add(check.id);
            checks.push(check);
          }
          count += data.check_runs.length;
          if (count >= expected) {
            finished = true;
            break;
          }
          if (!data.check_runs.length) break;
        } else {
          const data = await this.request(path, statusesSchema, signal);
          if (data.sha !== sha) throw new GithubReadError("SHA_MISMATCH");
          if (expected !== null && expected !== data.total_count)
            complete = false;
          expected = data.total_count;
          for (const status of data.statuses) {
            if (seen.has(status.id)) complete = false;
            seen.add(status.id);
            statuses.push(status);
          }
          count += data.statuses.length;
          if (count >= expected) {
            finished = true;
            break;
          }
          if (!data.statuses.length) break;
        }
      }
      if (!finished || count !== expected) complete = false;
    }
    if (
      checks.length >= 1000 ||
      (checks.length > 0 && suites.total_count === 0)
    )
      complete = false;
    if (new Set(statuses.map((s) => s.context)).size !== statuses.length)
      complete = false;
    let headSha = sha;
    if (input.kind === "pr") headSha = await this.pull(input, signal);
    const stale = headSha !== sha;
    return {
      headSha,
      snapshotSha: sha,
      ci: stale || !complete ? "unknown" : classify(checks, statuses),
      snapshotCi: complete ? classify(checks, statuses) : "unknown",
      stale,
      complete,
      checkCount: checks.length,
      statusCount: statuses.length,
    };
  }
}
function classify(checks: Check[], statuses: Status[]): GithubCi {
  const states: GithubCi[] = [
    ...checks.map((c): GithubCi => {
      if (c.status !== "completed") return "pending";
      if (c.conclusion === "success") return "success";
      if (
        c.conclusion &&
        ["failure", "timed_out", "action_required"].includes(c.conclusion)
      )
        return "failure";
      return "unknown";
    }),
    ...statuses.map((s): GithubCi =>
      s.state === "error" ? "failure" : s.state,
    ),
  ];
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  if (!states.length || states.includes("unknown")) return "unknown";
  return "success";
}

async function readBoundedJson(
  response: Response,
  max: number,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > max) return rejectResponse(response, "RESPONSE_TOO_LARGE");
  if (!response.body) throw new GithubReadError("INVALID_RESPONSE");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0,
    finished = false;
  try {
    while (!finished) {
      if (signal.aborted) throw new GithubReadError("TIMEOUT");
      const { value, done } = await reader.read();
      finished = done;
      if (done) break;
      size += value.length;
      if (size > max) throw new GithubReadError("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GithubReadError("INVALID_RESPONSE");
  }

  return raw;
}

async function rejectResponse(
  response: Response,
  code: GithubErrorCode,
): Promise<never> {
  try {
    await response.body?.cancel();
  } catch {
    /* Preserve sanitized provider classification. */
  }
  throw new GithubReadError(code);
}
