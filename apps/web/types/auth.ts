export interface AuthSession {
  userId: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  organization: string;
  role: "owner" | "member";
  expiresAt: string;
}

export interface AuthSessionResponse {
  session: AuthSession;
}

export interface AuthMessageResponse {
  message: string;
}

export type AuthPublicConfig =
  | { mode: "disabled" }
  | { mode: "magic_link" }
  | { mode: "local_owner"; bootstrapRequired: boolean };

export interface PasswordChangeResponse {
  changed: true;
}
