import { z } from "zod";
export const accessModeSchema = z
  .object({ mode: z.enum(["password", "trusted-loopback"]) })
  .strict();
