import http from 'http';

export function startHealthCheck() {
    // Renderは環境変数 PORT を自動で割り当てるので、それを使用します
    const port = process.env.PORT || 3000;

    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Tomatobot is running! 🍅');
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(port, () => {
        console.log(`[🚀 System] ヘルスチェックサーバーがポート ${port} で起動しました`);
    });
}