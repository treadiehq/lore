import { z } from "zod";
import { AuthenticatedWorkspaceSchema as BaseAuthenticatedWorkspaceSchema } from "./pilot-schemas.js";

export const AuthEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .pipe(z.email().max(320));
export type AuthEmail = z.infer<typeof AuthEmailSchema>;

export function normalizeAuthEmail(email: string): string {
  return AuthEmailSchema.parse(email);
}

export const AuthTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u);
export type AuthToken = z.infer<typeof AuthTokenSchema>;

export const WorkspaceTokenSecretSchema = z
  .string()
  .length(48)
  .regex(/^lore_[A-Za-z0-9_-]{43}$/u);
export type WorkspaceTokenSecret = z.infer<
  typeof WorkspaceTokenSecretSchema
>;

export const WorkspaceTokenNameSchema = z.string().trim().min(1).max(100);
export const WorkspaceTokenStatusSchema = z.enum([
  "active",
  "expired",
  "revoked",
]);
export type WorkspaceTokenStatus = z.infer<
  typeof WorkspaceTokenStatusSchema
>;

export const WorkspaceTokenSchema = z
  .object({
    id: z.uuid(),
    name: WorkspaceTokenNameSchema,
    tokenPrefix: z.string().min(4).max(16),
    status: WorkspaceTokenStatusSchema,
    expiresAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type WorkspaceToken = z.infer<typeof WorkspaceTokenSchema>;

export const ListWorkspaceTokensResponseSchema = z
  .object({
    tokens: z.array(WorkspaceTokenSchema),
  })
  .strict();
export type ListWorkspaceTokensResponse = z.infer<
  typeof ListWorkspaceTokensResponseSchema
>;

export const CreateWorkspaceTokenRequestSchema = z
  .object({
    name: WorkspaceTokenNameSchema,
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
export type CreateWorkspaceTokenRequest = z.infer<
  typeof CreateWorkspaceTokenRequestSchema
>;

export const CreateWorkspaceTokenResponseSchema = z
  .object({
    token: WorkspaceTokenSecretSchema,
    workspaceToken: WorkspaceTokenSchema,
  })
  .strict();
export type CreateWorkspaceTokenResponse = z.infer<
  typeof CreateWorkspaceTokenResponseSchema
>;

export const RevokeWorkspaceTokenResponseSchema = z
  .object({
    workspaceToken: WorkspaceTokenSchema,
  })
  .strict();
export type RevokeWorkspaceTokenResponse = z.infer<
  typeof RevokeWorkspaceTokenResponseSchema
>;

export const AuthUserStatusSchema = z.enum(["active", "disabled"]);
export type AuthUserStatus = z.infer<typeof AuthUserStatusSchema>;

export const AuthUserRoleSchema = z.enum(["owner", "member"]);
export type AuthUserRole = z.infer<typeof AuthUserRoleSchema>;

export const AuthModeSchema = z.enum([
  "magic_link",
  "local_owner",
  "disabled",
]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export const AuthPasswordSchema = z.string().min(12).max(1_024);
export type AuthPassword = z.infer<typeof AuthPasswordSchema>;

export const AuthSignupRequestSchema = z
  .object({
    organizationName: z.string().trim().min(1).max(200),
    email: AuthEmailSchema,
  })
  .strict();
export type AuthSignupRequest = z.infer<typeof AuthSignupRequestSchema>;

export const AuthLoginRequestSchema = z
  .object({
    email: AuthEmailSchema,
  })
  .strict();
export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;

export const LocalOwnerLoginRequestSchema = z
  .object({
    email: AuthEmailSchema,
    password: AuthPasswordSchema,
  })
  .strict();
export type LocalOwnerLoginRequest = z.infer<
  typeof LocalOwnerLoginRequestSchema
>;

export const LocalOwnerBootstrapClaimRequestSchema = z
  .object({
    email: AuthEmailSchema,
    password: AuthPasswordSchema,
  })
  .strict();
export type LocalOwnerBootstrapClaimRequest = z.infer<
  typeof LocalOwnerBootstrapClaimRequestSchema
>;

export const PasswordChangeRequestSchema = z
  .object({
    currentPassword: AuthPasswordSchema,
    newPassword: AuthPasswordSchema,
  })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "New password must differ from the current password",
    path: ["newPassword"],
  });
export type PasswordChangeRequest = z.infer<
  typeof PasswordChangeRequestSchema
>;

export const PasswordResetConsumeRequestSchema = z
  .object({
    token: AuthTokenSchema,
    password: AuthPasswordSchema,
  })
  .strict();
export type PasswordResetConsumeRequest = z.infer<
  typeof PasswordResetConsumeRequestSchema
>;

export const AuthInitiationResponseSchema = z
  .object({
    accepted: z.literal(true),
  })
  .strict();
export type AuthInitiationResponse = z.infer<
  typeof AuthInitiationResponseSchema
>;

export const AuthVerifyRequestSchema = z
  .object({
    token: AuthTokenSchema,
  })
  .strict();
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequestSchema>;

export const AuthSessionProfileSchema = z
  .object({
    userId: z.uuid(),
    email: AuthEmailSchema,
    workspaceId: z.uuid(),
    workspaceName: z.string().trim().min(1).max(200),
    organization: z.string().trim().min(1).max(200),
    role: AuthUserRoleSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type AuthSessionProfile = z.infer<typeof AuthSessionProfileSchema>;

export const AuthenticatedSessionResponseSchema = z
  .object({
    sessionToken: AuthTokenSchema,
    session: AuthSessionProfileSchema,
  })
  .strict();
export type AuthenticatedSessionResponse = z.infer<
  typeof AuthenticatedSessionResponseSchema
>;

export const AuthVerifyResponseSchema = AuthenticatedSessionResponseSchema;
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponseSchema>;

export const AuthSessionResponseSchema = z
  .object({
    session: AuthSessionProfileSchema,
  })
  .strict();
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const AuthPublicConfigResponseSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z.object({ mode: z.literal("magic_link") }).strict(),
  z
    .object({
      mode: z.literal("local_owner"),
      bootstrapRequired: z.boolean(),
    })
    .strict(),
]);
export type AuthPublicConfigResponse = z.infer<
  typeof AuthPublicConfigResponseSchema
>;

export const PasswordChangeResponseSchema = z
  .object({ changed: z.literal(true) })
  .strict();
export type PasswordChangeResponse = z.infer<
  typeof PasswordChangeResponseSchema
>;

export const AuthLogoutRequestSchema = z.object({}).strict().default({});
export type AuthLogoutRequest = z.infer<typeof AuthLogoutRequestSchema>;

export const AuthLogoutResponseSchema = z.undefined();
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponseSchema>;

export const AuthenticatedWorkspaceSchema =
  BaseAuthenticatedWorkspaceSchema.extend({
    credentialType: z.enum(["workspace_token", "session"]).optional(),
    userId: z.uuid().optional(),
    email: AuthEmailSchema.optional(),
    workspaceName: z.string().trim().min(1).max(200).optional(),
    role: AuthUserRoleSchema.optional(),
    sessionExpiresAt: z.iso.datetime().optional(),
  });
export type AuthenticatedWorkspace = z.infer<
  typeof AuthenticatedWorkspaceSchema
>;

export const ServerIdentitySchema = z
  .object({
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
    revision: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();
export type ServerIdentity = z.infer<typeof ServerIdentitySchema>;

export const WorkspaceIdentityResponseSchema = z
  .object({
    workspaceId: z.uuid(),
    workspaceName: z.string().trim().min(1).max(200),
    organization: z.string().trim().min(1).max(200),
    credentialType: z.enum(["workspace_token", "session"]),
    role: AuthUserRoleSchema.optional(),
    server: ServerIdentitySchema,
  })
  .strict();
export type WorkspaceIdentityResponse = z.infer<
  typeof WorkspaceIdentityResponseSchema
>;

export const SignupRequestSchema = AuthSignupRequestSchema;
export type SignupRequest = AuthSignupRequest;
export const LoginRequestSchema = AuthLoginRequestSchema;
export type LoginRequest = AuthLoginRequest;
export const AuthAcceptedResponseSchema = AuthInitiationResponseSchema;
export type AuthAcceptedResponse = AuthInitiationResponse;
export const VerifyRequestSchema = AuthVerifyRequestSchema;
export type VerifyRequest = AuthVerifyRequest;
export const VerifyResponseSchema = AuthVerifyResponseSchema;
export type VerifyResponse = AuthVerifyResponse;
export const SessionProfileSchema = AuthSessionProfileSchema;
export type SessionProfile = AuthSessionProfile;
export const SessionResponseSchema = AuthSessionResponseSchema;
export type SessionResponse = AuthSessionResponse;
export const LogoutRequestSchema = AuthLogoutRequestSchema;
export type LogoutRequest = AuthLogoutRequest;
export const LogoutResponseSchema = AuthLogoutResponseSchema;
export type LogoutResponse = AuthLogoutResponse;
