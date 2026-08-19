import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import {
  closeDatabase,
  createDatabase,
  PostgresAuthRepository,
  PostgresDevinConnectorRepository,
  PostgresMemoryRepository,
  PostgresPilotRepository,
  type DatabaseConnection,
} from "@lore-co/database";
import type { MemoryRepository } from "@lore-co/core";
import { apiDeploymentConfig } from "../common/deployment-config.js";
import {
  AUTH_REPOSITORY,
  DATABASE_CONNECTION,
  DEVIN_CONNECTOR_REPOSITORY,
  MEMORY_REPOSITORY,
  PILOT_REPOSITORY,
  SEMANTIC_MEMORY_STORE,
} from "../common/tokens.js";

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  readonly #connection: DatabaseConnection;
  #closed = false;

  constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
  ) {
    this.#connection = connection;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await closeDatabase(this.#connection);
  }
}

@Injectable()
class WorkspaceBootstrap implements OnApplicationBootstrap {
  readonly #repository: PostgresPilotRepository;

  constructor(
    @Inject(PILOT_REPOSITORY) repository: PostgresPilotRepository,
  ) {
    this.#repository = repository;
  }

  async onApplicationBootstrap(): Promise<void> {
    const bootstrap = apiDeploymentConfig().workspaceBootstrap;
    if (bootstrap === null) {
      return;
    }
    await this.#repository.ensureWorkspaceToken({
      token: bootstrap.token,
      organization: bootstrap.organization,
      workspaceName: bootstrap.name,
      tokenName: "environment-bootstrap",
    });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      useFactory: (): DatabaseConnection => createDatabase(),
    },
    {
      provide: MEMORY_REPOSITORY,
      inject: [DATABASE_CONNECTION],
      useFactory: (connection: DatabaseConnection): MemoryRepository =>
        new PostgresMemoryRepository(connection),
    },
    {
      provide: AUTH_REPOSITORY,
      inject: [DATABASE_CONNECTION],
      useFactory: (connection: DatabaseConnection): PostgresAuthRepository =>
        new PostgresAuthRepository(connection),
    },
    {
      provide: PILOT_REPOSITORY,
      inject: [DATABASE_CONNECTION],
      useFactory: (connection: DatabaseConnection): PostgresPilotRepository =>
        new PostgresPilotRepository(connection),
    },
    {
      provide: DEVIN_CONNECTOR_REPOSITORY,
      inject: [DATABASE_CONNECTION],
      useFactory: (
        connection: DatabaseConnection,
      ): PostgresDevinConnectorRepository =>
        new PostgresDevinConnectorRepository(connection),
    },
    {
      provide: SEMANTIC_MEMORY_STORE,
      useExisting: MEMORY_REPOSITORY,
    },
    DatabaseLifecycle,
    WorkspaceBootstrap,
  ],
  exports: [
    DATABASE_CONNECTION,
    AUTH_REPOSITORY,
    DEVIN_CONNECTOR_REPOSITORY,
    MEMORY_REPOSITORY,
    PILOT_REPOSITORY,
    SEMANTIC_MEMORY_STORE,
  ],
})
export class DatabaseModule {}
