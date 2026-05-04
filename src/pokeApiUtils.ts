// src/pokeApiUtils.ts の getRandomPokemonIdByArea を上書き

export const AREAS: Record<string, string[]> = {
    '草原': ['normal', 'flying'],
    '森': ['bug', 'grass', 'poison'],
    '海': ['water'],
    '洞窟': ['rock', 'ground', 'dark'],
    '火山': ['fire', 'fighting'],
    '雪山': ['ice', 'steel'],
    '霊園': ['ghost', 'psychic'],
    '神殿': ['dragon', 'fairy', 'electric']
};

// src/pokeApiUtils.ts に追加

// 今日の日付から、本日の大量発生ポケモンを「完全ランダム」で特定する関数
export async function getTodaysOutbreak() {
    const d = new Date();
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000); // JSTに変換
    
    // 日付を数値化してシード（種）にする（例：20260502）
    const dateSeed = jst.getFullYear() * 10000 + (jst.getMonth() + 1) * 100 + jst.getDate();

    // シード値を使った疑似乱数生成（全員が同じ結果になる）
    const random = (seed: number) => {
        let x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    };

    const areas = ['草原', '森', '海', '洞窟', '火山', '雪山', '霊園', '神殿'];
    
    // エリアを完全ランダムに決定
    const area = areas[Math.floor(random(dateSeed) * areas.length)];
    
    // ポケモンIDを1〜1025の中から完全ランダムに決定
    const pokeId = Math.floor(random(dateSeed + 1) * 1025) + 1;

    // PokeAPIから日本語の名前を取得する
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${pokeId}`);
    const data = await res.json();
    const jaName = data.names.find((n: any) => n.language.name === 'ja' || n.language.name === 'ja-Hrkt')?.name || data.name.toUpperCase();

    return { area, pokeId, name: jaName };
}


export async function getRandomPokemonIdByArea(areaName: string | null): Promise<number> {
    const outbreak = await getTodaysOutbreak();
    if (areaName === outbreak.area && Math.random() < 0.30) {
        return outbreak.pokeId; // 30%の確率で大量発生ポケモンが確定！
    }
    const d = new Date();
    const day = d.getDay(); // 0=日, 1=月, 2=火, 3=水, 4=木, 5=金, 6=土
    const hour = d.getHours();
    const isNight = hour >= 20 || hour < 5;

    // 🌟 10%の確率で「特定の曜日・時間・エリア」を満たした特別枠が出現！
    if (Math.random() < 0.10) {
        if (day === 5 && areaName === '霊園') return 425; // 金曜日の霊園: フワンテ
        if (day === 1 && areaName === '洞窟') return 35;  // 月曜日の洞窟: ピッピ
        if (day === 5 && areaName === '海') return 131;   // 金曜日の海: ラプラス
        if (isNight && areaName === '森') return 163;     // 夜の森: ホーホー
    }

    // エリア指定がない、または不正な場合は全種類から完全ランダム
    if (!areaName || !AREAS[areaName]) return Math.floor(Math.random() * 1025) + 1;

    let types = [...AREAS[areaName]]; 
    
    // 🌙 夜ならゴーストやあくタイプが出現テーブルに混ざる！
    if (isNight) types.push('ghost', 'dark');

    const randomType = types[Math.floor(Math.random() * types.length)];
    const res = await fetch(`https://pokeapi.co/api/v2/type/${randomType}`);
    const data = await res.json();
    const pokemons = data.pokemon.map((p: any) => {
        const urlParts = p.pokemon.url.split('/');
        return parseInt(urlParts[urlParts.length - 2]);
    }).filter((id: number) => id <= 1025);

    return pokemons[Math.floor(Math.random() * pokemons.length)];
}

// src/pokeApiUtils.ts の getMovesForLevel を置き換え
export async function getMovesForLevel(pokeData: any, level: number) {
    const levelUpMoves = pokeData.moves
        .map((m: any) => {
            const detail = m.version_group_details.find((v: any) => v.move_learn_method.name === 'level-up');
            return detail ? { url: m.move.url, level: detail.level_learned_at } : null;
        })
        .filter((m: any) => m && m.level <= level)
        .sort((a: any, b: any) => b.level - a.level);

    const validMoves: any[] = [];
    const moveDataList = await Promise.all(levelUpMoves.slice(0, 15).map((m: any) => fetch(m.url).then(r => r.json())));
    
    for (const m of moveDataList) {
        if (validMoves.length < 4) {
            const nameObj = m.names.find((n: any) => n.language.name === 'ja-Hrkt' || n.language.name === 'ja');
            const name = nameObj ? nameObj.name : m.name;
            const accuracy = m.accuracy || 100;
            const power = m.power || 0; // 🌟 威力0(変化技)も許容する
            const damageClass = m.damage_class.name;
            const pp = m.pp || 10;
            
            const ailment = m.meta?.ailment?.name !== 'none' ? m.meta?.ailment?.name : null;
            const statChanges = m.stat_changes?.map((sc: any) => ({ stat: sc.stat.name, change: sc.change })) || [];
            const healing = m.meta?.healing || 0;
            const target = m.target?.name || 'selected-pokemon'; 

            // 🌟 追加：状態異常とステータス変化の「発生確率」を取得
            const ailmentChance = m.meta?.ailment_chance || 0;
            const statChance = m.meta?.stat_chance || 0;

            // 配列に追加するプロパティに ailmentChance と statChance を足す
            validMoves.push({ name, power, type: m.type.name, damageClass, accuracy, pp, maxPp: pp, ailment, statChanges, healing, target, ailmentChance, statChance });
        }
    }
    
    if (validMoves.length === 0) validMoves.push({ name: 'たいあたり', power: 40, type: 'normal', damageClass: 'physical', accuracy: 100, pp: 35, maxPp: 35 });
    return validMoves;
}

