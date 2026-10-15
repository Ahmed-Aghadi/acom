// Event subscriptions and idle waits. All clients, credentials, data, and servers
// are temporary fixtures; this suite never launches a real provider.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(run) {
  const executableDir = path.dirname(fs.realpathSync(binary));
  for (const client of ['codex', 'claude']) assert.equal(fs.existsSync(path.join(executableDir, client)), false, `${client} must not shadow the fake fixture client`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-subscription-test-'));
  const home = path.join(root, 'state'), bin = path.join(root, 'bin'), projectDir = path.join(root, 'project');
  for (const dir of [home, bin, projectDir]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const home=process.env.ACOM_HOME;
if(process.argv[2]==='app-server') {
 let buffer=''; process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){
  const request=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
  if(request.method==='initialize')console.log(JSON.stringify({id:request.id,result:{}}));
  if(request.method==='account/rateLimits/read') {
   fs.appendFileSync(path.join(home,'usage-reads'),'read\\n');
   const file=path.join(home,'usage.json');
   const result=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{rateLimits:{primary:{usedPercent:0,resetsAt:Math.floor(Date.now()/1000)+3600}}};
   console.log(JSON.stringify({id:request.id,result}));
  }
 }});
} else {
 let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);
 process.stdin.on('end',async()=>{
  const id=Number(process.env.ACOM_ID),file=path.join(home,'runs.jsonl'),claude=path.basename(process.argv[1])==='claude';
  const previous=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse).filter(row=>row.id===id):[];
  const args=process.argv.slice(2),session=claude?args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1]:args[1]==='resume'?args.at(-2):crypto.randomUUID();
  fs.appendFileSync(file,JSON.stringify({id,pid:process.pid,prompt,at:Date.now(),turn:previous.length})+'\\n');
  const dir=claude?path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture'):path.join(process.env.CODEX_HOME,'sessions','2026','10','15');fs.mkdirSync(dir,{recursive:true});
  fs.appendFileSync(path.join(dir,'rollout-'+session+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id:session}})+'\\n');
  console.log(JSON.stringify(claude?{type:'system',subtype:'init',session_id:session}:{type:'thread.started',thread_id:session}));
  const task=previous[0]?.prompt||prompt;
  if(task.includes('HOLD_FIRST')&&previous.length===0)while(!fs.existsSync(path.join(home,'release-'+id)))await new Promise(resolve=>setTimeout(resolve,25));
  if(task.includes('HOLD_EACH'))while(!fs.existsSync(path.join(home,'release-'+id+'-'+previous.length)))await new Promise(resolve=>setTimeout(resolve,25));
  console.log(JSON.stringify({type:'turn.completed'}));
 });
}
`, { mode: 0o755 });
  fs.copyFileSync(path.join(bin, 'codex'), path.join(bin, 'claude'));
  const env = { ...process.env, ACOM_HOME: home, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'no-credentials'), PATH: bin };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  let server, url, stderr = '';
  const db = action => {
    const connection = new DatabaseSync(path.join(home, 'acom.db'));
    try { connection.exec('PRAGMA busy_timeout=5000'); return action(connection); }
    finally { connection.close(); }
  };
  const stop = async () => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    let timer;
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('isolated server failed to stop')), 10000); })]); }
    finally { clearTimeout(timer); }
  };
  const start = async () => {
    url = `http://127.0.0.1:${await freePort()}`;
    server = spawn(binary, ['serve', '--port', url.split(':').at(-1)], { cwd: projectDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', chunk => stderr += chunk);
    await until(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`fixture server exited: ${stderr}`);
      try { return (await fetch(url + '/overview')).ok; } catch { return false; }
    }, 'server startup');
  };
  const api = async (method, route, body, expected = 200) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${route}: expected ${expected}, got ${response.status}: ${raw.slice(0, 1200)}`);
    return JSON.parse(raw);
  };
  const cli = async (args, id) => {
    const child = spawn(binary, args, { cwd: projectDir, env: { ...env, ACOM_URL: url, ...(id ? { ACOM_ID: String(id) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const [status, signal] = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (status, signal) => resolve([status, signal])); });
      assert.equal(signal, null, `CLI timed out: ${stderr}`);
      return { status, stdout, stderr };
    } finally { clearTimeout(timer); }
  };
  const runs = id => {
    const file = path.join(home, 'runs.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => id === undefined || row.id === id) : [];
  };
  try {
    await start();
    const project = await api('POST', '/projects', { path: projectDir });
    const otherDir = path.join(root, 'other'); fs.mkdirSync(otherDir);
    const other = await api('POST', '/projects', { path: otherDir });
    const settings = (await api('GET', '/configs/1')).settings;
    settings.done_closes = false; settings.auto_resume = false;
    settings.allow_agent_model_change = true;
    settings.limits.active = { soft: null, hard: null };
    for (const key of Object.keys(settings.limits.active_per_harness)) settings.limits.active_per_harness[key] = { soft: null, hard: null };
    for (const key of Object.keys(settings.limits.usage)) settings.limits.usage[key] = { soft: null, hard: null };
    settings.usage_poll_secs = 3600;
    for (const p of [project, other]) await api('PUT', `/projects/${p.id}/config`, { custom: settings });
    db(connection => {
      const insert = connection.prepare("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(?,?,?,'subscription fixture','codex','gpt-6-sol','medium','working',0,0)");
      for (let id = 1; id <= 8; id++) insert.run(id, id === 8 ? other.id : project.id, `fixture ${id}`);
      const at = Math.floor(Date.now() / 1000);
      const usage = connection.prepare('INSERT INTO usage_checks(provider,attempted_at,next_check,in_flight) VALUES(?,?,?,0) ON CONFLICT(provider) DO UPDATE SET attempted_at=excluded.attempted_at,next_check=excluded.next_check,in_flight=0');
      for (const provider of ['codex', 'claude']) usage.run(provider, at, at + 3600);
    });
    await run({ api, cli, db, start, stop, home, root, project, other, runs, env, projectDir });
  } finally {
    await stop();
    for (const { pid } of runs()) {
      try {
        const vars = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (vars.includes(`ACOM_HOME=${home}`) && ['codex', 'claude'].some(client => args.includes(path.join(bin, client)))) process.kill(-pid, 'SIGKILL');
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const subs = (api, agent, viewer = agent) => api('GET', `/subscriptions?agent=${agent}&viewer=${viewer}`);
const record = (api, id, viewer = 0) => api('GET', `/subscriptions/${id}?viewer=${viewer}`);
const hook = (api, agent) => api('POST', `/hook/${agent}`, {});

test('subscription validation, project permissions, listing, and cancellation', async () => fixture(async ({ api }) => {
  for (const body of [
    { agent: 1 }, { agent: 1, agents: [] }, { agent: 1, agents: [1] }, { agent: 1, agents: [8] },
    { agent: 1, agents: [2], states: ['unknown'] }, { agent: 1, timeout: 0 }, { agent: 1, timeout: 3601 },
    { agent: 1, usage: { provider: 'codex', window: 'primary', condition: 'above' } },
    { agent: 1, usage: { provider: 'codex', window: 'primary', condition: 'above', percent: 101 } },
    { agent: 1, usage: { provider: 'unknown', window: 'primary', condition: 'reset' } },
  ]) await api('POST', '/subscriptions', body, 400);
  const first = await api('POST', '/subscriptions', { agent: 1, agents: [2], states: ['crashed', 'done'] });
  assert.ok(first.id > 0); assert.equal(first.agent, 1); assert.equal(first.mode, 'persistent'); assert.equal(first.state, 'active');
  const second = await api('POST', '/subscriptions', { agent: 1, agents: 'all', status_text: true });
  const own = await subs(api, 1);
  assert.deepEqual(own.items.map(row => row.id).sort((a, b) => a - b), [first.id, second.id]);
  assert.equal((await subs(api, 1, 2)).items.length, 2, 'peers can inspect coordination dependencies');
  await api('GET', `/subscriptions?agent=1&viewer=8`, undefined, [403, 404]);
  await api('GET', `/subscriptions/${first.id}?viewer=8`, undefined, [403, 404]);
  await api('GET', '/subscriptions?agent=1&viewer=-1', undefined, 400);
  await api('GET', `/subscriptions/${first.id}?viewer=-1`, undefined, 400);
  await api('POST', `/subscriptions/${first.id}/cancel`, { agent: 2 }, [403, 404]);
  await api('POST', `/subscriptions/${first.id}/cancel`, { agent: 1 });
  assert.equal((await record(api, first.id, 1)).state, 'canceled');
  await api('POST', `/subscriptions/${second.id}/cancel`, { agent: 0 });
  assert.equal((await record(api, second.id, 0)).state, 'canceled');
}));

test('persistent status subscriptions retain transitions and share durable receipt delivery', async () => fixture(async ({ api, db, start, stop }) => {
  const subscription = await api('POST', '/subscriptions', { agent: 1, agents: [2], states: ['done', 'crashed'], status_text: true });
  db(connection => connection.exec("UPDATE agents SET state='done' WHERE id=2; UPDATE agents SET state='idle' WHERE id=2; UPDATE agents SET state='crashed',problem='fixture crash' WHERE id=2; UPDATE agents SET status_text='UNIQUE_PEER_STATUS' WHERE id=2; UPDATE agents SET status_text='UNSELECTED_STATUS' WHERE id=3;"));
  const first = await api('POST', '/wait/1', { timeout: 3 });
  assert.ok(first.delivery_id > 0); assert.match(first.text, /done/); assert.match(first.text, /crashed/); assert.match(first.text, /UNIQUE_PEER_STATUS/); assert.doesNotMatch(first.text, /UNSELECTED_STATUS/);
  assert.match(first.text, new RegExp(`(?:subscription|Subscription) #?${subscription.id}\\b`));
  assert.deepEqual(await api('POST', '/wait/1', { timeout: 1 }), first, 'unacknowledged subscription batch replays byte-for-byte');
  await api('POST', '/wait/1/ack', { delivery_id: first.delivery_id });
  assert.equal((await hook(api, 1)).text, '', 'ACK also prevents a later hook repeating it');
  await stop(); await start();
  assert.equal((await record(api, subscription.id, 1)).state, 'active');
  // Simulate the fixture's next working turn without starting a real process.
  db(connection => connection.exec("UPDATE agents SET state='working' WHERE id=1"));
  db(connection => connection.exec("UPDATE agents SET status_text='STATUS_AFTER_RESTART' WHERE id=2"));
  const recovered = await hook(api, 1);
  assert.match(recovered.text, /STATUS_AFTER_RESTART/); assert.doesNotMatch(recovered.text, /"to":"UNIQUE_PEER_STATUS"/, 'the old destination is not replayed; it may appear as the new transition\'s source');
  assert.equal((await hook(api, 1)).text, '');
}));

test('persistent event overflow crosses process slices and bounded hook/wait batches without loss', async () => fixture(async ({ api, db }) => {
  const subscription = await api('POST', '/subscriptions', { agent: 1, agents: [2], status_text: true });
  const expected = db(connection => {
    const start = connection.prepare('SELECT coalesce(max(id),0) id FROM events').get().id;
    connection.exec('BEGIN');
    const update = connection.prepare('UPDATE agents SET status_text=? WHERE id=2');
    for (let i = 0; i < 75; i++) update.run(`BACKLOG_${i} ${'多字节😀'.repeat(45)}`);
    connection.exec('COMMIT');
    return connection.prepare("SELECT id FROM events WHERE agent=2 AND kind='agent.status' AND id>? ORDER BY id").all(start).map(row => row.id);
  });
  assert.equal(expected.length, 75);
  const seen = [];
  for (let i = 0; seen.length < expected.length && i < 50; i++) {
    const response = i % 2 ? await hook(api, 1) : await api('POST', '/wait/1', { timeout: 1 });
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 16000, 'complete delivery envelope stays bounded');
    const ids = [...response.text.matchAll(/Event #(\d+):/g)].map(match => Number(match[1]));
    assert.ok(ids.length > 0, 'a pending bounded batch must make progress');
    seen.push(...ids);
    if (response.delivery_id) await api('POST', '/wait/1/ack', { delivery_id: response.delivery_id });
  }
  assert.deepEqual(seen, expected, 'every matched event is delivered exactly once, in order, including after the 50-event process boundary');
  assert.equal(new Set(seen).size, 75);
  assert.ok((await record(api, subscription.id, 1)).cursor >= expected.at(-1));
  assert.equal((await hook(api, 1)).text, '');
}));

test('a pending immutable receipt resolves an idle wait without leaving a second timer armed', async () => fixture(async ({ api, db }) => {
  await api('POST', '/subscriptions', { agent: 1, agents: [2], status_text: true });
  db(connection => connection.exec("UPDATE agents SET status_text='PENDING_RECEIPT_SOURCE' WHERE id=2"));
  const receipt = await api('POST', '/wait/1', { timeout: 3 });
  assert.match(receipt.text, /PENDING_RECEIPT_SOURCE/);
  const wait = await api('POST', '/subscriptions', { agent: 1, timeout: 2, agents: [3], states: ['done'] });
  assert.equal(wait.state, 'resolved'); assert.equal(wait.completion.kind, 'delivery'); assert.equal(wait.completion.delivery, receipt.delivery_id);
  assert.deepEqual(await api('POST', '/wait/1', { timeout: 1 }), receipt, 'completion must not mutate the prior receipt');
  await api('POST', '/wait/1/ack', { delivery_id: receipt.delivery_id });
  const completion = await api('POST', '/wait/1', { timeout: 1 });
  assert.match(completion.text, new RegExp(`Deferred wait #${wait.id}\\b`));
  assert.match(completion.text, new RegExp(`delivery #${receipt.delivery_id}\\b`));
  assert.doesNotMatch(completion.text, /PENDING_RECEIPT_SOURCE/, 'the new completion does not replay the old event body');
  await api('POST', '/wait/1/ack', { delivery_id: completion.delivery_id });
  await sleep(2300); assert.equal((await hook(api, 1)).text, '');
}));

test('deadline-second events cannot resolve early, but timely backlog still beats timeout', async () => fixture(async ({ api, db, project }) => {
  const makeWait = () => api('POST', '/subscriptions', { agent: 1, timeout: 30, agents: [2], status_text: true });
  const trigger = (subscription, label, offset) => db(connection => {
    connection.exec('BEGIN');
    const boundary = connection.prepare('SELECT unixepoch() at').get().at;
    connection.prepare('UPDATE subscriptions SET deadline=? WHERE id=?').run(boundary, subscription.id);
    const event = Number(connection.prepare("INSERT INTO events(project,at,kind,actor,agent,details) VALUES(?,?,'agent.status','agent 2',2,?)").run(project.id, boundary + offset, JSON.stringify({ from: null, to: label })).lastInsertRowid);
    connection.exec('COMMIT');
    return event;
  });
  const expired = await makeWait();
  trigger(expired, 'AT_EXPIRED_DEADLINE', 0);
  const timeout = await hook(api, 1);
  assert.equal((await record(api, expired.id, 1)).completion.kind, 'timeout');
  assert.match(timeout.text, /timeout|deadline/i); assert.doesNotMatch(timeout.text, /AT_EXPIRED_DEADLINE/);
  const timely = await makeWait();
  const event = trigger(timely, 'TIMELY_BACKLOG_BEFORE_DEADLINE', -1);
  assert.match((await hook(api, 1)).text, /TIMELY_BACKLOG_BEFORE_DEADLINE/);
  assert.equal((await record(api, timely.id, 1)).completion.event, event, 'late processing does not discard a trigger that occurred before expiry');
}));

test('deferred waits resolve once with explicit early-message cause and cancel their deadline', async () => fixture(async ({ api, db, project }) => {
  const thread = await api('POST', '/threads', { project: project.id, title: 'PRIVATE_WAIT_CAUSE', members: ['1'], private: true, joinable: false });
  await hook(api, 1); // Do not let the earlier membership update resolve the wait.
  const wait = await api('POST', '/subscriptions', { agent: 1, timeout: 2, agents: [2], states: ['done'] });
  assert.equal(wait.mode, 'once'); assert.equal(wait.state, 'active'); assert.ok(wait.deadline > 0);
  const message = await api('POST', '/messages', { thread: thread.id, text: 'PRIVATE_MESSAGE_BODY' });
  const update = await hook(api, 1);
  assert.match(update.text, new RegExp(`(?:wait|Wait) #?${wait.id}\\b`));
  assert.match(update.text, /resolv|complet/i); assert.match(update.text, /message/i); assert.match(update.text, /timeout.*cancel|cancel.*timeout/i);
  assert.equal((await record(api, wait.id, 1)).state, 'resolved');
  const peerView = JSON.stringify(await record(api, wait.id, 2));
  assert.doesNotMatch(peerView, /PRIVATE_WAIT_CAUSE|PRIVATE_MESSAGE_BODY/);
  assert.doesNotMatch(peerView, /"(?:thread|message)(?:_id)?":\s*\d/, 'private trigger identifiers must also be redacted for nonmembers');
  await sleep(2300);
  assert.equal((await hook(api, 1)).text, '', 'early completion leaves no later timeout delivery');
  assert.equal((await api('GET', `/messages/${message.id}?agent=1`)).mark, 'new', 'event notification does not handle message content');
  const history = await api('GET', '/history?agent=1&viewer=1');
  const resolved = history.events.find(row => row.kind === 'subscription.resolved' && row.details.subscription === wait.id);
  assert.ok(resolved, 'completion is recorded in the owner\'s structured history');
  await api('GET', `/history/${resolved.id}?viewer=2`, undefined, 404);
  assert.ok(!(await api('GET', '/history?agent=1&viewer=2&kind=subscription.resolved')).events.some(row => row.id === resolved.id), 'private cause is not exposed through the history list either');
  // A peer transition after resolution must not reactivate this one-shot wait.
  db(connection => connection.exec("UPDATE agents SET state='done' WHERE id=2"));
  await sleep(150);
  assert.equal((await hook(api, 1)).text, '');
}));

test('registration-to-turn-end events wait for the old worker and wake exactly once', async () => fixture(async ({ api, db, home, project, runs }) => {
  const agent = await api('POST', '/agents', { project: project.id, harness: 'codex', task: 'HOLD_FIRST subscription race fixture' });
  await until(() => runs(agent.id).length === 1, 'first fake turn');
  await until(async () => Boolean((await api('GET', `/agents/${agent.id}`)).session), 'native session recorded');
  const wait = await api('POST', '/subscriptions', { agent: agent.id, timeout: 30, agents: [2], states: ['done'] });
  db(connection => connection.exec("UPDATE agents SET state='done' WHERE id=2"));
  await until(async () => (await record(api, wait.id, agent.id)).state === 'resolved', 'event resolves before turn end');
  assert.equal(runs(agent.id).length, 1, 'still-running worker must never overlap its replacement turn');
  assert.equal((await api('GET', `/agents/${agent.id}`)).state, 'working', 'registration does not pretend that a working turn is idle');
  fs.writeFileSync(path.join(home, `release-${agent.id}`), '');
  await until(() => runs(agent.id).length === 2, 'one deferred wake after worker exits');
  await until(async () => (await api('GET', `/agents/${agent.id}`)).state === 'idle', 'resumed fake turn completes');
  const prompt = runs(agent.id)[1].prompt;
  assert.match(prompt, new RegExp(`(?:wait|Wait) #?${wait.id}\\b`)); assert.match(prompt, /done/);
  await sleep(1300);
  assert.equal(runs(agent.id).length, 2, 'committed startup consumes the wake trigger exactly once');
}));

test('subscription events do not override paused or finished lifecycle states', async () => fixture(async ({ api, db, runs }) => {
  const ids = [1, 3, 4, 5, 6];
  for (const id of ids) await api('POST', '/subscriptions', { agent: id, agents: [2], states: ['done'] });
  const states = ['paused', 'done', 'closed', 'crashed', 'replaced'];
  db(connection => {
    const update = connection.prepare('UPDATE agents SET state=? WHERE id=?');
    ids.forEach((id, i) => update.run(states[i], id));
    connection.exec("UPDATE agents SET state='done' WHERE id=2");
  });
  await sleep(1600);
  for (let i = 0; i < ids.length; i++) assert.equal((await api('GET', `/agents/${ids[i]}`)).state, states[i]);
  assert.equal(runs().length, 0, 'events must not launch any inactive fixture');
}));

test('subscription list pagination is bounded and never repeats or skips IDs', async () => fixture(async ({ api }) => {
  const expected = [];
  for (let i = 0; i < 12; i++) expected.push((await api('POST', '/subscriptions', { agent: 1, agents: [2 + i % 5], states: ['done'] })).id);
  let route = '/subscriptions?agent=1&viewer=1&limit=3&max_bytes=512';
  const seen = []; let first;
  for (let i = 0; i < 20; i++) {
    const page = await api('GET', route);
    first ??= page;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512);
    assert.equal(page.total, expected.length); assert.ok(page.items.length <= 3);
    seen.push(...page.items.map(row => row.id));
    if (!page.has_more) break;
    assert.ok(page.items.length > 0, 'a bounded nonterminal page must advance');
    route = `/subscriptions?agent=1&viewer=1&limit=3&max_bytes=512&before=${page.next_before}&through=${page.through}&revision=${encodeURIComponent(page.revision)}`;
  }
  assert.deepEqual(seen, expected.reverse()); assert.equal(new Set(seen).size, seen.length);
  const cursor = `limit=3&max_bytes=512&before=${first.next_before}&through=${first.through}&revision=${encodeURIComponent(first.revision)}`;
  await api('GET', `/subscriptions?agent=1&viewer=2&${cursor}`, undefined, 409);
  await api('GET', `/subscriptions?agent=3&viewer=1&${cursor}`, undefined, 409);
  await api('POST', `/subscriptions/${seen[0]}/cancel`, { agent: 1 });
  await api('GET', `/subscriptions?agent=1&viewer=1&${cursor}`, undefined, 409);
}));

test('already-due usage reset reports its initial condition only once', async () => fixture(async ({ api, db }) => {
  db(connection => connection.prepare("INSERT OR REPLACE INTO usage(provider,win,used_pct,resets_at,at) VALUES('codex','codex secondary',50,unixepoch()-1,unixepoch())").run());
  const subscription = await api('POST', '/subscriptions', { agent: 1, usage: { provider: 'codex', window: 'codex secondary', condition: 'reset-due' } });
  const updates = (await hook(api, 1)).text;
  const count = [...updates.matchAll(new RegExp(`Subscription #${subscription.id}:`, 'g'))].length;
  assert.equal(count, 1, 'the initial due snapshot and its journal event describe one notification');
  assert.equal((await hook(api, 1)).text, '');
}));

test('explicit cancellation drops queued updates but cannot rewrite an issued receipt', async () => fixture(async ({ api, db }) => {
  const subscribe = () => api('POST', '/subscriptions', { agent: 1, agents: [2], status_text: true });
  const first = await subscribe();
  db(connection => connection.exec("UPDATE agents SET status_text='QUEUED_BEFORE_CANCEL' WHERE id=2"));
  await until(() => db(connection => connection.prepare('SELECT count(*) count FROM subscription_updates WHERE subscription=? AND delivered=0').get(first.id).count > 0), 'pending update is queued');
  const canceled = await api('POST', `/subscriptions/${first.id}/cancel`, { agent: 1 });
  assert.ok(canceled.canceled_pending > 0);
  assert.equal((await hook(api, 1)).text, '', 'explicit unsubscribe prevents later backlog delivery');
  const second = await subscribe();
  db(connection => connection.exec("UPDATE agents SET status_text='IMMUTABLE_ISSUED_RECEIPT' WHERE id=2"));
  const receipt = await api('POST', '/wait/1', { timeout: 3 });
  assert.match(receipt.text, /IMMUTABLE_ISSUED_RECEIPT/);
  await api('POST', `/subscriptions/${second.id}/cancel`, { agent: 1 });
  assert.deepEqual(await api('POST', '/wait/1', { timeout: 1 }), receipt, 'already-issued delivery remains immutable until ACK');
  await api('POST', '/wait/1/ack', { delivery_id: receipt.delivery_id });
  assert.equal((await hook(api, 1)).text, '');
}));

test('idle timeout wakes once, while an update delivered during work needs no second turn', async () => fixture(async ({ api, db, home, project, runs }) => {
  const launch = async () => {
    const agent = await api('POST', '/agents', { project: project.id, harness: 'codex', task: 'HOLD_FIRST deferred timeout fixture' });
    await until(() => runs(agent.id).length === 1, 'held fake turn');
    await until(async () => Boolean((await api('GET', `/agents/${agent.id}`)).session), 'held fake session');
    return agent;
  };
  const timeoutAgent = await launch();
  const timeout = await api('POST', '/subscriptions', { agent: timeoutAgent.id, timeout: 1 });
  fs.writeFileSync(path.join(home, `release-${timeoutAgent.id}`), '');
  await until(() => runs(timeoutAgent.id).length === 2, 'timeout wakes idle agent');
  assert.match(runs(timeoutAgent.id)[1].prompt, new RegExp(`(?:wait|Wait) #?${timeout.id}\\b`));
  assert.match(runs(timeoutAgent.id)[1].prompt, /timeout|deadline/i);
  const handled = await launch();
  const wait = await api('POST', '/subscriptions', { agent: handled.id, timeout: 2, agents: [2], states: ['done'] });
  db(connection => connection.exec("UPDATE agents SET state='done' WHERE id=2"));
  await until(async () => (await record(api, wait.id, handled.id)).state === 'resolved', 'held wait receives event');
  assert.match((await hook(api, handled.id)).text, new RegExp(`(?:wait|Wait) #?${wait.id}\\b`));
  fs.writeFileSync(path.join(home, `release-${handled.id}`), '');
  await until(async () => (await api('GET', `/agents/${handled.id}`)).state === 'idle', 'handled update turn ends idle');
  await sleep(2300);
  assert.equal(runs(handled.id).length, 1, 'delivered update cannot wake another turn or leave its deadline armed');
  assert.equal(runs(timeoutAgent.id).length, 2, 'timeout is a one-shot wake');
}));

test('an idle deferred deadline survives server restart without resuming restart-paused peers', async () => fixture(async ({ api, home, project, runs, start, stop }) => {
  const agent = await api('POST', '/agents', { project: project.id, harness: 'codex', task: 'HOLD_FIRST restart deadline fixture' });
  await until(() => runs(agent.id).length === 1, 'restart deadline first turn');
  await until(async () => Boolean((await api('GET', `/agents/${agent.id}`)).session), 'restart deadline session');
  const wait = await api('POST', '/subscriptions', { agent: agent.id, timeout: 3 });
  fs.writeFileSync(path.join(home, `release-${agent.id}`), '');
  await until(async () => (await api('GET', `/agents/${agent.id}`)).state === 'idle', 'deadline owner becomes idle');
  assert.equal((await record(api, wait.id, agent.id)).state, 'active');
  await stop(); await sleep(3200); await start();
  await until(() => runs(agent.id).length === 2, 'overdue idle deadline wakes after restart');
  await until(async () => (await api('GET', `/agents/${agent.id}`)).state === 'idle', 'overdue wake finishes');
  assert.equal((await record(api, wait.id, agent.id)).state, 'resolved');
  assert.match(runs(agent.id)[1].prompt, new RegExp(`(?:wait|Wait) #?${wait.id}\\b`));
  assert.equal((await api('GET', '/agents/1')).state, 'paused', 'restart pause is not bypassed by event processing');
  await sleep(1200); assert.equal(runs(agent.id).length, 2);
}));

test('true replacement transfers stable subscription ownership and unacknowledged updates once', async () => fixture(async ({ api, db, home, project, runs }) => {
  const agent = await api('POST', '/agents', { project: project.id, harness: 'codex', task: 'HOLD_FIRST subscription predecessor' });
  await until(() => runs(agent.id).length === 1, 'replacement predecessor starts');
  await until(async () => Boolean((await api('GET', `/agents/${agent.id}`)).session), 'replacement predecessor session');
  const subscription = await api('POST', '/subscriptions', { agent: agent.id, agents: [2], status_text: true });
  db(connection => connection.exec("UPDATE agents SET status_text='TRANSFER_SUBSCRIPTION_UPDATE' WHERE id=2"));
  const receipt = await api('POST', `/wait/${agent.id}`, { timeout: 3 });
  assert.match(receipt.text, /TRANSFER_SUBSCRIPTION_UPDATE/);
  await api('POST', `/agents/${agent.id}/replacement`, { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high', task: 'HOLD_FIRST subscription successor' });
  assert.equal((await api('GET', `/agents/${agent.id}`)).state, 'working');
  fs.writeFileSync(path.join(home, `release-${agent.id}`), '');
  let successor;
  await until(async () => { successor = (await api('GET', `/agents/${agent.id}`)).replacement; return Boolean(successor); }, 'true replacement commits');
  await until(() => runs(successor).length === 1, 'replacement fake client starts');
  assert.equal((await api('GET', `/agents/${agent.id}`)).state, 'replaced');
  assert.equal((await record(api, subscription.id, successor)).agent, successor, 'ID stays stable while ownership moves');
  assert.equal((await subs(api, agent.id)).items.length, 0, 'old identity no longer owns subscriptions');
  assert.equal((await subs(api, successor)).items[0].id, subscription.id);
  const prompt = runs(successor)[0].prompt;
  assert.equal(prompt.split('TRANSFER_SUBSCRIPTION_UPDATE').length - 1, 1, 'unacknowledged immutable batch transfers exactly once');
  assert.match(prompt, new RegExp(`Recovered delivery #${receipt.delivery_id}`));
  await api('POST', `/subscriptions/${subscription.id}/cancel`, { agent: agent.id }, [403, 404]);
  db(connection => connection.exec("UPDATE agents SET status_text='AFTER_TRANSFER_FRESH_EVENT' WHERE id=2"));
  assert.match((await hook(api, successor)).text, /AFTER_TRANSFER_FRESH_EVENT/);
  assert.equal((await hook(api, successor)).text, '');
  assert.equal((await hook(api, agent.id)).text, '');
  await api('POST', `/subscriptions/${subscription.id}/cancel`, { agent: successor });
  fs.writeFileSync(path.join(home, `release-${successor}`), '');
  await until(async () => (await api('GET', `/agents/${successor}`)).state === 'idle', 'replacement turn ends');
  await sleep(1200); assert.equal(runs(successor).length, 1);
}));

test('usage thresholds notify on crossings, distinguish due from confirmed resets, and ignore failed readings', async () => fixture(async ({ api, db, home, project }) => {
  let reset = Math.floor(Date.now() / 1000) + 3600;
  const reads = () => fs.existsSync(path.join(home, 'usage-reads')) ? fs.readFileSync(path.join(home, 'usage-reads'), 'utf8').split('\n').filter(Boolean).length : 0;
  const check = async (percent, at = reset) => {
    fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ rateLimits: { primary: { usedPercent: percent, resetsAt: at } } }));
    const before = reads();
    await api('POST', '/usage/check', { provider: 'codex' });
    await until(async () => {
      const view = await api('GET', `/limits?project=${project.id}`);
      return reads() > before && view.usage.some(row => row.provider === 'codex' && row.win === 'codex primary' && row.used_pct === percent && row.resets_at === at)
        && db(connection => connection.prepare("SELECT in_flight FROM usage_checks WHERE provider='codex'").get()?.in_flight === 0);
    }, `usage reading ${percent}%`);
  };
  await check(20);
  const above = await api('POST', '/subscriptions', { agent: 1, usage: { provider: 'codex', window: 'codex primary', condition: 'above', percent: 80 } });
  const below = await api('POST', '/subscriptions', { agent: 3, usage: { provider: 'codex', window: 'codex primary', condition: 'below', percent: 30 } });
  assert.equal((await hook(api, 1)).text, '');
  assert.match((await hook(api, 3)).text, new RegExp(`(?:subscription|Subscription) #?${below.id}\\b`), 'an already-qualifying current reading is reported once');
  await check(81);
  const crossing = await hook(api, 1);
  assert.match(crossing.text, /codex/); assert.match(crossing.text, /81/); assert.match(crossing.text, new RegExp(`(?:subscription|Subscription) #?${above.id}\\b`));
  await check(81);
  assert.equal((await hook(api, 1)).text, '', 'equal qualifying readings are not repeated');
  await check(82);
  assert.equal((await hook(api, 1)).text, '', 'remaining above the threshold is not another crossing');
  assert.equal((await hook(api, 3)).text, '');
  await check(10);
  assert.match((await hook(api, 3)).text, /10/);

  const resetWatch = await api('POST', '/subscriptions', { agent: 4, usage: { provider: 'codex', window: 'codex primary', condition: 'reset' } });
  const dueWatch = await api('POST', '/subscriptions', { agent: 5, usage: { provider: 'codex', window: 'codex primary', condition: 'reset-due' } });
  reset = Math.floor(Date.now() / 1000) + 2;
  await check(10, reset);
  await until(async () => (await hook(api, 5)).text.includes(String(dueWatch.id)), 'provider-reported reset deadline becomes due', 7000);
  assert.equal((await hook(api, 4)).text, '', 'estimated reset time is not confirmation');
  await check(0, reset + 3600);
  const confirmed = await hook(api, 4);
  assert.match(confirmed.text, new RegExp(`(?:subscription|Subscription) #?${resetWatch.id}\\b`)); assert.match(confirmed.text, /reset/i);
  fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ rateLimits: { primary: { usedPercent: null } } }));
  await api('POST', '/usage/check', { provider: 'codex' });
  await until(async () => (await api('GET', `/limits?project=${project.id}`)).checks.some(row => row.provider === 'codex' && row.error), 'failed usage check recorded');
  assert.equal((await hook(api, 4)).text, '', 'unknown readings cannot fabricate reset notifications');
  assert.equal((await hook(api, 3)).text, '', 'unknown readings cannot fabricate a below-threshold crossing');
  const waiting = api('POST', '/wait/1', { timeout: 5, usage: { provider: 'codex', window: 'codex primary', condition: 'above', percent: 90 } });
  await until(async () => Boolean((await api('GET', '/agents/1')).waiting), 'foreground usage watch registers');
  await check(95, reset + 3600);
  const delivered = await waiting;
  assert.ok(delivered.delivery_id > 0); assert.match(delivered.text, /95/);
  assert.deepEqual(await api('POST', '/wait/1', { timeout: 1 }), delivered, 'foreground usage notifications preserve normal receipt replay');
  await api('POST', '/wait/1/ack', { delivery_id: delivered.delivery_id });
  const beforeOmission = reads();
  fs.writeFileSync(path.join(home, 'usage.json'), JSON.stringify({ rateLimits: { secondary: { usedPercent: 5 } } }));
  await api('POST', '/usage/check', { provider: 'codex' });
  await until(() => reads() > beforeOmission && db(connection => connection.prepare("SELECT in_flight FROM usage_checks WHERE provider='codex'").get()?.in_flight === 0), 'valid response omits primary window');
  assert.equal((await hook(api, 1)).text, '', 'a missing window is unknown rather than a threshold crossing');
  await check(95, reset + 3600);
  assert.equal((await hook(api, 1)).text, '', 'an unchanged reading returning after omission is not a new crossing');
}));

test('CLI idle waits return registration rather than blocking or acknowledging a delivery', async () => fixture(async ({ api, cli }) => {
  const registered = await cli(['wait', '--idle', '--timeout', '30', '--agents', '2', '--states', 'done'], 1);
  assert.equal(registered.status, 0, registered.stderr);
  assert.match(registered.stdout, /end.*turn/i); assert.match(registered.stdout, /acom done/i);
  assert.equal((await api('GET', '/agents/1')).state, 'working');
  const rows = (await subs(api, 1)).items;
  assert.equal(rows.length, 1); assert.equal(rows[0].mode, 'once');
  const listing = await cli(['subscriptions'], 1);
  assert.equal(listing.status, 0, listing.stderr); assert.match(listing.stdout, new RegExp(`\\b${rows[0].id}\\b`));
  const detail = await cli(['subscription', String(rows[0].id)], 2);
  assert.equal(detail.status, 0, detail.stderr);
  const denied = await cli(['unsubscribe', String(rows[0].id)], 2);
  assert.notEqual(denied.status, 0); assert.doesNotMatch(denied.stdout, /canceled|cancelled/i);
  const canceled = await cli(['unsubscribe', String(rows[0].id)], 1);
  assert.equal(canceled.status, 0, canceled.stderr);
  assert.equal((await record(api, rows[0].id, 1)).state, 'canceled');
  for (const args of [
    ['wait', '--idle', '--ack', '1'], ['subscribe'],
    ['subscribe', '--usage', 'codex', '--window', 'codex primary', '--above', 'NaN'],
    ['subscribe', '--usage', 'codex', '--window', 'codex primary', '--above', '80', '--below', '20'],
  ]) assert.notEqual((await cli(args, 1)).status, 0, `${args.join(' ')} must fail before registration`);
  assert.equal((await subs(api, 1)).items.length, 1, 'invalid commands never create extra subscriptions');
}));

test('suspected wake cycles are evidence-backed, deduplicated advisories without intervention', async () => fixture(async ({ api, db, project, runs }) => {
  const one = await api('POST', '/subscriptions', { agent: 1, agents: [2], states: ['working', 'idle'] });
  const two = await api('POST', '/subscriptions', { agent: 2, agents: [1], states: ['working', 'idle'] });
  // Seed the journal that committed fake wakes would leave; no real turn or
  // intentionally unbounded A/B wake loop is needed to test the diagnostic.
  const wakeIds = db(connection => {
    const insert = connection.prepare('INSERT INTO events(project,at,kind,actor,agent,details) VALUES(?,unixepoch(),?,?,?,?)');
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const source = i % 2 ? 2 : 1, target = i % 2 ? 1 : 2;
      const sourceEvent = Number(insert.run(project.id, 'agent.state', 'acom', source, JSON.stringify({ from: 'idle', to: 'working' })).lastInsertRowid);
      ids.push(Number(insert.run(project.id, 'subscription.wake', 'acom', target, JSON.stringify({ sources: [source], subscriptions: [target === 1 ? one.id : two.id], events: [sourceEvent] })).lastInsertRowid));
    }
    return ids;
  });
  const diagnostics = () => api('GET', '/history?viewer=0&kind=coordination.suspected-loop');
  await until(async () => (await diagnostics()).events.length >= 2, 'suspected reciprocal wake loop is logged');
  const warnings = (await diagnostics()).events;
  assert.equal(warnings.length, 2, 'one structured diagnostic is recorded for each affected agent');
  for (const warning of warnings) {
    const details = typeof warning.details === 'string' ? JSON.parse(warning.details) : warning.details;
    assert.deepEqual(details.agents.sort((a, b) => a - b), [1, 2]);
    assert.deepEqual(details.wake_events.sort((a, b) => a - b), wakeIds);
    assert.ok(details.events.length >= 6); assert.ok(details.subscriptions.includes(one.id)); assert.ok(details.subscriptions.includes(two.id));
  }
  assert.match((await hook(api, 1)).text, /suspect|loop|cycle/i);
  await sleep(1200);
  assert.equal((await diagnostics()).events.length, 2, 'unchanged evidence does not create a warning storm');
  for (const id of [1, 2]) assert.equal((await api('GET', `/agents/${id}`)).state, 'working');
  for (const id of [one.id, two.id]) assert.equal((await record(api, id)).state, 'active');
  assert.equal(runs().length, 0, 'diagnostics do not start, pause, or replace workers');
}));
