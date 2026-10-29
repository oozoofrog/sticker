import type { Express } from "express";
import type { HistoryService } from "../features/history.js";
import { requestActor as actor, requestId as id } from "../http-context.js";
export function registerHistoryRoutes(app: Express, history: HistoryService) {
  app.get("/api/issues/:id/history", (req, res) =>
    res.json(history.list(actor(req), id(req))),
  );
  app.get("/api/issues/:id/history/:changeId", (req, res) =>
    res.json(history.get(actor(req), id(req), req.params.changeId)),
  );
  app.post("/api/issues/:id/restore/preview", (req, res) =>
    res.json(history.preview(actor(req), id(req), req.body)),
  );
  app.post("/api/issues/:id/restore", (req, res) =>
    res.json(history.restore(actor(req), id(req), req.body)),
  );
}
