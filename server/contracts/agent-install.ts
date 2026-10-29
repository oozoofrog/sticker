import { z } from "zod";
import { mcpSettingsSchema } from "./mcp-settings.js";
export const agentInstallRequestSchema = z
  .object({
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    agentId: z.string().min(1).max(80).nullable(),
    mcp: z.boolean(),
    skill: z.boolean(),
  })
  .strict()
  .refine((value) => value.mcp || value.skill, "설치할 항목을 선택하세요.");
export const agentInstallCatalogSchema = z
  .object({
    target: z.literal("codex-mac"),
    scope: z.literal("user"),
    version: z.literal("1.0.0"),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    skill: z
      .object({
        name: z.literal("sticker-workflow"),
        version: z.literal("1.0.0"),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        content: z.string().max(20000),
        invocation: z.literal("explicit"),
      })
      .strict(),
    agents: mcpSettingsSchema.shape.agents,
    readTools: z
      .array(z.string().regex(/^sticker_[a-z_]+$/))
      .min(1)
      .max(100),
    verification: z.literal("local_execution_required"),
  })
  .strict();
export type AgentInstallCatalog = z.infer<typeof agentInstallCatalogSchema>;
