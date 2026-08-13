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
  })
  .strict();
export type AuthSessionProfile = z.infer<typeof AuthSessionProfileSchema>;

export const AuthVerifyResponseSchema = z
  .object({
    sessionToken: AuthTokenSchema,
    session: AuthSessionProfileSchema,
  })
  .strict();
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponseSchema>;

export const AuthSessionResponseSchema = z
  .object({
    session: AuthSessionProfileSchema,
  })
  .strict();
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

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
  });
export type AuthenticatedWorkspace = z.infer<
  typeof AuthenticatedWorkspaceSchema
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
