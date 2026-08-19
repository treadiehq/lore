import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { SessionAuthGuard } from "../common/session-auth.guard.js";
import { OwnerAuthGuard } from "../common/owner-auth.guard.js";
import { WorkspacePolicyController } from "./workspace-policy.controller.js";
import { WorkspacePolicyService } from "./workspace-policy.service.js";

@Module({
  imports: [AgentModule],
  controllers: [WorkspacePolicyController],
  providers: [OwnerAuthGuard, SessionAuthGuard, WorkspacePolicyService],
})
export class WorkspacePolicyModule {}
