import { z } from "zod";
export const healthStatusSchema = z
  .object({ status: z.literal("ok") })
  .strict();
export const readinessStatusSchema = z
  .object({ status: z.enum(["ready", "maintenance"]) })
  .strict();

export const readyStatusSchema = z
  .object({ status: z.literal("ready") })
  .strict();
