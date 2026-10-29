import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Actor } from "./types.js";
import { DomainError } from "./domain.js";
import {
  agentInstallCatalogSchema,
  agentInstallRequestSchema,
} from "./contracts/agent-install.js";
import { buildAgentInstallZip } from "./agent-install-zip.js";
const root = () => resolve("packaging/agent-install");
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const installReadTools = [
  "sticker_get_issue",
  "sticker_list_issues",
  "sticker_list_projects",
  "sticker_list_reports",
  "sticker_list_versions",
  "sticker_read_file",
];
export function agentInstallCatalog(directory: Actor[]) {
  const content = readFileSync(resolve(root(), "SKILL.md"), "utf8");
  const agents = directory
    .filter((actor) => actor.role === "agent")
    .map(({ id, name, canWrite, projectIds }) => ({
      id,
      name,
      canWrite,
      projectIds: projectIds === null ? null : [...projectIds],
    }));
  const skill = {
    name: "sticker-workflow" as const,
    version: "1.0.0" as const,
    sha256: hash(content),
    content,
    invocation: "explicit" as const,
  };
  return agentInstallCatalogSchema.parse({
    target: "codex-mac",
    scope: "user",
    version: "1.0.0",
    previewHash: hash(
      JSON.stringify({ skill, agents, readTools: installReadTools }),
    ),
    skill,
    agents,
    readTools: installReadTools,
    verification: "local_execution_required",
  });
}
export function agentInstallBundle(directory: Actor[], input: unknown) {
  const parsed = agentInstallRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError(
      400,
      "INVALID_INSTALL_PLAN",
      "설치 계획을 확인하세요.",
    );
  const data = parsed.data,
    catalog = agentInstallCatalog(directory);
  if (data.previewHash !== catalog.previewHash)
    throw new DomainError(
      409,
      "INSTALL_PLAN_CHANGED",
      "현재 설정을 다시 검토하세요.",
    );
  const agent = catalog.agents.find((item) => item.id === data.agentId) ?? null;
  if (data.mcp && !agent)
    throw new DomainError(
      400,
      "AGENT_REQUIRED",
      "설정된 에이전트를 선택하세요.",
    );
  const release = Buffer.from(
    `globalThis.StickerInstallRelease = ${JSON.stringify({ skillHash: catalog.skill.sha256, readTools: catalog.readTools })};\n`,
  );
  const program = Buffer.concat([
    release,
    ...[
      "core.js",
      "schema.js",
      "flow.js",
      "process.jxa.js",
      "installer.jxa.js",
    ].flatMap((name) => [
      readFileSync(resolve(root(), name)),
      Buffer.from("\n"),
    ]),
  ]);
  const skill = Buffer.from(catalog.skill.content);
  const manifest = {
    schemaVersion: 1,
    product: "Sticker",
    version: catalog.version,
    target: "codex-mac",
    scope: "user",
    components: { mcp: data.mcp, skill: data.skill },
    agent: data.mcp ? agent : null,
    skill: {
      name: catalog.skill.name,
      version: catalog.skill.version,
      sha256: catalog.skill.sha256,
    },
    readTools: catalog.readTools,
    previewHash: catalog.previewHash,
  };
  // The shell contains only a fixed program and computed public-code digest, never user paths/config.
  const command = Buffer.from(
    `#!/bin/bash\nset -euo pipefail\ncd -- "$(dirname -- "$0")"\nexpected='${hash(program)}'\nactual=$(/usr/bin/shasum -a 256 installer.js)\n[[ "\${actual%% *}" == "$expected" ]] || { printf 'Installer verification failed.\\n' >&2; exit 1; }\nexec /usr/bin/osascript -l JavaScript installer.js manifest.json\n`,
  );
  return buildAgentInstallZip([
    { name: "Install Sticker.command", content: command, executable: true },
    { name: "installer.js", content: program },
    {
      name: "manifest.json",
      content: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
    },
    { name: "sticker-workflow/SKILL.md", content: skill },
  ]);
}
