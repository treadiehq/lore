import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { McpService } from "./mcp.service.js";

@Module({
  imports: [AgentModule],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
