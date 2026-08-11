// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 自動テストから実際の戦績DBへ接続しないよう、明示的に無効化する。
    env: {
      SUPABASE_URL: "",
      SUPABASE_KEY: "",
      SUPABASE_SECRET_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
    },
  },
});
