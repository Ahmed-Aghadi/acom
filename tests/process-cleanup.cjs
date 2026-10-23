// Isolated ownership/lock regressions. No real provider clients or live state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).startsWith('Z'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function killOwnedTool(pid, id, home, url) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(id) || id <= 0) return;
  try {
    const identity = () => {
      const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/);
      return !['Z', 'X'].includes(fields[0]) && /^\d+$/.test(fields[19] || '') ? fields[19] : null;
    };
    const start = identity();
    if (start === null) return;
    const markers = fs.readFileSync(`/proc/${pid}/environ`).toString().split('\0');
    if (![ `ACOM_ID=${id}`, `ACOM_HOME=${home}`, `ACOM_URL=${url}` ].every(value => markers.includes(value))) return;
    if (identity() === start) process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
  }
}
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) { const result = await check(); if (result) return result; if (Date.now() > deadline) throw Error(`Timed out: ${label}`); await delay(20); }
}

const client = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
if(!process.argv.includes('exec')&&!process.argv.includes('-p'))process.exit(0);
const home=process.env.ACOM_HOME,id=Number(process.env.ACOM_ID),claude=path.basename(process.argv[1])==='claude';
const file=name=>path.join(home,name+'-'+id),alive=pid=>{try{return !fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).startsWith('Z')}catch{return false}};
const post=async(route,body)=>{const r=await fetch(process.env.ACOM_URL+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text())};
const emit=value=>console.log(JSON.stringify(value));
let prompt='';process.stdin.on('data',data=>prompt+=data);process.stdin.on('end',async()=>{
 const previous=fs.existsSync(file('starts'))?JSON.parse(fs.readFileSync(file('starts'),'utf8')):[];
 const oldTools=fs.readdirSync(home).filter(name=>/^tool-pid-/.test(name)).map(name=>Number(fs.readFileSync(path.join(home,name),'utf8'))).filter(alive);
 previous.push({pid:process.pid,prompt,oldTools});fs.writeFileSync(file('starts'),JSON.stringify(previous));
 emit(claude?{type:'system',subtype:'init',session_id:'11111111-1111-4111-8111-'+String(id).padStart(12,'0')}:{type:'thread.started',thread_id:'11111111-1111-4111-8111-'+String(id).padStart(12,'0')});
 if(previous.length>1&&!previous[0].prompt.includes('CLEANUP_REST_DONE')||prompt.includes('CLEANUP_TARGET')){process.exit(0);return}
 if(previous.length===1)await post('/locks',{agent:id,name:'guarded-'+id,about:'Owned tools must stop before release'});
 await post('/locks/acquire',{agent:id,name:'guarded-'+id,ttl:120});
 const late=prompt.includes('CLEANUP_LATE'),resistant=prompt.includes('CLEANUP_RESISTANT');
 const toolCode="const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(process.env.TERM_FILE,'term');if(process.env.RESISTANT!=='yes')process.exit(0)});fs.writeFileSync(process.env.TOOL_READY,'ready');setInterval(()=>{if(fs.existsSync(process.env.TOOL_FINISH))process.exit(0)},10);if(process.env.LATE_FAILURE==='yes')setTimeout(()=>console.log(JSON.stringify({type:'turn.failed',error:{message:'late synthetic crash'}})),200);";
 const tool=spawn(process.execPath,['-e',toolCode],{detached:true,stdio:['ignore',late?'inherit':'ignore','ignore'],env:{...process.env,TERM_FILE:file('term'),TOOL_READY:file('tool-ready'),TOOL_FINISH:file('tool-finish'),RESISTANT:resistant?'yes':'no',LATE_FAILURE:prompt.includes('CLEANUP_LATE_FAILURE')?'yes':'no'}});tool.unref();fs.writeFileSync(file('tool-pid'),String(tool.pid));
 while(!fs.existsSync(file('tool-ready')))await new Promise(resolve=>setTimeout(resolve,10));
 fs.writeFileSync(file('ready'),'ready');
 while(!fs.existsSync(file('release')))await new Promise(resolve=>setTimeout(resolve,10));
 if(prompt.includes('CLEANUP_MODEL_SWITCH')){emit({type:'event_msg',payload:{type:'model_reroute',from_model:'gpt-6-sol',to_model:'other-model'}});setInterval(()=>{},1000);return}
 if(prompt.includes('CLEANUP_CRASH')){emit({type:'turn.failed',error:{message:'synthetic crash'}});process.exit(1);return}
 process.exit(0);
});
`;

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-process-cleanup-'));
  const home = path.join(root, 'data'), bin = path.join(root, 'bin'), project = path.join(root, 'project');
  for (const dir of [home, bin, project, path.join(root, 'user')]) fs.mkdirSync(dir);
  for (const harness of ['codex', 'claude']) fs.writeFileSync(path.join(bin, harness), client, { mode: 0o700 });
  const env = { ...process.env, HOME: path.join(root, 'user'), ACOM_HOME: home, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), PATH: bin };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key];
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(binary, ['serve', '--port', String(port)], { cwd: project, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; server.stderr.on('data', data => errors += data);
  const api = async (method, route, body, status = 200) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`); return value;
  };
  const file = (name, id) => path.join(home, `${name}-${id}`);
  const starts = id => fs.existsSync(file('starts', id)) ? JSON.parse(fs.readFileSync(file('starts', id), 'utf8')) : [];
  let db;
  try {
    await until(async () => { if (server.exitCode !== null) throw Error(errors); try { return (await fetch(url + '/catalog')).ok; } catch { return false; } }, 'server startup');
    const p = await api('POST', '/projects', { path: project });
    const config = (await api('GET', '/configs/1')).settings;
    config.allow_agent_model_change = true; config.allow_agent_effort_change = true;
    config.limits.active = { soft: null, hard: null };
    for (const provider of Object.keys(config.limits.active_per_harness)) config.limits.active_per_harness[provider] = { soft: null, hard: null };
    await api('PUT', `/projects/${p.id}/config`, { custom: config });
    db = new DatabaseSync(path.join(home, 'acom.db'));
    const launch = async task => {
      const a = await api('POST', '/agents', { project: p.id, task, harness: 'codex', model: 'gpt-6-sol', effort: 'medium' });
      if (!task.includes('CLEANUP_TARGET')) await until(() => fs.existsSync(file('ready', a.id)), 'fake source ready');
      return a.id;
    };
    await run({ root, home, project: p.id, api, file, starts, db, launch, config, saveConfig: () => api('PUT', `/projects/${p.id}/config`, { custom: config }), view: id => api('GET', `/agents/${id}`), release: id => fs.writeFileSync(file('release', id), 'exit'), tool: id => Number(fs.readFileSync(file('tool-pid', id), 'utf8')) });
  } finally {
    db?.close();
    if (server.exitCode === null) server.kill('SIGTERM');
    await until(() => server.exitCode !== null, 'server shutdown', 15000);
    for (const name of fs.readdirSync(home).filter(name => /^tool-pid-/.test(name))) {
      const pid = Number(fs.readFileSync(path.join(home, name), 'utf8'));
      killOwnedTool(pid, Number(name.slice('tool-pid-'.length)), home, url);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('crash retains an expired lease until detached owned tools stop, without killing an unrelated tool', async () => fixture(async f => {
  const id = await f.launch('CLEANUP_CRASH CLEANUP_RESISTANT'), tool = f.tool(id);
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, ACOM_ID: String(id), ACOM_URL: 'http://127.0.0.1:1', ACOM_HOME: f.home } });
  try {
    f.release(id);
    await until(async () => fs.existsSync(f.file('term', id)) || (await f.view(id)).state === 'crashed', 'crash cleanup begins');
    assert.ok(fs.existsSync(f.file('term', id)), 'crash requests identity-aware detached cleanup before releasing the lease');
    assert.equal((await f.view(id)).stopping, true);
    f.db.prepare('UPDATE locks SET expires_at=? WHERE name=?').run(Math.floor(Date.now()/1000)-1, `guarded-${id}`);
    await delay(1100);
    const lock = (await f.api('GET', `/locks?project=${f.project}`)).items.find(lock => lock.name === `guarded-${id}`);
    assert.equal(lock.holder, id); assert.ok(alive(tool)); assert.ok(alive(foreign.pid));
    f.db.prepare('INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(2,?,\'contender\',\'No provider process\',\'codex\',\'gpt-6-sol\',\'medium\',\'working\',0,0)').run(f.project);
    await f.api('POST', '/locks/acquire', { agent: 2, name: `guarded-${id}`, ttl: 120 }, 409);
    await f.api('POST', '/locks/free', { project: f.project, name: `guarded-${id}` }, 409);
    await f.api('POST', '/locks/release', { agent: id, name: `guarded-${id}` }, 409);
    fs.writeFileSync(f.file('tool-finish', id), 'finish');
    await until(async () => (await f.view(id)).state === 'crashed', 'crash is finalized');
    assert.equal(alive(tool), false); assert.equal((await f.api('GET', `/locks?project=${f.project}`)).items[0].holder, null);
    await f.api('POST', '/locks/acquire', { agent: 2, name: `guarded-${id}`, ttl: 120 });
    assert.ok(alive(foreign.pid));
  } finally {
    if (foreign.exitCode === null && foreign.signalCode === null) {
      foreign.kill('SIGKILL'); await new Promise(resolve => foreign.once('exit', resolve));
    }
  }
}));

for (const mode of ['CONTINUE', 'REPLACE', 'LATE_CONTINUE', 'LATE_REPLACE']) {
  test(`${mode.toLowerCase()} stops detached predecessors before starting the next turn`, async () => fixture(async f => {
    const id = await f.launch(`CLEANUP_${mode}`), tool = f.tool(id), late = mode.startsWith('LATE');
    if (late) { f.release(id); await until(() => !alive(f.starts(id)[0].pid), 'source parent reaped with stdout still inherited'); }
    if (mode.endsWith('CONTINUE')) await f.api('POST', '/agent-config', { id, agent: id, effort: 'high', continuation: 'CLEANUP_TARGET' });
    else await f.api('POST', `/agents/${id}/replacement`, { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high', task: 'CLEANUP_TARGET' });
    if (!late) f.release(id);
    let next = id;
    await until(async () => { const a = await f.view(id); if (mode.endsWith('REPLACE')) next = a.replacement; return next && f.starts(next).length >= (next === id ? 2 : 1); }, 'next turn starts');
    assert.equal(alive(tool), false);
    assert.deepEqual(f.starts(next).at(-1).oldTools, [], 'no old owned tool is alive when the task is delivered');
    const lock = (await f.api('GET', `/locks?project=${f.project}`)).items.find(lock => lock.name === `guarded-${id}`);
    assert.equal(lock.holder, mode.endsWith('CONTINUE') ? id : null, 'same-agent continuation preserves its lease, replacement releases it');
  }));
}

test('a late failure from a detached stdout owner completes crash cleanup', async () => fixture(async f => {
  const id = await f.launch('CLEANUP_LATE_FAILURE'), tool = f.tool(id);
  f.release(id);
  await until(async () => (await f.view(id)).state === 'crashed', 'late failure is finalized');
  assert.equal(alive(tool), false);
}));

test('ordinary successful turns preserve background work until an explicit pause', async () => fixture(async f => {
  const id = await f.launch('CLEANUP_NORMAL'), tool = f.tool(id);
  f.release(id); await until(async () => (await f.view(id)).state === 'idle', 'ordinary success becomes idle');
  assert.ok(alive(tool));
  await f.api('POST', `/agents/${id}/pause`, {});
  await until(async () => !(await f.view(id)).stopping, 'explicit pause cleans owned tools');
  assert.equal(alive(tool), false);
}));

for (const closes of [true, false]) for (const late of [false, true]) {
  test(`${late ? 'late ' : ''}finished turns stop detached tools before becoming ${closes ? 'closed' : 'done'} and releasing locks`, async () => fixture(async f => {
    f.config.done_closes = closes; await f.saveConfig();
    const id = await f.launch(late ? 'CLEANUP_LATE_FINISHED' : 'CLEANUP_FINISHED'), tool = f.tool(id);
    if (late) { f.release(id); await until(() => !alive(f.starts(id)[0].pid), 'finished source parent reaped with stdout still inherited'); }
    await f.api('POST', `/agents/${id}/done`, {}); if (!late) f.release(id);
    await until(async () => (await f.view(id)).state === (closes ? 'closed' : 'done'), 'finished turn state');
    assert.equal(alive(tool), false, 'finished state is not exposed before detached work stops');
    assert.equal((await f.api('GET', `/locks?project=${f.project}`)).items[0].holder, null);
  }));
}

test('a message-woken done agent cleans detached tools before returning to done', async () => fixture(async f => {
  f.config.done_closes = false; await f.saveConfig();
  const id = await f.launch('CLEANUP_REST_DONE'), firstTool = f.tool(id);
  await f.api('POST', `/agents/${id}/done`, {}); f.release(id);
  await until(async () => (await f.view(id)).state === 'done', 'original turn finishes');
  assert.equal(alive(firstTool), false);
  for (const name of ['release', 'ready', 'tool-ready', 'term', 'tool-finish']) {
    try { fs.unlinkSync(f.file(name, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const thread = await f.api('POST', '/threads', { project: f.project, title: 'Wake completed work', members: [String(id)], include_user: true });
  await f.api('POST', '/messages', { thread: thread.id, text: 'One additional task' });
  await until(() => f.starts(id).length === 2 && fs.existsSync(f.file('ready', id)), 'message-woken turn starts');
  const secondTool = f.tool(id);
  assert.equal(f.db.prepare('SELECT rest FROM agents WHERE id=?').get(id).rest, 'done');
  assert.ok(alive(secondTool)); f.release(id);
  await until(async () => (await f.view(id)).state === 'done', 'message-woken turn returns to done');
  assert.equal(alive(secondTool), false);
  assert.equal((await f.api('GET', `/locks?project=${f.project}`)).items[0].holder, null);
}));

test('model substitution stops the native worker and detached tools using identity-aware escalation', async () => fixture(async f => {
  const id = await f.launch('CLEANUP_MODEL_SWITCH CLEANUP_RESISTANT'), tool = f.tool(id), worker = f.starts(id)[0].pid;
  f.release(id);
  await until(() => fs.existsSync(f.file('term', id)), 'detached tool receives TERM');
  assert.equal((await f.view(id)).stopping, true);
  assert.ok(alive(tool));
  await until(async () => (await f.view(id)).state === 'crashed', 'resistant tool is killed and crash finalized');
  assert.equal(alive(worker), false); assert.equal(alive(tool), false);
  assert.match((await f.view(id)).problem, /rerouted/);
}));

test('configured crash recovery cannot start while old detached work is still stopping', async () => fixture(async f => {
  f.config.crash_retries['gpt-6-sol'] = { same_model_retries: 1, harness: 'claude', model: 'claude-sonnet-5-5' };
  await f.saveConfig();
  const id = await f.launch('CLEANUP_CRASH CLEANUP_RESISTANT'), tool = f.tool(id);
  f.release(id);
  await until(() => fs.existsSync(f.file('term', id)), 'crash cleanup begins before recovery');
  await delay(2200);
  assert.equal(f.starts(id).length, 1); assert.equal((await f.view(id)).stopping, true); assert.ok(alive(tool));
  fs.writeFileSync(f.file('tool-finish', id), 'finish');
  await until(() => f.starts(id).length === 2, 'one same-model retry starts after cleanup');
  assert.equal(alive(tool), false); assert.deepEqual(f.starts(id)[1].oldTools, []);
  await until(async () => (await f.view(id)).state === 'idle', 'successful retry becomes idle');
  assert.equal((await f.view(id)).replacement, null);
}));

for (const action of ['pause', 'close']) {
  test(`${action} during continuation cleanup preserves the existing control boundary`, async () => fixture(async f => {
    const id = await f.launch('CLEANUP_CONTINUE CLEANUP_RESISTANT'), tool = f.tool(id);
    await f.api('POST', '/agent-config', { id, agent: id, effort: 'high', continuation: 'CLEANUP_TARGET' });
    f.release(id);
    await until(() => fs.existsSync(f.file('term', id)), 'continuation cleanup begins');
    await f.api('POST', `/agents/${id}/${action}`, {}, action === 'pause' ? 200 : 409);
    assert.ok(alive(tool));
    fs.writeFileSync(f.file('tool-finish', id), 'finish');
    if (action === 'close') {
      await until(() => f.starts(id).length === 2, 'refused close did not discard the continuation');
      await until(async () => (await f.view(id)).state === 'idle', 'continuation succeeds');
      await f.api('POST', `/agents/${id}/close`, {});
    }
    await until(async () => !(await f.view(id)).stopping, 'control cleanup completes');
    const a = await f.view(id);
    assert.equal(a.state, action === 'pause' ? 'paused' : 'closed');
    assert.equal(a.continuation, null); assert.equal(f.starts(id).length, action === 'pause' ? 1 : 2); assert.equal(alive(tool), false);
    assert.equal((await f.api('GET', `/locks?project=${f.project}`)).items[0].holder, null);
  }));
}
