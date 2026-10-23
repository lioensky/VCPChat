'use strict';
const http = require('node:http');
const { URL } = require('node:url');
const { CentralStore, SyncError } = require('./nativeSyncCentralStore.cjs');

async function startSyncService({ dbPath, token, port = 0 }) {
  if (!token) throw new Error('Explicit sync token required');
  const store = new CentralStore(dbPath);
  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } });
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/v1/sync/pull') {
        const after = Number(url.searchParams.get('after_seq') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        return send(res, 200, store.pull(after, limit));
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/sync/push') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 1024 * 1024) throw new SyncError('BODY_TOO_LARGE', '1 MiB maximum', 413);
        }
        const op = JSON.parse(raw);
        return send(res, 200, store.apply(op));
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/sync/status') return send(res, 200, store.metrics());
      return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route' } });
    } catch (error) {
      return send(res, error.status || 400, { error: { code: error.code || 'BAD_REQUEST', message: error.message } });
    }
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { store.close(); throw error; }
  const { port: actualPort } = server.address();
  return {
    url: `http://127.0.0.1:${actualPort}`,
    store,
    close: async () => { await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())); store.close(); }
  };
}
module.exports = { startSyncService };
