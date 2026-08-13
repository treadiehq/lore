import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  compatibilityDate: "2025-05-15",
  css: ["~/assets/css/main.css"],
  app: {
    head: {
      link: [
        { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
        { rel: "apple-touch-icon", href: "/img/logo.png" },
      ],
    },
  },
  components: [{ path: "~/components", pathPrefix: false }],
  experimental: {
    appManifest: false,
  },
  devServer: {
    port: 3002,
  },
  runtimeConfig: {
    loreApiUrl: "http://localhost:3004",
    authCookieName: "lore_session",
    authCookieSecure:
      process.env.NUXT_AUTH_COOKIE_SECURE === undefined
        ? process.env.NODE_ENV === "production"
        : process.env.NUXT_AUTH_COOKIE_SECURE === "true",
    public: {
      apiBaseUrl: "/api/lore",
      connectorApiUrl:
        process.env.NUXT_PUBLIC_LORE_CONNECTOR_API_URL ??
        "http://localhost:3004",
      loreInstallUrl:
        process.env.NUXT_PUBLIC_LORE_INSTALL_URL ??
        "https://raw.githubusercontent.com/treadiehq/lore/main/scripts/install.sh",
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
