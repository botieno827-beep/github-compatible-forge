// GraphQL and MCP adapters share the REST store; neither owns a second copy of forge data.
type RecordValue = Record<string, any>;
interface ForgeLike {
  owner: string;
  repos: Map<string, any>;
  request(method: string, path: string, body?: any, url?: string | URL): { status: number; body: any; headers?: Record<string, string> };
}

type Value = any;
interface Field { name: string; alias: string; args: RecordValue; directives: any[]; selection: Selection[] }
interface Spread { spread: string; condition?: string; directives: any[]; selection?: Selection[] }
type Selection = Field | Spread;
interface Operation { kind: string; name?: string; defaults: RecordValue; required: string[]; selection: Selection[] }

/** A small GraphQL document parser, supporting aliases, fragments, inputs, variables and directives. */
class DocumentParser {
  tokens: string[] = [];
  at = 0;
  fragments = new Map<string, Spread>();
  constructor(source: string) {
    let position = 0;
    const token = /\s+|,|#[^\r\n]*|\.\.\.|"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{|}]/y;
    while (position < source.length) {
      token.lastIndex = position;
      const match = token.exec(source);
      if (!match) throw new Error(`Syntax error near character ${position}.`);
      position = token.lastIndex;
      if (!/^\s|^,|^#/.test(match[0])) this.tokens.push(match[0]);
    }
  }
  peek() { return this.tokens[this.at]; }
  take(expected?: string) {
    const value = this.tokens[this.at++];
    if (value === undefined || expected !== undefined && value !== expected) throw new Error(`Expected ${expected ?? 'a token'}, found ${value ?? 'end of document'}.`);
    return value;
  }
  name() {
    const value = this.take();
    if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(value)) throw new Error(`Expected a name, found ${value}.`);
    return value;
  }
  value(): Value {
    const value = this.take();
    if (value === '$') return { variable: this.name() };
    if (value === '[') {
      const result: Value[] = [];
      while (this.peek() !== ']') result.push(this.value());
      this.take(']'); return result;
    }
    if (value === '{') {
      const result: RecordValue = Object.create(null);
      while (this.peek() !== '}') { const name = this.name(); this.take(':'); result[name] = this.value(); }
      this.take('}'); return result;
    }
    if (value.startsWith('"')) return JSON.parse(value);
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (/^-?\d/.test(value)) return Number(value);
    if (/^[_A-Za-z]/.test(value)) return value;
    throw new Error(`Invalid value ${value}.`);
  }
  arguments(): RecordValue {
    const args: RecordValue = Object.create(null);
    if (this.peek() !== '(') return args;
    this.take('(');
    while (this.peek() !== ')') { const name = this.name(); this.take(':'); args[name] = this.value(); }
    this.take(')'); return args;
  }
  directives() {
    const result: any[] = [];
    while (this.peek() === '@') { this.take('@'); result.push({ name: this.name(), args: this.arguments() }); }
    return result;
  }
  selection(): Selection[] {
    this.take('{'); const result: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.take('...');
        if (this.peek() === 'on') {
          this.take('on'); const condition = this.name(); const directives = this.directives();
          result.push({ spread: '', condition, directives, selection: this.selection() });
        } else if (this.peek() === '@' || this.peek() === '{') {
          const directives = this.directives(); result.push({ spread: '', directives, selection: this.selection() });
        } else result.push({ spread: this.name(), directives: this.directives() });
      } else {
        let name = this.name(); let alias = name;
        if (this.peek() === ':') { this.take(':'); name = this.name(); }
        const args = this.arguments(); const directives = this.directives();
        result.push({ name, alias, args, directives, selection: this.peek() === '{' ? this.selection() : [] });
      }
    }
    this.take('}'); return result;
  }
  type(): string {
    let type: string;
    if (this.peek() === '[') { this.take('['); type = `[${this.type()}]`; this.take(']'); }
    else type = this.name();
    if (this.peek() === '!') { this.take('!'); type += '!'; }
    return type;
  }
  document(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== undefined) {
      if (this.peek() === 'fragment') {
        this.take(); const name = this.name(); this.take('on'); const condition = this.name();
        const directives = this.directives(); this.fragments.set(name, { spread: '', condition, directives, selection: this.selection() });
        continue;
      }
      let kind = 'query'; let name: string | undefined;
      const defaults: RecordValue = Object.create(null); const required: string[] = [];
      if (this.peek() !== '{') {
        kind = this.name();
        if (!['query', 'mutation'].includes(kind)) throw new Error(`Unsupported operation ${kind}.`);
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') name = this.name();
        if (this.peek() === '(') {
          this.take('(');
          while (this.peek() !== ')') {
            this.take('$'); const variable = this.name(); this.take(':'); const type = this.type();
            if (this.peek() === '=') { this.take('='); defaults[variable] = this.value(); }
            else if (type.endsWith('!')) required.push(variable);
            this.directives();
          }
          this.take(')');
        }
        this.directives();
      }
      operations.push({ kind, name, defaults, required, selection: this.selection() });
    }
    if (!operations.length) throw new Error('A GraphQL operation is required.');
    return operations;
  }
}

// The type table drives both validation and introspection, so feature probes describe actual fields.
const TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', nodes: 'Node[]', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', reopenIssue: 'ReopenIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Node: { id: 'ID' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', description: 'String', url: 'String', isPrivate: 'Boolean', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest', createdAt: 'String', updatedAt: 'String' },
  Issue: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', state: 'IssueState', body: 'String', url: 'String', author: 'User', createdAt: 'String', updatedAt: 'String', closedAt: 'String', comments: 'IssueCommentConnection' },
  PullRequest: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', state: 'PullRequestState', body: 'String', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', merged: 'Boolean', files: 'PullRequestChangedFileConnection', author: 'User', url: 'String', createdAt: 'String', updatedAt: 'String', mergedAt: 'String', comments: 'IssueCommentConnection' },
  User: { id: 'ID', databaseId: 'Int', login: 'String', name: 'String', url: 'String' },
  Ref: { id: 'ID', name: 'String', target: 'Commit' },
  Commit: { id: 'ID', oid: 'String', message: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  IssueComment: { id: 'ID', databaseId: 'Int', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  ReopenIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Node', clientMutationId: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', types: '__Type[]', directives: '__Directive[]' },
  __Type: { name: 'String', kind: '__TypeKind', description: 'String', fields: '__Field[]', enumValues: '__EnumValue[]', inputFields: '__InputValue[]', interfaces: '__Type[]', possibleTypes: '__Type[]', ofType: '__Type' },
  __Field: { name: 'String', description: 'String', type: '__Type', args: '__InputValue[]', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String' },
  __Directive: { name: 'String', description: 'String', locations: 'String[]', args: '__InputValue[]' },
};
const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'],
};
for (const node of ['Issue', 'PullRequest', 'PullRequestChangedFile', 'IssueComment']) {
  TYPES[`${node}Connection`] = { nodes: `${node}[]`, edges: `${node}Edge[]`, pageInfo: 'PageInfo', totalCount: 'Int' };
  TYPES[`${node}Edge`] = { node, cursor: 'String' };
}

const tag = (kind: string, value: RecordValue = {}): RecordValue => ({ ...value, __kind: kind });
const encode = (value: string) => Buffer.from(value).toString('base64');
const idOf = (kind: string, row: RecordValue) => row.node_id || encode(`${kind}:${row.id}`);
const pathOf = (repo: RecordValue) => `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;

function valuesOf(value: Value, variables: RecordValue): Value {
  if (Array.isArray(value)) return value.map(item => valuesOf(item, variables));
  if (value !== null && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.variable === 'string') return variables[value.variable];
    const result: RecordValue = Object.create(null);
    for (const [key, item] of Object.entries(value)) result[key] = valuesOf(item, variables);
    return result;
  }
  return value;
}
function selected(directives: any[], variables: RecordValue) {
  return directives.every(d => d.name === 'skip' ? valuesOf(d.args.if, variables) !== true : d.name === 'include' ? valuesOf(d.args.if, variables) === true : true);
}
function validate(selection: Selection[], type: string, fragments: Map<string, Spread>, active = new Set<string>()) {
  for (const item of selection) {
    if ('spread' in item) {
      const fragment = item.spread ? fragments.get(item.spread) : item;
      if (!fragment) throw new Error(`Unknown fragment ${item.spread}.`);
      if (item.spread && active.has(item.spread)) throw new Error(`Fragment cycle involving ${item.spread}.`);
      validate(fragment.selection ?? [], fragment.condition ?? type, fragments, new Set([...active, item.spread]));
      continue;
    }
    if (item.name === '__typename') continue;
    const fieldType = TYPES[type]?.[item.name];
    if (!fieldType) throw new Error(`Cannot query field "${item.name}" on type "${type}".`);
    const childType = fieldType.replace('[]', '');
    if (item.selection.length) {
      if (!TYPES[childType]) throw new Error(`Field "${item.name}" must not have a selection since type "${childType}" has no subfields.`);
      validate(item.selection, childType, fragments, active);
    } else if (TYPES[childType]) throw new Error(`Field "${item.name}" requires a selection of subfields.`);
  }
}

function api(forge: ForgeLike, method: string, path: string, body?: any) {
  const result = forge.request(method, `/api/v3${path}`, body);
  if (result.status >= 400) throw new Error(result.body?.message ?? `Request failed with status ${result.status}.`);
  return result.body;
}
function repoLookup(forge: ForgeLike, owner: any, name: any) {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  const result = forge.request('GET', `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  return result.status === 200 ? tag('Repository', { row: result.body }) : null;
}
function nodeLookup(forge: ForgeLike, id: any): RecordValue | null {
  if (typeof id !== 'string') return null;
  for (const repo of forge.repos.values()) {
    if (idOf('Repository', repo) === id) return tag('Repository', { row: repo });
    for (const [kind, rows] of [['Issue', repo.issues], ['PullRequest', repo.pulls]] as const) {
      for (const row of rows?.values() ?? []) if (idOf(kind, row) === id) return tag(kind, { row, repo });
    }
  }
  return null;
}
function requiredNode(forge: ForgeLike, id: any, kind?: string) {
  const node = nodeLookup(forge, id);
  if (!node || kind && node.__kind !== kind) throw new Error(`Could not resolve to a ${kind ?? 'node'} with the global id ${String(id)}.`);
  return node;
}
function connection(kind: string, rows: any[], args: RecordValue) {
  let offset = 0;
  if (args.after != null) {
    const decoded = Buffer.from(String(args.after), 'base64').toString();
    if (!/^cursor:\d+$/.test(decoded)) throw new Error('Invalid cursor.');
    offset = Number(decoded.slice(7)) + 1;
  }
  const size = Math.min(100, Math.max(0, Math.trunc(Number(args.first ?? 30))));
  const page = rows.slice(offset, offset + size);
  return tag(`${kind}Connection`, {
    nodes: page, totalCount: rows.length,
    edges: page.map((node, index) => tag(`${kind}Edge`, { node, cursor: encode(`cursor:${offset + index}`) })),
    pageInfo: tag('PageInfo', { hasNextPage: offset + size < rows.length, hasPreviousPage: offset > 0, startCursor: page.length ? encode(`cursor:${offset}`) : null, endCursor: page.length ? encode(`cursor:${offset + page.length - 1}`) : null }),
  });
}
function typeInfo(name: string): RecordValue | null {
  if (!TYPES[name] && !ENUMS[name] && !['ID', 'String', 'Int', 'Float', 'Boolean'].includes(name)) return null;
  return tag('__Type', { name, kind: TYPES[name] ? name === 'Node' ? 'INTERFACE' : 'OBJECT' : ENUMS[name] ? 'ENUM' : 'SCALAR', description: null });
}
function allRows(forge: ForgeLike, path: string): any[] {
  const rows: any[] = [];
  for (let page = 1; page < 10000; page++) {
    const next = api(forge, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(next)) return rows;
    rows.push(...next);
    if (next.length < 100) return rows;
  }
  return rows;
}

function resolve(forge: ForgeLike, object: RecordValue, field: string, args: RecordValue): any {
  const kind = object.__kind;
  if (field === '__typename') return kind;
  if (kind === 'Query') {
    if (field === 'viewer') return tag('User', { row: { login: forge.owner, id: 1 } });
    if (field === 'repository') return repoLookup(forge, args.owner, args.name);
    if (field === 'node') return nodeLookup(forge, args.id);
    if (field === 'nodes') return (args.ids ?? []).map((id: string) => nodeLookup(forge, id));
    if (field === '__type') return typeInfo(args.name);
    if (field === '__schema') return tag('__Schema', { queryType: typeInfo('Query'), mutationType: typeInfo('Mutation'), subscriptionType: null, types: [...Object.keys(TYPES), ...Object.keys(ENUMS)].map(typeInfo), directives: [] });
  }
  if (kind === 'Mutation') {
    const input = args.input;
    if (!input || typeof input !== 'object') throw new Error(`Field ${field} requires an input object.`);
    const clientMutationId = input.clientMutationId ?? null;
    if (field === 'createIssue' || field === 'createPullRequest') {
      const repository = requiredNode(forge, input.repositoryId, 'Repository').row;
      const isIssue = field === 'createIssue';
      const row = api(forge, 'POST', `${pathOf(repository)}/${isIssue ? 'issues' : 'pulls'}`, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName });
      return tag(isIssue ? 'CreateIssuePayload' : 'CreatePullRequestPayload', { [isIssue ? 'issue' : 'pullRequest']: tag(isIssue ? 'Issue' : 'PullRequest', { row, repo: repository }), clientMutationId });
    }
    if (field === 'closeIssue' || field === 'reopenIssue') {
      const issue = requiredNode(forge, input.issueId, 'Issue');
      const row = api(forge, 'PATCH', `${pathOf(issue.repo)}/issues/${issue.row.number}`, { state: field === 'closeIssue' ? 'closed' : 'open' });
      return tag(field === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload', { issue: tag('Issue', { row, repo: issue.repo }), clientMutationId });
    }
    if (field === 'mergePullRequest') {
      const pull = requiredNode(forge, input.pullRequestId, 'PullRequest');
      api(forge, 'PUT', `${pathOf(pull.repo)}/pulls/${pull.row.number}/merge`, { merge_method: String(input.mergeMethod ?? 'SQUASH').toLowerCase() });
      const row = api(forge, 'GET', `${pathOf(pull.repo)}/pulls/${pull.row.number}`);
      return tag('MergePullRequestPayload', { pullRequest: tag('PullRequest', { row, repo: pull.repo }), clientMutationId });
    }
    if (field === 'addComment') {
      const subject = requiredNode(forge, input.subjectId);
      if (!['Issue', 'PullRequest'].includes(subject.__kind)) throw new Error('The subject does not support comments.');
      const row = api(forge, 'POST', `${pathOf(subject.repo)}/issues/${subject.row.number}/comments`, { body: input.body });
      return tag('AddCommentPayload', { commentEdge: tag('IssueCommentEdge', { node: tag('IssueComment', { row }), cursor: encode(`comment:${row.id}`) }), subject, clientMutationId });
    }
  }
  if (kind === 'Repository') {
    const row = object.row;
    if (field === 'id') return idOf('Repository', row);
    if (field === 'databaseId') return row.id;
    if (field === 'nameWithOwner') return row.full_name;
    if (field === 'isPrivate') return !!row.private;
    if (field === 'owner') return tag('User', { row: row.owner });
    if (field === 'defaultBranchRef') {
      const ref = forge.request('GET', `/api/v3${pathOf(row)}/git/ref/heads/${row.default_branch}`);
      return tag('Ref', { name: row.default_branch, id: encode(`Ref:${row.id}:${row.default_branch}`), target: tag('Commit', { oid: ref.body?.object?.sha ?? null }) });
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issues' || field === 'pullRequests') {
      const isIssue = field === 'issues'; const entityKind = isIssue ? 'Issue' : 'PullRequest';
      let rows = allRows(forge, `${pathOf(row)}/${isIssue ? 'issues' : 'pulls'}?state=all`);
      if (isIssue) rows = rows.filter(item => !item.pull_request);
      if (Array.isArray(args.states) && args.states.length) rows = rows.filter(item => args.states.includes(item.merged ? 'MERGED' : item.state.toUpperCase()));
      if (!isIssue && !args.states) rows = rows.filter(item => item.state === 'open');
      const sort = args.orderBy?.field === 'UPDATED_AT' ? 'updated_at' : 'created_at';
      const direction = args.orderBy?.direction === 'DESC' ? -1 : 1;
      rows.sort((a, b) => direction * (String(a[sort] ?? '').localeCompare(String(b[sort] ?? '')) || a.number - b.number));
      return connection(entityKind, rows.map(item => tag(entityKind, { row: item, repo: row })), args);
    }
    if (field === 'issue' || field === 'pullRequest') {
      const isIssue = field === 'issue';
      const answer = forge.request('GET', `/api/v3${pathOf(row)}/${isIssue ? 'issues' : 'pulls'}/${args.number}`);
      return answer.status === 200 ? tag(isIssue ? 'Issue' : 'PullRequest', { row: answer.body, repo: row }) : null;
    }
  }
  if (['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'].includes(kind)) {
    const row = object.row;
    if (field === 'id') return idOf(kind, row);
    if (field === 'databaseId') return row.id;
    if (field === 'url') return row.html_url ?? row.url ?? null;
    if (field === 'author') return tag('User', { row: row.user ?? { login: forge.owner, id: 1 } });
    const snake: Record<string, string> = { createdAt: 'created_at', updatedAt: 'updated_at', closedAt: 'closed_at', mergedAt: 'merged_at' };
    if (snake[field]) return row[snake[field]] ?? null;
    if (field === 'state') return kind === 'PullRequest' && row.merged ? 'MERGED' : String(row.state ?? 'open').toUpperCase();
    if (field === 'headRefName') return row.head?.ref ?? null;
    if (field === 'baseRefName') return row.base?.ref ?? null;
    if (field === 'mergeable') return row.mergeable === false ? 'CONFLICTING' : row.mergeable === null ? 'UNKNOWN' : 'MERGEABLE';
    if (field === 'merged') return !!row.merged;
    if (field === 'files') {
      const files = allRows(forge, `${pathOf(object.repo)}/pulls/${row.number}/files`);
      return connection('PullRequestChangedFile', files.map(file => tag('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: String(file.status).toUpperCase() })), args);
    }
    if (field === 'comments') return connection('IssueComment', allRows(forge, `${pathOf(object.repo)}/issues/${row.number}/comments`).map(row => tag('IssueComment', { row })), args);
    return row[field] ?? null;
  }
  if (kind === '__Type') {
    if (field === 'fields') return TYPES[object.name] ? Object.entries(TYPES[object.name]).map(([name, type]) => tag('__Field', { name, description: null, type: type.endsWith('[]') ? tag('__Type', { kind: 'LIST', name: null, ofType: typeInfo(type.slice(0, -2)) }) : typeInfo(type), args: [], isDeprecated: false, deprecationReason: null })) : null;
    if (field === 'enumValues') return ENUMS[object.name]?.map(name => tag('__EnumValue', { name, description: null, isDeprecated: false, deprecationReason: null })) ?? null;
    if (field === 'interfaces') return ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'].includes(object.name) ? [typeInfo('Node')] : [];
    if (field === 'possibleTypes') return object.name === 'Node' ? ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'].map(typeInfo) : null;
    if (field === 'inputFields') return null;
  }
  return object[field] ?? null;
}

async function execute(forge: ForgeLike, object: any, selection: Selection[], fragments: Map<string, Spread>, variables: RecordValue): Promise<any> {
  if (object == null) return null;
  if (Array.isArray(object)) return Promise.all(object.map(item => execute(forge, item, selection, fragments, variables)));
  const result: RecordValue = Object.create(null);
  for (const item of selection) {
    if (!selected(item.directives, variables)) continue;
    if ('spread' in item) {
      const fragment = item.spread ? fragments.get(item.spread)! : item;
      if ((!fragment.condition || fragment.condition === object.__kind || fragment.condition === 'Node') && selected(fragment.directives, variables)) Object.assign(result, await execute(forge, object, fragment.selection ?? [], fragments, variables));
    } else {
      const value = resolve(forge, object, item.name, valuesOf(item.args, variables));
      result[item.alias] = item.selection.length ? await execute(forge, value, item.selection, fragments, variables) : value;
    }
  }
  return result;
}

/** Execute one operation envelope, or a JSON array of independent operation envelopes. */
export async function graphql(forge: ForgeLike, body: any): Promise<any> {
  if (Array.isArray(body)) return Promise.all(body.map(operation => graphql(forge, operation)));
  try {
    if (!body || typeof body.query !== 'string') throw new Error('A GraphQL query string is required.');
    const parser = new DocumentParser(body.query); const operations = parser.document();
    if (!body.operationName && operations.length > 1) throw new Error('An operation name is required for a document containing multiple operations.');
    const operation = body.operationName ? operations.find(item => item.name === body.operationName) : operations[0];
    if (!operation) throw new Error(`Unknown operation named ${body.operationName}.`);
    const variables = { ...operation.defaults, ...(body.variables ?? {}) };
    for (const required of operation.required) if (variables[required] == null) throw new Error(`Variable "$${required}" of required type was not provided.`);
    const kind = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    validate(operation.selection, kind, parser.fragments);
    return { data: await execute(forge, tag(kind), operation.selection, parser.fragments, variables) };
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

const STRING = { type: 'string' };
const REPO_PROPERTIES = { owner: STRING, repo: STRING };
function tool(name: string, description: string, properties: RecordValue, required: string[]) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
const TOOLS = Object.freeze([
  tool('create_repo', 'Create a repository owned by the authenticated user.', { name: STRING, description: STRING, private: { type: 'boolean' } }, ['name']),
  tool('get_repo', 'Read a repository and its stable identifiers.', REPO_PROPERTIES, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', { ...REPO_PROPERTIES, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List repository issues filtered by open, closed or all state.', { ...REPO_PROPERTIES, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', { ...REPO_PROPERTIES, title: STRING, head: STRING, base: STRING, body: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash and merge a pull request into its base branch.', { ...REPO_PROPERTIES, pull_number: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'pull_number']),
]);
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'local-git-forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

/** Stateless Streamable HTTP MCP; a request's ID and result never share mutable state. */
export async function mcp(forge: ForgeLike, body: any): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
  if (Array.isArray(body)) {
    if (!body.length) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
    const results = await Promise.all(body.map(item => mcp(forge, item)));
    const replies = results.filter(item => item.status !== 202).map(item => item.body);
    return { status: replies.length ? 200 : 202, body: replies.length ? replies : null };
  }
  const id = body?.id ?? null;
  const error = (code: number, message: string) => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });
  const success = (result: any) => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || body.id !== undefined && typeof body.id !== 'string' && typeof body.id !== 'number' && body.id !== null) return error(-32600, 'Invalid Request');
  if (body.id === undefined) return { status: 202, body: null };
  if (body.method === 'server/discover') return success({ serverInfo: SERVER_INFO, capabilities: CAPABILITIES, supportedVersions: SUPPORTED_VERSIONS });
  if (body.method === 'initialize') return success({ serverInfo: SERVER_INFO, capabilities: CAPABILITIES, protocolVersion: SUPPORTED_VERSIONS.includes(body.params?.protocolVersion) ? body.params.protocolVersion : SUPPORTED_VERSIONS[0] });
  if (body.method === 'ping') return success({});
  if (body.method === 'tools/list') return success({ tools: TOOLS });
  if (body.method !== 'tools/call') return error(-32601, `Method not found: ${body.method}`);
  const selectedTool = TOOLS.find(tool => tool.name === body.params?.name);
  if (!selectedTool) return error(-32602, `Unknown tool: ${String(body.params?.name)}`);
  const args = body.params?.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return error(-32602, 'Tool arguments must be an object.');
  for (const name of selectedTool.inputSchema.required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return error(-32602, `Missing required argument: ${name}`);
  }
  for (const [name, value] of Object.entries(args)) {
    const schema = selectedTool.inputSchema.properties[name];
    if (!schema) return error(-32602, `Unknown argument: ${name}`);
    if (schema.type === 'integer' ? !Number.isSafeInteger(value) || Number(value) < (schema.minimum ?? -Infinity) : typeof value !== schema.type) return error(-32602, `Invalid argument type: ${name}`);
    if (schema.enum && !schema.enum.includes(value)) return error(-32602, `Invalid value for argument: ${name}`);
  }
  try {
    const path = `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`;
    let result: any;
    switch (selectedTool.name) {
      case 'create_repo': result = api(forge, 'POST', '/user/repos', args); break;
      case 'get_repo': result = api(forge, 'GET', path); break;
      case 'create_issue': result = api(forge, 'POST', `${path}/issues`, { title: args.title, body: args.body }); break;
      case 'list_issues': result = allRows(forge, `${path}/issues?state=${args.state ?? 'open'}`); break;
      case 'create_pull_request': result = api(forge, 'POST', `${path}/pulls`, { title: args.title, body: args.body, head: args.head, base: args.base }); break;
      case 'merge_pull_request': result = api(forge, 'PUT', `${path}/pulls/${args.pull_number}/merge`, { merge_method: 'squash' }); break;
    }
    return success({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: Array.isArray(result) ? { issues: result } : result, isError: false });
  } catch (cause) {
    return success({ content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }], isError: true });
  }
}
