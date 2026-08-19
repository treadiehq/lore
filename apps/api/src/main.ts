import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { apiDeploymentConfig } from "./common/deployment-config.js";

async function bootstrap(): Promise<void> {
  const deployment = apiDeploymentConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.disable("x-powered-by");
  app.useBodyParser("json", {
    limit: deployment.server.jsonBodyLimit,
  });
  if (deployment.corsOrigins.length > 0) {
    app.enableCors({
      origin: deployment.corsOrigins,
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
  }
  app.enableShutdownHooks();

  await app.listen(deployment.server.port, deployment.server.host);
}

void bootstrap();
