import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { WorkspaceTokenController } from "./workspace-token.controller.js";
import { WorkspaceTokenService } from "./workspace-token.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [WorkspaceTokenController],
  providers: [WorkspaceTokenService],
})
export class WorkspaceTokenModule {}
