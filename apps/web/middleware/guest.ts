export default defineNuxtRouteMiddleware(async () => {
  const auth = useAuth();
  const session = await auth.getSession({ force: true });

  if (session !== null) {
    return navigateTo("/activity", { replace: true, redirectCode: 302 });
  }
});
