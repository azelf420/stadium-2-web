// Serves a built page on http://127.0.0.1:<port>/ with the headers a threaded page needs (SharedArrayBuffer):
// Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp. Local only.
//   node tools/serve.mjs <build dir> [port] [--rom <file>]    e.g. node tools/serve.mjs build/stadium2-web 8090 --rom roms/stadium2.us.z64
// --rom offers that file at /baserom.z64, which the page loads by itself (local play only: never serve a ROM publicly).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 8090);
const romIdx = process.argv.indexOf('--rom');
const rom = romIdx > 0 ? path.resolve(process.argv[romIdx + 1]) : null;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.json': 'application/json', '.png': 'image/png' };
http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = url === '/baserom.z64' && rom ? rom : path.join(root, url === '/' ? '/index.html' : url);
  if (!file.startsWith(root) && file !== rom) { res.writeHead(403).end(); return; }
  if (url === '/' && !fs.existsSync(file)) {
    const page = fs.readdirSync(root).find(f => f.endsWith('.html'));
    if (page) { res.writeHead(302, { Location: '/' + page }).end(); return; }
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': st.size,
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}/` + (rom ? ` (ROM ${rom})` : '')));
