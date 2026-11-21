import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObject = { type: string; data: Buffer; oid?: string };
export type TreeEntry = { mode: string; name: string; oid: string };
export const ZERO = '0'.repeat(40);
const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');
const TYPES = ['', 'commit', 'tree', 'blob', 'tag'];
const MAX_OBJECT = 64 * 1024 * 1024;

export function hashObject(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

export function parseCommit(data: Buffer) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const lines = text.slice(0, split < 0 ? text.length : split).split('\n');
  const field = (name: string) => lines.find(line => line.startsWith(name + ' '))?.slice(name.length + 1) ?? '';
  return { tree: field('tree'), parents: lines.filter(line => line.startsWith('parent ')).map(line => line.slice(7)),
    author: field('author'), committer: field('committer'), message: split < 0 ? '' : text.slice(split + 2) };
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset), zero = data.indexOf(0, space + 1);
    if (space < 0 || zero < 0 || zero + 21 > data.length) throw new Error('Malformed tree');
    entries.push({ mode: data.toString('ascii', offset, space), name: data.toString('utf8', space + 1, zero), oid: data.toString('hex', zero + 1, zero + 21) });
    offset = zero + 21;
  }
  return entries;
}

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
  if (data.length + 4 > 65520) throw new Error('Oversized pkt-line');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}

function packets(data: Buffer, stopAtFlush = false): { lines: Buffer[]; offset: number } {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const header = data.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('Invalid pkt-line');
    const size = parseInt(header, 16);
    offset += 4;
    if (size === 0) { if (stopAtFlush) break; else continue; }
    if (size === 1 || size === 2) continue;
    if (size < 4 || size > 65520 || offset + size - 4 > data.length) throw new Error('Truncated pkt-line');
    lines.push(data.subarray(offset, offset + size - 4));
    offset += size - 4;
  }
  return { lines, offset };
}

function readDelta(base: Buffer, delta: Buffer): Buffer {
  let cursor = 0;
  const variable = () => {
    let result = 0, shift = 0, byte: number;
    do {
      if (cursor >= delta.length || shift > 49) throw new Error('Invalid delta size');
      byte = delta[cursor++]; result += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    return result;
  };
  if (variable() !== base.length) throw new Error('Delta base size mismatch');
  const size = variable();
  if (size > MAX_OBJECT) throw new Error('Delta object too large');
  const output = Buffer.alloc(size);
  let target = 0;
  while (cursor < delta.length) {
    const opcode = delta[cursor++];
    if (opcode & 128) {
      let offset = 0, length = 0;
      for (let i = 0; i < 4; i++) if (opcode & (1 << i)) {
        if (cursor >= delta.length) throw new Error('Truncated delta');
        offset += delta[cursor++] * 2 ** (8 * i);
      }
      for (let i = 0; i < 3; i++) if (opcode & (1 << (4 + i))) {
        if (cursor >= delta.length) throw new Error('Truncated delta');
        length += delta[cursor++] * 2 ** (8 * i);
      }
      if (length === 0) length = 65536;
      if (offset + length > base.length || target + length > size) throw new Error('Invalid delta copy');
      base.copy(output, target, offset, offset + length); target += length;
    } else {
      if (opcode === 0 || cursor + opcode > delta.length || target + opcode > size) throw new Error('Invalid delta insertion');
      delta.copy(output, target, cursor, cursor + opcode); cursor += opcode; target += opcode;
    }
  }
  if (target !== size) throw new Error('Delta result size mismatch');
  return output;
}

/** Decode complete or thin PACK v2/v3 streams without invoking a git executable. */
export function unpack(pack: Buffer, existing: Map<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('Invalid pack');
  const version = pack.readUInt32BE(4), count = pack.readUInt32BE(8);
  if ((version !== 2 && version !== 3) || count > 1000000) throw new Error('Unsupported pack');
  const end = pack.length - 20;
  if (!createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end))) throw new Error('Pack checksum mismatch');
  type Entry = { offset: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string; object?: GitObject };
  const entries: Entry[] = [], byOffset = new Map<number, Entry>(), output = new Map<string, GitObject>();
  let cursor = 12;
  for (let index = 0; index < count; index++) {
    const offset = cursor;
    let byte = pack[cursor++], size = byte & 15, shift = 4;
    const type = (byte >> 4) & 7;
    while (byte & 128) {
      if (cursor >= end || shift > 49) throw new Error('Invalid object header');
      byte = pack[cursor++]; size += (byte & 127) * 2 ** shift; shift += 7;
    }
    if (size > MAX_OBJECT) throw new Error('Object too large');
    let baseOffset: number | undefined, baseOid: string | undefined;
    if (type === 6) {
      byte = pack[cursor++]; let distance = byte & 127;
      while (byte & 128) { if (cursor >= end) throw new Error('Invalid delta offset'); byte = pack[cursor++]; distance = (distance + 1) * 128 + (byte & 127); }
      baseOffset = offset - distance;
      if (baseOffset < 12 || baseOffset >= offset) throw new Error('Invalid delta base');
    } else if (type === 7) {
      if (cursor + 20 > end) throw new Error('Truncated delta oid');
      baseOid = pack.toString('hex', cursor, cursor + 20); cursor += 20;
    } else if (!TYPES[type]) throw new Error('Invalid object type');
    const inflated = inflateSync(pack.subarray(cursor, end), { info: true, maxOutputLength: MAX_OBJECT }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    cursor += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('Packed object size mismatch');
    const entry: Entry = { offset, type, data: inflated.buffer, baseOffset, baseOid };
    entries.push(entry); byOffset.set(offset, entry);
    if (type < 5) {
      const oid = hashObject(TYPES[type], entry.data); entry.object = { type: TYPES[type], data: entry.data, oid }; output.set(oid, entry.object);
    }
  }
  if (cursor !== end) throw new Error('Unexpected pack trailing data');
  let pending = entries.filter(entry => !entry.object);
  while (pending.length) {
    const remaining: Entry[] = [];
    for (const entry of pending) {
      const base = entry.baseOffset !== undefined ? byOffset.get(entry.baseOffset)?.object : output.get(entry.baseOid!) ?? existing.get(entry.baseOid!);
      if (!base) { remaining.push(entry); continue; }
      const data = readDelta(base.data, entry.data), oid = hashObject(base.type, data);
      entry.object = { type: base.type, data, oid }; output.set(oid, entry.object);
    }
    if (remaining.length === pending.length) throw new Error('Missing delta base');
    pending = remaining;
  }
  return output;
}

export class GitRepository {
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  defaultBranch: string;
  private compressed = new Map<string, Buffer>();
  private packCache = new Map<string, Buffer>();
  private sequence = 0;
  constructor(defaultBranch = 'main') { this.defaultBranch = defaultBranch; }

  resolve(ref = 'HEAD'): string | undefined {
    if (ref === 'HEAD') ref = `refs/heads/${this.defaultBranch}`;
    return this.refs.get(ref) ?? this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`) ?? (this.objects.has(ref) ? ref : undefined);
  }

  addObject(type: string, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data, oid });
    return oid;
  }

  readFiles(ref = 'HEAD'): Map<string, Buffer> {
    const result = new Map<string, Buffer>();
    let oid = this.resolve(ref);
    if (!oid) return result;
    const peeled = new Set<string>();
    while (this.objects.get(oid)?.type === 'tag') {
      if (peeled.has(oid)) throw new Error('Cyclic tag'); peeled.add(oid);
      oid = this.objects.get(oid)!.data.toString().match(/^object ([a-f0-9]{40})\n/)?.[1];
      if (!oid) return result;
    }
    if (this.objects.get(oid)?.type === 'commit') oid = parseCommit(this.objects.get(oid)!.data).tree;
    const walk = (tree: string, prefix: string, depth = 0) => {
      if (depth > 256) throw new Error('Tree too deep');
      const object = this.objects.get(tree);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, prefix + entry.name + '/', depth + 1);
        else { const blob = this.objects.get(entry.oid); if (blob?.type === 'blob') result.set(prefix + entry.name, blob.data); }
      }
    };
    walk(oid, ''); return result;
  }

  commitFiles(files: Map<string, Buffer>, message: string, branch: string, parents?: string[]): string {
    type Dir = Map<string, Dir | Buffer>;
    const root: Dir = new Map();
    for (const [path, bytes] of files) {
      const segments = path.split('/');
      if (segments.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) throw new Error('Invalid file path');
      let dir = root;
      segments.forEach((part, index) => {
        if (index === segments.length - 1) dir.set(part, Buffer.from(bytes));
        else {
          if (!dir.has(part)) dir.set(part, new Map());
          const child = dir.get(part); if (!(child instanceof Map)) throw new Error('File/directory collision'); dir = child;
        }
      });
    }
    const build = (dir: Dir): string => {
      const items = [...dir].map(([name, value]) => ({ name, tree: value instanceof Map, oid: value instanceof Map ? build(value) : this.addObject('blob', value) }));
      items.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.tree ? '/' : '')), Buffer.from(b.name + (b.tree ? '/' : ''))));
      const data = Buffer.concat(items.flatMap(item => [Buffer.from(`${item.tree ? '40000' : '100644'} ${item.name}\0`), Buffer.from(item.oid, 'hex')]));
      return this.addObject('tree', data);
    };
    const target = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    const old = this.refs.get(target), actualParents = parents ?? (old ? [old] : []);
    const identity = `Local Forge <forge@localhost> ${1735689600 + this.sequence++} +0000`;
    const commit = Buffer.from(`tree ${build(root)}\n${actualParents.map(parent => `parent ${parent}\n`).join('')}author ${identity}\ncommitter ${identity}\n\n${message.endsWith('\n') ? message : message + '\n'}`);
    const oid = this.addObject('commit', commit); this.refs.set(target, oid); return oid;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const queue = [descendant], seen = new Set<string>();
    while (queue.length) {
      const oid = queue.pop()!; if (oid === ancestor) return true;
      if (seen.has(oid)) continue; seen.add(oid);
      const obj = this.objects.get(oid);
      if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return false;
  }

  reachable(starts: string[], stops = new Set<string>(), depth = Infinity): { ids: Set<string>; shallow: Set<string> } {
    const ids = new Set<string>(), shallow = new Set<string>(), visited = new Map<string, number>();
    const queue: Array<[string, number]> = starts.map(oid => [oid, 1]);
    while (queue.length) {
      const [oid, level] = queue.pop()!;
      if ((visited.get(oid) ?? Infinity) <= level) continue; visited.set(oid, level);
      const obj = this.objects.get(oid); if (!obj) continue;
      ids.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data); queue.push([commit.tree, level]);
        if (level >= depth || stops.has(oid)) { if (commit.parents.length) shallow.add(oid); }
        else {
          // A merge can first reach a commit along a longer path. If a shorter path
          // later brings its parents into range, it is no longer a shallow boundary.
          shallow.delete(oid);
          queue.push(...commit.parents.map(parent => [parent, level + 1] as [string, number]));
        }
      } else if (obj.type === 'tree') queue.push(...parseTree(obj.data).filter(entry => entry.mode !== '160000').map(entry => [entry.oid, level] as [string, number]));
      else if (obj.type === 'tag') {
        const target = obj.data.toString().match(/^object ([a-f0-9]{40})\n/)?.[1]; if (target) queue.push([target, level]);
      }
    }
    return { ids, shallow };
  }

  pack(ids: Set<string>): Buffer {
    const key = [...ids].join(',');
    const cached = this.packCache.get(key); if (cached) return cached;
    const head = Buffer.alloc(12); head.write('PACK'); head.writeUInt32BE(2, 4); head.writeUInt32BE(ids.size, 8);
    const chunks = [head];
    for (const oid of ids) {
      let encoded = this.compressed.get(oid);
      if (!encoded) {
        const object = this.objects.get(oid)!;
        let size = object.data.length, byte = (TYPES.indexOf(object.type) << 4) | (size & 15); size = Math.floor(size / 16);
        const header = [byte | (size ? 128 : 0)];
        while (size) { byte = size & 127; size = Math.floor(size / 128); header.push(byte | (size ? 128 : 0)); }
        encoded = Buffer.concat([Buffer.from(header), deflateSync(object.data, { level: 1 })]);
        this.compressed.set(oid, encoded);
      }
      chunks.push(encoded);
    }
    const data = Buffer.concat(chunks), pack = Buffer.concat([data, createHash('sha1').update(data).digest()]);
    if (this.packCache.size >= 8) this.packCache.delete(this.packCache.keys().next().value!);
    this.packCache.set(key, pack); return pack;
  }
}

function sideband(data: Buffer): Buffer[] {
  const output: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65515) output.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + 65515)])));
  return output;
}

function advertise(repo: GitRepository, service: string, v2: boolean): Buffer {
  if (v2 && service === 'git-upload-pack') return Buffer.concat([
    ...['version 2\n', 'agent=local-forge/1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt), FLUSH,
  ]);
  const push = service === 'git-receive-pack';
  const capabilities = push ? 'report-status side-band-64k delete-refs ofs-delta agent=local-forge/1' : `multi_ack_detailed side-band-64k shallow ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=local-forge/1`;
  const output = [pkt(`# service=${service}\n`), FLUSH];
  const refs: Array<[string, string]> = [];
  const head = repo.resolve('HEAD'); if (head) refs.push(['HEAD', head]);
  refs.push(...repo.refs);
  if (!refs.length) output.push(pkt(`${ZERO} capabilities^{}\0${capabilities}\n`));
  refs.forEach(([name, oid], index) => output.push(pkt(`${oid} ${name}${index === 0 ? '\0' + capabilities : ''}\n`)));
  output.push(FLUSH); return Buffer.concat(output);
}

function lsRefs(repo: GitRepository, lines: string[]): Buffer {
  const prefixes = lines.filter(line => line.startsWith('ref-prefix ')).map(line => line.slice(11));
  const keep = (name: string) => prefixes.length === 0 || prefixes.some(prefix => name.startsWith(prefix));
  const output: Buffer[] = [];
  const symrefs = lines.includes('symrefs'), peel = lines.includes('peel');
  const head = repo.resolve('HEAD');
  if (keep('HEAD') && (head || lines.includes('unborn'))) output.push(pkt(`${head ?? 'unborn'} HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`));
  for (const [name, oid] of repo.refs) {
    if (!keep(name)) continue;
    let extra = '', object = repo.objects.get(oid), target = oid;
    const seen = new Set<string>();
    while (peel && object?.type === 'tag' && !seen.has(target)) {
      seen.add(target); target = object.data.toString().match(/^object ([a-f0-9]{40})\n/)?.[1] ?? target; object = repo.objects.get(target); extra = ` peeled:${target}`;
    }
    output.push(pkt(`${oid} ${name}${extra}\n`));
  }
  output.push(FLUSH); return Buffer.concat(output);
}

function fetchPack(repo: GitRepository, lines: string[], v2: boolean): Buffer {
  const values = (prefix: string) => lines.filter(line => line.startsWith(prefix + ' ')).map(line => line.slice(prefix.length + 1).split(' ')[0]);
  const wants = values('want'), haves = values('have'), oldShallow = new Set(values('shallow'));
  if (wants.some(oid => !repo.objects.has(oid))) throw new Error('Unknown wanted object');
  const deepen = Number(values('deepen')[0] ?? Infinity);
  if (!(deepen > 0)) throw new Error('Invalid depth');
  const held = repo.reachable(haves, oldShallow).ids;
  const wanted = repo.reachable(wants, new Set(), deepen);
  const ids = new Set([...wanted.ids].filter(oid => !held.has(oid)));
  const shallow = [...wanted.shallow], unshallow = [...oldShallow].filter(oid => wanted.ids.has(oid) && !wanted.shallow.has(oid));
  const output: Buffer[] = [];
  if (v2) {
    if (shallow.length || unshallow.length) {
      output.push(pkt('shallow-info\n'), ...shallow.map(oid => pkt(`shallow ${oid}\n`)), ...unshallow.map(oid => pkt(`unshallow ${oid}\n`)), DELIM);
    }
    output.push(pkt('packfile\n'), ...sideband(repo.pack(ids)), FLUSH);
  } else {
    if (values('deepen').length) output.push(...shallow.map(oid => pkt(`shallow ${oid}\n`)), ...unshallow.map(oid => pkt(`unshallow ${oid}\n`)), FLUSH);
    output.push(pkt('NAK\n'), ...sideband(repo.pack(ids)), FLUSH);
  }
  return Buffer.concat(output);
}

function receivePack(repo: GitRepository, body: Buffer): Buffer {
  const decoded = packets(body, true), commands = decoded.lines.map(line => line.toString('utf8').trimEnd());
  const side = commands[0]?.split('\0')[1]?.split(' ').includes('side-band-64k');
  let error = '';
  try {
    if (decoded.offset < body.length) {
      const incoming = unpack(body.subarray(decoded.offset), repo.objects);
      for (const [oid, object] of incoming) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  } catch (err) { error = err instanceof Error ? err.message : 'Unpack failed'; }
  const report: Buffer[] = [pkt(`unpack ${error || 'ok'}\n`)];
  for (const command of commands) {
    const [old, next, ref] = command.split('\0')[0].split(' ');
    let reason = error ? 'unpacker error' : '';
    if (!/^[a-f0-9]{40}$/.test(old ?? '') || !/^[a-f0-9]{40}$/.test(next ?? '') || !ref?.startsWith('refs/') || /[\s~^:?*\[\\\x00-\x1f]|\.\.|@\{/.test(ref) || ref.endsWith('/') || ref.endsWith('.lock')) reason = 'invalid ref';
    else if ((repo.refs.get(ref) ?? ZERO) !== old) reason = 'stale old object id';
    else if (next !== ZERO && !repo.objects.has(next)) reason = 'missing object';
    else if (old !== ZERO && next !== ZERO && !repo.isAncestor(old, next)) reason = 'non-fast-forward';
    if (!reason) { if (next === ZERO) repo.refs.delete(ref); else repo.refs.set(ref, next); }
    report.push(pkt(reason ? `ng ${ref} ${reason}\n` : `ok ${ref}\n`));
  }
  report.push(FLUSH);
  const bytes = Buffer.concat(report);
  return side ? Buffer.concat([...sideband(bytes), FLUSH]) : bytes;
}

export function handleGit(repo: GitRepository, service: string, method: string, body: Buffer = Buffer.alloc(0), protocol = '') {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return { status: 400, body: Buffer.from('Unsupported git service'), headers: { 'content-type': 'text/plain' } };
  const headers = { 'content-type': `application/x-${service}-${method === 'GET' ? 'advertisement' : 'result'}`, 'cache-control': 'no-cache' };
  try {
    if (method === 'GET') return { status: 200, body: advertise(repo, service, protocol.includes('version=2')), headers };
    if (method !== 'POST') return { status: 405, body: Buffer.alloc(0), headers };
    if (service === 'git-receive-pack') return { status: 200, body: receivePack(repo, body), headers };
    const lines = packets(body).lines.map(line => line.toString('utf8').trimEnd());
    const v2 = lines.some(line => line.startsWith('command='));
    const result = lines.includes('command=ls-refs') ? lsRefs(repo, lines) : fetchPack(repo, lines, v2);
    return { status: 200, body: result, headers };
  } catch (err) {
    return { status: 400, body: pkt(`ERR ${err instanceof Error ? err.message : 'Bad request'}\n`), headers };
  }
}
