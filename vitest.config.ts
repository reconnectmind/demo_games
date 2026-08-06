import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@gamespace/core": resolve("./packages/core/src/index.ts"),
      "@gamespace/ui-web": resolve("./packages/ui-web/src/index.ts"),
      "@gamespace/games": resolve("./packages/games/src/index.ts"),
      "@gamespace/race": resolve("./packages/race/src/index.ts"),
      "@gamespace/env": resolve("./packages/env/src/index.ts"),
      "@gamespace/car": resolve("./packages/car/src/index.ts"),
      "@gamespace/flora": resolve("./packages/flora/src/index.ts"),
      "@gamespace/protocol": resolve("./packages/protocol/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
