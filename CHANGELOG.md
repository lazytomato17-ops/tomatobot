# Changelog

このプロジェクトの変更履歴です。フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [2.1.0] - 2026-08-13

### Added

- 1人用でも村人・人狼・狂人・占い師・騎士・霊能者から役職を抽選
- 通算成績・連勝・役職別成績を確認できる `/stats`
- 昼に疑う相手と根拠を表明し、NPCの投票判断へ反映する意見システム
- 占い師・霊能者の過去判定を日付付きで公開し、COを取り消せる機能
- βテスター向けに占い師3人・狂人2人までの複数配役設定

### Changed

- NPCの投票・質問・CO評価を公開情報に基づく判断へ改善
- 人狼・狂人NPCの占い騙りを試合開始時に決め、潜伏解除後は結果公開を継続
- 2日目に潜伏解除するNPCが、1日目と2日目の結果をまとめて公開するよう改善
- CO操作と表示、ロビーの配役設定を簡潔に整理
- 騎士の連続護衛を標準で許可
- 同票時のNPC再投票を性格と初回票に応じて調整
- 人間の占い師が未行動の場合の自動占いを30秒後に変更

### Fixed

- 占い結果の公開日や、偽結果公開後の未公開結果が正しく扱われない問題を修正
- NPCが自分の占い結果と矛盾する発言・投票を行う問題を修正
- 再戦時に前の試合結果が編集されて消える問題を修正
- Renderで依存関係の導入に失敗する問題を修正

## [2.0.0] - 2026-08-11

### Changed

- 多数の特殊機能を整理し、Discordで遊びやすいシンプルな人狼ゲームとして再構成
- 人間1人からNPCを加えて最大15人まで遊べる進行へ変更
- 基本役職を村人・人狼・狂人・占い師・騎士・霊能者に整理
- ロビー・議論・投票・夜・結果画面の表示と待ち時間を刷新

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
