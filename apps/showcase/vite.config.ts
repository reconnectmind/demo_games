import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: "./",
  // Модель машины — бинарный ассет: без этого Vite пытается разобрать .glb как код.
  assetsInclude: ["**/*.glb"],
  resolve: {
    alias: {
      "@gamespace/core": resolve("../../packages/core/src/index.ts"),
      "@gamespace/ui-web": resolve("../../packages/ui-web/src/index.ts"),
      "@gamespace/games": resolve("../../packages/games/src/index.ts"),
      "@gamespace/protocol": resolve("../../packages/protocol/src/index.ts"),
    },
  },
  // Порт закреплён: витрину открывают по ссылке и по ней же присылают замечания,
  // а перезапуск с автоподбором порта уводил адрес то на 5173, то на следующий
  // свободный. strictPort — чтобы падать вслух, а не тихо переехать.
  server: { port: 5199, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
