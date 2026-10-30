import type { MaintenanceController } from "../maintenance.js";
import type { Express } from "express";
import type { GithubService } from "../features/github.js";
import { requestActor as actor, requestId as id } from "../http-context.js";
/** Register after the common authentication and origin middleware. */
export function registerGithubRoutes(
  app: Express,
  github: GithubService,
  maintenance?: MaintenanceController,
) {
  const run = <T>(operation: () => Promise<T>): Promise<T> =>
    maintenance ? maintenance.runOperation(operation) : operation();
  app.get("/api/projects/:id/github", (req, res) =>
    res.json(github.connection(actor(req), id(req))),
  );
  app.put("/api/projects/:id/github", (req, res) =>
    res.json(github.connect(actor(req), id(req), req.body)),
  );
  app.delete("/api/projects/:id/github", (req, res) =>
    res.json(github.disconnect(actor(req), id(req), req.body)),
  );
  app.post("/api/projects/:id/github/verify", async (req, res) =>
    res.json(await run(() => github.verify(actor(req), id(req), req.body))),
  );
  app.get("/api/issues/:id/github-evidence", (req, res) =>
    res.json(github.list(actor(req), id(req))),
  );
  app.post("/api/issues/:id/github-evidence", (req, res) =>
    res.status(201).json(github.add(actor(req), id(req), req.body)),
  );
  app.get("/api/github-evidence/:id", (req, res) =>
    res.json(github.get(actor(req), id(req))),
  );
  app.delete("/api/github-evidence/:id", (req, res) =>
    res.json(github.remove(actor(req), id(req), req.body)),
  );
  app.post("/api/github-evidence/:id/refresh", async (req, res) =>
    res.json(await run(() => github.refresh(actor(req), id(req), req.body))),
  );
}
