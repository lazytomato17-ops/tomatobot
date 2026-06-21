// src/phase/index.ts
//
// phase ディレクトリの公開窓口（バレルファイル）。
// 旧 `src/phase.ts` をインポートしていた箇所（例: gameLogic.ts の `import * as Phases from './phase'`）が
// そのまま動作するよう、utils と core の公開関数をすべて re-export しています。
export * from './utils';
export * from './core';

// decideRoles / setupSpecialRoles は utils.ts 側に定義されています。
