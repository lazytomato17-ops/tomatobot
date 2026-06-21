// lint-staged.config.mjs
// git commit 時に「ステージされたファイルだけ」を対象にチェックする設定。
// 既存コードを丸ごと Prettier で整形すると巨大な差分になってしまうため（README参照）、
// ここでは新規・変更されたファイルにのみ Prettier と ESLint を適用する。
//
// 並列実行数の制御（メモリ対策）は .husky/pre-commit 側で
// `lint-staged --concurrent false` として渡している。
export default {
  'src/**/*.ts': ['eslint --fix', 'prettier --write'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
