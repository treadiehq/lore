import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { TurnController } from "./turn.controller.js";
import { TurnService } from "./turn.service.js";

@Module({
  imports: [AgentModule, DatabaseModule],
  controllers: [TurnController],
  providers: [TurnService],
  exports: [TurnService],
})
export class TurnModule {}
