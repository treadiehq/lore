import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { ContextController } from "./context.controller.js";
import { ContextService } from "./context.service.js";

@Module({
  imports: [AgentModule, DatabaseModule],
  controllers: [ContextController],
  providers: [ContextService],
})
export class ContextModule {}
