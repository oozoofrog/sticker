import { z } from "zod";
import { LocalOwnerPolicy } from "./local-owner.js";
const portSchema = z.coerce.number().int().min(1).max(65535);
const composeSchema = z.object({
  services: z.object({
    sticker: z.object({
      network_mode: z.string().optional(),
      environment: z.object({
        LOCAL_OWNER_MODE: z.literal("trusted-loopback"),
        APP_ORIGIN: z.string(),
        HOST: z.literal("0.0.0.0"),
        PORT: z.literal("8787"),
      }),
      ports: z
        .array(
          z.object({
            target: z.literal(8787),
            published: portSchema,
            host_ip: z.literal("127.0.0.1"),
            protocol: z.literal("tcp"),
          }),
        )
        .length(1),
    }),
  }),
});
export function validateLocalCompose(input: unknown): number {
  const service = composeSchema.parse(input).services.sticker;
  if (service.network_mode)
    throw new Error(
      "Custom network_mode is not supported for trusted local publication.",
    );
  const policy = new LocalOwnerPolicy(service.environment.APP_ORIGIN);
  const port = Number(new URL(policy.origin).port || 80);
  if (service.ports[0].published !== port)
    throw new Error("Published port must match APP_ORIGIN.");
  return port;
}
const inspectionSchema = z.object({
  networkMode: z.string(),
  ports: z.record(
    z.string(),
    z.array(z.object({ HostIp: z.string(), HostPort: portSchema })).nullable(),
  ),
});
export function validateLocalInspection(
  input: unknown,
  expectedPort: number,
): void {
  const inspection = inspectionSchema.parse(input);
  if (
    inspection.networkMode === "host" ||
    inspection.networkMode === "none" ||
    inspection.networkMode.startsWith("container:")
  )
    throw new Error("Unsupported runtime network mode.");
  if (Object.keys(inspection.ports).length !== 1)
    throw new Error("Unexpected published ports.");
  const ports = inspection.ports["8787/tcp"];
  if (
    !ports ||
    ports.length !== 1 ||
    ports[0].HostIp !== "127.0.0.1" ||
    ports[0].HostPort !== expectedPort
  )
    throw new Error("Actual publication is not the expected loopback binding.");
}
