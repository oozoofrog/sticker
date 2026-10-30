import type { Express } from "express";
import type { MaintenanceController } from "../maintenance.js";
import { requestActor } from "../http-context.js";
import { DomainError } from "../domain-error.js";
export function registerMaintenanceRoutes(
  app: Express,
  maintenance: MaintenanceController,
) {
  app.get("/api/maintenance", (_req, res) => res.json(maintenance.snapshot()));
  for (const action of ["begin", "resume"] as const) {
    app.post(`/api/maintenance/${action}`, (req, res) => {
      const actor = requestActor(req);
      if (actor.role !== "owner" || !actor.canWrite)
        throw new DomainError(
          403,
          "OWNER_REQUIRED",
          "소유자만 유지보수 상태를 변경할 수 있습니다.",
        );
      res.json(maintenance.change(action, req.body));
    });
  }
}
