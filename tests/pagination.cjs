// Bounded reads, cursor traversal, and CLI response failures; no model providers.
// cargo build && node --test tests/pagination.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');

async function cli(args, { cwd, env }) {
  const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signal) => resolve([status, signal]));
    });
    assert.equal(signal, null, `CLI timed out: ${stderr}`);
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function mock(handler, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-response-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.on('error', () => {});
    handler(req, res);
  });
  server.on('clientError', (_, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    ACOM_URL: `http://127.0.0.1:${server.address().port}`,
    ACOM_HOME: path.join(root, 'state'),
    CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'no-credentials'),
    PATH: bin,
  };
  delete env.ACOM_ID;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  try { await run({ cwd: root, env, requests }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
}

test('CLI thread creation sends explicit access settings', async t => {
  for (const [flags, expected] of [
    [[], { private: false, joinable: true }],
    [['--private'], { private: true, joinable: false }],
    [['--no-join'], { private: false, joinable: false }],
  ]) await t.test(flags[0] || 'public open default', async () => {
    let body;
    await mock((req, res) => {
      let raw = ''; req.on('data', chunk => raw += chunk);
      req.on('end', () => {
        body = JSON.parse(raw); res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 4, members: [7, 2, 3], ...expected }));
      });
    }, async fixture => {
      fixture.env.ACOM_ID = '7';
      const result = await cli(['thread', 'new', '--title', 'team', '--members', '2,3', ...flags], fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(body, { title: 'team', members: ['2', '3'], watch: [], agent: 7, include_user: false, ...expected });
      assert.deepEqual(fixture.requests, [{ method: 'POST', url: '/threads' }]);
    });
  });
  for (const flags of [['--private', '--watch', 'active'], ['--no-join', '--watch', 'active'], ['--private', '--no-join']]) {
    await t.test(`rejects conflicting ${flags.join(' ')}`, async () => {
      await mock((_, res) => res.end('{}'), async fixture => {
        const result = await cli(['thread', 'new', '--title', 'team', ...flags], fixture);
        assert.notEqual(result.status, 0); assert.match(result.stderr, /cannot be used with/);
        assert.deepEqual(fixture.requests, [], 'invalid audience options must not create a thread');
      });
    });
  }
});

test('CLI thread membership commands identify their caller and preserve permission errors', async t => {
  for (const command of ['add', 'remove']) for (const identity of [0, 7]) await t.test(`${command} as ${identity || 'user'}`, async () => {
    let body;
    await mock((req, res) => {
      let raw = ''; req.on('data', chunk => raw += chunk);
      req.on('end', () => {
        body = JSON.parse(raw); res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ members: [2] }));
      });
    }, async fixture => {
      if (identity) fixture.env.ACOM_ID = String(identity);
      const result = await cli(['thread', command, '4', '2'], fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(body, { agent: identity, members: ['2'] });
      assert.deepEqual(fixture.requests, [{ method: 'POST', url: `/threads/4/members${command === 'remove' ? '/remove' : ''}` }]);
    });
  });
  await t.test('denied addition is not claimed successful or retried', async () => {
    await mock((req, res) => {
      req.resume(); res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'only the user or current thread owner can add members to this thread' }));
    }, async fixture => {
      fixture.env.ACOM_ID = '7';
      const result = await cli(['thread', 'add', '4', '2'], fixture);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /only the user or current thread owner can add/);
      assert.doesNotMatch(result.stdout, /added/); assert.equal(fixture.requests.length, 1);
    });
  });
});

test('CLI thread ownership transfer identifies its caller and validates the result', async t => {
  for (const identity of [0, 7]) await t.test(`transfer as ${identity || 'user'}`, async () => {
    let body;
    await mock((req, res) => {
      let raw = ''; req.on('data', chunk => raw += chunk);
      req.on('end', () => {
        body = JSON.parse(raw); res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ owner: 2 }));
      });
    }, async fixture => {
      if (identity) fixture.env.ACOM_ID = String(identity);
      const result = await cli(['thread', 'transfer-owner', '4', '2'], fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /thread 4 ownership transferred to agent 2/);
      assert.deepEqual(body, { agent: identity, owner: 2 });
      assert.deepEqual(fixture.requests, [{ method: 'POST', url: '/threads/4/owner' }]);
    });
  });
  for (const owner of ['0', '-1', 'user', '2.0']) await t.test(`rejects destination ${owner}`, async () => {
    await mock((_, res) => res.end('{}'), async fixture => {
      const result = await cli(['thread', 'transfer-owner', '4', owner], fixture);
      assert.notEqual(result.status, 0); assert.deepEqual(fixture.requests, []);
    });
  });
  for (const body of [{}, { owner: null }, { owner: 0 }, { owner: '2' }, { owner: 2.5 }]) await t.test(`rejects incomplete response ${JSON.stringify(body)}`, async () => {
    await mock((req, res) => {
      req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
    }, async fixture => {
      const result = await cli(['thread', 'transfer-owner', '4', '2'], fixture);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /invalid ownership response; inspect the thread before retrying/);
      assert.doesNotMatch(result.stdout, /ownership transferred/); assert.equal(fixture.requests.length, 1);
    });
  });
  await t.test('permission errors do not claim success or repeat the transfer', async () => {
    await mock((req, res) => {
      req.resume(); res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'only the user or current thread owner can transfer ownership' }));
    }, async fixture => {
      fixture.env.ACOM_ID = '7';
      const result = await cli(['thread', 'transfer-owner', '4', '2'], fixture);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /only the user or current thread owner/);
      assert.doesNotMatch(result.stdout, /ownership transferred/); assert.equal(fixture.requests.length, 1);
    });
  });
});

test('CLI privacy viewer is separate from membership and history filters', async t => {
  for (const [args, endpoint, identityKey, filter] of [
    [['threads'], '/threads', 'viewer', null],
    [['activity'], '/activity', 'agent', null],
    [['activity', '3'], '/activity/3', 'agent', null],
    [['history'], '/history', 'viewer', '7'],
    [['history', '--all-agents'], '/history', 'viewer', null],
    [['history', '--agent', '2'], '/history', 'viewer', '2'],
    [['history', '3'], '/history/3', 'viewer', null],
  ]) await t.test(args.join(' '), async () => {
    await mock((req, res) => {
      req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/agents/7/project' ? { project: 9 } : { items: [], events: [], has_more: false }));
    }, async fixture => {
      fixture.env.ACOM_ID = '7';
      const result = await cli(args, fixture);
      assert.equal(result.status, 0, result.stderr);
      const request = fixture.requests.find(request => new URL(request.url, 'http://fixture').pathname === endpoint);
      assert.ok(request, JSON.stringify(fixture.requests));
      const query = new URL(request.url, 'http://fixture').searchParams;
      assert.equal(query.get('project'), '9'); assert.equal(query.get(identityKey), '7');
      if (identityKey === 'viewer') assert.equal(query.get('agent'), filter, 'caller identity must not overwrite or introduce a membership/history filter');
      assert.ok(fixture.requests.every(request => request.method === 'GET'));
    });
  });
});

test('CLI pause has no lock-preservation options or payload',async t=>{
  for(const flag of ['--keep-locks','--release-locks']) await t.test(`rejects ${flag}`,async()=>{
    await mock((_,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');},async fixture=>{
      const result=await cli(['pause','1',flag],fixture);
      assert.notEqual(result.status,0); assert.match(result.stderr,/unexpected argument/);
      assert.deepEqual(fixture.requests,[],'removed options must fail before sending an action');
    });
  });
  await t.test('plain Pause sends no lock mode',async()=>{
    let body;
    await mock((req,res)=>{
      let raw=''; req.on('data',chunk=>raw+=chunk); req.on('end',()=>{
        body=JSON.parse(raw);res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');
      });
    },async fixture=>{
      const result=await cli(['pause','1'],fixture);
      assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/locks release after.*worker stops/);
      assert.equal(Object.hasOwn(body,'locks'),false);
      assert.deepEqual(fixture.requests,[{method:'POST',url:'/agents/1/pause'}]);
    });
  });
});

test('CLI locks distinguishes stopping reservations from ordinary timed leases',async()=>{
  for(const holder_stopping of [true,false]) await mock((req,res)=>{
    req.resume(); res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(req.url==='/agents/1/project' ? {project:9} : {
      items:[{id:3,name:'protected reservation',about:'release only after cleanup',holder:1,holder_name:'fixture',acquired_at:1,expires_at:2,holder_stopping,queue:[]}],
      has_more:false,next_before:null,next_after:null,total:1,through:3,revision:'owned-fixture'
    }));
  },async fixture=>{
    fixture.env.ACOM_ID='1';
    const result=await cli(['locks'],fixture);
    assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/held by agent 1/);
    if(holder_stopping) {
      assert.match(result.stdout,/releasing after worker stops/);
      assert.doesNotMatch(result.stdout,/expires/,'an expired stopping lease is not advertised as ordinarily available');
    } else {
      assert.match(result.stdout,/expires/); assert.doesNotMatch(result.stdout,/releasing after worker stops/);
    }
    assert.ok(fixture.requests.every(request=>request.method==='GET'));
    assert.equal(fixture.requests.length,2);
  });
});

test('CLI preserves server error details and rejects incomplete successful bodies', async t => {
  for (const [status, body, contentType] of [
    [400, JSON.stringify({ error: 'page cursor conflicts with requested direction 漢' }), 'application/json'],
    [404, JSON.stringify({ error: 'message 7 is absent' }), 'application/json'],
    [409, JSON.stringify({ error: 'collection changed; restart the traversal' }), 'application/json'],
    [500, 'database write failed: diagnostic body retained', 'text/plain'],
  ]) {
    await t.test(`HTTP ${status} retains its body`, async () => {
      await mock((_, res) => {
        res.writeHead(status, { 'Content-Type': contentType });
        res.end(body);
      }, async fixture => {
        const result = await cli(['read', '7'], fixture);
        assert.notEqual(result.status, 0);
        const diagnostic = contentType === 'application/json' ? JSON.parse(body).error : body;
        assert.ok(result.stderr.includes(diagnostic), result.stderr);
      });
    });
  }
  await t.test('malformed HTTP 200 JSON is an error', async () => {
    await mock((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{invalid success JSON');
    }, async fixture => {
      const result = await cli(['read', '7'], fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid JSON.*HTTP 200/);
    });
  });
  await t.test('HTTP 200 null cannot become a successful empty read', async () => {
    await mock((_,res)=>{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end('null');
    },async fixture=>{
      const result=await cli(['read','7'],fixture);
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/invalid acom response: expected a JSON object/);
    });
  });
  await t.test('a response above the client read cap is an error', async () => {
    const body = JSON.stringify({ id: 7, thread: 1, sender: 0, text: 'x'.repeat(10 * 1024 * 1024 + 100), at: 0 });
    await mock((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    }, async fixture => {
      const result = await cli(['read', '7'], fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /can't read the acom response.*HTTP 200/);
    });
  });
  await t.test('truncated HTTP 200 cannot become a successful empty read', async () => {
    await mock((_, res) => {
      const body = JSON.stringify({ id: 7, text: 'partial response' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) + 100, Connection: 'close' });
      res.end(body);
    }, async fixture => {
      const result = await cli(['read', '7'], fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /can't read the acom response.*HTTP 200/);
    });
  });
});

test('CLI uncertain write responses warn without automatically resending',async t=>{
  for(const [name,handler,diagnostic] of [
    ['malformed JSON',(_,res)=>{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end('{invalid completed action JSON');
    },/invalid JSON.*HTTP 200/],
    ['truncated HTTP 200',(_,res)=>{
      const body=JSON.stringify({id:8,not_woken:[]});
      res.writeHead(200,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)+100,Connection:'close'});
      res.end(body);
    },/can't read the acom response.*HTTP 200/],
    ['null successful body',(_,res)=>{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end('null');
    },/invalid acom response: expected a JSON object/],
    ['disconnect after receiving the POST',(req)=>{
      req.once('end',()=>req.socket.destroy());
      req.resume();
    },/can't reach the acom server/],
  ]) {
    await t.test(name,async()=>{
      await mock(handler,async fixture=>{
        fixture.env.ACOM_ID='1';
        const result=await cli(['send','--thread','7','once'],fixture);
        assert.equal(result.status,1);
        assert.match(result.stderr,diagnostic);
        assert.match(result.stderr,/action may have completed\. Inspect current state before retrying/);
        assert.doesNotMatch(result.stdout,/^sent #/m);
        assert.deepEqual(fixture.requests,[{method:'POST',url:'/messages'}],'an uncertain receipt must not trigger an automatic resend');
      });
    });
  }
});

test('failed project lookup retains its cause and never launches an agent', async t => {
  for (const status of [500, 404]) {
    await t.test(`project lookup HTTP ${status}${status === 404 ? ' with truncated body' : ''}`, async () => {
      await mock((_, res) => {
        const body = JSON.stringify({ error: 'project database lookup failed explicitly' });
        res.writeHead(status, {
          'Content-Type': 'application/json',
          ...(status === 404 ? { 'Content-Length': Buffer.byteLength(body) + 100, Connection: 'close' } : {}),
        });
        res.end(body);
      }, async fixture => {
        const result = await cli(['launch', '--task', 'must never launch'], fixture);
        assert.notEqual(result.status, 0);
        if (status === 500) assert.match(result.stderr, /project database lookup failed explicitly/);
        else assert.match(result.stderr, /can't read the acom response.*HTTP 404/);
        assert.equal(fixture.requests.filter(req => req.method === 'POST').length, 0);
        assert.ok(fixture.requests.some(req => req.url.startsWith('/projects?path=')));
      });
    });
  }
  await t.test('project lookup HTTP 200 null cannot create a project',async()=>{
    await mock((_,res)=>{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end('null');
    },async fixture=>{
      const result=await cli(['launch','--task','must never launch'],fixture);
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/invalid acom response: expected a JSON object/);
      assert.equal(fixture.requests.filter(req=>req.method==='POST').length,0);
    });
  });
});

async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

async function isolated(run) {
  const executableDir = path.dirname(fs.realpathSync(binary));
  for (const client of ['codex', 'claude']) {
    assert.equal(fs.existsSync(path.join(executableDir, client)), false, `${client} must not shadow the empty fixture PATH`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-page-test-'));
  const home = path.join(root, 'state'), bin = path.join(root, 'bin'), projectDir = path.join(root, 'project');
  for (const dir of [home, bin, projectDir]) fs.mkdirSync(dir);
  const env = { ...process.env, ACOM_HOME: home, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'no-credentials'), PATH: bin };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete env[key];
  let server, url, errors = '';
  const stop = async () => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  };
  const start = async () => {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    url = `http://127.0.0.1:${port}`;
    server = spawn(binary, ['serve', '--port', String(port)], { env, cwd: projectDir, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', chunk => errors += chunk);
    await until(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`server exited: ${errors}`);
      try { return (await fetch(url + '/overview')).ok; } catch { return false; }
    }, 'isolated server startup');
  };
  const api = async (method, route, body, status = 200, budget) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${route}: ${text.slice(0, 1000)}`);
    if (budget !== undefined && status === 200) assert.ok(Buffer.byteLength(text) <= budget, `${route} exceeded ${budget} bytes (${Buffer.byteLength(text)})`);
    return JSON.parse(text);
  };
  const db = action => {
    const connection = new DatabaseSync(path.join(home, 'acom.db'));
    try { connection.exec('PRAGMA busy_timeout=5000'); return action(connection); }
    finally { connection.close(); }
  };
  try {
    await start();
    const project = await api('POST', '/projects', { path: projectDir });
    // All agents are closed database fixtures. No API launch or provider client
    // exists, and the empty PATH also prevents periodic checks from falling back.
    db(connection => {
      connection.exec('BEGIN');
      const insert = connection.prepare("INSERT INTO agents(id,project,name,grp,task,harness,model,effort,state,launched_by,launched_at) VALUES(?,?,?,?,?,'codex','gpt-6-sol','medium','closed',0,0)");
      for (let id = 1; id <= 130; id++) insert.run(id, project.id, `fixture ${id}`, 'team', `task ${id}`);
      const usage = connection.prepare('INSERT INTO usage_checks(provider,attempted_at,next_check,in_flight) VALUES(?,?,?,0) ON CONFLICT(provider) DO UPDATE SET attempted_at=excluded.attempted_at,next_check=excluded.next_check,in_flight=0');
      const now = Math.floor(Date.now() / 1000);
      for (const provider of ['codex', 'claude']) usage.run(provider, now, now + 3600);
      connection.exec('COMMIT');
    });
    await run({ api, db, start, stop, home, env, project, projectDir, root });
  } finally {
    await stop();
    fs.rmSync(root,{recursive:true,force:true});
  }
}

function params(route, values) {
  const url = new URL(route, 'http://fixture');
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) url.searchParams.set(key, value);
  return url.pathname + url.search;
}

async function collect(api, route, { ascending = false, limit = 3, max_bytes = 2048 } = {}) {
  let query = { limit, max_bytes }, previous, count = 0;
  const items = [];
  for (;;) {
    const page = await api('GET', params(route, query), undefined, 200, max_bytes);
    assert.ok(Array.isArray(page.items), `missing items envelope: ${JSON.stringify(page)}`);
    assert.ok(page.items.length <= limit);
    assert.equal(typeof page.total, 'number');
    for (const item of page.items) {
      assert.equal(typeof item.id, 'number');
      if (previous !== undefined) assert.ok(ascending ? item.id > previous : item.id < previous, `cursor repeated or reordered ID ${item.id}`);
      previous = item.id;
      items.push(item);
    }
    if (!page.has_more) return { items, page };
    assert.ok(page.items.length > 0, 'nonterminal page must make progress');
    const direction = ascending ? 'after' : 'before';
    const cursor = ascending ? page.next_after : page.next_before;
    assert.equal(cursor, page.items.at(-1).id);
    query = { limit, max_bytes, [direction]: cursor, through: page.through, revision: page.revision };
    assert.ok(++count < 1000, 'pagination did not terminate');
  }
}

async function complete(api, route, max_bytes = 1024) {
  const stub = await api('GET', params(route, { max_bytes }), undefined, 200, max_bytes);
  assert.equal(stub.truncated, true, 'large detail needs an explicit recoverable stub');
  assert.equal(stub.next_offset, 0);
  assert.equal(typeof stub.version, 'string');
  assert.ok(stub.total_bytes > max_bytes);
  let offset = 0, serialized = '', count = 0;
  for (;;) {
    const page = await api('GET', params(route, { offset, version: stub.version, max_bytes }), undefined, 200, max_bytes);
    assert.equal(page.offset, offset);
    assert.equal(page.version, stub.version);
    assert.equal(page.total_bytes, stub.total_bytes);
    assert.equal(page.format, 'json');
    assert.equal(typeof page.chunk, 'string');
    serialized += page.chunk;
    const next = offset + Buffer.byteLength(page.chunk);
    if (!page.has_more) {
      assert.equal(next, stub.total_bytes);
      assert.equal(page.next_offset, next);
      return { value: JSON.parse(serialized), serialized, stub };
    }
    assert.ok(next > offset, 'chunk cursor did not advance');
    assert.equal(page.next_offset, next);
    offset = next;
    assert.ok(++count < 1000, 'detail chunking did not terminate');
  }
}

test('immutable message pages and UTF-8 chunks remain complete across bounded reads', async t => {
  await isolated(async fixture => {
    const { api, db, project, start, stop } = fixture;
    const thread = await api('POST', '/threads', { project: project.id, title: 'bounded messages', members: ['1', '2'], include_user: true });
    const longText = '漢🙂"\\\n'.repeat(5000);
    const ids = db(connection => {
      const insert = connection.prepare('INSERT INTO messages(thread_id,sender,text,at) VALUES(?,3,?,0)');
      const result = [];
      for (let index = 0; index < 12; index++) result.push(Number(insert.run(thread.id, index === 5 ? longText : `message ${index}`).lastInsertRowid));
      return result;
    });
    await t.test('thread metadata and chunk reads do not acknowledge unseen messages', async () => {
      const view=await api('GET',`/threads/${thread.id}?limit=2&max_bytes=4096`,undefined,200,4096);
      assert.equal(view.unread,ids.length);
      assert.equal(view.last_read,0);
      assert.equal(view.latest_message,ids.at(-1));
      assert.deepEqual(view.messages.items.map(item=>item.id),ids.slice(0,2));
      assert.equal(view.messages.has_more,true);
      const hydrated=await complete(api,`/threads/${thread.id}`,512);
      assert.equal(hydrated.value.title,'bounded messages');
      assert.equal(hydrated.value.last_read,0);
      assert.equal(hydrated.value.unread,ids.length);
      assert.equal(db(connection=>connection.prepare('SELECT count(*) n FROM user_reads WHERE thread_id=?').get(thread.id).n),0);
    });
    await t.test('thread message traversal has no skips or duplicates', async () => {
      const result = await collect(api, `/threads/${thread.id}/messages`, { limit: 2 });
      assert.deepEqual(result.items.map(item => item.id), ids.toReversed());
      assert.ok(result.items.some(item => item.id === ids[5] && item.truncated), 'oversized record must remain in its ID position');
    });
    await t.test('large message detail reconstructs exactly through UTF-8 JSON chunks', async () => {
      const result = await complete(api, `/messages/${ids[5]}`);
      assert.equal(result.value.text, longText);
      const bytes = Buffer.from(result.serialized);
      const split = bytes.indexOf(Buffer.from('漢')) + 1;
      assert.ok(split > 0 && split < bytes.length);
      await api('GET', params(`/messages/${ids[5]}`, { offset: split, version: result.stub.version, max_bytes: 1024 }), undefined, 400);
      await api('GET', params(`/messages/${ids[5]}`, { offset: 1, max_bytes: 1024 }), undefined, 400);
      await api('GET', params(`/messages/${ids[5]}`, { offset: bytes.length + 1, version: result.stub.version, max_bytes: 1024 }), undefined, 400);
      db(connection => connection.prepare('UPDATE messages SET text=? WHERE id=?').run(longText + ' changed', ids[5]));
      await api('GET', params(`/messages/${ids[5]}`, { offset: 1, version: result.stub.version, max_bytes: 1024 }), undefined, 409);
    });
    await t.test('limited inbox reads leave unseen notifications and message marks alone', async () => {
      const page = await api('GET', `/inbox/1?limit=2&max_bytes=4096`, undefined, 200, 4096);
      assert.equal(page.items.length, 2);
      assert.deepEqual(page.items.map(item => item.id), ids.slice(0, 2));
      const notified = db(connection => connection.prepare('SELECT last_notified FROM members WHERE thread_id=? AND agent_id=1').get(thread.id).last_notified);
      assert.ok(notified <= page.items.at(-1).id, 'a page acknowledged messages it did not return');
      assert.equal(db(connection => connection.prepare('SELECT count(*) n FROM marks WHERE agent_id=1').get().n), 0);
      const unchanged=await api('GET',params('/inbox/1',{since:page.revision,limit:2,max_bytes:4096}));
      assert.equal(unchanged.unchanged,true,'notification-only acknowledgement must not invalidate inbox content');
      const inbox = await collect(api, '/inbox/1?mark=new', { ascending: true, limit: 2, max_bytes: 4096 });
      assert.deepEqual(inbox.items.map(item => item.id), ids);
      const afterStub = db(connection => connection.prepare('SELECT last_notified FROM members WHERE thread_id=? AND agent_id=1').get(thread.id).last_notified);
      assert.ok(afterStub < ids[5], 'an oversized stub cannot acknowledge its unseen text or messages beyond that gap');
    });
    await t.test('an explicit skipped range cannot erase earlier pending notifications', async () => {
      db(connection => connection.prepare('UPDATE members SET last_notified=0 WHERE thread_id=? AND agent_id=2').run(thread.id));
      const page = await api('GET', `/inbox/2?after=${ids[7]}&limit=2&max_bytes=4096`, undefined, 200, 4096);
      assert.deepEqual(page.items.map(item => item.id), ids.slice(8, 10));
      const notified = db(connection => connection.prepare('SELECT last_notified FROM members WHERE thread_id=? AND agent_id=2').get(thread.id).last_notified);
      assert.ok(notified < ids[0], 'later delivered messages must not acknowledge an earlier skipped range');
      const pending = db(connection => connection.prepare('SELECT count(*) n FROM messages WHERE thread_id=? AND sender<>2 AND id>?').get(thread.id, notified).n);
      assert.equal(pending, ids.length, 'omitted messages remain pending for notification');
    });
    await t.test('a changed message mark invalidates a pinned inbox traversal',async()=>{
      const first=await api('GET','/inbox/2?limit=2&max_bytes=4096');
      await api('POST','/marks',{agent:2,ids:[ids.at(-1)],mark:'in-progress'});
      await api('GET',params('/inbox/2',{after:first.next_after,through:first.through,revision:first.revision,limit:2,max_bytes:4096}),undefined,409);
      await api('POST','/marks',{agent:2,ids:[ids.at(-1)],mark:'new'});
    });
    await t.test('a bounded user CLI read acknowledges only its displayed prefix', async () => {
      const client={cwd:fixture.projectDir,env:fixture.env};
      const result=await cli(['thread','read',String(thread.id),'--limit','2','--max-bytes','4096'],client);
      assert.equal(result.status,0,result.stderr);
      assert.match(result.stdout,/More available:/);
      const cursor=db(connection=>connection.prepare('SELECT message_id FROM user_reads WHERE thread_id=?').get(thread.id).message_id);
      assert.equal(cursor,ids[1]);
      const next=await api('GET',`/threads/${thread.id}?limit=2&max_bytes=4096`);
      assert.equal(next.unread,ids.length-2);
      assert.deepEqual(next.messages.items.map(item=>item.id),ids.slice(2,4));
      const skipped=await cli(['thread','read',String(thread.id),'--after',String(ids[8]),'--limit','2','--max-bytes','4096'],client);
      assert.equal(skipped.status,0,skipped.stderr);
      assert.equal(db(connection=>connection.prepare('SELECT message_id FROM user_reads WHERE thread_id=?').get(thread.id).message_id),cursor,'a skipped range cannot clear older unseen messages');
    });
    await t.test('an ID ceiling excludes later arrivals until a fresh read', async () => {
      const first = await api('GET', `/threads/${thread.id}/messages?after=0&limit=3&max_bytes=4096`, undefined, 200, 4096);
      const late = await api('POST', '/messages', { thread: thread.id, text: 'arrived after the first page' });
      const seen = [...first.items.map(item => item.id)];
      let page = first;
      while (page.has_more) {
        page = await api('GET', params(`/threads/${thread.id}/messages`, { after: page.next_after, through: first.through, limit: 3, max_bytes: 4096 }), undefined, 200, 4096);
        seen.push(...page.items.map(item => item.id));
      }
      assert.deepEqual(seen, ids);
      assert.ok(!seen.includes(late.id));
      const newPage = await api('GET', params(`/threads/${thread.id}/messages`, { after: first.through, limit: 3, max_bytes: 4096 }));
      assert.deepEqual(newPage.items.map(item => item.id), [late.id]);
    });
    await t.test('cursor traversal resumes after an isolated server restart', async () => {
      const first = await api('GET', `/threads/${thread.id}/messages?after=0&limit=2&max_bytes=4096`);
      await stop(); await start();
      const second = await api('GET', params(`/threads/${thread.id}/messages`, { after: first.next_after, through: first.through, limit: 2, max_bytes: 4096 }));
      assert.ok(second.items.every(item => item.id > first.items.at(-1).id));
      assert.equal(second.items[0].id, ids[2]);
    });
    await t.test('default detail hydration preserves the user membership context', async () => {
      const catchup=await api('POST','/threads',{project:project.id,title:'membership catch-up',members:['1'],include_user:true});
      await api('POST',`/threads/${catchup.id}/user`,{joined:false});
      const text='outside membership 漢🙂'.repeat(800);
      const outside=db(connection=>Number(connection.prepare('INSERT INTO messages(thread_id,sender,text,at) VALUES(?,1,?,0)').run(catchup.id,text).lastInsertRowid));
      await api('POST',`/threads/${catchup.id}/user`,{joined:true});
      const inside=db(connection=>Number(connection.prepare('INSERT INTO messages(thread_id,sender,text,at) VALUES(?,1,?,0)').run(catchup.id,'new unread message').lastInsertRowid));
      const page=await api('GET',`/threads/${catchup.id}/messages?after=0&max_bytes=65536`);
      const hydrated=await complete(api,`/messages/${outside}`,512);
      const explicit=await api('GET',`/messages/${outside}?agent=0&max_bytes=65536`);
      assert.deepEqual(hydrated.value,explicit);
      assert.equal(hydrated.value.outside_membership,true);
      assert.equal(hydrated.value.membership_unknown,false);
      assert.equal(page.items[0].outside_membership,hydrated.value.outside_membership);
      assert.equal(page.items[0].membership_unknown,hydrated.value.membership_unknown);
      assert.equal(page.items[1].id,inside);
      assert.equal(page.items[1].outside_membership,false);
      const metadata=await api('GET',`/threads/${catchup.id}/metadata`);
      assert.equal(metadata.unread,1);
      assert.equal(metadata.first_unread,inside);
    });
  });
});

test('mutable collection cursors reject changed views and conditional reads stay bounded', async t => {
  await isolated(async ({ api, db, project }) => {
    await t.test('all agents are reachable within record and byte budgets', async () => {
      const result = await collect(api, `/agents?project=${project.id}`, { limit: 7, max_bytes: 4096 });
      assert.deepEqual(result.items.map(item => item.id), Array.from({ length: 130 }, (_, i) => 130 - i));
      assert.equal(result.page.total, 130);
    });
    await t.test('no-op writes preserve revision; real mutations reject old continuation', async () => {
      const first = await api('GET', `/agents?project=${project.id}&limit=3&max_bytes=4096`);
      await api('POST', '/agents/1/group', { group: 'team' });
      const unchanged = await api('GET', params(`/agents?project=${project.id}`, { since: first.revision, limit: 3, max_bytes: 4096 }));
      assert.equal(unchanged.unchanged, true);
      await api('POST', '/agents/1/group', { group: 'changed' });
      await api('GET', params(`/agents?project=${project.id}`, { before: first.next_before, through: first.through, revision: first.revision, limit: 3, max_bytes: 4096 }), undefined, 409);
      const fresh = await api('GET', `/agents?project=${project.id}&limit=3&max_bytes=4096`);
      assert.notEqual(fresh.revision, first.revision);
    });
    await t.test('counter updates also invalidate a collection cursor', async () => {
      const first = await api('GET', `/agents?project=${project.id}&limit=3&max_bytes=4096`);
      db(connection => connection.prepare('UPDATE agents SET output=output+1 WHERE id=1').run());
      await api('GET', params(`/agents?project=${project.id}`, { before: first.next_before, through: first.through, revision: first.revision, limit: 3, max_bytes: 4096 }), undefined, 409);
    });
    await t.test('invalid cursors and sizes fail explicitly', async () => {
      for (const query of ['limit=0', 'limit=201', 'max_bytes=511', 'max_bytes=65537', 'before=1&after=2', 'before=-1', 'through=-1']) {
        await api('GET', `/agents?project=${project.id}&${query}`, undefined, 400);
      }
    });
    await t.test('obsolete lock-preservation inputs are rejected without changing ownership',async()=>{
      const name='ordinary pause fixture';
      await api('POST','/locks',{project:project.id,name,about:'pause releases an ordinary timed lease'});
      db(connection=>{
        connection.prepare("UPDATE agents SET state='idle' WHERE id=1").run();
        connection.prepare('UPDATE locks SET holder=1,expires_at=?,frozen=0,frozen_left=NULL WHERE project=? AND name=?').run(Math.floor(Date.now()/1000)+600,project.id,name);
      });
      const holder=()=>db(connection=>connection.prepare('SELECT holder FROM locks WHERE project=? AND name=?').get(project.id,name).holder);
      try {
        for(const expected_holder of [null,'1',0,-1,1.5,false,1]) {
          await api('POST','/locks/free',{project:project.id,name,expected_holder},400);
          assert.equal(holder(),1);
        }
        for(const locks of ['keep','release',null]) {
          await api('POST','/agents/1/pause',{locks},400);
          assert.equal(holder(),1);
          assert.equal((await api('GET','/agents/1')).state,'idle');
        }
        const listed=(await api('GET',`/locks?project=${project.id}`)).items[0];
        assert.equal(Object.hasOwn(listed,'frozen'),false);
        assert.equal(Object.hasOwn(listed,'frozen_left'),false);
        await api('POST','/agents/1/pause',{});
        await until(()=>holder()===null,'even an idle pause releases after asynchronous cleanup proof');
        assert.equal(holder(),null);
        assert.equal((await api('GET','/agents/1')).state,'paused');
        db(connection=>connection.prepare('UPDATE locks SET holder=1,expires_at=? WHERE project=? AND name=?').run(Math.floor(Date.now()/1000)+600,project.id,name));
        await api('POST','/locks/free',{project:project.id,name});
        assert.equal(holder(),null,'ordinary explicit user Free remains supported');
      } finally {
        db(connection=>connection.prepare("UPDATE agents SET state='closed',pid=NULL WHERE id=1").run());
      }
    });
  });
});

test('large detail types and agent logs remain recoverable without providers', async t => {
  await isolated(async ({ api, db, home, project, projectDir }) => {
    const longText='漢🙂"\\\n'.repeat(2000);
    await t.test('agent and lock details retain omitted large fields', async () => {
      db(connection=>connection.prepare('UPDATE agents SET task=? WHERE id=1').run(longText));
      assert.equal((await complete(api,'/agents/1')).value.task,longText);
      await api('POST','/locks',{project:project.id,name:'large detail',about:longText});
      const locks=await collect(api,`/locks?project=${project.id}`,{max_bytes:512});
      assert.equal(locks.items.length,1);
      assert.equal(locks.items[0].truncated,true);
      assert.equal((await complete(api,`/locks/${locks.items[0].id}`)).value.about,longText);
    });
    await t.test('configuration stubs can be recovered by ID', async () => {
      const base=await api('GET','/configs/1?max_bytes=65536');
      base.settings.prompts.launch='漢🙂"\\\n'.repeat(300);
      const added=await api('POST','/configs',{name:'large configuration',settings:base.settings});
      const result=await complete(api,`/configs/${added.id}`,512);
      assert.equal(result.value.settings.prompts.launch,base.settings.prompts.launch);
      const configs=await collect(api,'/configs',{max_bytes:512});
      assert.deepEqual(configs.items.map(item=>item.id),[added.id,1]);
      assert.ok(configs.items.every(item=>item.truncated));
    });
    await t.test('oversized thread metadata retains full title and membership', async () => {
      const thread=await api('POST','/threads',{project:project.id,title:longText,members:['1','2'],include_user:true});
      const page=await api('GET',`/threads?project=${project.id}&limit=1&max_bytes=512`,undefined,200,512);
      assert.equal(page.items[0].id,thread.id);
      assert.equal(page.items[0].truncated,true);
      assert.equal(page.items[0].user_member,true);
      assert.equal(page.items[0].unread,0);
      assert.equal(page.items[0].messages,0);
      const result=await complete(api,`/threads/${thread.id}`,512);
      assert.equal(result.value.title,longText.trim());
      assert.deepEqual(result.value.members,[0,1,2]);
      const metadata=await complete(api,`/threads/${thread.id}/metadata`,512);
      assert.equal(metadata.value.title,longText.trim());
      assert.deepEqual(metadata.value.members,[0,1,2]);
    });
    await t.test('activity traversal keeps oversized records in place and details recover them',async()=>{
      const largeId=db(connection=>{
        const insert=connection.prepare("INSERT INTO activity(project,at,actor,what) VALUES(?,0,'owned fixture',?)");
        let largeId;
        for(let index=0;index<100;index++) {
          const inserted=Number(insert.run(project.id,index===96?longText:`activity ${index}`).lastInsertRowid);
          if(index===96) largeId=inserted;
        }
        return largeId;
      });
      const expected=db(connection=>connection.prepare('SELECT id FROM activity WHERE project=? OR project IS NULL ORDER BY id DESC').all(project.id).map(row=>row.id));
      const activity=await collect(api,`/activity?project=${project.id}`,{limit:5,max_bytes:512});
      assert.deepEqual(activity.items.map(item=>item.id),expected);
      const large=activity.items.find(item=>item.id===largeId);
      assert.equal(large.truncated,true);
      assert.equal((await complete(api,`/activity/${largeId}?project=${project.id}`,512)).value.what,longText);
    });
    await t.test('folder pages have stable lexical cursors and reject stale continuations', async () => {
      const expected=[];
      for(let index=0;index<15;index++) {
        const name=`entry ${String(index).padStart(2,'0')} 漢🙂`;
        const directory=index%2===0;
        if(directory) fs.mkdirSync(path.join(projectDir,name));
        else fs.writeFileSync(path.join(projectDir,name),'owned fixture');
        expected.push(`${directory?'d':'f'}:${name}`);
      }
      expected.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
      const first=await api('GET',params('/folders',{path:projectDir,limit:3,max_bytes:1024}),undefined,200,1024);
      const seen=[];
      let page=first;
      for(;;) {
        seen.push(...page.entries.map(entry=>`${entry.directory?'d':'f'}:${entry.name}`));
        if(!page.has_more) break;
        assert.ok(page.entries.length>0);
        page=await api('GET',params('/folders',{path:projectDir,after:page.next_after,revision:first.revision,limit:3,max_bytes:1024}),undefined,200,1024);
      }
      assert.deepEqual(seen,expected);
      assert.equal((await api('GET',params('/folders',{path:projectDir,since:first.revision,limit:3,max_bytes:1024}))).unchanged,true);
      fs.writeFileSync(path.join(projectDir,'new record'),'owned fixture');
      await api('GET',params('/folders',{path:projectDir,after:first.next_after,revision:first.revision,limit:3,max_bytes:1024}),undefined,409);
      await api('GET',params('/folders',{path:projectDir,after:first.next_after,limit:3,max_bytes:1024}),undefined,400);
    });
    await t.test('log byte cursors reconstruct escaped UTF-8 and pin append ceilings', async () => {
      const log=path.join(home,'logs','1.txt');
      const original=longText+'\nsecond line\n';
      fs.mkdirSync(path.dirname(log),{recursive:true});
      fs.writeFileSync(log,original);
      const first=await api('GET','/agents/1/log?after=0&max_bytes=512&lines=200',undefined,200,512);
      const through=first.through, version=first.version;
      fs.appendFileSync(log,'new arrival 漢🙂\n');
      let page=first, text=page.text, count=0;
      while(page.has_more) {
        const previous=page.next_after;
        page=await api('GET',params('/agents/1/log',{after:previous,through,version,max_bytes:512,lines:200}),undefined,200,512);
        assert.equal(page.start,previous);
        assert.equal(page.next_after,page.end);
        assert.ok(page.end>page.start);
        text+=page.text;
        assert.ok(++count<1000);
      }
      assert.equal(text,original);
      page=await api('GET',params('/agents/1/log',{through,version,max_bytes:512,lines:200}),undefined,200,512);
      const older=[page.text];
      count=0;
      while(page.has_more) {
        const previous=page.next_before;
        page=await api('GET',params('/agents/1/log',{before:previous,through,version,max_bytes:512,lines:200}),undefined,200,512);
        assert.equal(page.end,previous);
        assert.ok(page.end>page.start);
        older.unshift(page.text);
        assert.ok(++count<1000);
      }
      assert.equal(older.join(''),original,'backward byte pages must recover the same full log');
      const arrival=await api('GET',params('/agents/1/log',{after:through,version,max_bytes:512}),undefined,200,512);
      assert.equal(arrival.text,'new arrival 漢🙂\n');
      await api('GET',params('/agents/1/log',{after:1,version,max_bytes:512}),undefined,400);
      await api('GET',params('/agents/1/log',{before:1,version,max_bytes:512}),undefined,400);
      fs.renameSync(log,path.join(home,'logs','old-owned-log.txt'));
      fs.writeFileSync(log,'replacement log\n');
      await api('GET',params('/agents/1/log',{after:0,version,max_bytes:512}),undefined,409);
    });
  });
});

test('retained notices and large mutation receipts stay bounded without replay', async t => {
  await isolated(async ({api,db,env,project,projectDir})=>{
    const longText='漢🙂"\\\n'.repeat(2000);
    await t.test('notice pages and chunks preserve content without consuming unseen notices',async()=>{
      const ids=db(connection=>{
        const insert=connection.prepare('INSERT INTO notices(agent_id,text,at) VALUES(3,?,0)');
        return Array.from({length:130},(_,index)=>Number(insert.run(index===0?longText:`retained notice ${index}`).lastInsertRowid));
      });
      const notes=await collect(api,'/notices/3',{limit:7,max_bytes:512});
      assert.deepEqual(notes.items.map(item=>item.id),ids.toReversed());
      assert.equal(notes.items.at(-1).truncated,true);
      assert.equal((await complete(api,`/notices/3/${ids[0]}`,512)).value.text,longText);
      assert.equal(db(connection=>connection.prepare('SELECT count(*) n FROM notices WHERE agent_id=3 AND shown<>0').get().n),0);
      const output=await cli(['notices','--limit','2','--max-bytes','1024'],{cwd:projectDir,env:{...env,ACOM_ID:'3'}});
      assert.equal(output.status,0,output.stderr);
      assert.match(output.stdout,/More available: acom notices/);
      db(connection=>connection.prepare("UPDATE agents SET state='working',pid=NULL WHERE id=3").run());
      try {
        const hook=await api('POST','/hook/3',{},200,16000);
        assert.equal(typeof hook.text,'string');
        assert.match(hook.text,/more notices waiting/);
        assert.match(hook.text,new RegExp(`acom notices ${ids[0]}`));
        const shown=db(connection=>connection.prepare('SELECT count(*) n FROM notices WHERE agent_id=3 AND shown<>0').get().n);
        assert.ok(shown>0 && shown<=25);
        assert.equal(db(connection=>connection.prepare('SELECT count(*) n FROM notices WHERE agent_id=3 AND shown=0').get().n),ids.length-shown);
      } finally {
        db(connection=>connection.prepare("UPDATE agents SET state='closed',pid=NULL WHERE id=3").run());
      }
    });
    await t.test('oversized send receipt is saved and subsequent reads do not send again',async()=>{
      db(connection=>{
        const insert=connection.prepare("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(?,?,?,'closed receipt fixture','codex','gpt-6-sol','medium','closed',0,0)");
        for(let id=131;id<=300;id++) insert.run(id,project.id,`receipt fixture ${id}`);
      });
      const thread=await api('POST','/threads',{project:project.id,title:'large receipt',members:Array.from({length:300},(_,index)=>String(index+1)),include_user:true});
      const receipt=await api('POST','/messages',{thread:thread.id,text:'exactly one saved message'},200,16000);
      assert.equal(receipt.result_truncated,true);
      assert.equal(receipt.counts.not_woken,300);
      assert.ok(receipt.not_woken.length<300);
      assert.equal(typeof receipt.id,'number');
      assert.equal(typeof receipt.receipt_event,'number');
      const saved=await complete(api,`/receipts/${receipt.receipt_event}`,1024);
      assert.equal(saved.value.kind,'command.receipt');
      assert.equal(saved.value.details.response.id,receipt.id);
      assert.equal(saved.value.details.response.not_woken.length,300);
      assert.deepEqual(saved.value.details.response.not_woken.map(item=>item.agent),Array.from({length:300},(_,index)=>index+1));
      const read=await cli(['receipt',String(receipt.receipt_event),'--max-bytes','65536'],{cwd:path.dirname(projectDir),env});
      assert.equal(read.status,0,read.stderr);
      assert.equal(JSON.parse(read.stdout).details.response.not_woken.length,300);
      assert.equal(db(connection=>connection.prepare('SELECT count(*) n FROM messages WHERE thread_id=?').get(thread.id).n),1);
      const own=await api('GET',`/receipts/${receipt.receipt_event}?agent=1&max_bytes=65536`);
      assert.equal(own.id,receipt.receipt_event);
      const otherDir=path.join(path.dirname(projectDir),'foreign-project');
      fs.mkdirSync(otherDir);
      const other=await api('POST','/projects',{path:otherDir});
      db(connection=>connection.prepare("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(301,?,'foreign receipt reader','closed fixture','codex','gpt-6-sol','medium','closed',0,0)").run(other.id));
      await api('GET',`/receipts/${receipt.receipt_event}?agent=301&max_bytes=65536`,undefined,404);
    });
  });
});
