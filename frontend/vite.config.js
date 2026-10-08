import process from "node:process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const API_NAVIGATION_PATHS = [
  /^\/api(?:\/|$)/,
  /^\/(?:predict|auth|predictions|stats|admin|reports)(?:\/|$)/,
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBaseUrl = env.VITE_API_BASE_URL?.trim();

  if (mode === "production") {
    if (!apiBaseUrl) {
      throw new Error(
        "VITE_API_BASE_URL wajib diisi untuk production build.",
      );
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(apiBaseUrl);
    } catch {
      throw new Error(
        "VITE_API_BASE_URL harus berupa URL HTTPS yang valid.",
      );
    }
    if (parsedUrl.protocol !== "https:") {
      throw new Error(
        "VITE_API_BASE_URL production harus menggunakan HTTPS.",
      );
    }
  }

  return {
    plugins: [
      react(),
      VitePWA({
        strategies: "generateSW",
        registerType: "prompt",
        injectRegister: false,
        includeManifestIcons: false,
        manifest: {
          name: "SawitVision",
          short_name: "SawitVision",
          description: "Teknologi pendukung analisis kematangan TBS sawit.",
          lang: "id",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#f6f4ec",
          theme_color: "#285c3b",
          icons: [
            {
              src: "/favicon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
          ],
        },
        workbox: {
          globPatterns: [
            "**/*.{html,js,css,svg,png,jpg,jpeg,webp,woff,woff2}",
          ],
          globIgnores: ["**/favicon.png"],
          navigateFallback: "index.html",
          navigateFallbackDenylist: API_NAVIGATION_PATHS,
          runtimeCaching: [],
          skipWaiting: false,
          clientsClaim: false,
          cleanupOutdatedCaches: false,
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    server: {
      host: true,
      allowedHosts: ["ancient-drivable-cupping.ngrok-free.dev"],
      proxy: {
        "/predict": {
          target: "http://localhost:8000",
          changeOrigin: true,
        },
      },
    },
  };
});
