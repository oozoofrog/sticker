import { DomainError } from "./domain.js";
import type { Actor } from "./types.js";
export type LocalOwnerMode = "trusted-loopback";
export function localOwnerMode(
  value: string | undefined,
): LocalOwnerMode | undefined {
  if (value === undefined || value === "" || value === "off") return undefined;
  if (value !== "trusted-loopback")
    throw new Error("LOCAL_OWNER_MODE must be off or trusted-loopback.");
  return value;
}
export const localOwnerActor: Actor = {
  id: "owner",
  name: "나",
  role: "owner",
  canWrite: true,
  projectIds: null,
};
// This validates browser/request boundaries, NOT Docker host publication.
export class LocalOwnerPolicy {
  readonly origin: string;
  readonly host: string;
  constructor(origin: string) {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Trusted local owner mode requires a canonical HTTP localhost or 127.0.0.1 origin.",
      );
    this.origin = url.origin;
    this.host = url.host;
  }
  validate(method: string, rawHeaders: string[], bearerPresent: boolean): void {
    const headers = new Map<string, string[]>();
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index].toLowerCase(),
        value = rawHeaders.at(index + 1);
      if (value === undefined)
        throw new DomainError(403, "LOCAL_BOUNDARY", "잘못된 요청 헤더입니다.");
      if (
        name === "forwarded" ||
        name.startsWith("x-forwarded-") ||
        name.startsWith("tailscale-")
      )
        throw new DomainError(
          403,
          "LOCAL_PROXY",
          "로컬 소유자 모드에서는 프록시 요청을 허용하지 않습니다.",
        );
      headers.set(name, [...(headers.get(name) ?? []), value]);
    }
    for (const name of ["host", "origin", "authorization", "sec-fetch-site"])
      if ((headers.get(name)?.length ?? 0) > 1)
        throw new DomainError(403, "LOCAL_BOUNDARY", "중복 요청 헤더입니다.");
    if (!bearerPresent && headers.get("host")?.[0] !== this.host)
      throw new DomainError(
        403,
        "LOCAL_HOST",
        "허용되지 않은 요청 호스트입니다.",
      );
    const origin = headers.get("origin")?.[0],
      fetchSite = headers.get("sec-fetch-site")?.[0];
    if (origin !== undefined && origin !== this.origin)
      throw new DomainError(403, "ORIGIN", "허용되지 않은 요청 출처입니다.");
    if (fetchSite !== undefined && !["same-origin", "none"].includes(fetchSite))
      throw new DomainError(
        403,
        "LOCAL_SITE",
        "다른 사이트의 요청을 허용하지 않습니다.",
      );
    if (
      !["GET", "HEAD", "OPTIONS"].includes(method) &&
      !bearerPresent &&
      origin !== this.origin
    )
      throw new DomainError(403, "ORIGIN", "요청 출처가 필요합니다.");
  }
}
