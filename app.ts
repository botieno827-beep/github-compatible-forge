import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Forge } from './store.ts';
import { handleGit } from './git.ts';
import { graphql, mcp } from './surfaces.ts';

const MAX_BODY = 64 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const bytes = Buffer.from(JSON.stringify(body ?? null));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': status === 204 ? 0 : bytes.length, ...headers });
  res.end(status === 204 ? undefined : bytes);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  let provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Native git commonly sends Basic auth with the access token as its password.
  if (header.startsWith('Basic ')) {
    const basic = Buffer.from(header.slice(6), 'base64').toString();
    const colon = basic.indexOf(':');
    provided = colon < 0 ? '' : basic.slice(colon + 1);
  }
  const left = Buffer.from(provided);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

export function createApp(options: { forge?: Forge; token?: string } = {}) {
  const forge = options.forge ?? new Forge();
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? 'local-development-only';
  if (!token) throw new Error('An empty access token is not allowed');
  let requestId = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('x-github-request-id', (++requestId).toString(16).padStart(16, '0'));
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (!authorized(req, token)) {
        req.resume();
        return json(res, 401, { message: 'Bad credentials' }, { 'www-authenticate': 'Basic realm="Local forge"' });
      }
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (gitMatch) {
        const repo = forge.getRepo(decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]));
        if (!repo) return json(res, 404, { message: 'Not Found' });
        const service = gitMatch[3] === 'info/refs' ? url.searchParams.get('service') ?? '' : gitMatch[3];
        if ((gitMatch[3] === 'info/refs' && method !== 'GET') || (gitMatch[3] !== 'info/refs' && method !== 'POST')) {
          return json(res, 405, { message: 'Method not allowed' });
        }
        const result = handleGit(repo.git, service, method as 'GET' | 'POST', await readBody(req), String(req.headers['git-protocol'] ?? ''));
        res.writeHead(result.status, { 'cache-control': 'no-cache', ...result.headers, 'content-length': result.body.length });
        return res.end(result.body);
      }
      let body: any = {};
      if (method !== 'GET' && method !== 'HEAD') {
        const raw = await readBody(req);
        if (raw.length) {
          try { body = JSON.parse(raw.toString('utf8')); }
          catch {
            return json(res, 400, url.pathname === '/mcp'
              ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
              : { message: 'Problems parsing JSON' });
          }
        }
      }
      if (url.pathname === '/api/graphql' && method === 'POST') return json(res, 200, await graphql(forge, body));
      if (url.pathname === '/mcp' && method === 'POST') {
        const result = await mcp(forge, body);
        return json(res, result.status, result.body, result.headers);
      }
      if (url.pathname === '/mcp' && method === 'DELETE') return json(res, 204, null);
      if (url.pathname.startsWith('/api/v3')) {
        const result = await forge.request(method, url.pathname + url.search, body, url);
        return json(res, result.status, result.body, result.headers);
      }
      json(res, 404, { message: 'Not Found' });
    } catch (error) {
      const status = Number((error as any)?.status ?? (error as any)?.statusCode ?? 500);
      if (status === 500) process.stderr.write(`[forge] ${error instanceof Error ? error.stack : String(error)}\n`);
      if (!res.headersSent) json(res, status, { message: status === 500 ? 'Internal server error' : (error as Error).message });
      else res.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 60_000;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return server;
}
