import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import type { OutputBundle, OutputChunk } from "rollup";

// DEMO=1: одна страница без сервера (имитация API) для показа заказчику
const demo = process.env.DEMO === "1";

/** Файлы, нужные только панели сотрудников: сервер не отдаёт их на сайте клиента, service worker их не кэширует. */
const adminOnly = new Set<string>();

/**
 * Проверка сборки: в код сайта клиента не должны попасть тарифы (server/) и панель сотрудников (src/admin/).
 * Если попали — сборка падает. Заодно пишет admin-assets.json со списком файлов панели для сервера.
 */
function separateAdmin(): Plugin {
  return {
    name: "brookclean-separate-admin",
    apply: "build",
    generateBundle(_, bundle: OutputBundle) {
      const chunks = Object.values(bundle).filter((c): c is OutputChunk => c.type === "chunk");
      const reach = (entry: string) => {
        const seen = new Set<string>();
        const walk = (file: string) => {
          if (seen.has(file)) return;
          seen.add(file);
          const c = bundle[file] as OutputChunk | undefined;
          if (c?.type !== "chunk") return;
          [...c.imports, ...c.dynamicImports].forEach(walk);
          for (const css of c.viteMetadata?.importedCss ?? []) seen.add(css);
        };
        const start = chunks.find((c) => c.isEntry && c.facadeModuleId?.endsWith(entry));
        if (!start) this.error(`Нет точки входа ${entry}`);
        walk(start.fileName);
        return seen;
      };
      for (const c of chunks)
        for (const id of Object.keys(c.modules))
          if (id.includes("/server/")) this.error(`Тарифы с сервера попали в код сайта: ${id} → ${c.fileName}`);
      const client = reach("/index.html");
      for (const file of client) {
        const c = bundle[file];
        const leak = c?.type === "chunk" && Object.keys(c.modules).find((id) => id.includes("/src/admin/"));
        if (leak) this.error(`Код панели сотрудников попал на сайт клиента: ${leak} → ${file}`);
      }
      adminOnly.clear();
      for (const file of reach("/admin.html")) if (!client.has(file)) adminOnly.add(file);
      adminOnly.add("admin.html");
      this.emitFile({ type: "asset", fileName: "admin-assets.json", source: JSON.stringify([...adminOnly].sort(), null, 1) });
    },
  };
}

/** Разработка: /admin/... открывает панель (admin.html), как staff.<домен> на сервере. */
function adminDevRoute(): Plugin {
  return {
    name: "brookclean-admin-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/admin(\/|\?|$)/.test(req.url)) req.url = "/admin.html";
        next();
      });
    },
  };
}

export default defineConfig({
  base: demo ? "./" : "/",
  define: demo ? { "import.meta.env.VITE_DEMO": JSON.stringify("1") } : {},
  build: demo
    ? { outDir: "dist-demo", assetsInlineLimit: 100_000_000, cssCodeSplit: false, modulePreload: false, rollupOptions: { output: { inlineDynamicImports: true } } }
    : { rollupOptions: { input: { index: "index.html", admin: "admin.html" } } },
  plugins: [
    react(),
    ...(demo ? [] : [separateAdmin(), adminDevRoute()]),
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
        // Клиентский service worker не скачивает файлы панели сотрудников
        // и тяжёлый генератор PDF (≈2 МБ): он грузится, только когда клиент нажимает «Скачать PDF»
        globIgnores: ["**/node_modules/**", "admin.html", "admin-assets.json", "assets/pdfmake-*.js", "assets/vfs_fonts-*.js"],
        manifestTransforms: [async (entries) => ({ manifest: entries.filter((e) => !adminOnly.has(e.url)), warnings: [] })],
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
