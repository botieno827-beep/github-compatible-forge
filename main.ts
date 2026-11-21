import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function harnessRequest(path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${envUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (path === '/register' && response.status === 409) return {};
      if (response.status === 400 || response.status === 405) {
        throw Object.assign(new Error(`${path}: HTTP ${response.status}`), { fatal: true });
      }
      if (response.ok) return await response.json();
    } catch (error) {
      if ((error as any)?.fatal) throw error;
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function main(): Promise<void> {
  const port = envUrl ? 0 : Number(process.env.FORGE_PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || port === 8080) {
    throw new Error('FORGE_PORT must be 0..65535 and cannot be 8080');
  }
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, process.env.FORGE_HOST ?? '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP bind failed');
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  const close = () => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  if (!envUrl) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => { void close().then(() => process.exit(0)); });
    }
    return;
  }
  await harnessRequest('/register', { port: address.port });
  process.stdout.write('[forge] registered\n');
  while ((await harnessRequest('/done')).done !== true) await sleep(250);
  await close();
  process.stdout.write('[forge] done\n');
}

main().catch((error) => {
  process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
