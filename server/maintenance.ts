import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { z } from "zod";
import { DomainError } from "./domain-error.js";
import {
  maintenanceControlSchema,
  type maintenanceStateSchema,
} from "./contracts/maintenance.js";

/** Per-process lifecycle only; not an agent registry or a persistent permission. */
export class MaintenanceController {
  private readonly instanceId = randomUUID();
  private revision = 0;
  private state: z.infer<typeof maintenanceStateSchema> = "serving";
  private startedAt: string | null = null;
  private active = 0;
  private readonly idleWaiters = new Set<() => void>();
  private lease() {
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      if (this.active === 0) for (const waiter of this.idleWaiters) waiter();
    };
  }
  async runOperation<T>(run: () => Promise<T>): Promise<T> {
    const release = this.lease();
    try {
      return await run();
    } finally {
      release();
    }
  }
  /** Callback-based parsers can finish after a client disconnects. */
  trackMiddleware(handler: RequestHandler): RequestHandler {
    return (req, res, next) => {
      void this.runOperation(
        () =>
          new Promise<void>((resolve, reject) => {
            let settled = false;
            try {
              handler(req, res, (error?: unknown) => {
                if (settled) return;
                settled = true;
                try {
                  next(error);
                  resolve();
                } catch (failure) {
                  reject(
                    failure instanceof Error
                      ? failure
                      : new Error("Middleware completion failed"),
                  );
                }
              });
            } catch (error) {
              reject(
                error instanceof Error ? error : new Error("Middleware failed"),
              );
            }
          }),
      ).catch(next);
    };
  }
  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.active === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.idleWaiters.delete(done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idleWaiters.delete(done);
        resolve(false);
      }, timeoutMs);
      this.idleWaiters.add(done);
    });
  }
  snapshot() {
    return {
      contractVersion: 1 as const,
      instanceId: this.instanceId,
      revision: this.revision,
      state: this.state,
      drained: this.state !== "serving" && this.active === 0,
      startedAt: this.startedAt,
    };
  }
  stop() {
    if (this.state !== "stopping") {
      this.state = "stopping";
      this.startedAt ??= new Date().toISOString();
      this.revision++;
    }
  }
  change(action: "begin" | "resume", input: unknown) {
    const data = maintenanceControlSchema.safeParse(input);
    if (!data.success)
      throw new DomainError(
        400,
        "INVALID_INPUT",
        "유지보수 요청을 확인하세요.",
      );
    if (
      data.data.instanceId !== this.instanceId ||
      data.data.revision !== this.revision
    )
      throw new DomainError(
        409,
        "REVISION_CONFLICT",
        "현재 서버 상태를 다시 확인하세요.",
      );
    if (this.state === "stopping")
      throw new DomainError(409, "SERVER_STOPPING", "서버가 종료 중입니다.");
    const next = action === "begin" ? "draining" : "serving";
    if (next !== this.state) {
      this.state = next;
      this.startedAt = next === "draining" ? new Date().toISOString() : null;
      this.revision++;
    }
    return this.snapshot();
  }
  readonly admit: RequestHandler = (req, res, next) => {
    const exempt =
      (req.method === "GET" &&
        ["/maintenance", "/session", "/access-mode"].includes(req.path)) ||
      (req.method === "POST" &&
        ["/maintenance/begin", "/maintenance/resume"].includes(req.path)) ||
      (req.method === "DELETE" && req.path === "/session");
    if (!exempt && this.state !== "serving") {
      res.set("Retry-After", "5").status(503).json({
        error: "스티커 점검 중입니다. 잠시 후 다시 확인하세요.",
        code: "MAINTENANCE",
        retryAfterSeconds: 5,
        maintenance: this.snapshot(),
      });
      return;
    }
    if (!exempt) {
      const release = this.lease();
      res.once("finish", release);
      res.once("close", release);
    }
    next();
  };
}
