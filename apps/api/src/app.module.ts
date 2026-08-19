import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AgentModule } from "./agent/agent.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ContextModule } from "./context/context.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { DevinConnectorModule } from "./devin/devin-connector.module.js";
import { ExtractionModule } from "./extraction/extraction.module.js";
import { HealthController } from "./health.controller.js";
import { InteractionModule } from "./interaction/interaction.module.js";
import { McpModule } from "./mcp/mcp.module.js";
import { MemoryModule } from "./memory/memory.module.js";
import { RetrievalModule } from "./retrieval/retrieval.module.js";
import { RequestContextInterceptor } from "./common/request-context.interceptor.js";
import { WorkspaceAuthGuard } from "./common/workspace-auth.guard.js";
import { TurnModule } from "./turn/turn.module.js";
import { ActivityModule } from "./activity/activity.module.js";
import { WorkspaceTokenModule } from "./workspace-token/workspace-token.module.js";
import { WorkspacePolicyModule } from "./workspace-policy/workspace-policy.module.js";
import { WorkspaceIdentityModule } from "./workspace-identity/workspace-identity.module.js";

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    ExtractionModule,
    RetrievalModule,
    AgentModule,
    MemoryModule,
    InteractionModule,
    ContextModule,
    TurnModule,
    DevinConnectorModule,
    ActivityModule,
    WorkspaceTokenModule,
    WorkspacePolicyModule,
    WorkspaceIdentityModule,
    McpModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: WorkspaceAuthGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestContextInterceptor,
    },
  ],
})
export class AppModule {}
