// Run the kit's unchanged conformance/benchmark server against a separate forge process.
// This is an advisory native run; grade-local remains the sandbox authority.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const kit = resolve(root, 'github-core-clone-01-kit');
const { startEnv } = await import(pathToFileURL(resolve(kit, 'program/env/src/main.ts')).href);
const { run: score } = await import(pathToFileURL(resolve(kit, 'program/scorer/main.ts')).href);
const output = resolve(root, process.argv[2] ?? '.local/kit-native');
await mkdir(output, { recursive: true });
const messages: string[] = [];
const token = 'local-conformance-token';
const env = { ...process.env, MAKEFUN_SHOP_TOKEN: token, MAKEFUN_ENV_PORT: '0', MAKEFUN_ENV_HOST: '127.0.0.1', MAKEFUN_STATE_DIR: output };
const handle = await startEnv({ env, stateDir: output, port: 0, host: '127.0.0.1', log: (line: string) => {
  messages.push(line);
  process.stdout.write(`[kit] ${line}\n`);
} });
const child = spawn(process.execPath, ['main.ts'], { cwd: root, env: { ...env, MAKEFUN_ENV_URL: `http://127.0.0.1:${handle.address.port}` }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
child.stdout.on('data', (bytes: Buffer) => process.stdout.write(bytes));
child.stderr.on('data', (bytes: Buffer) => process.stderr.write(bytes));
let childResult: number | null = null;
const exited = new Promise<void>((done) => {
  child.on('error', (error: Error) => { process.stderr.write(`${error.message}\n`); childResult = 1; done(); });
  child.on('exit', (code: number | null) => { childResult = code ?? 1; done(); });
});
const watchdog = setTimeout(() => { child.kill(); void handle.stop('local runner timeout'); }, 840_000);
try {
  await handle.done;
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
  if (childResult === null) { child.kill(); await exited; }
} finally {
  clearTimeout(watchdog);
  await handle.stop('native run completed');
  await writeFile(resolve(output, 'suite.log'), messages.join('\n') + '\n');
}
const scores = score({ exportDir: resolve(output, 'export'), scoresDir: resolve(output, 'scores') });
const state = JSON.parse(await readFile(resolve(output, 'export/state.json'), 'utf8'));
const failed = Object.entries(state.checks ?? {}).filter(([, bit]) => bit !== 1).map(([id]) => id);
process.stdout.write(JSON.stringify({ node: process.version, childExitCode: childResult, scores, failed, output }, null, 2) + '\n');
process.exitCode = childResult === 0 && failed.length === 0 ? 0 : 1;
