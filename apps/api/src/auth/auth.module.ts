import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { OwnerAuthGuard } from "../common/owner-auth.guard.js";
import { AuthEnabledGuard } from "./auth-enabled.guard.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [AuthService, AuthEnabledGuard, OwnerAuthGuard],
})
export class AuthModule {}
