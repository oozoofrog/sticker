export interface CodexMcpConfig {
  command: string;
  args: string[];
  cwd: string;
  envVars: string[];
  toml: string;
}

/** Syntax only: no host path lookup, expansion, process execution or environment read. */
export function buildCodexMcpConfig(cwd: string): CodexMcpConfig {
  const invalidCharacter = Array.from(cwd).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return (
      point < 0x20 ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0xd800 && point <= 0xdfff)
    );
  });
  const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+\\[^\\/]+(?:\\|$))/.test(
    cwd,
  );
  if (!cwd || cwd.length > 4096 || invalidCharacter || !absolute)
    throw new Error("설치 위치에 소스 루트의 절대 경로를 입력하세요.");

  const command = "docker";
  const args = [
    "compose",
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "-e",
    "STICKER_AGENT_TOKEN",
    "mcp",
  ];
  const envVars = ["STICKER_AGENT_TOKEN"];
  const array = (values: string[]) =>
    `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const toml = `[mcp_servers.sticker]
command = ${JSON.stringify(command)}
args = ${array(args)}
cwd = ${JSON.stringify(cwd)}
env_vars = ${array(envVars)}
startup_timeout_sec = 15
tool_timeout_sec = 30
`;
  return { command, args, cwd, envVars, toml };
}
