import { z } from "zod";
import { githubRepositorySchema, githubConnectionSchema } from "./github.js";
export const githubRepositoryOptionSchema = z.object({
  id: z.number().int().positive(),
  repository: githubRepositorySchema,
  visibility: z.enum(["public", "private"]),
  archived: z.boolean(),
  disabled: z.boolean(),
});
export type GithubRepositoryOption = z.infer<
  typeof githubRepositoryOptionSchema
>;
export interface GithubRepositoryPage {
  items: GithubRepositoryOption[];
  hasMore: boolean;
}
const ticket = z.uuid();
export const githubDiscoverySourceSchema = z.object({
  id: ticket,
  label: z.string().max(150),
  mode: z.enum(["public", "authenticated"]),
});
export const githubDiscoverySourcesSchema = z.object({
  revision: z.number().int().nonnegative(),
  providerEnabled: z.boolean(),
  sources: githubDiscoverySourceSchema.array().max(200),
});
export const githubDiscoveryQuerySchema = z
  .object({ sourceId: ticket, cursor: ticket.optional() })
  .strict();
export const githubRepositorySelectionSchema =
  githubRepositoryOptionSchema.extend({ selectionId: ticket });
export const githubDiscoveryPageSchema = z.object({
  sourceId: ticket,
  revision: z.number().int().nonnegative(),
  repositories: githubRepositorySelectionSchema.array().max(30),
  nextCursor: ticket.nullable(),
  limitReached: z.boolean(),
});
export const githubSelectionConnectSchema = z
  .object({
    sourceId: ticket,
    selectionId: ticket,
    revision: z.number().int().nonnegative(),
    confirm: z.literal(true),
  })
  .strict();
export type GithubDiscoverySources = z.infer<
  typeof githubDiscoverySourcesSchema
>;
export type GithubDiscoveryPage = z.infer<typeof githubDiscoveryPageSchema>;
export type GithubSelectionConnect = z.infer<
  typeof githubSelectionConnectSchema
>;

export const githubSelectionStatusSchema = z.object({
  matches: z.boolean(),
  connection: githubConnectionSchema,
});
