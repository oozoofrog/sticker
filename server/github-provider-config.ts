import { readFileSync, lstatSync } from "node:fs";
import { z } from "zod";
import type { GithubProvider } from "./features/github.js";
const credentialsSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    z
      .object({
        label: z.string().trim().min(1).max(120),
        token: z
          .string()
          .min(1)
          .max(4096)
          .regex(/^[^\r\n]+$/),
      })
      .strict(),
  )
  .refine((map) => Object.keys(map).length <= 100);
/** No environment file is read unless the operator explicitly enables this provider. */
export function githubProviderFromEnvironment(
  env: Record<string, string | undefined>,
): GithubProvider {
  if (env.GITHUB_READ_ENABLED !== "true") return { enabled: false };
  const path = env.GITHUB_CREDENTIAL_CONFIG_PATH;
  if (!path) return { enabled: true };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576)
      throw new Error("Invalid credential file");
    const input: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = credentialsSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid credential file");
    const credentials: NonNullable<GithubProvider["credentials"]> = {};
    for (const [ref, item] of Object.entries(parsed.data)) {
      if (item.label.includes(item.token))
        throw new Error("Invalid credential label");
      credentials[ref] = { label: item.label, resolve: () => item.token };
    }
    return { enabled: true, credentials };
  } catch {
    throw new Error(
      "GitHub credential configuration is unavailable or invalid.",
    );
  }
}
