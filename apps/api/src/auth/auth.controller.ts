import {
  Body,
  Controller,
  Get,
  Headers,
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
  LocalOwnerBootstrapClaimRequestSchema,
  LocalOwnerLoginRequestSchema,
  PasswordChangeRequestSchema,
  PasswordResetConsumeRequestSchema,
  type AuthenticatedSessionResponse,
  type AuthInitiationResponse,
  type AuthLoginRequest,
  type AuthLogoutRequest,
  type AuthPublicConfigResponse,
  type AuthSessionResponse,
  type AuthSignupRequest,
  type AuthVerifyRequest,
  type AuthVerifyResponse,
  type LocalOwnerBootstrapClaimRequest,
  type LocalOwnerLoginRequest,
  type PasswordChangeRequest,
  type PasswordChangeResponse,
  type PasswordResetConsumeRequest,
} from "@lore-co/core";
import { OwnerOnly } from "../common/owner-only.decorator.js";
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
  @Get("config")
  config(): Promise<AuthPublicConfigResponse> {
    return this.#service.publicConfig();
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

  @Public()
  @Post("local-owner/bootstrap")
  @HttpCode(HttpStatus.OK)
  claimLocalOwner(
    @Body(new ZodValidationPipe(LocalOwnerBootstrapClaimRequestSchema))
    input: LocalOwnerBootstrapClaimRequest,
    @Headers("x-lore-owner-bootstrap-token") bootstrapToken: string | undefined,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<AuthenticatedSessionResponse> {
    return this.#service.claimLocalOwner(
      input,
      bootstrapToken?.trim() ?? "",
      request.ip ?? "unknown",
    );
  }

  @Public()
  @Post("password/login")
  @HttpCode(HttpStatus.OK)
  passwordLogin(
    @Body(new ZodValidationPipe(LocalOwnerLoginRequestSchema))
    input: LocalOwnerLoginRequest,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<AuthenticatedSessionResponse> {
    return this.#service.passwordLogin(input, request.ip ?? "unknown");
  }

  @Public()
  @Post("password/reset")
  @HttpCode(HttpStatus.OK)
  consumePasswordReset(
    @Body(new ZodValidationPipe(PasswordResetConsumeRequestSchema))
    input: PasswordResetConsumeRequest,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<AuthenticatedSessionResponse> {
    return this.#service.consumePasswordReset(
      input,
      request.ip ?? "unknown",
    );
  }

  @OwnerOnly()
  @Post("password/change")
  @HttpCode(HttpStatus.OK)
  changePassword(
    @Body(new ZodValidationPipe(PasswordChangeRequestSchema))
    input: PasswordChangeRequest,
    @Req() request: WorkspaceHttpRequest,
  ): Promise<PasswordChangeResponse> {
    return this.#service.changePassword(requireWorkspace(request), input);
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
