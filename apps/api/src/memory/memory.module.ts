import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { SessionAuthGuard } from "../common/session-auth.guard.js";
import { MemoryController } from "./memory.controller.js";
import { MemoryService } from "./memory.service.js";

@Module({
  imports: [AgentModule, DatabaseModule],
  controllers: [MemoryController],
  providers: [MemoryService, SessionAuthGuard],
})
export class MemoryModule {}
