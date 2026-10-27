// Synthetic harness frames only: no real clients, credentials, or saved state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const diagnostic = 'Reconnecting... 2/5 (synthetic transport interrupted)';
const terminal = 'Synthetic authoritative terminal failure';

async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await delay(20); } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}`);
}

const client = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);if(!args.includes('exec'))process.exit(0);
const home=process.env.ACOM_HOME,id=Number(process.env.ACOM_ID),file=name=>path.join(home,name+'-'+id);
const emit=value=>console.log(JSON.stringify(value)),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let prompt='';process.stdin.on('data',data=>prompt+=data);process.stdin.on('end',async()=>{
 const runs=fs.existsSync(file('runs'))?JSON.parse(fs.readFileSync(file('runs'),'utf8')):[];
 const mode=runs[0]?.mode||prompt.match(/FAILURE_REPORTING:([A-Z_]+)/)?.[1];
 const session='22222222-2222-4222-8222-'+String(id).padStart(12,'0');
 runs.push({mode,pid:process.pid,prompt,resume:args[1]==='resume',session});fs.writeFileSync(file('runs'),JSON.stringify(runs));
 const dir=path.join(process.env.CODEX_HOME,'sessions','2026','01','01');fs.mkdirSync(dir,{recursive:true});
 const history=path.join(dir,'rollout-'+session+'.jsonl'),side=value=>fs.appendFileSync(history,JSON.stringify(value)+'\\n');
 side({type:'session_meta',payload:{id:session}});emit({type:'thread.started',thread_id:session});
 if(runs.length>1){
  if(mode==='RESUMED_HISTORY'){
   emit({type:'error',message:'Synthetic current resumed error'});
   side({type:'event_msg',payload:{type:'error',message:'Synthetic current resumed error'}});return;
  }
  emit({type:'turn.completed'});return;
 }
 fs.writeFileSync(file('ready'),'ready');while(!fs.existsSync(file('release')))await pause(10);
 const error=message=>emit({type:'error',message}),failed=message=>emit({type:'turn.failed',error:{message}});
 if(mode==='STDERR_ONLY'){console.error('Synthetic stderr exit reason');process.exitCode=1;return}
 if(mode==='ITEM_ONLY'){emit({type:'item.completed',item:{type:'error',message:'Synthetic startup notice'}});process.exitCode=1;return}
 if(mode!=='RESUMED_HISTORY')error(${JSON.stringify(diagnostic)});
 if(mode==='RECOVERED'){
  side({type:'event_msg',payload:{type:'error',message:'Synthetic side-file reconnect notice'}});
  emit({type:'turn.completed',usage:{input_tokens:8,output_tokens:2}});return;
 }
 if(mode==='UNRESOLVED_ZERO')return;
 if(mode==='MALFORMED_COMPLETION'){emit({type:'turn.completed',error:{message:'Synthetic malformed completion'}});return}
 if(mode==='NATIVE_FAILURE'){
  side({type:'event_msg',payload:{type:'task_complete',error:{message:${JSON.stringify(terminal)}}}});return;
 }
 if(mode==='DIAGNOSTIC_EXIT'){error('Synthetic final transport diagnostic');console.error('Synthetic stderr fallback');process.exitCode=1;return}
 if(mode==='COMPLETED_NONZERO'){emit({type:'turn.completed'});console.error('Synthetic failure after completion');process.exitCode=1;return}
 if(mode==='QUOTA'){
  emit({type:'turn.failed',error:{code:'usage_limit_reached',message:'Synthetic subscription usage limit reached'}});process.exitCode=1;return;
 }
 if(mode==='RESUMED_HISTORY'){
  side({type:'event_msg',payload:{type:'task_complete'}});
  side({type:'event_msg',payload:{type:'task_complete',error:{message:'Synthetic earlier turn failure'}}});
  failed('Synthetic earlier turn failure');return;
 }
 if(mode==='DONE_FAILURE'){
  const response=await fetch(process.env.ACOM_URL+'/agents/'+id+'/done',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  if(!response.ok)throw Error(await response.text());
 }
 failed(${JSON.stringify(terminal)});
 side({type:'event_msg',payload:{type:'error',message:'Synthetic stale side-file diagnostic'}});
 side({type:'turn.failed',error:{message:${JSON.stringify(terminal)}}});
 side({type:'event_msg',payload:{type:'error',message:'Synthetic late side-file diagnostic'}});
 error('Synthetic late stdout diagnostic');
 if(mode==='FAILURE_THEN_COMPLETE')emit({type:'turn.completed'});
 if(!['TERMINAL_ZERO','FAILURE_THEN_COMPLETE'].includes(mode))process.exitCode=1;
});
`;

async function fixture(run) {
  const executableDir = path.dirname(fs.realpathSync(binary));
  for (const name of ['codex', 'claude']) assert.equal(fs.existsSync(path.join(executableDir, name)), false, 'a real client must not shadow the fixture');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-failure-reporting-'));
  const home = path.join(root, 'data'), projectDir = path.join(root, 'project'), bin = path.join(root, 'bin');
  for (const dir of [home, projectDir, bin, path.join(root, 'user')]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, 'codex'), client, { mode: 0o700 });
  const env = { ...process.env, HOME: path.join(root, 'user'), ACOM_HOME: home, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), PATH: bin };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(binary, ['serve', '--port', String(port)], { cwd: projectDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; server.stderr.on('data', data => errors += data);
  const api = async (method, route, body) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(value)}`); return value;
  };
  const file = (name, id) => path.join(home, `${name}-${id}`);
  const runs = id => fs.existsSync(file('runs', id)) ? JSON.parse(fs.readFileSync(file('runs', id), 'utf8')) : [];
  try {
    await until(async () => { if (server.exitCode !== null) throw Error(errors); try { return (await fetch(url + '/catalog')).ok; } catch { return false; } }, 'fixture startup');
    const project = (await api('POST', '/projects', { path: projectDir })).id;
    const config = (await api('GET', '/configs/1')).settings;
    config.auto_resume = false; config.usage_poll_secs = 3600;
    config.limits.active = { soft: null, hard: null };
    for (const limits of [config.limits.active_per_harness, config.limits.usage]) for (const key of Object.keys(limits)) limits[key] = { soft: null, hard: null };
    config.crash_retries = {};
    const save = () => api('PUT', `/projects/${project}/config`, { custom: config }); await save();
    const launch = async mode => {
      const agent = await api('POST', '/agents', { project, harness: 'codex', model: 'gpt-6-sol', effort: 'medium', task: `FAILURE_REPORTING:${mode}` });
      await until(() => fs.existsSync(file('ready', agent.id)), 'synthetic turn ready'); return agent.id;
    };
    await run({ api, project, config, save, runs, launch, view: id => api('GET', `/agents/${id}`),
      release: id => fs.writeFileSync(file('release', id), 'finish'),
      failures: async id => (await api('GET', `/history?project=${project}&agent=${id}&kind=agent.failed`)).events });
  } finally {
    if (server.exitCode === null) server.kill('SIGTERM');
    await until(() => server.exitCode !== null || server.signalCode !== null, 'fixture shutdown', 15000);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const retryRule = { harness: 'codex', model: 'gpt-6-luna', same_model_retries: 1 };

test('recovered stdout and side-file diagnostics do not fail or retry a successful Codex turn', async () => fixture(async f => {
  f.config.crash_retries['gpt-6-sol'] = retryRule; await f.save();
  const id = await f.launch('RECOVERED'); f.release(id);
  await until(async () => (await f.view(id)).state !== 'working', 'completed synthetic turn');
  const agent = await f.view(id);
  assert.equal(agent.state, 'idle'); assert.equal(agent.problem, null); assert.equal(agent.retry, null);
  assert.deepEqual(await f.failures(id), []);
  await delay(2200); assert.equal(f.runs(id).length, 1, 'reconnect diagnostics do not trigger configured recovery');
  const log = (await f.api('GET', `/agents/${id}/log`)).text;
  assert.ok(log.includes(diagnostic), 'recoverable diagnostics remain inspectable');
}));

test('terminal cause wins over diagnostics in agent details, activity, history and automatic recovery', async () => fixture(async f => {
  f.config.crash_retries['gpt-6-sol'] = retryRule; await f.save();
  const id = await f.launch('TERMINAL_FAILURE'); f.release(id);
  await until(async () => (await f.view(id)).state === 'crashed', 'failed synthetic turn');
  assert.equal((await f.view(id)).problem, terminal);
  const failures = await f.failures(id); assert.equal(failures.length, 1); assert.equal(failures[0].details.reason, terminal);
  const activity = (await f.api('GET', `/activity?project=${f.project}&agent=${id}`)).items;
  assert.deepEqual(activity.filter(item => item.what.includes(' crashed: ')).map(item => item.what), [`agent ${id} crashed: ${terminal}`]);
  await until(() => f.runs(id).length === 2, 'one configured retry');
  await until(async () => (await f.view(id)).state === 'idle', 'retry succeeds');
  const runs = f.runs(id); assert.equal(runs[1].resume, true); assert.equal(runs[1].session, runs[0].session);
  assert.match(runs[1].prompt, /Crash recovery:/); assert.ok(runs[1].prompt.includes(`Failure: ${terminal}`));
  assert.ok(!runs[1].prompt.includes(`Failure: ${diagnostic}`));
  assert.equal((await f.view(id)).problem, null, 'the retry does not inherit a retained failure');
  assert.equal((await f.view(id)).retry, null); assert.equal((await f.failures(id)).length, 1);
  await delay(2200); assert.equal(f.runs(id).length, 2, 'duplicate stdout and side-file frames do not duplicate retries');
}));

for (const mode of ['DONE_FAILURE', 'TERMINAL_ZERO', 'NATIVE_FAILURE', 'FAILURE_THEN_COMPLETE']) {
  test(`${mode.toLowerCase()} remains a crash despite a finishing request or zero process exit`, async () => fixture(async f => {
    const id = await f.launch(mode); f.release(id);
    await until(async () => (await f.view(id)).state !== 'working', 'terminal failure finalized');
    const agent = await f.view(id); assert.equal(agent.state, 'crashed'); assert.equal(agent.problem, terminal);
    assert.equal((await f.failures(id)).length, 1);
  }));
}

for (const mode of ['UNRESOLVED_ZERO', 'MALFORMED_COMPLETION']) {
  test(`${mode.toLowerCase()} does not hide an unresolved harness error`, async () => fixture(async f => {
    const id = await f.launch(mode); f.release(id);
    await until(async () => (await f.view(id)).state !== 'working', 'unresolved error finalized');
    assert.equal((await f.view(id)).state, 'crashed');
    assert.equal((await f.failures(id)).length, 1);
  }));
}

test('a nonzero exit uses the latest diagnostic when no terminal cause exists', async () => fixture(async f => {
  const id = await f.launch('DIAGNOSTIC_EXIT'); f.release(id);
  await until(async () => (await f.view(id)).state === 'crashed', 'nonzero exit finalized');
  assert.equal((await f.view(id)).problem, 'Synthetic final transport diagnostic');
  assert.equal((await f.failures(id))[0].details.reason, 'Synthetic final transport diagnostic');
}));

for (const [mode, reason] of [['STDERR_ONLY', 'Synthetic stderr exit reason'], ['ITEM_ONLY', 'its process exited with an error'], ['COMPLETED_NONZERO', 'Synthetic failure after completion']]) {
  test(`${mode.toLowerCase()} preserves the nonzero-exit fallback without inventing a notice as the cause`, async () => fixture(async f => {
    const id = await f.launch(mode); f.release(id);
    await until(async () => (await f.view(id)).state === 'crashed', 'nonzero exit finalized');
    assert.equal((await f.view(id)).problem, reason);
  }));
}

test('manual retry clears provisional and terminal causes while retaining the native session', async () => fixture(async f => {
  const id = await f.launch('TERMINAL_FAILURE'); f.release(id);
  await until(async () => (await f.view(id)).state === 'crashed', 'original failed turn');
  await f.api('POST', `/agents/${id}/resume`, {});
  await until(async () => f.runs(id).length === 2 && (await f.view(id)).state === 'idle', 'manual retry completes');
  assert.equal((await f.view(id)).problem, null); assert.equal((await f.view(id)).retry, null);
  const runs = f.runs(id); assert.equal(runs[1].resume, true); assert.equal(runs[1].session, runs[0].session);
  assert.equal((await f.failures(id)).length, 1);
}));

test('resumed native history does not replay old completions or failures into the new turn', async () => fixture(async f => {
  const id = await f.launch('RESUMED_HISTORY'); f.release(id);
  await until(async () => (await f.view(id)).state === 'crashed', 'earlier turn fails');
  assert.equal((await f.view(id)).problem, 'Synthetic earlier turn failure');
  await f.api('POST', `/agents/${id}/resume`, {});
  await until(async () => f.runs(id).length === 2 && (await f.view(id)).state !== 'working', 'resumed turn finalized');
  const agent = await f.view(id); assert.equal(agent.state, 'crashed'); assert.equal(agent.problem, 'Synthetic current resumed error');
  const failures = await f.failures(id);
  assert.deepEqual(failures.map(event => event.details.reason).sort(), ['Synthetic current resumed error', 'Synthetic earlier turn failure']);
  const runs = f.runs(id); assert.equal(runs[1].resume, true); assert.equal(runs[1].session, runs[0].session);
}));

test('recognized quota interruption after a reconnect diagnostic pauses without a crash retry', async () => fixture(async f => {
  f.config.crash_retries['gpt-6-sol'] = retryRule; await f.save();
  const id = await f.launch('QUOTA'); f.release(id);
  await until(async () => (await f.view(id)).state === 'paused', 'quota pause');
  const agent = await f.view(id); assert.equal(agent.pause_reason, 'limit'); assert.equal(agent.retry, null);
  assert.deepEqual(await f.failures(id), []);
  await delay(2200); assert.equal(f.runs(id).length, 1, 'quota interruptions do not enter crash recovery');
}));
