import type { Express } from "express";
import type { GithubService } from "../features/github.js";
import { requestActor as actor, requestId as id } from "../http-context.js";
/** Register after the common authentication and origin middleware. */
export function registerGithubRoutes(app: Express, github: GithubService) {
  app.get("/api/projects/:id/github/sources", (req, res) =>
    res.json(github.discovery.sources(actor(req), id(req))),
  );
  app.post("/api/projects/:id/github/repositories", async (req, res) =>
    res.json(
      await github.discovery.repositories(actor(req), id(req), req.body),
    ),
  );
  app.post("/api/projects/:id/github/select", async (req, res) =>
    res.json(await github.discovery.connect(actor(req), id(req), req.body)),
  );
  app.post("/api/projects/:id/github/selection-status", (req, res) =>
    res.json(github.discovery.status(actor(req), id(req), req.body)),
  );
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
    res.json(await github.verify(actor(req), id(req), req.body)),
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
    res.json(await github.refresh(actor(req), id(req), req.body)),
  );
}
