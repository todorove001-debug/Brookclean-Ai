import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// DEMO=1: одна страница без сервера (имитация API) для показа заказчику
const demo = process.env.DEMO === "1";

export default defineConfig({
  base: demo ? "./" : "/",
  define: demo ? { "import.meta.env.VITE_DEMO": JSON.stringify("1") } : {},
  build: demo ? { outDir: "dist-demo", assetsInlineLimit: 100_000_000, cssCodeSplit: false, modulePreload: false, rollupOptions: { output: { inlineDynamicImports: true } } } : {},
  plugins: [
    react(),
    VitePWA({
      disable: demo,
      registerType: "autoUpdate",
      includeAssets: ["icons/favicon-32.png", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Brookclean · Доставка автомобилей",
        short_name: "Brookclean",
        description: "Расчёт доставки автовозом из Владивостока, договор и трекинг",
        lang: "ru",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#eef1f4",
        theme_color: "#14202e",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Трекинг открывается и без сети: показываем последнее известное положение
            urlPattern: ({ url }) => url.pathname.startsWith("/api/t/"),
            handler: "NetworkFirst",
            options: { cacheName: "tracking", networkTimeoutSeconds: 5, expiration: { maxEntries: 20 } },
          },
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com",
            handler: "CacheFirst",
            options: { cacheName: "fonts", expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
