import { z } from "zod";
export const maintenanceStateSchema = z.enum([
  "serving",
  "draining",
  "stopping",
]);
export const maintenanceSnapshotSchema = z
  .object({
    contractVersion: z.literal(1),
    instanceId: z.uuid(),
    revision: z.number().int().nonnegative(),
    state: maintenanceStateSchema,
    drained: z.boolean(),
    startedAt: z.iso.datetime().max(40).nullable(),
  })
  .strict();
export const maintenanceControlSchema = z
  .object({
    instanceId: z.uuid(),
    revision: z.number().int().nonnegative(),
    confirm: z.literal(true),
  })
  .strict();
