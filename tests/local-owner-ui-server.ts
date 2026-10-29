import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
const dataDir = mkdtempSync(join(tmpdir(), "sticker-local-owner-browser-"));
const instance = createApp({
  dataDir,
  ownerPassword: "",
  localOwnerMode: "trusted-loopback",
  appOrigin: "http://127.0.0.1:8790",
});
instance.store.createProject(
  { id: "owner", name: "나", role: "owner", canWrite: true, projectIds: null },
  { key: "LOCAL", name: "로컬 접속 검증" },
);
const server = instance.app.listen(8790, "127.0.0.1");
function close() {
  server.closeAllConnections();
  server.close(() => {
    instance.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
