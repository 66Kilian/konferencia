// Helyi futtatás: kiszolgálja a public/ mappát és az /api/* végpontokat,
// ugyanazzal a kóddal, ami Vercelen serverless függvényként fut.

const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./lib/handler');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = path.join(__dirname, 'data', 'uploads');
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
    if (url.pathname.startsWith('/api/')) return handler(req, res);

    if (url.pathname.startsWith('/uploads/')) {
      const id = path.basename(url.pathname);
      const name = url.searchParams.get('name') || id;
      const disp = url.searchParams.get('download') ? 'attachment' : 'inline';
      return serveFile(res, path.join(UPLOADS, id), {
        'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
    }

    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || url.pathname === '/') file = path.join(PUBLIC, 'index.html');
    serveFile(res, file, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  })
  .listen(PORT, () => console.log(`\n  Tárgyaló fut:  http://localhost:${PORT}\n`));
