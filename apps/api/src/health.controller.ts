import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import type { DatabaseConnection } from "@lore-co/database";
import { Public } from "./common/public.decorator.js";
import { DATABASE_CONNECTION } from "./common/tokens.js";

@Public()
@Controller("health")
export class HealthController {
  readonly #connection: DatabaseConnection;

  constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
  ) {
    this.#connection = connection;
  }

  @Get()
  health(): { status: "ok"; check: "liveness" } {
    return { status: "ok", check: "liveness" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ok"; check: "readiness" }> {
    try {
      await this.#connection.client`select 1`;
      return { status: "ok", check: "readiness" };
    } catch {
      throw new ServiceUnavailableException("Database is not ready");
    }
  }
}
