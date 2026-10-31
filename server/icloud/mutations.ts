import { z } from "zod";
import { canonicalJson } from "../canonical-json.js";
import type { IssueMutationEvent } from "../store-context.js";
import { scopeSchema, type Scope } from "./contracts.js";

const contentSchema = z
  .object({
    title: z.string().min(1).max(300),
    description: z.string().max(100000),
  })
  .strict();
export const issueEnvelopeSchema = z
  .object({
    version: z.literal(1),
    operationId: z.uuid(),
    scope: scopeSchema,
    issueId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    baseRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    base: contentSchema,
    content: contentSchema,
  })
  .strict()
  .refine((value) => value.revision === value.baseRevision + 1);
export type IssueEnvelope = z.infer<typeof issueEnvelopeSchema>;

/** This partial synthetic projection grants no actor or remote-apply authority. */
export function ordinaryIssueEnvelope(
  event: IssueMutationEvent,
  scope: Scope,
): IssueEnvelope | null {
  const { before, after, metadata } = event;
  if (
    !before ||
    before.status === "closed" ||
    after.status === "closed" ||
    metadata.action !== "updated" ||
    metadata.sourceChangeId
  )
    return null;
  const omitted = new Set(["title", "description", "revision", "updatedAt"]);
  const stable = (issue: typeof after) =>
    Object.fromEntries(
      Object.entries(issue).filter(([key]) => !omitted.has(key)),
    );
  if (canonicalJson(stable(before)) !== canonicalJson(stable(after)))
    return null;
  if (before.title === after.title && before.description === after.description)
    return null;
  return issueEnvelopeSchema.parse({
    version: 1,
    operationId: event.activityId,
    scope,
    issueId: after.id,
    projectId: after.projectId,
    baseRevision: before.revision,
    revision: after.revision,
    base: { title: before.title, description: before.description },
    content: { title: after.title, description: after.description },
  });
}
