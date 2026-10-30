import type { Server } from "node:http";
import type { MaintenanceController } from "./maintenance.js";
/** Stop this server only. Never close data while an admitted async operation can write. */
export function createShutdown({
  server,
  maintenance,
  closeData,
  timeoutMs = 10_000,
}: {
  server: Server;
  maintenance: MaintenanceController;
  closeData: () => void;
  timeoutMs?: number;
}): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined;
  return () => {
    if (pending) return pending;
    maintenance.stop();
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = new Promise<boolean>((resolve) =>
        server.close((error) => {
          resolve(!error);
        }),
      );
      const drained = Promise.all([
        closed,
        maintenance.waitForIdle(timeoutMs),
      ]).then(([http, operations]) => http && operations);
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      });
      const success = await Promise.race([drained, timeout]);
      clearTimeout(timer);
      if (!success) return false;
      try {
        closeData();
        return true;
      } catch {
        return false;
      }
    })();
    return pending;
  };
}
