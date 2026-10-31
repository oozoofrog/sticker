import { MCP_CATALOGUE } from "./catalogue.js";
/** Parameter names do not change an HTTP route's coverage identity. */
export const normalizedRoute = (route: string) =>
  route.replace(/:[A-Za-z][A-Za-z0-9_]*/g, ":param");
export const MCP_ROUTE_EQUIVALENTS = [
  {
    route: "GET /api/resources",
    tool: "sticker_list_resources",
    reason: "Same authorized resource query through typed POST input.",
  },
  {
    route: "GET /api/issues",
    tool: "sticker_query_issues",
    reason: "Same shared query and warnings through typed POST input.",
  },
  {
    route: "GET /api/versions/:id/changelog/export",
    tool: "sticker_get_version_changelog",
    reason: "Exact saved Markdown content; no host file destination is needed.",
  },
] as const;
/** Deliberately named pending work and transport boundaries, never a catch-all. */
export const MCP_ROUTE_EXCEPTIONS = [
  {
    route: "POST /api/session",
    reason:
      "External owner credential provisioning; no model-visible password input.",
  },
  {
    route: "GET /{*path}",
    reason:
      "SPA presentation transport; product actions are covered individually.",
  },
  ...[
    "GET /api/projects/:id/github/sources",
    "POST /api/projects/:id/github/repositories",
    "POST /api/projects/:id/github/select",
    "POST /api/projects/:id/github/selection-status",
    "GET /api/projects/:id/github",
    "PUT /api/projects/:id/github",
    "DELETE /api/projects/:id/github",
    "POST /api/projects/:id/github/verify",
    "POST /api/issues/:id/github-evidence",
    "GET /api/github-evidence/:id",
    "DELETE /api/github-evidence/:id",
    "POST /api/github-evidence/:id/refresh",
  ].map((route) => ({
    route,
    reason:
      "Pending Task3 typed GitHub/provider adapter; no claim of parity yet.",
  })),
] as const;
/** Chunked file tools cover the full HTTP file budget; legacy one-message tools retain their limits. */
export const MCP_PARTIAL_FILE_ROUTES: readonly string[] = [];
export function routeCoverage(route: string) {
  const key = normalizedRoute(route);
  const tools = MCP_CATALOGUE.filter((entry) =>
    entry.route.some((candidate) => normalizedRoute(candidate) === key),
  ).map((entry) => entry.tool);
  const equivalent = MCP_ROUTE_EQUIVALENTS.find(
    (entry) => normalizedRoute(entry.route) === key,
  );
  const exception = MCP_ROUTE_EXCEPTIONS.find(
    (entry) => normalizedRoute(entry.route) === key,
  );
  return {
    tools,
    equivalent,
    exception,
    partial: MCP_PARTIAL_FILE_ROUTES.some(
      (candidate) => normalizedRoute(candidate) === key,
    ),
  };
}
