import { Module } from "@nestjs/common";
import { WorkspaceIdentityController } from "./workspace-identity.controller.js";
import { WorkspaceIdentityService } from "./workspace-identity.service.js";

@Module({
  controllers: [WorkspaceIdentityController],
  providers: [WorkspaceIdentityService],
})
export class WorkspaceIdentityModule {}
