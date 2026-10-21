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

test('CLI agent lifecycle filters validate before requests and retain paging scope', async t => {
  for (const flags of [
    ['--state', 'unknown'], ['--state', ''], ['--state', 'Paused'],
    ['--pause-reason', 'unknown'], ['--pause-reason', ''], ['--pause-reason', 'user'],
    ['--state', 'idle', '--pause-reason', 'limit'],
  ]) await t.test(`rejects ${JSON.stringify(flags)}`, async () => {
    await mock((_, res) => res.end('{}'), async fixture => {
      const result = await cli(['agents', ...flags], fixture);
      assert.notEqual(result.status, 0);
      assert.deepEqual(fixture.requests, [], 'invalid lifecycle filters must fail before project discovery');
    });
  });
  for (const flags of [
    ['--state', 'paused', '--pause-reason', 'limit'],
    ['--pause-reason', 'manual'],
  ]) await t.test(`retains ${flags.join(' ')}`, async () => {
    await mock((req, res) => {
      req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/agents/7/project' ? { project: 9 } : {
        items: [{ id: 12, truncated: true }], has_more: true, next_before: 12,
        next_after: null, total: 3, through: 20, revision: 'filtered-view', event_cursor: 21,
      }));
    }, async fixture => {
      fixture.env.ACOM_ID = '7';
      const result = await cli(['agents', ...flags, '--group', 'two words', '--event-cursor', '--limit', '1', '--max-bytes', '512'], fixture);
      assert.equal(result.status, 0, result.stderr);
      const request = fixture.requests.find(request => request.url.startsWith('/agents?'));
      assert.ok(request, JSON.stringify(fixture.requests));
      const query = new URL(request.url, 'http://fixture').searchParams;
      assert.equal(query.get('project'), '9');
      assert.equal(query.get('group'), 'two words');
      assert.equal(query.get('pause_reason'), flags.at(-1));
      if (flags.includes('--state')) assert.equal(query.get('state'), 'paused');
      assert.equal(query.get('limit'), '1'); assert.equal(query.get('max_bytes'), '512');
      const hint = result.stdout.split('\n').find(line => line.startsWith('More available: '));
      assert.ok(hint, result.stdout);
      for (const [index, flag] of flags.entries()) if (index % 2 === 0) {
        assert.ok(hint.includes(`${flag} '${flags[index + 1]}'`) || hint.includes(`${flag} ${flags[index + 1]}`), hint);
      }
      assert.match(hint, /--group 'two words'/);
      assert.match(hint, /--event-cursor/); assert.match(hint, /--before 12/);
      assert.match(hint, /--through 20/); assert.match(hint, /--revision 'filtered-view'/);
      assert.match(result.stdout, /Event cursor: 21/);
      assert.ok(fixture.requests.every(request => request.method === 'GET'));
    });
  });
});

test('CLI agent queries validate before discovery and preserve every paging filter', async t => {
  for (const flags of [
    ['--search', 'unknown:value'], ['--search', 'provider:other'],
    ['--search', 'state:paused,unknown'], ['--search', 'pause_reason:user'],
    ['--search', 'group:'], ['--search', 'group:"unterminated'],
    ['--search', 'model:model-id model:other'],
    ['--search', 'group:team', '--group', 'team'],
    ['--search', 'provider:codex', '--provider', 'codex'],
    ['--search', 'state:crashed', '--pause-reason', 'limit'],
    ['--provider', 'other'], ['--model', ''], ['--effort', ''],
  ]) await t.test(`rejects ${JSON.stringify(flags)}`, async () => {
    await mock((_, res) => res.end('{}'), async fixture => {
      const result = await cli(['agents', ...flags], fixture);
      assert.notEqual(result.status, 0, result.stdout);
      assert.deepEqual(fixture.requests, [], 'invalid queries must fail before project discovery');
    });
  });
  await t.test('continuation hints retain structured fields, query and event baseline', async () => {
    const search = 'state:paused,crashed "provider:literal" reentrancy';
    await mock((req, res) => {
      req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/agents/7/project' ? { project: 9 } : {
        items: [{ id: 12, truncated: true }], has_more: true, next_before: 12,
        next_after: null, total: 3, through: 20, revision: 'query-view', event_cursor: 21,
      }));
    }, async fixture => {
      fixture.env.ACOM_ID = '7';
      const flags = ['--group', 'Security review', '--provider', 'codex', '--model', 'model,id', '--effort', 'custom-effort', '--search', search];
      const result = await cli(['agents', ...flags, '--event-cursor', '--limit', '1', '--max-bytes', '512'], fixture);
      assert.equal(result.status, 0, result.stderr);
      const request = fixture.requests.find(request => request.url.startsWith('/agents?'));
      assert.ok(request, JSON.stringify(fixture.requests));
      const query = new URL(request.url, 'http://fixture').searchParams;
      for (let index = 0; index < flags.length; index += 2) assert.equal(query.get(flags[index].slice(2)), flags[index + 1]);
      assert.equal(query.get('project'), '9');
      const hint = result.stdout.split('\n').find(line => line.startsWith('More available: '));
      assert.ok(hint, result.stdout);
      for (let index = 0; index < flags.length; index += 2) assert.ok(hint.includes(`${flags[index]} '${flags[index + 1]}'`) || hint.includes(`${flags[index]} ${flags[index + 1]}`), hint);
      assert.match(hint, /--event-cursor/); assert.match(hint, /--before 12/);
      assert.match(hint, /--through 20/); assert.match(hint, /--revision 'query-view'/);
      assert.match(result.stdout, /Event cursor: 21/);
      assert.ok(fixture.requests.every(request => request.method === 'GET'));
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

test('agent filters search the whole project and return exact bounded facets', async t => {
  await isolated(async ({ api, db, project, root }) => {
    const states = new Map([[1, 'paused'], [2, 'crashed'], [3, 'working'], [4, 'idle'], [5, 'done'], [6, 'replaced'], [7, 'paused'], [8, 'working']]);
    const records = Array.from({ length: 130 }, (_, index) => ({ id: index + 1, state: states.get(index + 1) || 'closed' }));
    const matches = (record, category) => category === 'all'
      || category === 'active' && ['working', 'idle'].includes(record.state)
      || category === 'attention' && (['paused', 'crashed'].includes(record.state) || record.id === 9)
      || category === 'finished' && ['done', 'closed', 'replaced'].includes(record.state);
    const counts = rows => Object.fromEntries(['all', 'active', 'attention', 'finished'].map(category => [category, rows.filter(record => matches(record, category)).length]));
    const longTask = `${'x'.repeat(900)} ÄäDeepNeedle 東京🙂`;
    db(connection => {
      connection.exec('BEGIN');
      const update = connection.prepare('UPDATE agents SET state=?,grp=?,task=?,pause_reason=? WHERE id=?');
      for (const record of records) update.run(record.state, record.id <= 8 ? 'facet' : 'team', record.id === 1 ? longTask : `${record.id <= 9 ? 'cohort ' : ''}task ${record.id}`, record.id === 7 ? 'restart' : null, record.id);
      // A pending start is attention even when its terminal row is also finished.
      connection.prepare('INSERT INTO agent_starts(agent_id,predecessor) VALUES(9,6)').run();
      connection.exec('COMMIT');
    });
    await t.test('off-page categories traverse without skips, duplicates or oversized metadata', async () => {
      const initial = await api('GET', `/agents?project=${project.id}&limit=2&max_bytes=65536`);
      assert.deepEqual(initial.items.map(item => item.id), [130, 129]);
      for (const category of ['all', 'active', 'attention', 'finished']) {
        const page = await api('GET', `/agents?project=${project.id}&category=${category}&limit=3&max_bytes=512`, undefined, 200, 512);
        assert.deepEqual(page.counts, counts(records));
        assert.equal(page.total, counts(records)[category]);
        assert.equal(page.project_total, 130);
        assert.equal(typeof page.event_cursor, 'number');
        assert.equal(page.items[0].truncated, true);
      }
      const attention = await collect(api, `/agents?project=${project.id}&category=attention`, { limit: 3, max_bytes: 512 });
      assert.deepEqual(attention.items.map(item => item.id), records.filter(record => matches(record, 'attention')).map(record => record.id).reverse());
      assert.deepEqual(attention.page.counts, counts(records));
      const all = await collect(api, `/agents?project=${project.id}`, { limit: 7, max_bytes: 512 });
      assert.deepEqual(all.items.map(item => item.id), records.map(record => record.id).reverse());
      assert.deepEqual(all.page.counts, counts(records));
    });
    await t.test('Unicode case-insensitive search finds text beyond the task preview', async () => {
      const page = await api('GET', params('/agents', { project: project.id, search: '  äädeepNEEDLE 東京🙂  ', max_bytes: 65536 }));
      assert.deepEqual(page.items.map(item => item.id), [1]);
      assert.equal(page.items[0].task_preview.length, 400);
      assert.equal(page.items[0].task_preview.includes('Needle'), false);
      assert.deepEqual(page.counts, counts(records.slice(0, 1)));
      assert.equal(page.project_total, 130);
      const detail = await complete(api, '/agents/1', 512);
      assert.equal(detail.value.task, longTask);
    });
    await t.test('group and search constrain every facet, but category only constrains items', async () => {
      for (const [group, search, selected] of [
        [null, 'cohort', records.slice(1, 9)],
        ['facet', '', records.slice(0, 8)],
        ['facet', 'cohort', records.slice(1, 8)],
        ['missing', '', []],
      ]) for (const category of ['all', 'active', 'attention', 'finished']) {
        const page = await api('GET', params('/agents', { project: project.id, group, search, category, limit: 2, max_bytes: 512 }), undefined, 200, 512);
        assert.deepEqual(page.counts, counts(selected));
        assert.equal(page.total, counts(selected)[category]);
        assert.equal(page.project_total, 130);
        assert.ok(page.items.every(item => selected.some(record => record.id === item.id && matches(record, category))));
      }
    });
    await t.test('changing search, category or group rejects the previous view cursor', async () => {
      const page = await api('GET', `/agents?project=${project.id}&limit=2&max_bytes=512`);
      const cursor = { project: project.id, before: page.next_before, through: page.through, revision: page.revision, limit: 2, max_bytes: 512 };
      for (const changed of [{ category: 'attention' }, { search: 'cohort' }, { group: 'facet' }]) {
        await api('GET', params('/agents', { ...cursor, ...changed }), undefined, 409);
      }
      const same = await api('GET', params('/agents', { ...cursor, category: 'all', search: '   ' }), undefined, 200, 512);
      assert.equal(same.items[0].id, page.items.at(-1).id - 1);
      await api('GET', params('/agents', { project: project.id, category: 'invalid' }), undefined, 400);
      await api('GET', params('/agents', { project: project.id, search: 'é'.repeat(2049) }), undefined, 400);
    });
    await t.test('global bulk-action counts include other projects while facets do not', async () => {
      const otherDir = path.join(root, 'other-project');
      fs.mkdirSync(otherDir);
      const other = await api('POST', '/projects', { path: otherDir });
      db(connection => {
        connection.exec('BEGIN');
        const insert = connection.prepare("INSERT INTO agents(id,project,name,grp,task,harness,model,effort,state,pause_reason,launched_by,launched_at) VALUES(?,?,'foreign cohort','facet','cohort task','codex','gpt-6-sol','medium',?,?,0,0)");
        ['paused', 'paused', 'paused', 'working', 'idle', 'done'].forEach((state, index) => insert.run(131 + index, other.id, state, index < 2 ? 'restart' : state === 'paused' ? 'user' : null));
        connection.exec('COMMIT');
      });
      const overview = await api('GET', `/overview?project=${project.id}`);
      assert.equal(overview.project.id, project.id);
      assert.deepEqual(overview.agent_counts, counts(records));
      assert.equal(overview.restart_paused, 3);
      assert.equal(overview.resume_eligible, 5);
      assert.equal(overview.pause_eligible, 7);
      assert.deepEqual(overview.project_actions, { pause_eligible: 4, resume_eligible: 2, restart_paused: 1 });
      assert.deepEqual((await api('GET', `/overview?project=${other.id}`)).project_actions, { pause_eligible: 3, resume_eligible: 3, restart_paused: 2 });
      const page = await api('GET', params('/agents', { project: project.id, group: 'facet', search: 'cohort', max_bytes: 512 }), undefined, 200, 512);
      assert.deepEqual(page.counts, counts(records.slice(1, 8)));
      assert.equal(page.project_total, 130);
      const all = await api('GET', '/agents?max_bytes=512', undefined, 200, 512);
      assert.equal(all.project_total, 136);
    });
  });
});

test('structured agent filters preserve exact facets, paging and lifecycle scope', async t => {
  await isolated(async ({ api, db, project, root }) => {
    const special = new Map([
      [1, ['paused', 'limit']], [2, ['paused', 'user']], [3, ['paused', 'all']],
      [4, ['paused', 'restart']], [5, ['paused', 'limit']], [6, ['idle', 'limit']],
      [7, ['done', 'limit']], [8, ['working', null]], [9, ['crashed', null]],
      [10, ['replaced', null]], [12, ['paused', null]],
      [127, ['paused', 'limit']], [130, ['paused', 'limit']],
    ]);
    const records = Array.from({ length: 130 }, (_, index) => {
      const id = index + 1, [state, pause_reason] = special.get(id) || ['closed', null];
      return { id, state, pause_reason, group: id <= 12 ? 'facet' : 'team', task: id === 1 ? `${'x'.repeat(900)} ÄäLifecycleNeedle 東京🙂` : `cohort task ${id}` };
    });
    const matchesCategory = (record, category) => category === 'all'
      || category === 'active' && ['working', 'idle'].includes(record.state)
      || category === 'attention' && ['paused', 'crashed'].includes(record.state)
      || category === 'finished' && ['done', 'closed', 'replaced'].includes(record.state);
    const counts = rows => Object.fromEntries(['all', 'active', 'attention', 'finished'].map(category => [category, rows.filter(record => matchesCategory(record, category)).length]));
    const matches = (record, filter) => (!filter.state || record.state === filter.state)
      && (!filter.pause_reason || record.state === 'paused' && (filter.pause_reason === 'manual' ? ['user', 'all'].includes(record.pause_reason) : record.pause_reason === filter.pause_reason))
      && (!filter.group || record.group === filter.group)
      && (!filter.search || record.task.toLowerCase().includes(filter.search.trim().toLowerCase()));
    db(connection => {
      connection.exec('BEGIN');
      const update = connection.prepare('UPDATE agents SET state=?,pause_reason=?,grp=?,task=? WHERE id=?');
      for (const record of records) update.run(record.state, record.pause_reason, record.group, record.task, record.id);
      connection.exec('COMMIT');
    });
    await t.test('every lifecycle state and pause reason finds older matches across bounded pages', async () => {
      const filters = [
        ...['working', 'idle', 'paused', 'done', 'closed', 'crashed', 'replaced'].map(state => ({ state })),
        ...['manual', 'limit', 'restart'].map(pause_reason => ({ pause_reason })),
      ];
      for (const filter of filters) {
        const selected = records.filter(record => matches(record, filter));
        const result = await collect(api, params('/agents', { project: project.id, ...filter }), { limit: 2, max_bytes: 512 });
        assert.deepEqual(result.items.map(item => item.id), selected.map(record => record.id).reverse(), JSON.stringify(filter));
        assert.deepEqual(result.page.counts, counts(selected));
        assert.equal(result.page.total, selected.length);
        assert.equal(result.page.project_total, 130);
      }
    });
    await t.test('state and reason combine with full-text search, group and categories before pagination', async () => {
      for (const filter of [
        { state: 'paused', pause_reason: 'limit' },
        { pause_reason: 'limit', group: 'facet', search: 'cohort' },
        { pause_reason: 'manual', group: 'facet', search: 'cohort' },
        { state: 'paused', search: '  ääLifecycleNeedle 東京🙂  ' },
        { pause_reason: 'restart', group: 'team' },
      ]) for (const category of ['all', 'active', 'attention', 'finished']) {
        const selected = records.filter(record => matches(record, filter));
        const result = await collect(api, params('/agents', { project: project.id, ...filter, category }), { limit: 1, max_bytes: 512 });
        assert.deepEqual(result.items.map(item => item.id), selected.filter(record => matchesCategory(record, category)).map(record => record.id).reverse());
        assert.deepEqual(result.page.counts, counts(selected), JSON.stringify({ ...filter, category }));
        assert.equal(result.page.total, counts(selected)[category]);
        assert.equal(result.page.project_total, 130);
      }
    });
    await t.test('implicit paused state has the same cursor identity; changed filters reject stale cursors', async () => {
      const filter = { project: project.id, pause_reason: 'limit', limit: 1, max_bytes: 512 };
      const first = await api('GET', params('/agents', filter), undefined, 200, 512);
      const explicit = await api('GET', params('/agents', { ...filter, state: 'paused' }), undefined, 200, 512);
      assert.equal(explicit.revision, first.revision);
      assert.deepEqual(explicit.items.map(item => item.id), first.items.map(item => item.id));
      const cursor = { ...filter, before: first.next_before, through: first.through, revision: first.revision };
      const next = await api('GET', params('/agents', { ...cursor, state: 'paused' }), undefined, 200, 512);
      assert.deepEqual(next.items.map(item => item.id), [127]);
      for (const changed of [{ pause_reason: 'manual' }, { pause_reason: undefined, state: 'paused' }, { search: 'cohort' }, { group: 'team' }, { category: 'attention' }]) {
        await api('GET', params('/agents', { ...cursor, ...changed }), undefined, 409);
      }
      const unfiltered = await api('GET', params('/agents', { project: project.id, limit: 1, max_bytes: 512 }));
      await api('GET', params('/agents', { project: project.id, state: 'paused', before: unfiltered.next_before, through: unfiltered.through, revision: unfiltered.revision }), undefined, 409);
      const unchanged = await api('GET', params('/agents', { ...filter, state: 'paused', since: first.revision }));
      assert.equal(unchanged.unchanged, true);
    });
    await t.test('pause transitions invalidate filtered cursors and fresh polls update matches', async () => {
      const filter = { project: project.id, pause_reason: 'limit', limit: 1, max_bytes: 512 };
      const first = await api('GET', params('/agents', filter), undefined, 200, 512);
      db(connection => connection.prepare("UPDATE agents SET state='idle',pause_reason=NULL WHERE id=130").run());
      try {
        await api('GET', params('/agents', { ...filter, before: first.next_before, through: first.through, revision: first.revision }), undefined, 409);
        const fresh = await api('GET', params('/agents', { ...filter, since: first.revision }), undefined, 200, 512);
        assert.notEqual(fresh.unchanged, true);
        assert.equal(fresh.total, 3); assert.equal(fresh.counts.attention, 3);
        assert.deepEqual(fresh.items.map(item => item.id), [127]);
      } finally {
        db(connection => connection.prepare("UPDATE agents SET state='paused',pause_reason='limit' WHERE id=130").run());
      }
    });
    await t.test('unknown, empty and incompatible filters reject without changing business state', async () => {
      const snapshot = () => db(connection => Object.fromEntries(['agents', 'locks', 'events', 'notices', 'subscriptions'].map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
      const before = snapshot();
      for (const filter of [
        { state: '' }, { state: 'all' }, { state: 'Paused' }, { state: ' paused ' }, { state: 'unknown' },
        { pause_reason: '' }, { pause_reason: 'all' }, { pause_reason: 'user' }, { pause_reason: 'unknown' },
        ...['working', 'idle', 'done', 'closed', 'crashed', 'replaced'].map(state => ({ state, pause_reason: 'limit' })),
        { states: 'paused' }, { 'pause-reason': 'limit' },
      ]) {
        const result = await api('GET', params('/agents', { project: project.id, ...filter }), undefined, 400);
        assert.match(result.error, /state|reason|unknown/i);
        assert.deepEqual(snapshot(), before, JSON.stringify(filter));
      }
    });
    await t.test('structured matches never narrow project totals or project/global controls', async () => {
      const otherDir = path.join(root, 'other-project'); fs.mkdirSync(otherDir);
      const other = await api('POST', '/projects', { path: otherDir });
      db(connection => connection.prepare("INSERT INTO agents(id,project,name,task,harness,model,effort,state,pause_reason,launched_by,launched_at) VALUES(131,?,'other','cohort task','codex','gpt-6-sol','medium','paused','limit',0,0)").run(other.id));
      const overview = await api('GET', `/overview?project=${project.id}`);
      assert.deepEqual(overview.agent_counts, counts(records));
      assert.deepEqual(overview.project_actions, { pause_eligible: 3, resume_eligible: 8, restart_paused: 1 });
      assert.equal(overview.pause_eligible, 3); assert.equal(overview.resume_eligible, 9); assert.equal(overview.restart_paused, 1);
      const scoped = await collect(api, params('/agents', { project: project.id, pause_reason: 'limit' }), { limit: 2, max_bytes: 512 });
      assert.deepEqual(scoped.items.map(item => item.id), [130, 127, 5, 1]);
      assert.equal(scoped.page.project_total, 130);
      const global = await collect(api, '/agents?pause_reason=limit', { limit: 2, max_bytes: 512 });
      assert.deepEqual(global.items.map(item => item.id), [131, 130, 127, 5, 1]);
      assert.equal(global.page.project_total, 131);
      assert.deepEqual((await api('GET', `/overview?project=${project.id}`)).project_actions, overview.project_actions);
    });
  });
});

test('agent query fields, literals and alternatives stay exact across bounded pages', async t => {
  await isolated(async ({ api, db, project, root }) => {
    const records = Array.from({ length: 130 }, (_, index) => ({
      id: index + 1, group: 'team', provider: 'codex', model: 'gpt-6-sol', effort: 'medium',
      state: 'closed', reason: null, name: `fixture ${index + 1}`, task: `task ${index + 1}`, status: '',
    }));
    const update = (id, fields) => Object.assign(records[id - 1], fields);
    for (const id of [1, 2, 4, 5, 8, 9, 10, 11, 127, 130]) update(id, {
      group: 'Security review', model: 'model-id', effort: 'high', task: 'reentrancy', state: 'paused', reason: 'limit',
    });
    update(1, { task: 'reentrancy alpha 東京🙂' });
    update(2, { state: 'crashed', reason: null, task: 'reentrancy beta' });
    update(3, { group: 'Other', model: 'model-id', effort: 'high', state: 'paused', reason: 'limit', task: 'Security review reentrancy' });
    update(4, { provider: 'claude', model: 'claude-test', effort: 'medium', reason: 'user' });
    update(5, { model: 'model-other', effort: 'max', state: 'closed', reason: null });
    update(6, { group: 'Ops, red', model: 'model-id', effort: 'high', state: 'paused', reason: 'user', task: 'provider:codex quote "Q" slash\\ path reentrancy' });
    update(7, { group: '', state: 'idle', task: 'ungrouped' });
    update(8, { state: 'crashed', effort: 'low', reason: null });
    update(9, { reason: 'restart', task: 'background' });
    update(10, { model: 'custom,model', effort: 'fixed,effort', state: 'closed', reason: null });
    update(11, { state: 'closed', reason: null, name: 'boundaryleft', task: 'boundaryright', status: 'statusneedle', effort: 'effortonlyneedle' });
    const categories = rows => ({
      all: rows.length,
      active: rows.filter(row => ['working', 'idle'].includes(row.state)).length,
      attention: rows.filter(row => ['paused', 'crashed'].includes(row.state)).length,
      finished: rows.filter(row => ['done', 'closed', 'replaced'].includes(row.state)).length,
    });
    db(connection => {
      connection.exec('BEGIN');
      const statement = connection.prepare('UPDATE agents SET grp=?,harness=?,model=?,effort=?,state=?,pause_reason=?,name=?,task=?,status_text=? WHERE id=?');
      for (const row of records) statement.run(row.group, row.provider, row.model, row.effort, row.state, row.reason, row.name, row.task, row.status, row.id);
      connection.exec('COMMIT');
    });
    const route = filter => params('/agents', { project: project.id, ...filter });
    const ids = async filter => (await collect(api, route(filter), { limit: 2, max_bytes: 512 })).items.map(row => row.id);
    await t.test('exact group excludes matching task text, while bare terms AND across fields', async () => {
      assert.deepEqual(await ids({ search: 'group:"Security review" reentrancy' }), [130, 127, 10, 8, 5, 4, 2, 1]);
      assert.deepEqual(await ids({ search: 'Security review reentrancy' }), [130, 127, 10, 8, 5, 4, 3, 2, 1]);
      assert.deepEqual(await ids({ search: 'boundaryleft boundaryright' }), [11]);
      assert.deepEqual(await ids({ search: '"boundaryleft 11"' }), [], 'a phrase cannot cross metadata-field boundaries');
      assert.deepEqual(await ids({ search: 'statusneedle' }), [11]);
      assert.deepEqual(await ids({ search: 'effortonlyneedle' }), [], 'broad text does not search effort');
      assert.deepEqual(await ids({ search: 'effort:effortonlyneedle' }), [11]);
      assert.deepEqual(await ids({ search: '11 boundaryright' }), [11], 'IDs remain searchable');
    });
    await t.test('different fields AND, alternatives OR, and category facets precede category selection', async () => {
      const search = 'group:"Security review" provider:codex model:model-id effort:high state:paused,crashed reentrancy';
      const result = await collect(api, route({ search }), { limit: 1, max_bytes: 512 });
      assert.deepEqual(result.items.map(row => row.id), [130, 127, 2, 1]);
      assert.deepEqual(result.page.counts, { all: 4, active: 0, attention: 4, finished: 0 });
      assert.equal(result.page.project_total, 130);
      for (const category of ['all', 'active', 'attention', 'finished']) {
        const page = await api('GET', route({ search, category, max_bytes: 512 }), undefined, 200, 512);
        assert.deepEqual(page.counts, result.page.counts);
        assert.equal(page.total, result.page.counts[category]);
        assert.equal(page.project_total, 130);
      }
      assert.deepEqual(await ids({ search: 'group:"Security review","Ops, red" state:paused,crashed provider:codex reentrancy' }), [130, 127, 8, 6, 2, 1]);
      assert.deepEqual(await ids({ group: 'Security review', provider: 'codex', model: 'model-id', effort: 'high', search: 'state:paused,crashed reentrancy' }), [130, 127, 2, 1]);
      assert.deepEqual(await ids({ search: 'pause_reason:manual,limit state:crashed,paused' }), [130, 127, 6, 4, 3, 1]);
    });
    await t.test('quoted spaces, commas, colons, quotes and backslashes are literal', async () => {
      assert.deepEqual(await ids({ search: 'group:"Ops, red"' }), [6]);
      assert.deepEqual(await ids({ search: '"provider:codex"' }), [6]);
      assert.deepEqual(await ids({ search: 'group:"Ops, red" "quote \\"Q\\"" "slash\\\\ path"' }), [6]);
      assert.deepEqual(await ids({ search: 'group:""' }), [7]);
      assert.deepEqual(await ids({ group: '' }), [7]);
      assert.deepEqual(await ids({ model: 'custom,model', effort: 'fixed,effort' }), [10], 'direct scalar commas are not alternatives');
      assert.deepEqual(await ids({ model: 'model-id,model-other' }), [], 'direct scalar values stay literal');
      assert.deepEqual(await ids({ search: 'model:"custom,model" effort:"fixed,effort"' }), [10]);
      assert.deepEqual(await ids({ search: 'group:missing model:unlisted effort:unlisted' }), [], 'open-ended exact values are valid even with no matches');
      for (const search of ['group:"security review"', 'model:MODEL-ID', 'effort:High']) assert.deepEqual(await ids({ search }), [], 'field filters are exact, not broad case-insensitive search');
    });
    await t.test('equivalent canonical queries share cursors; changed meaning cannot reuse them', async () => {
      const search = 'group:"Security review" state:paused,crashed provider:codex reentrancy';
      const filter = { search, limit: 1, max_bytes: 512 };
      const first = await api('GET', route(filter), undefined, 200, 512);
      const cursor = { before: first.next_before, through: first.through, revision: first.revision, limit: 1, max_bytes: 512 };
      const equivalent = '  REENTRANCY provider:"codex" state:crashed,paused group:"Security review"  ';
      const next = await api('GET', route({ ...cursor, search: equivalent }), undefined, 200, 512);
      assert.deepEqual(next.items.map(row => row.id), [127]);
      const direct = await api('GET', route({ ...cursor, group: 'Security review', provider: 'codex', search: 'state:crashed,paused reentrancy' }), undefined, 200, 512);
      assert.deepEqual(direct.items.map(row => row.id), [127]);
      for (const changed of [
        { search: 'group:"Security review" state:paused provider:codex reentrancy' },
        { search, effort: 'high' }, { search, category: 'attention' },
        { search: 'group:"Security review" state:paused,crashed provider:codex background' },
      ]) await api('GET', route({ ...cursor, ...changed }), undefined, 409);
      const reason = await api('GET', route({ search: 'pause_reason:limit', limit: 1, max_bytes: 512 }), undefined, 200, 512);
      const paused = await api('GET', route({ search: 'state:paused,crashed pause_reason:limit', limit: 1, max_bytes: 512 }), undefined, 200, 512);
      assert.equal(paused.revision, reason.revision, 'a pause reason normalizes a state alternative list containing paused');
    });
    await t.test('invalid fields, grammar and contradictory or duplicate filters do not mutate or consume state', async () => {
      const snapshot = () => db(connection => Object.fromEntries(['agents', 'locks', 'events', 'notices', 'subscriptions', 'members', 'marks'].map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
      const before = snapshot();
      for (const search of [
        'unknown:value', 'provider:other', 'provider:Codex', 'state:unknown', 'state:paused,unknown', 'pause_reason:user',
        'pause_reason:limit state:idle,crashed', 'group:', 'model:""', 'effort:""', 'state:""', 'provider:""',
        'group:a,', 'group:,a', 'group:a,,b', 'group:"unterminated',
        '"bad\\q"', 'bad\\q', 'model:a model:b', 'state:paused state:paused', '""',
      ]) {
        const error = await api('GET', route({ search }), undefined, 400);
        assert.equal(typeof error.error, 'string'); assert.ok(error.error.length > 0, search);
        assert.deepEqual(snapshot(), before, search);
      }
      for (const filter of [
        { provider: 'other' }, { provider: '' }, { model: '' }, { effort: '' },
        { search: 'group:team', group: 'team' }, { search: 'provider:codex', provider: 'codex' },
        { search: 'model:model-id', model: 'model-id' }, { search: 'effort:high', effort: 'high' },
        { search: 'state:paused', state: 'paused' }, { search: 'pause_reason:limit', pause_reason: 'limit' },
      ]) {
        await api('GET', route(filter), undefined, 400);
        assert.deepEqual(snapshot(), before, JSON.stringify(filter));
      }
      assert.equal((await api('GET', route({ search: ' \t\n ', max_bytes: 512 }), undefined, 200, 512)).total, 130);
    });
    await t.test('bounded parser responses reconstruct without storing data or exposing agents', async () => {
      const snapshot = () => db(connection => Object.fromEntries(['agents', 'events', 'notices'].map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
      const before = snapshot();
      const search = 'group:"Security review" state:crashed,paused reentrancy';
      const parsed = await api('GET', params('/agent-query', { search }));
      assert.equal(typeof parsed.text, 'string'); assert.ok(parsed.text.length > 0);
      assert.ok(parsed.clauses.every(clause => Array.isArray(clause.values) && typeof clause.text === 'string'));
      assert.deepEqual(parsed.clauses.find(clause => clause.field === 'group').values, ['Security review']);
      assert.deepEqual(parsed.clauses.find(clause => clause.field === 'state').values, ['crashed', 'paused']);
      assert.deepEqual(parsed.clauses.find(clause => clause.field === null).values, ['reentrancy']);
      assert.deepEqual(await ids({ search: parsed.text }), await ids({ search }));
      assert.deepEqual((await api('GET', '/agent-query')).clauses, []);
      await api('GET', '/agent-query?project=1', undefined, 400);
      await api('GET', params('/agent-query', { search: 'unknown:value' }), undefined, 400);
      for (const invalid of ['x'.repeat(4097), Array(65).fill('term').join(' '), `group:${Array.from({ length: 129 }, (_, index) => index).join(',')}`]) {
        await api('GET', params('/agent-query', { search: invalid }), undefined, 400);
      }
      const longSearch = `group:"${'東京🙂'.repeat(200)}"`;
      const detailRoute = params('/agent-query', { search: longSearch });
      const completed = await complete(api, detailRoute, 512);
      assert.deepEqual(completed.value.clauses.find(clause => clause.field === 'group').values, ['東京🙂'.repeat(200)]);
      assert.equal(Object.hasOwn(completed.value, 'items'), false);
      assert.equal(Object.hasOwn(completed.value, 'project'), false);
      await api('GET', params('/agent-query', { search: 'group:changed', offset: 0, version: completed.stub.version, max_bytes: 512 }), undefined, 409);
      await api('GET', params('/agent-query', { search, version: completed.stub.version }), undefined, 400);
      assert.deepEqual(snapshot(), before);
    });
    await t.test('provider/model/group matches stay project scoped and never alter bulk counts', async () => {
      const otherDir = path.join(root, 'query-other-project'); fs.mkdirSync(otherDir);
      const other = await api('POST', '/projects', { path: otherDir });
      db(connection => connection.prepare("INSERT INTO agents(id,project,name,grp,task,harness,model,effort,state,pause_reason,launched_by,launched_at) VALUES(131,?,'foreign','Security review','reentrancy','codex','model-id','high','paused','limit',0,0)").run(other.id));
      const overview = await api('GET', `/overview?project=${project.id}`);
      assert.deepEqual(overview.agent_counts, categories(records));
      const search = 'group:"Security review" provider:codex model:model-id effort:high state:paused,crashed reentrancy';
      assert.deepEqual(await ids({ search }), [130, 127, 2, 1]);
      const global = await collect(api, params('/agents', { search }), { limit: 1, max_bytes: 512 });
      assert.deepEqual(global.items.map(row => row.id), [131, 130, 127, 2, 1]);
      assert.equal(global.page.project_total, 131);
      const fresh = await api('GET', `/overview?project=${project.id}`);
      assert.deepEqual(fresh.project_actions, overview.project_actions);
      assert.equal(fresh.pause_eligible, overview.pause_eligible); assert.equal(fresh.resume_eligible, overview.resume_eligible);
      assert.deepEqual(fresh.agent_counts, categories(records));
    });
  });
});

test('project bulk pause leaves other projects and their locks untouched', async () => {
  await isolated(async ({ api, db, project, root }) => {
    const otherDir = path.join(root, 'other-project');
    fs.mkdirSync(otherDir);
    const other = await api('POST', '/projects', { path: otherDir });
    db(connection => {
      connection.exec('BEGIN');
      const insert = connection.prepare("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(?,?,'other','fixture','codex','gpt-6-sol','medium',?,0,0)");
      for (const [index, state] of ['working', 'idle', 'done', 'paused', 'crashed', 'replaced'].entries()) {
        connection.prepare('UPDATE agents SET state=? WHERE id=?').run(state, index + 1);
        insert.run(131 + index, other.id, state);
      }
      connection.exec('COMMIT');
    });
    for (const [scope, agent] of [[project.id, 1], [other.id, 131]]) {
      await api('POST', '/locks', { project: scope, name: 'held', about: 'Scoped bulk pause fixture' });
      await api('POST', '/locks/acquire', { agent, name: 'held', wait: 0, ttl: 600 });
    }
    const foreign = () => db(connection => ({
      agents: connection.prepare('SELECT * FROM agents WHERE project=? ORDER BY id').all(other.id),
      locks: connection.prepare('SELECT * FROM locks WHERE project=? ORDER BY name').all(other.id),
    }));
    const before = foreign();
    assert.deepEqual((await api('POST', '/pause-all', { project: project.id })).ids.toSorted((a, b) => a - b), [1, 2, 3]);
    await until(() => db(connection => connection.prepare('SELECT holder FROM locks WHERE project=?').get(project.id).holder) === null, 'project pause releases its own lock');
    assert.deepEqual(foreign(), before, 'another project retains every lifecycle field and held lease');
    assert.deepEqual(db(connection => connection.prepare('SELECT id,state FROM agents WHERE id<=6 ORDER BY id').all()).map(row => ({ ...row })), [
      { id: 1, state: 'paused' }, { id: 2, state: 'paused' }, { id: 3, state: 'paused' },
      { id: 4, state: 'paused' }, { id: 5, state: 'crashed' }, { id: 6, state: 'replaced' },
    ]);
    assert.deepEqual((await api('POST', '/pause-all', {})).ids.toSorted((a, b) => a - b), [131, 132, 133], 'omitting project retains global scope');
    await until(() => db(connection => connection.prepare('SELECT holder FROM locks WHERE project=?').get(other.id).holder) === null, 'global pause releases the remaining project lock');
  });
});

test('project bulk resume respects scope and restart-only pause reasons', async () => {
  await isolated(async ({ api, db, project, root }) => {
    const otherDir = path.join(root, 'other-project');
    fs.mkdirSync(otherDir);
    const other = await api('POST', '/projects', { path: otherDir });
    db(connection => {
      connection.exec('BEGIN');
      const insert = connection.prepare("INSERT INTO agents(id,project,name,task,harness,model,effort,state,pause_reason,pause_from,paused_at,launched_by,launched_at) VALUES(?,?,'other','fixture','codex','gpt-6-sol','medium','paused',?,?,1,0,0)");
      for (const [index, reason] of ['restart', 'user', 'limit'].entries()) {
        const from = index === 1 ? 'done' : 'idle';
        connection.prepare("UPDATE agents SET state='paused',pause_reason=?,pause_from=?,paused_at=1 WHERE id=?").run(reason, from, index + 1);
        insert.run(131 + index, other.id, reason, from);
      }
      connection.prepare("UPDATE agents SET state='crashed' WHERE id=4").run();
      connection.exec('COMMIT');
    });
    const foreign = () => db(connection => connection.prepare('SELECT * FROM agents WHERE project=? ORDER BY id').all(other.id));
    const before = foreign();
    const resumed = await api('POST', '/resume-restart', { project: project.id });
    assert.deepEqual(resumed, { ids: [1], errors: [], warnings: [] });
    assert.deepEqual(foreign(), before);
    assert.deepEqual(db(connection => connection.prepare('SELECT id,pause_reason FROM agents WHERE id IN (2,3) ORDER BY id').all()).map(row => ({ ...row })), [
      { id: 2, pause_reason: 'user' }, { id: 3, pause_reason: 'limit' },
    ]);
    assert.deepEqual((await api('POST', '/resume-all', { project: project.id })).ids.toSorted((a, b) => a - b), [2, 3]);
    assert.deepEqual(foreign(), before);
    assert.deepEqual(db(connection => connection.prepare('SELECT id,state,pause_reason FROM agents WHERE id<=4 ORDER BY id').all()).map(row => ({ ...row })), [
      { id: 1, state: 'idle', pause_reason: null }, { id: 2, state: 'done', pause_reason: null },
      { id: 3, state: 'idle', pause_reason: null }, { id: 4, state: 'crashed', pause_reason: null },
    ]);
    assert.deepEqual((await api('POST', '/resume-restart', {})).ids, [131], 'global restart-only resume still spans projects');
    assert.deepEqual((await api('POST', '/resume-all', {})).ids.toSorted((a, b) => a - b), [132, 133], 'global resume includes remaining manual and limit pauses');
  });
});

test('project bulk actions reject invalid scopes without mutation', async () => {
  await isolated(async ({ api, db, project }) => {
    db(connection => connection.prepare("UPDATE agents SET state='working' WHERE id=1").run());
    await api('POST', '/locks', { project: project.id, name: 'held', about: 'Invalid scope must not release this' });
    await api('POST', '/locks/acquire', { agent: 1, name: 'held', wait: 0, ttl: 600 });
    const snapshot = () => db(connection => Object.fromEntries(['agents', 'locks', 'events', 'notices'].map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
    const before = snapshot();
    for (const route of ['/pause-all', '/resume-all', '/resume-restart']) {
      for (const invalid of [null, 0, -1, 1.5, '1', true, [], {}]) {
        const result = await api('POST', route, { project: invalid }, 400);
        assert.match(result.error, /project/i);
        assert.deepEqual(snapshot(), before, `${route} project=${JSON.stringify(invalid)} must not change state`);
      }
      await api('POST', route, { project: 999999 }, 404);
      await api('POST', route, { project: project.id, projects: [] }, 400);
      await api('POST', `${route}?project=${project.id}`, {}, 400);
      assert.deepEqual(snapshot(), before, `${route} invalid scope must not broaden to all projects`);
    }
  });
});

test('runtime waits invalidate agent views and remain visible in bounded stubs', async t => {
  await isolated(async ({ api, db, project }) => {
    db(connection => connection.prepare("UPDATE agents SET state='working',name=?,task=? WHERE id=130").run('large waiting agent '.repeat(100), 'large task '.repeat(100)));
    const before = await api('GET', `/agents?project=${project.id}&limit=1&max_bytes=65536`);
    const oldOverview = await api('GET', `/overview?project=${project.id}`);
    const eventsBefore = db(connection => connection.prepare('SELECT coalesce(max(id),0) AS id FROM events').get().id);
    let pending;
    try {
      pending = api('POST', '/wait/130', { timeout: 30, agents: [1, 2], states: ['crashed', 'done'], status_text: true });
      let waiting;
      await until(async () => {
        waiting = await api('GET', `/agents?project=${project.id}&limit=1&max_bytes=65536`);
        return waiting.items[0].is_waiting;
      }, 'working fixture entered foreground wait');
      await t.test('full list and detail expose the same runtime watch and timeout', async () => {
        const item = waiting.items[0];
        assert.equal(item.state, 'working');
        assert.deepEqual(item.waiting.agents, [1, 2]);
        assert.deepEqual(item.waiting.states, ['crashed', 'done']);
        assert.equal(item.waiting.status_text, true);
        assert.equal(item.waiting.expires_at - item.waiting.started_at, 30);
        assert.ok(item.waiting.remaining_secs > 0 && item.waiting.remaining_secs <= 30);
        const detail = await api('GET', '/agents/130?max_bytes=65536');
        assert.ok(detail.waiting, 'detail exposes the full wait descriptor, not the collection-only stub flag');
        assert.equal(detail.waiting.started_at, item.waiting.started_at);
        assert.equal(detail.waiting.expires_at, item.waiting.expires_at);
      });
      await t.test('small stubs preserve waiting state and full details are recoverable', async () => {
        const page = await api('GET', `/agents?project=${project.id}&limit=1&max_bytes=512`, undefined, 200, 512);
        assert.equal(page.items[0].id, 130);
        assert.equal(page.items[0].truncated, true);
        assert.equal(page.items[0].is_waiting, true);
        assert.equal(page.items[0].state, 'working');
        const detail = await api('GET', '/agents/130?max_bytes=512', undefined, 200, 512);
        assert.equal(detail.truncated, true);
        await new Promise(resolve => setTimeout(resolve, 1100));
        const chunk = await api('GET', params('/agents/130', { offset: 0, version: detail.version, max_bytes: 512 }), undefined, 200, 512);
        assert.equal(chunk.version, detail.version, 'a running countdown must not invalidate a pinned detail chunk');
      });
      await t.test('runtime-only transitions invalidate list and overview revisions', async () => {
        assert.equal(db(connection => connection.prepare('SELECT coalesce(max(id),0) AS id FROM events').get().id), eventsBefore, 'waiting is not a fabricated lifecycle event');
        assert.notEqual(waiting.revision, before.revision);
        const fresh = await api('GET', params('/agents', { project: project.id, since: before.revision, limit: 1, max_bytes: 512 }), undefined, 200, 512);
        assert.notEqual(fresh.unchanged, true);
        await api('GET', params('/agents', { project: project.id, before: before.next_before, through: before.through, revision: before.revision }), undefined, 409);
        const overview = await api('GET', params('/overview', { project: project.id, since: oldOverview.revision }));
        assert.notEqual(overview.unchanged, true);
        assert.notEqual(overview.revisions.agents, oldOverview.revisions.agents);
      });
      await api('POST', '/agents/1/status', { text: 'Release foreground wait fixture' });
      const result = await pending;
      pending = null;
      assert.equal(result.timed_out, false);
      assert.match(result.text, /Release foreground wait fixture/);
      await api('POST', '/wait/130/ack', { delivery_id: result.delivery_id });
      const after = await api('GET', `/agents?project=${project.id}&limit=1&max_bytes=65536`);
      assert.equal(after.items[0].is_waiting, false);
      assert.equal(after.items[0].waiting, null);
      assert.equal(after.items[0].state, 'working');
      assert.notEqual(after.revision, waiting.revision);
    } finally {
      if (pending) {
        await api('POST', '/agents/1/status', { text: 'Release foreground wait fixture' });
        await pending.catch(() => {});
      }
      db(connection => connection.prepare("UPDATE agents SET state='closed',pid=NULL WHERE id=130").run());
    }
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
