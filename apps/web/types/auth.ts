export interface AuthSession {
  userId: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  organization: string;
}

export interface AuthSessionResponse {
  session: AuthSession;
}

export interface AuthMessageResponse {
  message: string;
}
