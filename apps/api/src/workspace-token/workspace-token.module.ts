import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { OwnerAuthGuard } from "../common/owner-auth.guard.js";
import { WorkspaceTokenController } from "./workspace-token.controller.js";
import { WorkspaceTokenService } from "./workspace-token.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [WorkspaceTokenController],
  providers: [OwnerAuthGuard, WorkspaceTokenService],
})
export class WorkspaceTokenModule {}
