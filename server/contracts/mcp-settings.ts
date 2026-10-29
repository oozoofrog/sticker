import { z } from "zod";

/** Only public connection metadata. Never extend this with a credential value. */
export const mcpSettingsSchema = z
  .object({
    transport: z.literal("stdio"),
    application: z.literal("manual"),
    verification: z.literal("unknown"),
    tokenEnvironmentVariable: z.literal("STICKER_AGENT_TOKEN"),
    agents: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            name: z.string().min(1).max(80),
            canWrite: z.boolean(),
            projectIds: z
              .array(z.string().min(1).max(100))
              .max(1000)
              .nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type McpSettingsStatus = z.infer<typeof mcpSettingsSchema>;
