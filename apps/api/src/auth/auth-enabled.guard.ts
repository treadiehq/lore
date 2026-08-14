import { type CanActivate, Injectable } from "@nestjs/common";
import { AuthService } from "./auth.service.js";

@Injectable()
export class AuthEnabledGuard implements CanActivate {
  readonly #service: AuthService;

  constructor(service: AuthService) {
    this.#service = service;
  }

  canActivate(): boolean {
    this.#service.assertEnabled();
    return true;
  }
}
