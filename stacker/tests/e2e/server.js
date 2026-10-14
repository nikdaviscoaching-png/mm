// Static server for the e2e tests: serves site/ with the SAME headers a production deploy sends (vercel.json / _headers).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.wasm': 'application/wasm', '.txt': 'text/plain' };
export function startServer(root, { port = 0, isolation = true, log = false } = {}) {
  const hits = [];
  const srv = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(root, p)); if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
      const st = await stat(file); if (!st.isFile()) throw new Error('not a file');
      const h = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'" };
      if (isolation) Object.assign(h, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' });
      if (p === '/sw.js' || p === '/index.html') h['Cache-Control'] = 'no-cache';
      hits.push(p); if (log) console.log('GET', p);
      res.writeHead(200, h); res.end(await readFile(file));
    } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => new Promise((r) => srv.close(r)) })));
}
