// eslint.config.mjs
// ESLint v9+ の Flat Config 形式。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // このプロジェクトは any を許容する既存コードが多いため警告に留める（段階的に厳格化する想定）
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // ゲーム内テキスト（日本語の演出メッセージ）に意図的な全角スペース等が含まれるため無効化
      'no-irregular-whitespace': 'off',
      // 既存コードに残る @ts-ignore / 動的 require() は許容する（新規追加時は避けることを推奨）
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'no-useless-escape': 'warn',
    },
  },
  // Prettier と競合するフォーマット系ルールを無効化（必ず最後に置く）
  eslintConfigPrettier,
);
