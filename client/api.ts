import type { z } from "zod";
import { apiErrorSchema } from "../server/response-schemas.js";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public fields?: Record<string, string>,
    public maintenance?: z.infer<typeof apiErrorSchema>["maintenance"],
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
export function api<T>(
  path: string,
  init: RequestInit | undefined,
  schema: z.ZodType<T>,
): Promise<T>;
export function api(path: string, init?: RequestInit): Promise<unknown>;
export async function api(
  path: string,
  init: RequestInit = {},
  schema?: z.ZodType,
): Promise<unknown> {
  const isForm = init.body instanceof FormData;
  const headers = new Headers(init.headers);
  if (!isForm && init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) {
    const raw: unknown = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(raw);
    const body = parsed.success ? parsed.data : {};
    throw new ApiError(
      body.error || `요청을 처리하지 못했어요 (${String(response.status)}).`,
      response.status,
      body.code || "REQUEST_FAILED",
      body.fields,
      body.code === "MAINTENANCE" ? body.maintenance : undefined,
      body.code === "MAINTENANCE" ? body.retryAfterSeconds : undefined,
    );
  }
  if (response.status === 204)
    return schema ? schema.parse(undefined) : undefined;
  const body: unknown = await response.json();
  return schema ? schema.parse(body) : body;
}
export const json = (value: unknown) => JSON.stringify(value);
export const errorText = (error: unknown) =>
  error instanceof ApiError && error.status === 409
    ? `다른 변경 사항이 있거나 연결된 항목이 남아 있어요. ${error.message} 최신 상태를 확인한 뒤 다시 시도해 주세요.`
    : error instanceof Error
      ? error.message
      : "잠시 후 다시 시도해 주세요.";
