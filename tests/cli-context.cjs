// Project-local identities and global discovery, using only a synthetic HTTP server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');
const project = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

async function fixture(run, { actor, scoped = false, existing = true, respond } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-cli-context-'));
  const requests = [];
  let present = existing;
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(request.url, 'http://fixture');
    requests.push({ method: request.method, path: url.pathname, query: url.searchParams, body });
    response.setHeader('Content-Type', 'application/json');
    let result = { items: [], total: 0, has_more: false, next_cursor: null };
    if (request.method === 'GET' && url.pathname === '/projects' && url.searchParams.has('path')) {
      if (!present) { response.statusCode = 404; result = { error: 'project not found' }; }
      else result = { id: project, path: directory, name: 'Sample' };
    } else if (request.method === 'POST' && url.pathname === '/projects') {
      present = true; result = { id: project, path: directory, added: true };
    } else if (request.method === 'POST' && url.pathname.endsWith('/agents')) result = { id: 1 };
    else if (url.pathname.endsWith('/agents/1')) result = { id: 1, name: 'Sample', state: 'idle' };
    else if (url.pathname === '/limits') result = { text: 'Account limits', usage_windows: {} };
    if (respond) result = respond({ url, body, result });
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, ACOM_URL: `http://127.0.0.1:${server.address().port}${scoped ? `/p/${project}` : ''}`,
    ACOM_HOME: path.join(directory, 'state'), CODEX_HOME: path.join(directory, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), PATH: '' };
  for (const key of ['ACOM_ID', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete env[key];
  if (actor !== undefined) env.ACOM_ID = String(actor);
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value);
    child.stderr.on('data', value => stderr += value);
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
  try { await run({ cli, requests, directory }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
}

test('owner numeric IDs resolve the current project once and never use a root local route', async () => {
  await fixture(async ({ cli, requests }) => {
    const result = await cli(['resume', '1,2']);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
    assert.deepEqual(requests.map(row => row.path), ['/projects', `/p/${project}/agents/1/resume`, `/p/${project}/agents/2/resume`]);
    assert.deepEqual(requests.slice(1).map(row => row.body), [{}, {}]);
  });
});

test('agent scope is retained once while global requests strip its project prefix', async () => {
  await fixture(async ({ cli, requests }) => {
    for (const args of [['agents'], ['threads', '--sort', 'title'], ['projects'], ['configs'], ['config', 'default'], ['project', 'read', other]]) {
      const result = await cli(args); assert.equal(result.status, 0, `${args}: ${result.stderr}`);
    }
    assert.deepEqual(requests.map(row => row.path), [`/p/${project}/agents`, `/p/${project}/threads`, '/projects', '/configs', '/configs/default', `/projects/${other}`]);
    assert.ok(requests.every(row => !row.query.has('project')));
    assert.equal(requests[1].query.get('sort'), 'title');
    assert.ok(requests.every(row => !row.path.includes(`/p/${project}/p/`)));
  }, { actor: 7, scoped: true });
});

test('an agent without project context cannot guess a project from its numeric ID', async () => {
  await fixture(async ({ cli, requests }) => {
    const result = await cli(['agent', '1']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /project-scoped ACOM_URL/);
    assert.deepEqual(requests, []);
  }, { actor: 7 });
});

test('owner commands outside a project cannot target a local ID but can inspect account limits', async () => {
  await fixture(async ({ cli, requests }) => {
    const closed = await cli(['close', '1']);
    assert.notEqual(closed.status, 0); assert.match(closed.stderr, /isn't in an acom project/);
    assert.ok(requests.every(row => row.method === 'GET'));
    const limits = await cli(['limits']); assert.equal(limits.status, 0, limits.stderr);
    assert.equal(requests.at(-1).path, '/limits');
  }, { existing: false });
});

test('launch creates a missing project explicitly then uses its returned UUID without another lookup', async () => {
  await fixture(async ({ cli, requests }) => {
    const result = await cli(['launch', '--task', 'Synthetic task']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requests.map(row => `${row.method} ${row.path}`), ['GET /projects', 'POST /projects', `POST /p/${project}/agents`]);
    assert.equal(Object.hasOwn(requests.at(-1).body, 'project'), false);
    assert.equal(requests.at(-1).body.task, 'Synthetic task');
  }, { existing: false });
});

test('malformed identities and obsolete list cursor flags reject before contacting the server', async () => {
  await fixture(async ({ cli, requests }) => {
    for (const args of [['project', 'read', '1'], ['project', 'remove', '../sample'], ['config', '1'], ['configs', '--before', '2'], ['projects', '--after', '0'], ['threads', '--through', '1']]) {
      const result = await cli(args); assert.notEqual(result.status, 0, args.join(' '));
    }
    assert.deepEqual(requests, []);
  });
});

test('delegated controls and permissions retain local identity and exact request fields', async () => {
  await fixture(async ({ cli, requests }) => {
    const controlled = await cli(['control', 'close', '--agents', '2,3', '--if-state', 'idle,paused', '--limit', '1']);
    assert.equal(controlled.status, 0, controlled.stderr);
    assert.equal(requests[0].path, `/p/${project}/controls`);
    assert.deepEqual(requests[0].body, { agent: 7, action: 'close', agents: [2, 3], if_states: ['idle', 'paused'], limit: 1, after: null, through: null });
    assert.equal((await cli(['permissions'])).status, 0);
    assert.equal(requests[1].path, `/p/${project}/agents/7/permissions`);
    assert.equal(requests[1].query.get('viewer'), '7');
    assert.equal((await cli(['pause-all'])).status, 0);
    assert.equal(requests[2].path, '/pause-all');
    assert.deepEqual(requests[2].body, { via: 7, via_project: project });
  }, { actor: 7, scoped: true });
});

test('invalid delegated controls reject before HTTP', async () => {
  await fixture(async ({ cli, requests }) => {
    for (const args of [
      ['control', 'finish', '--agents', '2'], ['control', 'close', '--agents', ''],
      ['control', 'close', '--agents', 'all,2'], ['control', 'close', '--agents', '0'],
      ['control', 'close', '--agents', '2', '--if-state', 'sleeping'],
      ['control', 'close', '--agents', '2', '--after', '1'],
      ['control', 'close', '--agents', '2', '--limit', '201'],
    ]) {
      const result = await cli(args); assert.notEqual(result.status, 0, args.join(' '));
    }
    assert.deepEqual(requests, []);
  }, { actor: 7, scoped: true });
});

test('thread discovery sends exact filters and retains them in sorted continuation commands', async () => {
  await fixture(async ({ cli, requests }) => {
    const result = await cli(['threads', '--search', 'Design & review', '--members', '0,2', '--member-match', 'any', '--category', 'mine', '--sort', 'title', '--limit', '1']);
    assert.equal(result.status, 0, result.stderr);
    const request = requests[0];
    assert.equal(request.path, `/p/${project}/threads`);
    assert.deepEqual(Object.fromEntries(request.query), {
      sort: 'title', limit: '1', max_bytes: '16000', search: 'Design & review', members: '0,2', member_match: 'any', category: 'mine', viewer: '7',
    });
    assert.match(result.stdout, /thread|Design/);
    const continuation = result.stdout.split('\n').find(line => line.startsWith('More available: '));
    for (const part of ["--search 'Design & review'", "--members '0,2'", "--member-match 'any'", "--category 'mine'", "--sort title", "--cursor 'next'"]) assert.ok(continuation.includes(part), continuation);
    assert.equal((await cli(['threads', '--id', '42'])).status, 0);
    assert.equal(requests[1].query.get('id'), '42');
  }, { actor: 7, scoped: true, respond: ({ url, result }) => url.pathname.endsWith('/threads') ? {
    items: [{ id: 42, title: 'Design & review', members: [0, 2], messages: 3, last_at: 1 }], has_more: true, next_cursor: 'next',
  } : result });
});

test('message search uses complete-history endpoint and preserves filters in ID paging hints', async () => {
  await fixture(async ({ cli, requests }) => {
    const result = await cli(['messages', '--search', "a'b %", '--threads', '1,2', '--sender', '0', '--from', '0', '--to', '200', '--after', '0', '--limit', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests[0].path, `/p/${project}/messages/search`);
    assert.deepEqual(Object.fromEntries(requests[0].query), {
      limit: '1', max_bytes: '16000', after: '0', text: "a'b %", threads: '1,2', sender: '0', from: '0', to: '200', viewer: '7',
    });
    assert.match(result.stdout, /#83 · thread 2 "Review"/);
    assert.match(result.stdout, /a'b % snippet/);
    assert.match(result.stdout, /2 matching messages \(snippets\)/);
    const continuation = result.stdout.split('\n').find(line => line.startsWith('More available: '));
    for (const part of ["--search 'a'\\''b %'", "--threads '1,2'", "--sender '0'", "--from '0'", "--to '200'", '--after 83', '--through 90', "--revision 'r'"]) assert.ok(continuation.includes(part), continuation);
    assert.equal((await cli(['messages', '--id', '83', '--thread', '2'])).status, 0);
    assert.equal(requests[1].query.get('id'), '83');
    assert.equal(requests[1].query.get('thread'), '2');
    assert.equal(requests[1].query.has('text'), false);
    assert.ok(requests.every(request => request.method === 'GET'));
  }, { actor: 7, scoped: true, respond: ({ url, result }) => url.pathname.endsWith('/messages/search') ? {
    items: [{ id: 83, thread: 2, title: 'Review', sender: 0, at: 100, snippet: "a'b % snippet" }],
    total: 2, has_more: true, next_after: 83, through: 90, revision: 'r',
  } : result });
});

test('exact message read verifies its thread and retains that check for oversized records', async () => {
  await fixture(async ({ cli, requests }) => {
    const result = await cli(['read', '83', '--thread', '2', '--max-bytes', '512']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests[0].path, `/p/${project}/messages/83`);
    assert.equal(requests[0].query.get('thread'), '2');
    assert.equal(requests[0].query.get('agent'), '7');
    assert.match(result.stdout, /Continue record: acom read 83 --thread 2 --offset 0 --max-bytes 512 --version 'r'/);
  }, { actor: 7, scoped: true, respond: ({ url, result }) => url.pathname.endsWith('/messages/83') ? {
    id: 83, truncated: true, next_offset: 0, version: 'r',
  } : result });
});

test('agent details print visible current thread memberships with a discovery command', async () => {
  await fixture(async ({ cli }) => {
    const result = await cli(['agent', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Threads \(2 visible\): #4 "Planning", #8 "Review"/);
    assert.match(result.stdout, /Thread list: acom threads --members 1/);
  }, { actor: 7, scoped: true, respond: ({ url, result }) => url.pathname.endsWith('/agents/1') ? {
    ...result, threads: [{ id: 4, title: 'Planning' }, { id: 8, title: 'Review' }],
  } : result });
});

test('invalid thread and message search requests reject before project discovery or any network request', async () => {
  await fixture(async ({ cli, requests }) => {
    for (const args of [
      ['threads', '--search', ''], ['threads', '--id', '0'], ['threads', '--member-match', 'any'],
      ['threads', '--members', '1,'], ['threads', '--members', Array(65).fill('1').join(',')],
      ['threads', '--search', 'x', '--id', '1'], ['threads', '--category', 'private'],
      ['messages'], ['messages', '--search', ''], ['messages', '--id', '0'],
      ['messages', '--search', 'x', '--id', '1'], ['messages', '--search', 'x', '--threads', '0'],
      ['messages', '--search', 'x', '--thread', '1', '--threads', '2'],
      ['messages', '--search', 'x', '--from', '200', '--to', '100'],
      ['messages', '--search', 'x', '--sender', '-1'], ['messages', '--search', 'é'.repeat(2049)],
      ['read', '1', '--thread', '0'],
    ]) {
      const result = await cli(args);
      assert.notEqual(result.status, 0, args.join(' '));
    }
    assert.deepEqual(requests, []);
  });
});
