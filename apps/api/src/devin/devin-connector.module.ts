import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { TurnModule } from "../turn/turn.module.js";
import { DevinConnectorController } from "./devin-connector.controller.js";
import { DevinConnectorService } from "./devin-connector.service.js";

@Module({
  imports: [DatabaseModule, TurnModule],
  controllers: [DevinConnectorController],
  providers: [DevinConnectorService],
  exports: [DevinConnectorService],
})
export class DevinConnectorModule {}
