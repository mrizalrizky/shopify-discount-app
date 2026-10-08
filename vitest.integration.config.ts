import { defineConfig } from "vitest/config";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://salecodes:salecodes@localhost:5433/salecodes_test";

export default defineConfig({
  test: {
    include: ["app/**/*.int.test.ts", "test/**/*.int.test.ts"],
    environment: "node",
    globalSetup: ["./test/integration-setup.ts"],
    fileParallelism: false,
    env: { DATABASE_URL: TEST_DATABASE_URL },
  },
});
