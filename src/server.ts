import * as http from 'http';

export function startHealthCheck() {
    // Renderから指定されたポート、なければ10000を使用
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 10000;

    const server = http.createServer((req, res) => {
        // Renderの監視ロボットが /health だろうが /api だろうが、
        // どんなURLでアクセスしてきても「全部 200 OK」を返す最強設定
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Tomatobot is perfectly healthy! 🍅');
    });

    // 万が一Webサーバー内でエラーが起きても、ボット全体を道連れにしないための防御壁
    server.on('error', (err) => {
        console.error('[Error] ヘルスチェックサーバーでエラー発生:', err);
    });

    // 0.0.0.0 を指定して、外の世界からのアクセスを全開放
    server.listen(port, '0.0.0.0', () => {
        console.log(`[🚀 System] ヘルスチェックサーバーがポート ${port} で起動しました (http版)`);
    });
}
