import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.ts';

async function fixture(run: (url: string, headers: Record<string, string>) => Promise<void>) {
  const server = createApp({ token: 'test-token' });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`, { authorization: 'Bearer test-token', 'content-type': 'application/json' }); }
  finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}

test('authentication, JSON errors, and MCP parser preserve server health', async () => fixture(async (base, headers) => {
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/api/v3/user/repos')).status, 401);
  assert.equal((await fetch(base + '/api/graphql', { method: 'POST', body: '{}' })).status, 401);
  const malformed = await fetch(base + '/mcp', { method: 'POST', headers, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  const restMalformed = await fetch(base + '/api/v3/user/repos', { method: 'POST', headers, body: '{broken' });
  assert.equal(restMalformed.status, 400);
  assert.match(restMalformed.headers.get('x-github-request-id') ?? '', /\S/);
  const root = await fetch(base + '/api/v3/', { headers });
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type') ?? '', /application\/json/);
}));

test('MCP concurrent writes share REST IDs and isolate JSON-RPC requests', async () => fixture(async (base, headers) => {
  const rpc = async (id: number, name: string, args: any) => (await fetch(base + '/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  })).json();
  const created = await rpc(1, 'create_repo', { name: 'shared' });
  assert.equal(created.id, 1);
  const repo = JSON.parse(created.result.content[0].text);
  const owner = repo.owner.login;
  const replies = await Promise.all([rpc(2, 'create_issue', { owner, repo: 'shared', title: 'First' }), rpc(3, 'create_issue', { owner, repo: 'shared', title: 'Second' })]);
  assert.deepEqual(replies.map((reply) => reply.id), [2, 3]);
  const issues = await (await fetch(`${base}/api/v3/repos/${owner}/shared/issues?state=all`, { headers })).json();
  assert.equal(issues.length, 2);
  assert.deepEqual(new Set(issues.map((issue: any) => issue.title)), new Set(['First', 'Second']));
  for (const reply of replies) {
    const issue = JSON.parse(reply.result.content[0].text);
    assert.equal(issues.find((candidate: any) => candidate.number === issue.number).id, issue.id);
  }
}));
