// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // db.ts はモジュール読み込み時に Supabase クライアントを初期化しようとするため、
    // テスト実行時は未設定のままで安全な分岐（null）に倒れることを確認済み。
    // 万一の接続防止のため、テスト環境では明示的に空文字をセットしておく。
    env: {
      SUPABASE_URL: '',
      SUPABASE_KEY: '',
    },
  },
});
