import type {
  AuthMessageResponse,
  AuthSession,
  AuthSessionResponse,
} from "~/types/auth";

type AuthStatus = "idle" | "pending" | "authenticated" | "anonymous";

export function useAuth() {
  const session = useState<AuthSession | null>("auth-session", () => null);
  const status = useState<AuthStatus>("auth-status", () => "idle");
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

  async function login(email: string): Promise<AuthMessageResponse> {
    return await requestFetch<AuthMessageResponse>("/api/auth/login", {
      method: "POST",
      body: { email },
    });
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
    isAuthenticated,
    organizationName,
    getSession,
    login,
    signup,
    verify,
    signOut,
  };
}
