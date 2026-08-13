import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import {
  InteractionController,
  ObservationController,
} from "./interaction.controller.js";
import { InteractionService } from "./interaction.service.js";

@Module({
  imports: [AgentModule],
  controllers: [InteractionController, ObservationController],
  providers: [InteractionService],
})
export class InteractionModule {}
