import { z } from "zod";
export const githubRepositorySchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]+$/)
      .refine((v) => v !== "." && v !== ".."),
  })
  .strict();
export type GithubRepository = z.infer<typeof githubRepositorySchema>;
export type GithubTarget = GithubRepository &
  (
    | { kind: "pr"; number: number; url: string; sha?: never }
    | { kind: "commit"; sha: string; url: string; number?: never }
  );
export function parseGithubUrl(value: string): GithubTarget {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/(pull|commit)\/([A-Za-z0-9]+)$/.exec(
      value,
    );
  if (!match) throw new Error("GitHub PR 또는 전체 커밋 URL을 확인하세요.");
  const repo = githubRepositorySchema.parse({
    owner: match[1],
    name: match[2],
  });
  if (match[3] === "pull") {
    if (!/^[1-9][0-9]{0,14}$/.test(match[4]))
      throw new Error("PR 번호를 확인하세요.");
    const number = Number(match[4]);
    return {
      ...repo,
      kind: "pr",
      number,
      url: `https://github.com/${repo.owner}/${repo.name}/pull/${String(number)}`,
    };
  }
  if (!/^[a-fA-F0-9]{40}$/.test(match[4]))
    throw new Error("전체 커밋 SHA가 필요합니다.");
  const sha = match[4].toLowerCase();
  return {
    ...repo,
    kind: "commit",
    sha,
    url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}
export const githubCiSchema = z.enum([
  "success",
  "failure",
  "pending",
  "unknown",
]);
export type GithubCi = z.infer<typeof githubCiSchema>;
export const githubErrorSchema = z.enum([
  "PROVIDER_DISABLED",
  "CREDENTIAL_MISSING",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RATE_LIMIT",
  "NOT_FOUND",
  "NETWORK",
  "TIMEOUT",
  "INVALID_RESPONSE",
  "RESPONSE_TOO_LARGE",
  "REPOSITORY_MISMATCH",
  "SHA_MISMATCH",
]);
export type GithubErrorCode = z.infer<typeof githubErrorSchema>;
export const githubSnapshotSchema = z.object({
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  snapshotSha: z.string().regex(/^[a-f0-9]{40}$/),
  ci: githubCiSchema,
  snapshotCi: githubCiSchema,
  stale: z.boolean(),
  complete: z.boolean(),
  checkCount: z.number().int().nonnegative(),
  statusCount: z.number().int().nonnegative(),
});
export type GithubSnapshot = z.infer<typeof githubSnapshotSchema>;
const id = z.string().min(1).max(128),
  revision = z.number().int().nonnegative();
export const githubConnectSchema = z
  .object({
    repository: githubRepositorySchema,
    mode: z.enum(["public", "authenticated"]),
    credentialRef: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
      .optional(),
    revision,
    confirm: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "authenticated" && !value.credentialRef)
      ctx.addIssue({
        code: "custom",
        path: ["credentialRef"],
        message: "설정된 자격증명 참조가 필요합니다.",
      });
    if (value.mode === "public" && value.credentialRef)
      ctx.addIssue({
        code: "custom",
        path: ["credentialRef"],
        message: "공개 조회에는 자격증명을 사용하지 않습니다.",
      });
  });
export const githubConnectionMutationSchema = z
  .object({ revision, confirm: z.literal(true) })
  .strict();
export const githubConnectionSchema = z.object({
  projectId: id,
  repository: githubRepositorySchema.nullable(),
  mode: z.enum(["public", "authenticated"]),
  connected: z.boolean(),
  revision,
  principalLabel: z.string().max(120),
  credentialConfigured: z.boolean(),
  providerEnabled: z.boolean(),
  permissionsVerified: z.literal(false),
  lastVerifiedAt: z.string().nullable(),
  lastErrorCode: githubErrorSchema.nullable(),
});
export type GithubConnection = z.infer<typeof githubConnectionSchema>;
export const githubEvidenceCreateSchema = z
  .object({
    url: z
      .string()
      .max(300)
      .refine((value) => {
        try {
          parseGithubUrl(value);
          return true;
        } catch {
          return false;
        }
      }, "GitHub PR 또는 전체 커밋 URL을 확인하세요."),
    issueRevision: z.number().int().positive(),
  })
  .strict();
export const githubEvidenceMutationSchema = z
  .object({ revision: z.number().int().positive() })
  .strict();
export const githubEvidenceSchema = z.object({
  id,
  issueId: id,
  projectId: id,
  url: z.string().max(300),
  kind: z.enum(["pr", "commit"]),
  repository: githubRepositorySchema,
  number: z.number().int().positive().nullable(),
  revision: z.number().int().positive(),
  headSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  snapshot: githubSnapshotSchema.nullable(),
  checkedAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  stale: z.boolean(),
  disconnected: z.boolean(),
  errorCode: githubErrorSchema.nullable(),
  createdBy: id,
  createdAt: z.string(),
});
export type GithubEvidence = z.infer<typeof githubEvidenceSchema>;
