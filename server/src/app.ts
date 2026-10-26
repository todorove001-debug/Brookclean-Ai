import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type pg from "pg";
import { ZodError } from "zod";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import type { Storage } from "./storage/index.js";
import type { Sms } from "./services/sms.js";
import authRoutes from "./routes/auth.js";
import publicRoutes from "./routes/public.js";
import orderRoutes from "./routes/orders.js";
import tripRoutes from "./routes/trips.js";
import driverRoutes from "./routes/drivers.js";
import handoverRoutes from "./routes/handover.js";

export interface Deps { pool: pg.Pool; storage: Storage; sms: Sms }

declare module "fastify" {
  interface FastifyInstance { deps: Deps }
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  app.decorate("deps", deps);
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: "validation", message: "Проверьте поля", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: "bad_request", message: e.message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Ошибка сервера" });
  });

  app.get("/api/health", async () => {
    await deps.pool.query("select 1");
    return { ok: true };
  });
  await app.register(authRoutes, { prefix: "/api" });
  await app.register(publicRoutes, { prefix: "/api" });
  await app.register(orderRoutes, { prefix: "/api" });
  await app.register(tripRoutes, { prefix: "/api" });
  await app.register(driverRoutes, { prefix: "/api" });
  await app.register(handoverRoutes, { prefix: "/api" });
  return app;
}
