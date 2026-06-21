# Changelog

このプロジェクトの変更履歴です。フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

### Fixed

- 妖狐と恋人が両方生存したままゲーム終了条件を満たした場合、妖狐ではなく**恋人陣営が優先して勝利**するように修正（従来は妖狐が生存しているだけで恋人より優先されていた）
- 分断者の能力発動中（メインチャンネルが非表示状態）に、投票フェーズを経由せず勝敗が決まってゲームが終了すると、メインチャンネルの表示権限が復元されず結果発表が見えなくなる不具合を修正。ゲーム終了時に必ず分断状態を解除するよう変更
- 「白狼」を役職選択肢・闇鍋のランダム抽選プールから削除。`ROLE_MAP` が未登録のまま選択可能になっていたため、選んでも実際には村人に差し替わってしまう不具合があった（意図的に無効化されていた役職の選択肢だけが残っていた状態）
- 「狂信者」を人狼の隠れ家チャンネルに招待するよう修正。役職説明文に「誰が人狼かを知っている」とある通りの仕様に挙動を合わせた（従来はチャンネルに参加できていなかった）

### Added

- `CHANGELOG.md` を追加
- Issue / Pull Request テンプレートを追加
- `roles.ts` / `db.ts` の純粋関数に対する単体テスト（Vitest）を追加
  - テスト可能にするため、`db.ts` の `getRankInfo` / `getBaseWinPoints` / `getBaseLossPoints` を `export` 化（処理内容は変更なし）
- Husky + lint-staged によるコミット前自動チェックを追加
- 募集ロビーのEmbed色をマッチタイプに応じて変更（ランクマッチ＝黄金、練習試合＝緑）

## [1.1.0] - 2026-06-21

### Fixed

- ランクマッチ（レート変動あり）に切り替えた際、`teruteru`・`cupid`・`cat`・`thief`・`sorcerer`・`baker`・`psycho`・`ninja`・`fox` の9役職が選択中の設定から自動的に除外されてしまう挙動を撤廃。ランクマッチでも全役職を自由に選べるように変更。

### Changed

- `src/phase.ts`（2719行）を `src/phase/` ディレクトリに分割
    - `phase/utils.ts` — タイマー管理・役職抽選などの独立したヘルパー関数
    - `phase/core.ts` — 昼・投票・夜・朝・勝敗判定・終了処理（フェーズ間の相互依存が強いため意図的に集約）
    - `phase/index.ts` — 既存の `import * as Phases from './phase'` をそのまま使えるようにする re-export 窓口
- ESLint（Flat Config）・Prettier を導入し、`npm run lint` / `npm run format` で品質チェックできるように整備
- GitHub Actions による CI（型チェック・Lint・ビルド）と Docker ビルド検証を追加
- Render 向けデプロイ設定（`Dockerfile` / `render.yaml` / デプロイワークフロー）を追加
- README・CONTRIBUTING・LICENSE・`.env.example` を整備

## [1.0.0] - 2026-06-20

### Added

- 初回バージョン（TypeScript Edition）
