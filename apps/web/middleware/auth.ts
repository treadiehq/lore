export default defineNuxtRouteMiddleware(async () => {
  if (import.meta.server) {
    const config = useRuntimeConfig();
    const cookieName = String(config.authCookieName ?? "lore_session");
    const token = useCookie<string | null>(cookieName).value?.trim();
    if (token === undefined || token === "") {
      return navigateTo("/login", { replace: true, redirectCode: 302 });
    }
  }

  const auth = useAuth();
  const session = await auth.getSession();

  if (session === null) {
    return navigateTo("/login", { replace: true });
  }
});
