import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";

function apiPort(value = process.env.API_PORT ?? process.env.PORT): number {
  const port = value === undefined ? 3004 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`API_PORT must be an integer from 1 to 65535, got "${value}"`);
  }
  return port;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.disable("x-powered-by");
  app.useBodyParser("json", {
    limit: process.env.API_JSON_BODY_LIMIT?.trim() || "1mb",
  });
  app.enableCors({
    origin: (process.env.NUXT_ORIGIN ?? "http://localhost:3002")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "idempotency-key",
      "x-request-id",
    ],
    exposedHeaders: ["x-request-id"],
    credentials: false,
  });
  app.enableShutdownHooks();

  await app.listen(
    apiPort(),
    process.env.API_HOST?.trim() || "0.0.0.0",
  );
}

void bootstrap();
