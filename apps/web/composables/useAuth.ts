import type {
  AuthMessageResponse,
  AuthPublicConfig,
  AuthSession,
  AuthSessionResponse,
  PasswordChangeResponse,
} from "~/types/auth";

type AuthStatus = "idle" | "pending" | "authenticated" | "anonymous";

export function useAuth() {
  const session = useState<AuthSession | null>("auth-session", () => null);
  const status = useState<AuthStatus>("auth-status", () => "idle");
  const config = useState<AuthPublicConfig | null>("auth-config", () => null);
  const requestFetch = useRequestFetch();
  const requestHeaders = import.meta.server
    ? useRequestHeaders(["cookie"])
    : undefined;

  const isAuthenticated = computed(() => session.value !== null);
  const organizationName = computed(
    () => session.value?.workspaceName ?? "",
  );

  async function getSession(options: { force?: boolean } = {}) {
    if (!options.force && session.value !== null) {
      return session.value;
    }

    status.value = "pending";
    try {
      const response = await requestFetch<AuthSessionResponse>(
        "/api/auth/session",
        {
          ...(requestHeaders === undefined
            ? {}
            : { headers: requestHeaders }),
        },
      );
      session.value = response.session;
      status.value = "authenticated";
      return response.session;
    } catch {
      session.value = null;
      status.value = "anonymous";
      return null;
    }
  }

  async function getAuthConfig(options: { force?: boolean } = {}) {
    if (!options.force && config.value !== null) {
      return config.value;
    }
    config.value = await requestFetch<AuthPublicConfig>("/api/auth/config");
    return config.value;
  }

  async function login(
    email: string,
    password?: string,
  ): Promise<AuthMessageResponse | AuthSessionResponse> {
    const response = await requestFetch<
      AuthMessageResponse | AuthSessionResponse
    >("/api/auth/login", {
      method: "POST",
      body: { email, ...(password === undefined ? {} : { password }) },
    });
    if ("session" in response) {
      session.value = response.session;
      status.value = "authenticated";
    }
    return response;
  }

  async function signup(
    organizationName: string,
    email: string,
  ): Promise<AuthMessageResponse> {
    return await requestFetch<AuthMessageResponse>("/api/auth/signup", {
      method: "POST",
      body: { organizationName, email },
    });
  }

  async function verify(token: string): Promise<AuthSession> {
    status.value = "pending";
    try {
      const response = await requestFetch<AuthSessionResponse>(
        "/api/auth/verify",
        {
          method: "POST",
          body: { token },
        },
      );
      session.value = response.session;
      status.value = "authenticated";
      return response.session;
    } catch (error) {
      session.value = null;
      status.value = "anonymous";
      throw error;
    }
  }

  async function bootstrapOwner(
    email: string,
    password: string,
    bootstrapToken: string,
  ): Promise<AuthSession> {
    const response = await requestFetch<AuthSessionResponse>(
      "/api/auth/bootstrap",
      {
        method: "POST",
        body: { email, password, bootstrapToken },
      },
    );
    session.value = response.session;
    status.value = "authenticated";
    config.value = { mode: "local_owner", bootstrapRequired: false };
    return response.session;
  }

  async function resetPassword(
    token: string,
    password: string,
  ): Promise<AuthSession> {
    const response = await requestFetch<AuthSessionResponse>("/api/auth/reset", {
      method: "POST",
      body: { token, password },
    });
    session.value = response.session;
    status.value = "authenticated";
    return response.session;
  }

  async function changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<PasswordChangeResponse> {
    return await requestFetch<PasswordChangeResponse>("/api/auth/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
  }

  async function signOut(): Promise<void> {
    status.value = "pending";
    try {
      await requestFetch("/api/auth/logout", { method: "POST" });
    } finally {
      session.value = null;
      status.value = "anonymous";
    }
  }

  return {
    session,
    status,
    config,
    isAuthenticated,
    organizationName,
    getSession,
    getAuthConfig,
    login,
    signup,
    verify,
    bootstrapOwner,
    resetPassword,
    changePassword,
    signOut,
  };
}
