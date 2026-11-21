import test from 'node:test';
import assert from 'node:assert/strict';
import { Forge } from '../store.ts';
import { graphql, mcp } from '../surfaces.ts';

function fixture() {
  const forge = new Forge('alice');
  const repo = forge.request('POST', '/api/v3/user/repos', { name: 'project' }).body;
  return { forge, repo };
}

test('GraphQL parses named operations, aliases, defaults and fragments against the shared repository', async () => {
  const { forge, repo } = fixture();
  const result = await graphql(forge, {
    operationName: 'RepositoryQuery',
    query: `query Unused { viewer { login } }
      query RepositoryQuery($owner: String! = "alice", $repo: String! = "project") {
        project: repository(owner: $owner, name: $repo) { ...Names databaseId owner { login } }
      }
      fragment Names on Repository { id name nameWithOwner }`,
  });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data.project)), { id: repo.node_id, name: 'project', nameWithOwner: 'alice/project', databaseId: repo.id, owner: { login: 'alice' } });
});

test('GraphQL mutations preserve REST data and global IDs, with cursor pages that do not overlap', async () => {
  const { forge, repo } = fixture();
  for (const title of ['First', 'Second', 'Third']) {
    const created = await graphql(forge, {
      query: 'mutation($input: CreateIssueInput!) { createIssue(input:$input) { issue { id number title state } } }',
      variables: { input: { repositoryId: repo.node_id, title, body: 'shared body' } },
    });
    assert.equal(created.errors, undefined);
    const issue = created.data.createIssue.issue;
    const read = forge.request('GET', `/api/v3/repos/alice/project/issues/${issue.number}`).body;
    assert.equal(issue.id, read.node_id);
    assert.equal(read.body, 'shared body');
  }
  const query = 'query($cursor:String) { repository(owner:"alice",name:"project") { issues(first:2,after:$cursor) { nodes { number } pageInfo { hasNextPage endCursor } } } }';
  const first = (await graphql(forge, { query })).data.repository.issues;
  const second = (await graphql(forge, { query, variables: { cursor: first.pageInfo.endCursor } })).data.repository.issues;
  assert.deepEqual([...first.nodes, ...second.nodes].map(node => node.number), [1, 2, 3]);
  assert.equal(first.pageInfo.hasNextPage, true);
  assert.equal(second.pageInfo.hasNextPage, false);
  const id = forge.request('GET', '/api/v3/repos/alice/project/issues/1').body.node_id;
  const closed = await graphql(forge, { query: 'mutation($id: ID!) { closeIssue(input:{issueId:$id}) { issue { state } } }', variables: { id } });
  assert.equal(closed.data.closeIssue.issue.state, 'CLOSED');
  assert.equal(forge.request('GET', '/api/v3/repos/alice/project/issues/1').body.state, 'closed');
});

test('GraphQL validates all fields before a mutation can execute and supports directives and Relay nodes', async () => {
  const { forge, repo } = fixture();
  const invalid = await graphql(forge, { query: `mutation { createIssue(input:{repositoryId:"${repo.node_id}",title:"should not exist"}) { issue { number noSuchField } } }` });
  assert.match(invalid.errors[0].message, /noSuchField/);
  assert.equal(forge.request('GET', '/api/v3/repos/alice/project/issues').body.length, 0);
  const node = await graphql(forge, { query: 'query($id: ID!, $hide:Boolean!) { node(id:$id) { id ... on Repository { name nameWithOwner @skip(if:$hide) } } }', variables: { id: repo.node_id, hide: true } });
  assert.equal(node.data.node.name, 'project');
  assert.equal(node.data.node.nameWithOwner, undefined);
  assert.equal((await graphql(forge, { query: '{repository(owner:"alice",name:"missing"){id}}' })).data.repository, null);
});

test('MCP discovery, independent concurrent IDs, validation and REST parity', async () => {
  const { forge } = fixture();
  const rpc = (id: any, method: string, params?: any) => mcp(forge, { jsonrpc: '2.0', id, method, params });
  const discover = await rpc(1, 'server/discover');
  assert.ok(discover.body.result.supportedVersions.includes('2026-07-28'));
  const tools = await rpc(2, 'tools/list');
  assert.equal(tools.body.result.tools.length, 6);
  assert.deepEqual(tools.body.result.tools, (await rpc(3, 'tools/list')).body.result.tools);
  assert.equal((await rpc(4, 'tools/call', { name: 'create_issue', arguments: {} })).body.error.code, -32602);
  assert.equal((await rpc(5, 'tools/call', { name: 'unknown', arguments: {} })).body.error.code, -32602);
  const replies = await Promise.all(['left', 'right'].map(id => rpc(id, 'tools/call', { name: 'create_issue', arguments: { owner: 'alice', repo: 'project', title: id } })));
  for (const reply of replies) {
    const issue = JSON.parse(reply.body.result.content[0].text);
    assert.equal(issue.title, reply.body.id);
    assert.equal(forge.request('GET', `/api/v3/repos/alice/project/issues/${issue.number}`).body.id, issue.id);
  }
  assert.equal((await mcp(forge, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
});

