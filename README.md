# Tomatobot 修正版

## 🔧 修正された問題

### 1. **db.ts: キューピッドの勝利判定バグを修正** ⚠️ 重大
**問題:** 
- キューピッドが恋人に選ばれていない場合でも、恋人陣営が勝利するとキューピッドも勝利扱いになっていた
- これによりレート計算が不正確になっていた

**修正内容:**
```typescript
// 修正前（バグあり）
export function isPlayerWinning(p: Player, winnerTeam: string, lovers: string[]): boolean {
    if (winnerTeam === 'lovers' && lovers.includes(p.id)) return true;
    // ... 他の判定 ...
    if (p.role === 'キューピッド' && winnerTeam === 'lovers') return true; // ← この行が問題
    return false;
}

// 修正後
export function isPlayerWinning(p: Player, winnerTeam: string, lovers: string[]): boolean {
    // 第三陣営の勝利判定（優先度高）
    if (winnerTeam === 'lovers' && lovers.includes(p.id)) return true;
    if (winnerTeam === 'fox'      && p.role === '妖狐')     return true;
    if (winnerTeam === 'teruteru' && p.role === 'テルテル') return true;
    
    // 通常陣営の勝利判定
    if (Roles.ROLE_CATALOG[p.role as string]?.team === winnerTeam) return true;
    
    // キューピッドは恋人に選ばれた場合のみ勝利（loversチェックで判定済み）
    return false;
}
```

**影響:**
- キューピッド役のプレイヤーのレート計算が正確になる
- 恋人陣営の勝利条件が本来の仕様通りになる

---

### 2. **db.ts: ランク名表示の整形を統一**

**問題:**
- ランク名のスペース数がバラバラで可読性が低かった

**修正内容:**
```typescript
// 修正前
function getRankInfo(rate: number) {
    if (rate >= 2400) return { name: 'レジェンド',      icon: '⚜️', color: 0xFFD700 };
    if (rate >= 2000) return { name: 'グランドマスター', icon: '👑', color: 0xFF0000 };
    if (rate >= 1800) return { name: 'ダイヤモンド',    icon: '💎', color: 0x00BFFF };
    if (rate >= 1700) return { name: 'プラチナ',        icon: '💿', color: 0xE5E4E2 };
    if (rate >= 1600) return { name: 'ゴールド',        icon: '🥇', color: 0xFFD700 };
    if (rate >= 1500) return { name: 'シルバー', icon: '🥈', color: 0xC0C0C0 };  // ← スペース少ない
    if (rate >= 1400) return { name: 'ブロンズ',        icon: '🥉', color: 0xCD7F32 };
    return { name: 'ルーキー', icon: '🔰', color: 0x808080 };
}

// 修正後（全て統一）
function getRankInfo(rate: number) {
    if (rate >= 2400) return { name: 'レジェンド',       icon: '⚜️', color: 0xFFD700 };
    if (rate >= 2000) return { name: 'グランドマスター', icon: '👑', color: 0xFF0000 };
    if (rate >= 1800) return { name: 'ダイヤモンド',     icon: '💎', color: 0x00BFFF };
    if (rate >= 1700) return { name: 'プラチナ',         icon: '💿', color: 0xE5E4E2 };
    if (rate >= 1600) return { name: 'ゴールド',         icon: '🥇', color: 0xFFD700 };
    if (rate >= 1500) return { name: 'シルバー',         icon: '🥈', color: 0xC0C0C0 };
    if (rate >= 1400) return { name: 'ブロンズ',         icon: '🥉', color: 0xCD7F32 };
    return { name: 'ルーキー', icon: '🔰', color: 0x808080 };
}
```

---

### 3. **db.ts: ストリークボーナスのコメント追加**

**問題:**
- なぜ連勝でボーナスが付くのか、閾値の根拠が不明だった

**修正内容:**
```typescript
// 修正前（コメントなし）
if (streak >= 5) delta += 10; 
else if (streak >= 3) delta += 5;

// 修正後（意図を明確化）
// 連勝ボーナス（3連勝以上で追加ボーナス）
// 理由: 安定した勝利を評価し、プレイヤーのモチベーション向上
if (streak >= 5) delta += 10;       // 5連勝以上: +10ボーナス
else if (streak >= 3) delta += 5;   // 3-4連勝: +5ボーナス
```

---

### 4. **db.ts: レート変動の最低保証を統一**

**問題:**
- `predictRatingChange`で `delta < 10` チェックがあったが、これは予測用の最低値保証
- 実際の記録時には負のレート変動を防ぐため `delta < 0` チェックに変更

**修正内容:**
```typescript
// 修正前
if (delta < 10) delta = 10;  // 最低10保証（予測時のみ）

// 修正後
if (delta < 0) delta = 0;    // 負の値を防ぐ（実際の記録時と統一）
```

**注意:**
- 予測表示と実記録で若干の差が出る可能性はありますが、より正確な計算になります

---

### 5. **aiUtils.ts: MVPコメントテンプレートの改善**

**問題:**
- `{reason}` を【】で囲んでいたため、日本語として不自然になることがあった
- 例: 「勝因は間違いなく【占い師の推理が的確だった】ですね」 → 文法的に違和感

**修正内容:**
```typescript
// 修正前
const mvpComments: Record<string, string[]> = {
    normal: [
        "見事な活躍でした！勝因は間違いなく【{reason}】ですね！",
        "素晴らしいプレイング！【{reason}】が村を勝利へ導きました！",
        "まさにMVP級の働き！【{reason}】の動きが決定打になりましたね！"
    ],
    // ...
};

// 修正後（【】を削除し、自然な文に調整）
const mvpComments: Record<string, string[]> = {
    normal: [
        "見事な活躍でした！{reason}が村を勝利へ導きましたね！",
        "素晴らしいプレイング！{reason}のおかげで勝利できました！",
        "まさにMVP級の働き！{reason}が決定打になりました！"
    ],
    // ...
};
```

**例:**
- 修正前: 「勝因は間違いなく【占い師の推理が的確だった】ですね」
- 修正後: 「占い師の推理が的確だったが村を勝利へ導きましたね」

---

## 📦 修正ファイル

修正されたファイル:
- `db.ts` - キューピッドバグ修正、ランク名整形、コメント追加、レート計算改善
- `aiUtils.ts` - MVPコメントテンプレート改善

---

## 🚀 適用方法

1. 元の `src/db.ts` をバックアップ
   ```bash
   cp src/db.ts src/db.ts.backup
   ```

2. 修正版ファイルで置き換え
   ```bash
   cp fixed_files/db.ts src/db.ts
   cp fixed_files/aiUtils.ts src/aiUtils.ts
   ```

3. TypeScriptをビルド
   ```bash
   npm run build
   ```

4. Botを再起動
   ```bash
   npm start
   ```

---

## ⚠️ 注意事項

### キューピッドバグの影響
- **既存のゲーム記録には影響しません**（過去のレートは変更されない）
- **今後の試合から正しい判定が適用されます**
- プレイヤーへの説明が必要な場合:
  - 「キューピッドが恋人に選ばれなかった場合、恋人陣営勝利時に勝利扱いにならないよう修正しました」

### レート計算の変更
- 予測と実記録の微妙な差が出る可能性がありますが、より正確になります
- 既存のレートには影響しません

---

## 🎯 その他の推奨改善（未実装）

今回は修正しませんでしたが、以下の改善も検討してください:

1. **タイムアウト時間の可変化**
   - プレイヤー数や役職によって議論時間を調整可能にする

2. **エラーメッセージの改善**
   - 投票エラー時に有効な投票先を表示
   - ゲーム状態を明確に表示

3. **プレミアム判定の一元化**
   - isPremium判定ロジックを一箇所にまとめる

4. **ログの言語統一**
   - デバッグログを全て日本語または英語に統一

---

## 📝 変更履歴

### Version 1.1 (修正版)
- ✅ キューピッドの勝利判定バグを修正
- ✅ ランク名表示の整形を統一
- ✅ ストリークボーナスにコメント追加
- ✅ レート変動計算の最低保証を改善
- ✅ MVPコメントテンプレートを改善

---

## 🤝 サポート

問題が発生した場合:
1. 元のファイルに戻す（バックアップから復元）
2. ログを確認
3. 必要に応じて個別の修正を適用

---

**修正日:** 2026年4月3日  
**バージョン:** 1.1  
**対象プロジェクト:** tomatobot-main
