import { githubProviderFromEnvironment } from "./github-provider-config.js";
import { readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { agentsSchema } from "./auth.js";
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be 1–65535.");
const agentInput: unknown = process.env.AGENT_CONFIG_PATH
  ? JSON.parse(readFileSync(process.env.AGENT_CONFIG_PATH, "utf8"))
  : [];
const instance = createApp({
  githubProvider: githubProviderFromEnvironment(process.env),
  dataDir: process.env.DATA_DIR ?? "data",
  ownerPassword: process.env.OWNER_PASSWORD ?? "",
  agents: agentsSchema.parse(agentInput),
  appOrigin: process.env.APP_ORIGIN ?? `http://localhost:${String(port)}`,
  secureCookies: process.env.SECURE_COOKIES === "true" ? true : undefined,
});
const server = instance.app.listen(
  port,
  process.env.HOST ?? "127.0.0.1",
  () => {
    console.log(
      `Sticker ready at ${process.env.APP_ORIGIN ?? `http://localhost:${String(port)}`} (private authenticated workspace)`,
    );
  },
);
function shutdown() {
  server.close(() => {
    instance.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
