import http from 'http';

export function startHealthCheck() {
    // Renderは環境変数 PORT を自動で割り当てるので、それを使用します
    const port = process.env.PORT || 10000;

    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Tomatobot is running! 🍅');
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    // TypeScriptで型エラーが出ないように Number() で囲むと安全です
    const listenPort = Number(port);
    
    // 第2引数に '0.0.0.0' を追加！
    server.listen(listenPort, '0.0.0.0', () => {
        console.log(`[🚀 System] ヘルスチェックサーバーがポート ${listenPort} で起動しました`);
    });
}