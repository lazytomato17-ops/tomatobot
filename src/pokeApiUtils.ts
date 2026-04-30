// src/pokeApiUtils.ts
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

// 指定タイプのポケモン一覧からランダムに1匹のIDを取得
export async function getRandomPokemonIdByArea(areaName: string | null): Promise<number> {
    if (!areaName || !AREAS[areaName]) return Math.floor(Math.random() * 1025) + 1;

    const types = AREAS[areaName];
    const randomType = types[Math.floor(Math.random() * types.length)];
    
    const res = await fetch(`https://pokeapi.co/api/v2/type/${randomType}`);
    const data = await res.json();
    const pokemons = data.pokemon.map((p: any) => {
        const urlParts = p.pokemon.url.split('/');
        return parseInt(urlParts[urlParts.length - 2]);
    }).filter((id: number) => id <= 1025); // 最新世代までに制限

    return pokemons[Math.floor(Math.random() * pokemons.length)];
}

// ポケモンのレベルアップ技を取得
export async function getMovesForLevel(pokeData: any, level: number) {
    const levelUpMoves = pokeData.moves
        .map((m: any) => {
            const detail = m.version_group_details.find((v: any) => v.move_learn_method.name === 'level-up');
            return detail ? { url: m.move.url, level: detail.level_learned_at } : null;
        })
        .filter((m: any) => m && m.level <= level)
        .sort((a: any, b: any) => b.level - a.level);

    const validMoves: any[] = [];
    const moveDataList = await Promise.all(levelUpMoves.slice(0, 12).map((m: any) => fetch(m.url).then(r => r.json())));
    // src/pokeApiUtils.ts の getMovesForLevel 関数内
    for (const m of moveDataList) {
        if (m.power && validMoves.length < 4) {
            const nameObj = m.names.find((n: any) => n.language.name === 'ja-Hrkt' || n.language.name === 'ja');
            const name = nameObj ? nameObj.name : m.name;
            // 🌟 命中率(accuracy)も取得する（APIでnullの場合は必中として100にする）
            const accuracy = m.accuracy || 100;
            validMoves.push({ name, power: m.power, type: m.type.name, damageClass: m.damage_class.name, accuracy });
        }
    }
    // デフォルト技にも命中率を追加
    if (validMoves.length === 0) validMoves.push({ name: 'たいあたり', power: 40, type: 'normal', damageClass: 'physical', accuracy: 100 });
    return validMoves;
}
