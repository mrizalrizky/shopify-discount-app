import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    exclude: ["app/**/*.int.test.ts", "test/**", "node_modules/**"],
    environment: "node",
  },
});
