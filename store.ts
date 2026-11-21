import { createHash } from 'node:crypto';
import { GitRepository, parseCommit, parseTree } from './git.ts';

export type JsonObject = Record<string, any>;
export interface Reply { status: number; body: any; headers?: Record<string, string> }
export interface Repo extends JsonObject {
  id: number;
  node_id: string;
  name: string;
  owner: JsonObject;
  full_name: string;
  default_branch: string;
  git: GitRepository;
  issues: Map<number, JsonObject>;
  pulls: Map<number, JsonObject>;
  labels: Map<string, JsonObject>;
  comments: Map<number, JsonObject[]>;
  nextNumber: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const error = (status: number, message: string): never => { throw new ApiError(status, message); };
const nodeId = (kind: string, id: number) => Buffer.from(`${kind}:${id}`).toString('base64');
const oidFor = (type: string, data: Buffer) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
const equalBytes = (a?: Buffer, b?: Buffer) => a === undefined ? b === undefined : b !== undefined && a.equals(b);
const countLines = (bytes?: Buffer) => !bytes || bytes.length === 0 ? 0 : bytes.toString('utf8').split('\n').length - (bytes.at(-1) === 10 ? 1 : 0);

/** One account and an independent in-process object/database store shared by every surface. */
export class Forge {
  repos = new Map<string, Repo>();
  owner: string;
  private ownerBound: boolean;
  private sequence = 1000;
  private clock = 0;

  constructor(owner = process.env.MAKEFUN_OWNER || process.env.FORGE_OWNER || '') {
    this.owner = owner || 'forge';
    this.ownerBound = Boolean(owner);
  }

  private stamp() { return new Date(1_735_689_600_000 + this.clock++).toISOString(); }
  private id() { return ++this.sequence; }
  private user() { return { login: this.owner, id: 1, node_id: nodeId('User', 1), type: 'User', site_admin: false }; }

  /** Opaque trial credentials have no embedded login; the first addressed owned repo establishes it. */
  getRepo(owner: string, name: string): Repo | undefined {
    const repo = this.repos.get(name.toLowerCase());
    if (!repo) return undefined;
    if (!this.ownerBound) {
      this.owner = owner;
      this.ownerBound = true;
      for (const item of this.repos.values()) {
        item.owner = this.user();
        item.full_name = `${owner}/${item.name}`;
      }
    }
    return owner.toLowerCase() === this.owner.toLowerCase() ? repo : undefined;
  }

  repositoryObject(repo: Repo): JsonObject {
    return {
      id: repo.id, node_id: repo.node_id, name: repo.name, full_name: repo.full_name,
      owner: this.user(), private: repo.private, description: repo.description,
      fork: false, default_branch: repo.default_branch, has_issues: true, has_projects: false,
      has_wiki: false, archived: false, disabled: false, visibility: repo.private ? 'private' : 'public',
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      created_at: repo.created_at, updated_at: repo.updated_at, pushed_at: repo.updated_at,
      url: `/api/v3/repos/${this.owner}/${repo.name}`, html_url: `/${this.owner}/${repo.name}`,
      clone_url: `/${this.owner}/${repo.name}.git`, git_url: `/${this.owner}/${repo.name}.git`,
      ssh_url: `git@localhost:${this.owner}/${repo.name}.git`, size: repo.git.objects.size,
      open_issues_count: [...repo.issues.values(), ...repo.pulls.values()].filter(x => x.state === 'open').length,
      stargazers_count: 0, watchers_count: 0, forks_count: 0,
    };
  }

  private putObject(repo: Repo, type: string, data: Buffer): string {
    const oid = oidFor(type, data);
    repo.git.objects.set(oid, { type, data, oid } as any);
    return oid;
  }

  private required(body: JsonObject, key: string): string {
    return typeof body[key] === 'string' && body[key].trim() !== '' ? body[key] : error(422, `${key} is required`);
  }

  private filePath(path: string): string {
    if (!path || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.' || p === '' || p.includes('\0'))) error(422, 'Invalid repository path');
    return path;
  }

  private branchName(name: string): string {
    if (!name || name.includes('..') || /[\x00-\x20~^:?*\[\\]/.test(name) || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock') || name.includes('@{') || name.includes('//')) error(422, 'Invalid reference name');
    return name;
  }

  private createRepo(body: JsonObject): Repo {
    const name = this.required(body, 'name');
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..' || name.length > 100) error(422, 'Invalid repository name');
    if (this.repos.has(name.toLowerCase())) error(422, 'Repository already exists');
    const branch = this.branchName(body.default_branch || 'main');
    const id = this.id();
    const now = this.stamp();
    const repo: Repo = {
      id, node_id: nodeId('Repository', id), name, full_name: `${this.owner}/${name}`,
      owner: this.user(), private: Boolean(body.private), description: body.description || '',
      default_branch: branch, created_at: now, updated_at: now,
      git: new GitRepository(branch), issues: new Map(), pulls: new Map(), labels: new Map(), comments: new Map(), nextNumber: 1,
    };
    this.repos.set(name.toLowerCase(), repo);
    if (body.auto_init) repo.git.commitFiles(new Map([['README.md', Buffer.from(`# ${name}\n`)]]), 'Initial commit', branch);
    return repo;
  }

  private paginate(items: any[], url: URL): Reply {
    const limit = Math.max(1, Math.min(100, Math.floor(Number(url.searchParams.get('per_page')) || 30)));
    const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
    const headers: Record<string, string> = {};
    const last = Math.max(1, Math.ceil(items.length / limit));
    const links: string[] = [];
    for (const [rel, p] of [['next', page < last ? page + 1 : 0], ['last', page < last ? last : 0], ['prev', page > 1 ? page - 1 : 0], ['first', page > 1 ? 1 : 0]] as const) {
      if (p) { const target = new URL(url); target.searchParams.set('page', String(p)); target.searchParams.set('per_page', String(limit)); links.push(`<${target.href}>; rel="${rel}"`); }
    }
    if (links.length) headers.link = links.join(', ');
    return { status: 200, body: items.slice((page - 1) * limit, page * limit), headers };
  }

  private commitObject(repo: Repo, sha: string): JsonObject {
    const object = repo.git.objects.get(sha);
    if (!object || object.type !== 'commit') error(404, 'Commit not found');
    const parsed = parseCommit(object.data);
    const identity = (text: any) => {
      const m = /^(.*?) <(.*?)> (\d+) ([+-]\d+)$/.exec(String(text || ''));
      return { name: m?.[1] || this.owner, email: m?.[2] || `${this.owner}@localhost`, date: new Date((Number(m?.[3]) || 1_735_689_600) * 1000).toISOString() };
    };
    return { sha, node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
      commit: { message: parsed.message.replace(/\n$/, ''), author: identity(parsed.author), committer: identity(parsed.committer), tree: { sha: parsed.tree }, verification: { verified: false, reason: 'unsigned', signature: null, payload: null } },
      parents: parsed.parents.map(sha => ({ sha })), author: this.user(), committer: this.user(),
      url: `/api/v3/repos/${this.owner}/${repo.name}/commits/${sha}`, html_url: `/${this.owner}/${repo.name}/commit/${sha}` };
  }

  private treeOid(repo: Repo, files: Map<string, Buffer>): string {
    const root: any = new Map();
    for (const [path, data] of files) {
      const parts = path.split('/'); let tree = root;
      for (let i = 0; i < parts.length - 1; i++) { if (!tree.has(parts[i])) tree.set(parts[i], new Map()); tree = tree.get(parts[i]); }
      tree.set(parts.at(-1), data);
    }
    const write = (tree: Map<string, any>): string => {
      const entries = [...tree].map(([name, value]) => ({ name, dir: value instanceof Map, oid: value instanceof Map ? write(value) : this.putObject(repo, 'blob', value) }));
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.dir ? '/' : '')), Buffer.from(b.name + (b.dir ? '/' : ''))));
      return this.putObject(repo, 'tree', Buffer.concat(entries.flatMap(e => [Buffer.from(`${e.dir ? '40000' : '100644'} ${e.name}\0`), Buffer.from(e.oid, 'hex')])));
    };
    return write(root);
  }

  private contentObject(repo: Repo, path: string, data: Buffer): JsonObject {
    return { type: 'file', encoding: 'base64', size: data.length, name: path.split('/').at(-1), path,
      content: data.toString('base64'), sha: oidFor('blob', data),
      url: `/api/v3/repos/${this.owner}/${repo.name}/contents/${path}`, html_url: `/${this.owner}/${repo.name}/blob/${repo.default_branch}/${path}` };
  }

  private contents(repo: Repo, method: string, path: string, body: JsonObject, url: URL): Reply {
    if (path) this.filePath(path);
    const branch = typeof body.branch === 'string' ? body.branch : repo.default_branch;
    const ref = method === 'GET' ? url.searchParams.get('ref') || repo.default_branch : branch;
    const tip = repo.git.resolve(ref);
    if (method !== 'GET' && branch !== repo.default_branch && !tip) error(404, 'Branch not found');
    if (method === 'GET' && !tip) error(404, 'Not Found');
    const files = tip ? new Map(repo.git.readFiles(tip)) : new Map<string, Buffer>();
    const old = files.get(path);
    if (method === 'GET') {
      if (old) return { status: 200, body: this.contentObject(repo, path, old) };
      const prefix = path ? `${path}/` : '';
      const entries = new Map<string, JsonObject>();
      for (const [file, bytes] of files) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length); const name = rest.split('/')[0];
        if (rest.includes('/')) {
          if (!entries.has(name)) {
            const subtree = new Map([...files].filter(([p]) => p.startsWith(`${prefix}${name}/`)).map(([p, b]) => [p.slice(prefix.length + name.length + 1), b]));
            entries.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: this.treeOid(repo, subtree), size: 0 });
          }
        } else entries.set(name, this.contentObject(repo, file, bytes));
      }
      if (!entries.size) error(404, 'Not Found');
      return { status: 200, body: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (!['PUT', 'DELETE'].includes(method)) error(404, 'Not Found');
    this.filePath(path);
    const message = this.required(body, 'message');
    if (old && body.sha !== oidFor('blob', old)) error(409, 'The file sha does not match the current blob');
    if (!old && body.sha) error(409, 'The file sha does not match the current blob');
    if (method === 'DELETE') {
      if (!old) error(404, 'Not Found');
      files.delete(path);
      const sha = repo.git.commitFiles(files, message, branch);
      repo.updated_at = this.stamp();
      return { status: 200, body: { content: null, commit: this.commitObject(repo, sha) } };
    }
    if (typeof body.content !== 'string' || !/^[A-Za-z0-9+/=\r\n\t ]*$/.test(body.content)) error(422, 'content must be base64 encoded');
    const bytes = Buffer.from(body.content, 'base64');
    // A file cannot simultaneously be a directory, and ancestors cannot be files.
    for (const existing of files.keys()) if (existing.startsWith(path + '/') || path.startsWith(existing + '/')) error(409, 'A file or directory already exists at this path');
    files.set(path, bytes);
    const sha = repo.git.commitFiles(files, message, branch);
    repo.updated_at = this.stamp();
    return { status: old ? 200 : 201, body: { content: this.contentObject(repo, path, bytes), commit: this.commitObject(repo, sha) } };
  }

  private labelsFor(repo: Repo, value: any): JsonObject[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) error(422, 'labels must be an array');
    return value.map(label => {
      const name = typeof label === 'string' ? label : label?.name;
      const found = repo.labels.get(String(name));
      return found || error(422, `Label does not exist: ${name}`);
    });
  }

  private createIssue(repo: Repo, body: JsonObject): JsonObject {
    const title = this.required(body, 'title'); const labels = this.labelsFor(repo, body.labels);
    const id = this.id(); const number = repo.nextNumber++; const now = this.stamp();
    const issue = { id, node_id: nodeId('Issue', id), number, title, body: body.body ?? '', state: 'open', labels,
      user: this.user(), assignee: null, assignees: [], milestone: null, locked: false, comments: 0,
      created_at: now, updated_at: now, closed_at: null, state_reason: null,
      url: `/api/v3/repos/${this.owner}/${repo.name}/issues/${number}`, html_url: `/${this.owner}/${repo.name}/issues/${number}` };
    repo.issues.set(number, issue); repo.updated_at = now;
    return issue;
  }

  private issueRoutes(repo: Repo, method: string, segments: string[], body: JsonObject, url: URL): Reply {
    if (!segments.length) {
      if (method === 'POST') return { status: 201, body: this.createIssue(repo, body) };
      if (method !== 'GET') error(404, 'Not Found');
      const state = url.searchParams.get('state') || 'open';
      let list = [...repo.issues.values(), ...[...repo.pulls.values()].map(p => ({ ...this.pullObject(repo, p), pull_request: { url: `/api/v3/repos/${this.owner}/${repo.name}/pulls/${p.number}` } }))];
      list = list.filter(i => state === 'all' || i.state === state);
      const labels = url.searchParams.get('labels');
      if (labels) list = list.filter(i => labels.split(',').every(name => i.labels?.some((l: any) => l.name === name)));
      const direction = url.searchParams.get('direction') === 'asc' ? 1 : -1;
      const sort = url.searchParams.get('sort') || 'created';
      list.sort((a, b) => direction * ((sort === 'comments' ? a.comments - b.comments : String(a[sort === 'updated' ? 'updated_at' : 'created_at']).localeCompare(String(b[sort === 'updated' ? 'updated_at' : 'created_at']))) || a.number - b.number));
      return this.paginate(list, url);
    }
    const number = Number(segments[0]);
    const issue = repo.issues.get(number) || repo.pulls.get(number);
    if (!issue) error(404, 'Not Found');
    if (segments.length === 1) {
      if (method === 'GET') return { status: 200, body: issue };
      if (method === 'PATCH') {
        if ('title' in body) issue.title = this.required(body, 'title');
        if ('body' in body) issue.body = body.body ?? '';
        if ('labels' in body) issue.labels = this.labelsFor(repo, body.labels);
        if ('state' in body) {
          if (!['open', 'closed'].includes(body.state)) error(422, 'Invalid issue state');
          issue.state = body.state; issue.closed_at = body.state === 'closed' ? this.stamp() : null;
          issue.state_reason = body.state_reason || (body.state === 'closed' ? 'completed' : null);
        }
        issue.updated_at = this.stamp();
        return { status: 200, body: issue };
      }
    }
    if (segments.length === 2 && segments[1] === 'comments') {
      if (method === 'GET') return this.paginate(repo.comments.get(number) || [], url);
      if (method === 'POST') {
        const text = this.required(body, 'body'); const id = this.id(); const now = this.stamp();
        const comment = { id, node_id: nodeId('IssueComment', id), body: text, user: this.user(), created_at: now, updated_at: now,
          url: `/api/v3/repos/${this.owner}/${repo.name}/issues/comments/${id}` };
        if (!repo.comments.has(number)) repo.comments.set(number, []);
        repo.comments.get(number)!.push(comment); issue.comments++; issue.updated_at = now;
        return { status: 201, body: comment };
      }
    }
    if (segments.length === 2 && segments[1] === 'labels') {
      if (method === 'GET') return { status: 200, body: issue.labels };
      if (['POST', 'PUT'].includes(method)) { const labels = this.labelsFor(repo, body.labels); issue.labels = method === 'PUT' ? labels : [...new Map([...issue.labels, ...labels].map((l: any) => [l.name, l])).values()]; return { status: 200, body: issue.labels }; }
    }
    error(404, 'Not Found');
  }

  private ancestors(repo: Repo, start?: string): Map<string, number> {
    const result = new Map<string, number>();
    const queue: [string, number][] = start ? [[start, 0]] : [];
    for (let i = 0; i < queue.length; i++) {
      const [sha, depth] = queue[i];
      if (result.has(sha)) continue;
      result.set(sha, depth);
      const object = repo.git.objects.get(sha);
      if (object?.type === 'commit') for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
    }
    return result;
  }

  private commonAncestor(repo: Repo, a?: string, b?: string): string | undefined {
    const left = this.ancestors(repo, a); const right = this.ancestors(repo, b);
    let best: string | undefined; let depth = Infinity;
    for (const [sha, distance] of right) if (left.has(sha) && distance + left.get(sha)! < depth) { best = sha; depth = distance + left.get(sha)!; }
    return best;
  }

  private mergeFiles(repo: Repo, pull: JsonObject): { files: Map<string, Buffer>; conflict: boolean } {
    const head = repo.git.resolve(pull.head.ref), base = repo.git.resolve(pull.base.ref);
    const common = this.commonAncestor(repo, head, base);
    const before = common ? repo.git.readFiles(common) : new Map<string, Buffer>();
    const incoming = head ? repo.git.readFiles(head) : new Map<string, Buffer>();
    const current = base ? repo.git.readFiles(base) : new Map<string, Buffer>();
    const merged = new Map(current);
    let conflict = false;
    for (const path of new Set([...before.keys(), ...incoming.keys()])) {
      const original = before.get(path), change = incoming.get(path), existing = current.get(path);
      if (equalBytes(original, change)) continue;
      if (!equalBytes(existing, original) && !equalBytes(existing, change)) { conflict = true; continue; }
      if (change === undefined) merged.delete(path); else merged.set(path, change);
    }
    return { files: merged, conflict };
  }

  pullObject(repo: Repo, pull: JsonObject): JsonObject {
    const headSha = repo.git.resolve(pull.head.ref) || pull.head.sha;
    const baseSha = repo.git.resolve(pull.base.ref) || pull.base.sha;
    const merge = pull.merged ? false : this.mergeFiles(repo, pull).conflict;
    return { ...pull, head: { ...pull.head, sha: headSha, repo: this.repositoryObject(repo), user: this.user() },
      base: { ...pull.base, sha: baseSha, repo: this.repositoryObject(repo), user: this.user() },
      mergeable: !merge, mergeable_state: pull.merged ? 'unknown' : merge ? 'dirty' : 'clean' };
  }

  pullFiles(repo: Repo, pull: JsonObject): JsonObject[] {
    const head = repo.git.resolve(pull.head.ref), base = repo.git.resolve(pull.base.ref);
    const common = this.commonAncestor(repo, head, base);
    const before = common ? repo.git.readFiles(common) : new Map<string, Buffer>();
    const after = head ? repo.git.readFiles(head) : new Map<string, Buffer>();
    const files: JsonObject[] = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const old = before.get(path), next = after.get(path);
      if (equalBytes(old, next)) continue;
      const additions = countLines(next), deletions = countLines(old);
      files.push({ sha: oidFor('blob', next || old!), filename: path, status: !old ? 'added' : !next ? 'removed' : 'modified', additions, deletions, changes: additions + deletions,
        patch: `@@ -1,${deletions} +1,${additions} @@\n${old ? old.toString('utf8').split('\n').map(line => '-' + line).join('\n') : ''}\n${next ? next.toString('utf8').split('\n').map(line => '+' + line).join('\n') : ''}` });
    }
    return files;
  }

  private createPull(repo: Repo, body: JsonObject): JsonObject {
    const title = this.required(body, 'title');
    const head = this.required(body, 'head').replace(new RegExp(`^${this.owner}:`), '');
    const base = this.required(body, 'base');
    const headSha = repo.git.resolve(head), baseSha = repo.git.resolve(base);
    if (!headSha || !baseSha || head === base) error(422, 'Head and base must name distinct existing branches');
    const id = this.id(); const number = repo.nextNumber++; const now = this.stamp();
    const pull = { id, node_id: nodeId('PullRequest', id), number, title, body: body.body ?? '', state: 'open', merged: false,
      draft: Boolean(body.draft), locked: false, user: this.user(), labels: [], assignees: [], requested_reviewers: [], comments: 0,
      head: { ref: head, sha: headSha, label: `${this.owner}:${head}` }, base: { ref: base, sha: baseSha, label: `${this.owner}:${base}` },
      created_at: now, updated_at: now, closed_at: null, merged_at: null, merge_commit_sha: null,
      url: `/api/v3/repos/${this.owner}/${repo.name}/pulls/${number}`, html_url: `/${this.owner}/${repo.name}/pull/${number}` };
    repo.pulls.set(number, pull);
    return this.pullObject(repo, pull);
  }

  private pullRoutes(repo: Repo, method: string, segments: string[], body: JsonObject, url: URL): Reply {
    if (!segments.length) {
      if (method === 'POST') return { status: 201, body: this.createPull(repo, body) };
      if (method === 'GET') {
        const state = url.searchParams.get('state') || 'open'; const direction = url.searchParams.get('direction') === 'asc' ? 1 : -1;
        return this.paginate([...repo.pulls.values()].filter(p => state === 'all' || p.state === state).sort((a, b) => direction * (a.number - b.number)).map(p => this.pullObject(repo, p)), url);
      }
      error(404, 'Not Found');
    }
    const pull = repo.pulls.get(Number(segments[0]));
    if (!pull) error(404, 'Not Found');
    if (segments.length === 1) {
      if (method === 'GET') return { status: 200, body: this.pullObject(repo, pull) };
      if (method === 'PATCH') {
        for (const key of ['title', 'body', 'state']) if (key in body) pull[key] = body[key];
        if (body.base) { if (!repo.git.resolve(body.base)) error(422, 'Base does not exist'); pull.base.ref = body.base; }
        pull.updated_at = this.stamp(); return { status: 200, body: this.pullObject(repo, pull) };
      }
    }
    if (segments.length === 2 && segments[1] === 'files' && method === 'GET') return this.paginate(this.pullFiles(repo, pull), url);
    if (segments.length === 2 && segments[1] === 'commits' && method === 'GET') {
      const base = this.ancestors(repo, repo.git.resolve(pull.base.ref));
      return this.paginate([...this.ancestors(repo, repo.git.resolve(pull.head.ref)).keys()].filter(sha => !base.has(sha)).map(sha => this.commitObject(repo, sha)), url);
    }
    if (segments.length === 2 && segments[1] === 'merge') {
      if (method === 'GET') return { status: pull.merged ? 204 : 404, body: pull.merged ? null : { message: 'Pull request is not merged' } };
      if (method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) error(405, 'Pull request is not open');
        if (body.sha && body.sha !== repo.git.resolve(pull.head.ref)) error(409, 'Head branch was modified');
        if (body.merge_method && !['squash', 'merge', 'rebase'].includes(body.merge_method)) error(422, 'Invalid merge method');
        const merged = this.mergeFiles(repo, pull);
        if (merged.conflict) error(405, 'Pull request is not mergeable');
        const baseSha = repo.git.resolve(pull.base.ref)!;
        const parents = body.merge_method === 'merge' ? [baseSha, repo.git.resolve(pull.head.ref)!] : [baseSha];
        const sha = repo.git.commitFiles(merged.files, body.commit_title || `${pull.title} (#${pull.number})`, pull.base.ref, parents);
        const now = this.stamp(); pull.merged = true; pull.state = 'closed'; pull.merged_at = now; pull.closed_at = now; pull.updated_at = now; pull.merge_commit_sha = sha; repo.updated_at = now;
        return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
      }
    }
    error(404, 'Not Found');
  }

  private gitRoutes(repo: Repo, method: string, segments: string[], body: JsonObject, url: URL): Reply {
    const kind = segments[0]; const name = segments.slice(1).join('/');
    if ((kind === 'refs' || kind === 'ref' || kind === 'matching-refs')) {
      if (method === 'POST' && kind === 'refs' && !name) {
        const ref = this.required(body, 'ref'); const sha = this.required(body, 'sha');
        if (!ref.startsWith('refs/')) error(422, 'Reference must start with refs/');
        this.branchName(ref);
        if (repo.git.refs.has(ref) || !repo.git.objects.has(sha)) error(422, 'Reference already exists or object not found');
        repo.git.refs.set(ref, sha); return { status: 201, body: this.refObject(ref, sha, repo) };
      }
      const ref = name.startsWith('refs/') ? name : `refs/${name}`;
      if (method === 'GET') {
        if (kind === 'matching-refs' || !name) return { status: 200, body: [...repo.git.refs].filter(([r]) => r.startsWith(ref)).map(([r, sha]) => this.refObject(r, sha, repo)) };
        const sha = repo.git.refs.get(ref); if (!sha) error(404, 'Reference not found');
        return { status: 200, body: this.refObject(ref, sha, repo) };
      }
      if (method === 'DELETE' && name) { if (!repo.git.refs.delete(ref)) error(404, 'Reference not found'); return { status: 204, body: null }; }
      if (method === 'PATCH' && name) {
        const old = repo.git.refs.get(ref); if (!old) error(404, 'Reference not found');
        const sha = this.required(body, 'sha'); if (!repo.git.objects.has(sha)) error(422, 'Object not found');
        if (!body.force && !this.ancestors(repo, sha).has(old)) error(422, 'Update is not a fast forward');
        repo.git.refs.set(ref, sha); return { status: 200, body: this.refObject(ref, sha, repo) };
      }
    }
    if (kind === 'blobs') {
      if (method === 'POST' && !name) {
        if (typeof body.content !== 'string') error(422, 'content is required');
        const sha = this.putObject(repo, 'blob', Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8'));
        return { status: 201, body: { sha, url: `/api/v3/repos/${this.owner}/${repo.name}/git/blobs/${sha}` } };
      }
      if (method === 'GET' && name) { const o = repo.git.objects.get(name); if (o?.type !== 'blob') error(404, 'Blob not found'); return { status: 200, body: { sha: name, size: o.data.length, encoding: 'base64', content: o.data.toString('base64') } }; }
    }
    if (kind === 'commits') {
      if (method === 'GET' && name) {
        const c = this.commitObject(repo, name); return { status: 200, body: { sha: name, message: c.commit.message, tree: c.commit.tree, parents: c.parents, author: c.commit.author, committer: c.commit.committer } };
      }
      if (method === 'POST' && !name) {
        const tree = this.required(body, 'tree'), message = this.required(body, 'message');
        if (repo.git.objects.get(tree)?.type !== 'tree') error(422, 'Tree not found');
        const parents: string[] = body.parents || [];
        if (parents.some(p => repo.git.objects.get(p)?.type !== 'commit')) error(422, 'Parent not found');
        const person = body.author || { name: this.owner, email: `${this.owner}@localhost` };
        const identity = `${String(person.name).replace(/[<>\n]/g, '')} <${String(person.email).replace(/[<>\n]/g, '')}> 1735689600 +0000`;
        const sha = this.putObject(repo, 'commit', Buffer.from(`tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${identity}\ncommitter ${identity}\n\n${message}\n`));
        return { status: 201, body: { sha, tree: { sha: tree }, parents: parents.map(sha => ({ sha })), message } };
      }
    }
    if (kind === 'trees') {
      if (method === 'GET' && name) {
        const resolved = repo.git.resolve(name) || name; const object = repo.git.objects.get(resolved);
        const sha = object?.type === 'commit' ? parseCommit(object.data).tree : resolved;
        if (repo.git.objects.get(sha)?.type !== 'tree') error(404, 'Tree not found');
        const list: JsonObject[] = [];
        const visit = (id: string, prefix: string) => {
          for (const e of parseTree(repo.git.objects.get(id)!.data)) {
            const tree = String(e.mode) === '40000' || String(e.mode) === '040000';
            const o = repo.git.objects.get(e.oid);
            list.push({ path: prefix + e.name, mode: tree ? '040000' : String(e.mode), type: tree ? 'tree' : 'blob', sha: e.oid, ...(tree ? {} : { size: o?.data.length || 0 }) });
            if (tree && url.searchParams.has('recursive')) visit(e.oid, prefix + e.name + '/');
          }
        };
        visit(sha, ''); return { status: 200, body: { sha, tree: list, truncated: false } };
      }
      if (method === 'POST' && !name) {
        if (!Array.isArray(body.tree)) error(422, 'tree is required');
        const files = body.base_tree ? new Map(repo.git.readFiles(body.base_tree)) : new Map<string, Buffer>();
        for (const entry of body.tree) {
          const path = this.filePath(entry.path);
          if (entry.sha === null) { files.delete(path); continue; }
          if (typeof entry.content === 'string') files.set(path, Buffer.from(entry.content));
          else { const object = repo.git.objects.get(entry.sha); if (object?.type !== 'blob') error(422, 'Blob not found'); files.set(path, object.data); }
        }
        const sha = this.treeOid(repo, files); return { status: 201, body: { sha, tree: body.tree, truncated: false } };
      }
    }
    error(404, 'Not Found');
  }

  private refObject(ref: string, sha: string, repo: Repo) { return { ref, node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'), object: { type: repo.git.objects.get(sha)?.type || 'commit', sha, url: `/api/v3/repos/${this.owner}/${repo.name}/git/commits/${sha}` } }; }

  request(method: string, path: string, body: JsonObject = {}, origin: string | URL = 'http://localhost'): Reply {
    try { return this.dispatch(method.toUpperCase(), path, body ?? {}, origin); }
    catch (e) { if (e instanceof ApiError) return { status: e.status, body: { message: e.message } }; throw e; }
  }

  private dispatch(method: string, path: string, body: JsonObject, origin: string | URL): Reply {
    const url = new URL(path, origin instanceof URL ? origin.origin : origin);
    const segments = url.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p));
    if (segments[0] === 'api' && segments[1] === 'v3') segments.splice(0, 2);
    else error(404, 'Not Found');
    if (!body || typeof body !== 'object' || Array.isArray(body)) error(422, 'Expected a JSON object');
    if (!segments.length && method === 'GET') return { status: 200, body: { current_user_url: `${url.origin}/api/v3/user`, repository_url: `${url.origin}/api/v3/repos/{owner}/{repo}`, rate_limit_url: `${url.origin}/api/v3/rate_limit` }, headers: { 'x-oauth-scopes': 'repo, read:org' } };
    if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
    if (segments[0] === 'user' && segments.length === 1 && method === 'GET') return { status: 200, body: this.user() };
    if (segments[0] === 'rate_limit' && method === 'GET') return { status: 200, body: { resources: { core: { limit: 5000, remaining: 5000, reset: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0 } } };
    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      if (method === 'POST') return { status: 201, body: this.repositoryObject(this.createRepo(body)) };
      if (method === 'GET') return this.paginate([...this.repos.values()].map(repo => this.repositoryObject(repo)), url);
    }
    if (segments[0] === 'users' && segments.length === 3 && segments[2] === 'repos' && method === 'GET') return this.paginate(segments[1].toLowerCase() === this.owner.toLowerCase() ? [...this.repos.values()].map(repo => this.repositoryObject(repo)) : [], url);
    if (segments[0] === 'search' && method === 'GET') {
      const q = url.searchParams.get('q') || ''; let items: JsonObject[] = [];
      if (segments[1] === 'repositories') items = [...this.repos.values()].filter(repo => repo.name.includes(q)).map(repo => this.repositoryObject(repo));
      else if (segments[1] === 'issues') {
        for (const repo of this.repos.values()) for (const issue of [...repo.issues.values(), ...repo.pulls.values()]) if (!q || q.split(/\s+/).every(term => term.startsWith('repo:') ? repo.full_name === term.slice(5) : term.startsWith('state:') ? issue.state === term.slice(6) : term.includes(':') || `${issue.title} ${issue.body}`.toLowerCase().includes(term.toLowerCase()))) items.push(issue);
      }
      else error(404, 'Not Found');
      const page = this.paginate(items, url); return { ...page, body: { total_count: items.length, incomplete_results: false, items: page.body } };
    }
    if (segments[0] !== 'repos' || segments.length < 3) error(404, 'Not Found');
    const repo = this.getRepo(segments[1], segments[2]);
    if (!repo) error(404, 'Not Found');
    const rest = segments.slice(3);
    if (!rest.length) {
      if (method === 'GET') return { status: 200, body: this.repositoryObject(repo) };
      if (method === 'DELETE') { this.repos.delete(repo.name.toLowerCase()); return { status: 204, body: null }; }
      if (method === 'PATCH') {
        if ('description' in body) repo.description = body.description ?? '';
        if ('private' in body) repo.private = Boolean(body.private);
        if ('default_branch' in body) { if (!repo.git.resolve(body.default_branch)) error(422, 'Default branch does not exist'); repo.default_branch = body.default_branch; repo.git.defaultBranch = body.default_branch; }
        repo.updated_at = this.stamp(); return { status: 200, body: this.repositoryObject(repo) };
      }
    }
    if (rest[0] === 'contents') return this.contents(repo, method, rest.slice(1).join('/'), body, url);
    if (rest[0] === 'git') return this.gitRoutes(repo, method, rest.slice(1), body, url);
    if (rest[0] === 'issues') return this.issueRoutes(repo, method, rest.slice(1), body, url);
    if (rest[0] === 'pulls') return this.pullRoutes(repo, method, rest.slice(1), body, url);
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') return this.paginate([...repo.labels.values()], url);
      if (rest.length === 1 && method === 'POST') {
        const name = this.required(body, 'name'); if (repo.labels.has(name)) error(422, 'Label already exists');
        const id = this.id(); const label = { id, node_id: nodeId('Label', id), name, color: body.color || 'ededed', description: body.description || '', default: false };
        repo.labels.set(name, label); return { status: 201, body: label };
      }
      if (rest.length === 2) { const label = repo.labels.get(rest[1]); if (!label) error(404, 'Not Found'); if (method === 'GET') return { status: 200, body: label }; if (method === 'DELETE') { repo.labels.delete(rest[1]); return { status: 204, body: null }; } }
    }
    if (rest[0] === 'branches' && method === 'GET') {
      const branches = [...repo.git.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false }));
      if (rest.length === 1) return this.paginate(branches, url);
      const branch = branches.find(b => b.name === rest.slice(1).join('/')); return branch ? { status: 200, body: branch } : error(404, 'Branch not found');
    }
    if (rest[0] === 'tags' && rest.length === 1 && method === 'GET') return this.paginate([...repo.git.refs].filter(([ref]) => ref.startsWith('refs/tags/')).map(([ref, sha]) => ({ name: ref.slice(10), commit: { sha } })), url);
    if (rest[0] === 'commits' && method === 'GET') {
      const ref = rest.length > 1 ? rest.slice(1).join('/') : url.searchParams.get('sha') || repo.default_branch;
      const sha = repo.git.resolve(ref);
      if (!sha) return rest.length > 1 ? error(404, 'Commit not found') : { status: 200, body: [] };
      if (rest.length > 1) return { status: 200, body: this.commitObject(repo, sha) };
      return this.paginate([...this.ancestors(repo, sha).keys()].filter(oid => repo.git.objects.get(oid)?.type === 'commit').map(oid => this.commitObject(repo, oid)), url);
    }
    error(404, 'Not Found');
  }
}
