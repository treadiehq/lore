import { applyDecorators, UseGuards } from "@nestjs/common";
import { OwnerAuthGuard } from "./owner-auth.guard.js";

export function OwnerOnly(): MethodDecorator & ClassDecorator {
  return applyDecorators(UseGuards(OwnerAuthGuard));
}
