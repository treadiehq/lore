import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import {
  AuthLoginRequestSchema,
  AuthLogoutRequestSchema,
  AuthSignupRequestSchema,
  AuthVerifyRequestSchema,
  type AuthInitiationResponse,
  type AuthLoginRequest,
  type AuthLogoutRequest,
  type AuthSessionResponse,
  type AuthSignupRequest,
  type AuthVerifyRequest,
  type AuthVerifyResponse,
} from "@lore-co/core";
import { Public } from "../common/public.decorator.js";
import {
  requireWorkspace,
  type WorkspaceHttpRequest,
} from "../common/request-context.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AuthService } from "./auth.service.js";

@Controller("v1/auth")
export class AuthController {
  readonly #service: AuthService;

  constructor(service: AuthService) {
    this.#service = service;
  }

  @Public()
  @Post("signup")
  @HttpCode(HttpStatus.ACCEPTED)
  signup(
    @Body(new ZodValidationPipe(AuthSignupRequestSchema))
    input: AuthSignupRequest,
  ): Promise<AuthInitiationResponse> {
    return this.#service.signup(input);
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.ACCEPTED)
  login(
    @Body(new ZodValidationPipe(AuthLoginRequestSchema))
    input: AuthLoginRequest,
  ): Promise<AuthInitiationResponse> {
    return this.#service.login(input);
  }

  @Public()
  @Post("verify")
  @HttpCode(HttpStatus.OK)
  verify(
    @Body(new ZodValidationPipe(AuthVerifyRequestSchema))
    input: AuthVerifyRequest,
  ): Promise<AuthVerifyResponse> {
    return this.#service.verify(input);
  }

  @Get("session")
  session(@Req() request: WorkspaceHttpRequest): AuthSessionResponse {
    return this.#service.session(requireWorkspace(request));
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(
    @Body(new ZodValidationPipe(AuthLogoutRequestSchema))
    _input: AuthLogoutRequest,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<void> {
    return this.#service.logout(requireWorkspace(request));
  }
}
