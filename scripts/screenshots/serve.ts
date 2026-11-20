// The smallest static server that hosts the built web client for the screenshots.
//
// It exists because a capture needs no MBM server: every request to /api is answered inside the
// browser (capture.ts), so all that is left is delivering the bundle. The client routes
// (/transactions, /settings …) have no file behind them, hence the fallback to index.html.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
};

export function serve(root: string, port: number): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const rel = decodeURIComponent(url.pathname) === "/" ? "/index.html" : decodeURIComponent(url.pathname);
        let file = path.join(root, rel);
        // Contain the path inside root: short-lived and local, but a traversal would read the repository
        if (!file.startsWith(root)) {
            res.writeHead(403).end("Forbidden");
            return;
        }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () =>
            resolve({
                origin: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(() => r())),
            }),
        );
    });
}
