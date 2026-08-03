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
  build: { outDir: "dist", emptyOutDir: true },
});
