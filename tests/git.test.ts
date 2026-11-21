import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { GitRepository, handleGit, hashObject, parseCommit, pkt, unpack, ZERO } from '../git.ts';

function packedEntry(type: number, data: Buffer, prefix = Buffer.alloc(0)): Buffer {
  let size = data.length;
  const header = [(type << 4) | (size & 15) | (size > 15 ? 128 : 0)];
  size >>>= 4;
  while (size) { const next = size & 127; size >>>= 7; header.push(next | (size ? 128 : 0)); }
  return Buffer.concat([Buffer.from(header), prefix, deflateSync(data)]);
}

function pack(entries: Buffer[]): Buffer {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const content = Buffer.concat([header, ...entries]);
  return Buffer.concat([content, createHash('sha1').update(content).digest()]);
}

test('trees, commits and object packs round-trip nested and binary files', () => {
  const repo = new GitRepository('trunk');
  const files = new Map([['src/hello.txt', Buffer.from('hello\n')], ['data.bin', Buffer.from([0, 255, 13, 10])]]);
  const first = repo.commitFiles(files, 'initial', 'trunk');
  const second = repo.commitFiles(new Map([...files, ['nested/deep/file.txt', Buffer.from('second')]]), 'second', 'trunk');
  assert.deepEqual(parseCommit(repo.objects.get(second)!.data).parents, [first]);
  assert.equal(repo.resolve('HEAD'), second);
  assert.equal(repo.isAncestor(first, second), true);
  assert.equal(repo.isAncestor(second, first), false);
  assert.deepEqual(repo.readFiles(first), files);
  const ids = repo.reachable([second]).ids;
  const decoded = unpack(repo.pack(ids), new Map());
  assert.equal(decoded.size, ids.size);
  for (const oid of ids) assert.deepEqual(decoded.get(oid)!.data, repo.objects.get(oid)!.data);
});

test('REF_DELTA, OFS_DELTA and thin pack bases resolve and verify their hashes', () => {
  const base = Buffer.from('hello world\n'), wanted = Buffer.from('hello forge\n');
  const baseOid = hashObject('blob', base), wantedOid = hashObject('blob', wanted);
  const delta = Buffer.concat([Buffer.from([base.length, wanted.length, 0x90, 6, 6]), Buffer.from('forge\n')]);
  const ordinary = packedEntry(3, base);
  const reference = packedEntry(7, delta, Buffer.from(baseOid, 'hex'));
  assert.deepEqual(unpack(pack([ordinary, reference]), new Map()).get(wantedOid)!.data, wanted);
  assert.deepEqual(unpack(pack([reference]), new Map([[baseOid, { type: 'blob', data: base }]])).get(wantedOid)!.data, wanted);
  let distance = ordinary.length;
  const offsetBytes = [distance & 127];
  while ((distance = Math.floor(distance / 128)) > 0) { distance--; offsetBytes.unshift(128 | (distance & 127)); }
  const offset = packedEntry(6, delta, Buffer.from(offsetBytes));
  assert.deepEqual(unpack(pack([ordinary, offset]), new Map()).get(wantedOid)!.data, wanted);
  const corrupt = pack([ordinary, reference]); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => unpack(corrupt, new Map()), /checksum/);
  assert.throws(() => unpack(pack([reference]), new Map()), /Missing delta base/);
});

test('a mixed push applies its fast-forward ref while refusing its divergent ref', () => {
  const repo = new GitRepository();
  const first = repo.commitFiles(new Map([['a.txt', Buffer.from('one')]]), 'one', 'main');
  const second = repo.commitFiles(new Map([['a.txt', Buffer.from('two')]]), 'two', 'main');
  repo.refs.set('refs/heads/side', second);
  const forward = repo.commitFiles(new Map([['a.txt', Buffer.from('three')]]), 'three', 'scratch', [second]);
  const sibling = repo.commitFiles(new Map([['a.txt', Buffer.from('different')]]), 'different', 'sibling', [first]);
  const body = Buffer.concat([pkt(`${second} ${forward} refs/heads/main\0report-status\n`), pkt(`${second} ${sibling} refs/heads/side\n`), Buffer.from('0000'), repo.pack(new Set())]);
  const response = handleGit(repo, 'git-receive-pack', 'POST', body);
  assert.equal(response.status, 200);
  assert.match(response.body.toString(), /ok refs\/heads\/main\n/);
  assert.match(response.body.toString(), /ng refs\/heads\/side non-fast-forward\n/);
  assert.equal(repo.refs.get('refs/heads/main'), forward);
  assert.equal(repo.refs.get('refs/heads/side'), second);
  const remove = handleGit(repo, 'git-receive-pack', 'POST', Buffer.concat([pkt(`${second} ${ZERO} refs/heads/side\n`), Buffer.from('0000')]));
  assert.equal(remove.status, 200);
  assert.equal(repo.refs.has('refs/heads/side'), false);
});

test('malformed wire requests fail without damaging repository state', () => {
  const repo = new GitRepository();
  const oid = repo.commitFiles(new Map([['a.txt', Buffer.from('one')]]), 'one', 'main');
  const response = handleGit(repo, 'git-upload-pack', 'POST', Buffer.from('zzzzinvalid'));
  assert.equal(response.status, 400);
  assert.equal(repo.resolve('HEAD'), oid);
  assert.equal(handleGit(repo, 'git-upload-pack', 'GET', Buffer.alloc(0), 'version=2').status, 200);
});
