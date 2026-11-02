#!/usr/bin/env node
// 手元で dist/ を見るための小さなサーバー。追加の依存なし。公開には使わない。
//
//   SITE_URL=http://localhost:8787/ npm run build && npm run serve
//
// ページの中のリンクはサイトの URL（SITE_URL）で書き出すので、手元で見る時は
// SITE_URL を localhost にしてビルドし直す。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 8787);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

if (!fs.existsSync(DIST)) {
  console.error('dist/ がありません。先に `npm run build` を実行してください。');
  process.exit(1);
}

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/\.\./g, '');
  let file = path.join(DIST, clean);
  if (!file.startsWith(DIST)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

http
  .createServer((req, res) => {
    const file = resolveFile(req.url || '/');
    if (!file) {
      res.writeHead(404, { 'content-type': TYPES['.html'] });
      res.end(fs.readFileSync(path.join(DIST, '404.html')));
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`http://localhost:${PORT}/ で dist/ を配っています（止めるのは Ctrl+C）`);
  });
