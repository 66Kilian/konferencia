// Helyi futtatás: kiszolgálja a public/ mappát és az /api/* végpontokat,
// ugyanazzal a kóddal, ami Vercelen serverless függvényként fut.

const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./lib/handler');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
// Ugyanazok a biztonsági fejlécek, mint Vercelen (HSTS nélkül, mert helyben HTTP)
const SECURITY_HEADERS = Object.fromEntries(
  require('./vercel.json')
    .headers[0].headers.filter((h) => h.key !== 'Strict-Transport-Security')
    .map((h) => [h.key, h.value])
);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

function serveFile(res, file, headers = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.statusCode = 404;
      return res.end('Nem található');
    }
    res.writeHead(200, { 'Content-Length': st.size, ...headers });
    fs.createReadStream(file).pipe(res);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (url.pathname.startsWith('/api/')) return handler(req, res);

    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || url.pathname === '/') file = path.join(PUBLIC, 'index.html');
    serveFile(res, file, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  })
  .listen(PORT, () => console.log(`\n  Tárgyaló fut:  http://localhost:${PORT}\n`));
