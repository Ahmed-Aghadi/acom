// Synthetic provider events only; never run real clients or read saved sessions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await pause(20); } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}`);
}

const client = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),claude=path.basename(process.argv[1])==='claude';
if(!(claude?args.includes('-p'):args.includes('exec')))process.exit(0);
const home=process.env.ACOM_HOME,id=Number(process.env.ACOM_ID),file=name=>path.join(home,name+'-'+id);
let prompt='';process.stdin.on('data',data=>prompt+=data);process.stdin.on('end',async()=>{
 const previous=fs.existsSync(file('runs'))?JSON.parse(fs.readFileSync(file('runs'),'utf8')):[];
 const turn=previous.length,session=claude?args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1]:args[1]==='resume'?args.at(-2):'33333333-3333-4333-8333-'+String(id).padStart(12,'0');
 const dir=path.join(process.env.CODEX_HOME,'sessions','2026','01','01'),history=path.join(dir,'rollout-'+session+'.jsonl');
 if(!claude){fs.mkdirSync(dir,{recursive:true});if(!fs.existsSync(history))fs.writeFileSync(history,JSON.stringify({type:'session_meta',payload:{id:session}})+'\\n')}
 const emit=value=>console.log(JSON.stringify(value));
 emit(claude?{type:'system',subtype:'init',session_id:session}:{type:'thread.started',thread_id:session});
 previous.push({turn,session,history,args,pid:process.pid,prompt});fs.writeFileSync(file('runs'),JSON.stringify(previous));
 const commands=file('commands')+'-'+turn;let count=0;
 for(;;){
  const lines=fs.existsSync(commands)?fs.readFileSync(commands,'utf8').trim().split('\\n').filter(Boolean):[];
  for(;count<lines.length;count++){
   const command=JSON.parse(lines[count]);
   const output=command.session?path.join(dir,'rollout-'+command.session+'.jsonl'):history;
   for(const frame of command.frames||[])command.side?fs.appendFileSync(output,JSON.stringify(frame)+'\\n'):emit(frame);
   if(command.exit!==undefined){process.exitCode=command.exit;return}
  }
  await new Promise(resolve=>setTimeout(resolve,10));
 }
});
`;

async function fixture(run) {
  const executableDir = path.dirname(fs.realpathSync(binary));
  for (const name of ['codex', 'claude']) assert.equal(fs.existsSync(path.join(executableDir, name)), false, 'a real client must not shadow the fixture');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-token-usage-'));
  const home = path.join(root, 'data'), projectDir = path.join(root, 'project'), bin = path.join(root, 'bin');
  for (const dir of [home, projectDir, bin, path.join(root, 'user')]) fs.mkdirSync(dir);
  for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(bin, name), client, { mode: 0o700 });
  const env = { ...process.env, HOME: path.join(root, 'user'), ACOM_HOME: home, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), PATH: bin };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  let server, url, errors = '', marker = 0;
  const start = async () => {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    url = `http://127.0.0.1:${port}`;
    server = spawn(binary, ['serve', '--port', String(port)], { cwd: projectDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', data => errors += data);
    await until(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw Error(errors);
      try { return (await fetch(url + '/catalog')).ok; } catch { return false; }
    }, 'fixture startup');
  };
  const stop = async () => {
    if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
    await until(() => !server || server.exitCode !== null || server.signalCode !== null, 'fixture shutdown', 15000);
  };
  const api = async (method, route, body) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(value)}`); return value;
  };
  const file = (name, id) => path.join(home, `${name}-${id}`);
  const runs = id => fs.existsSync(file('runs', id)) ? JSON.parse(fs.readFileSync(file('runs', id), 'utf8')) : [];
  const command = (id, value) => fs.appendFileSync(`${file('commands', id)}-${runs(id).at(-1).turn}`, JSON.stringify(value) + '\n');
  const emit = async (id, frames, side = false, nativeSession) => {
    const text = `TOKEN_CHECKPOINT_${++marker}`;
    const context = 100000 + marker;
    const checkpoint = side
      ? { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: context } } } }
      : runs(id).at(-1).args.includes('-p')
      ? { type: 'assistant', message: { content: [{ type: 'text', text }] } }
      : { type: 'item.completed', item: { type: 'agent_message', text } };
    command(id, { frames: [...frames, checkpoint], side, session: nativeSession });
    await until(async () => side
      ? (await api('GET', `/agents/${id}`)).context === context
      : (await api('GET', `/agents/${id}/log`)).text.includes(text), 'provider events applied');
    return api('GET', `/agents/${id}`);
  };
  const cli = async id => {
    const child = spawn(binary, ['agent', String(id)], { cwd: projectDir, env: { ...env, ACOM_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(status, 0, stderr); return stdout;
    } finally { clearTimeout(timer); }
  };
  try {
    await start();
    const project = (await api('POST', '/projects', { path: projectDir })).id;
    const config = (await api('GET', '/configs/1')).settings;
    config.auto_resume = false; config.usage_poll_secs = 3600; config.crash_retries = {};
    config.limits.active = { soft: null, hard: null };
    for (const limits of [config.limits.active_per_harness, config.limits.usage]) for (const key of Object.keys(limits)) limits[key] = { soft: null, hard: null };
    await api('PUT', `/projects/${project}/config`, { custom: config });
    const launch = async (harness = 'claude') => {
      const { id } = await api('POST', '/agents', { project, harness, model: harness === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6-sol', effort: 'medium', task: 'Synthetic token accounting' });
      await until(() => runs(id).length === 1, 'synthetic turn ready'); return id;
    };
    const finish = async (id, frames = [], exit = 0) => {
      command(id, { frames, exit });
      return until(async () => { const value = await api('GET', `/agents/${id}`); return value.state !== 'working' ? value : false; }, 'synthetic turn ended');
    };
    const next = async id => {
      const before = runs(id).length;
      const a = await api('GET', `/agents/${id}`);
      if (a.state === 'idle') {
        const thread = await api('POST', '/threads', { project, title: 'Next synthetic turn', members: [String(id)] });
        await api('POST', '/messages', { thread: thread.id, text: 'Continue the synthetic token check' });
      } else await api('POST', `/agents/${id}/resume`, {});
      await until(() => runs(id).length === before + 1, 'next synthetic turn ready');
      return api('GET', `/agents/${id}`);
    };
    await run({ api, project, runs, emit, finish, launch, next, cli, view: id => api('GET', `/agents/${id}`), restart: async () => { await stop(); await start(); } });
  } finally {
    await stop();
    for (const name of fs.readdirSync(home).filter(name => /^runs-\d+$/.test(name))) {
      for (const { pid } of JSON.parse(fs.readFileSync(path.join(home, name), 'utf8'))) {
        try {
          const markers = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
          const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
          if (markers.includes(`ACOM_HOME=${home}`) && ['codex', 'claude'].some(client => args.includes(path.join(bin, client)))) process.kill(pid, 'SIGKILL');
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const fields = ['fresh_in', 'cache_write', 'cache_read', 'output'];
function usage(agent, state, counters, total) {
  assert.equal(agent.token_usage_state, state);
  assert.deepEqual(fields.map(key => agent[key]), counters);
  assert.equal(agent.total_tokens, total);
  if (state !== 'unknown') assert.ok(agent.token_usage_updated_at > 0);
}
const counts = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });
let block = 0;
const assistant = (id, values, extra = {}) => ({ type: 'assistant', uuid: `synthetic-block-${++block}`, parent_tool_use_id: null, message: { id, usage: values, content: [] }, ...extra });
const start = (id, values) => ({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: values } } });
const delta = output => ({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: output } } });
const result = values => ({ type: 'result', subtype: 'success', is_error: false, usage: values });
const native = values => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: values } } });

test('unreported usage is not measured zero in details, listings or CLI', async () => fixture(async f => {
  const id = await f.launch();
  usage(await f.view(id), 'unknown', [null, null, null, null], null);
  const before = await f.api('GET', `/agents?project=${f.project}`);
  const listed = before.items.find(a => a.id === id);
  usage(listed, 'unknown', [null, null, null, null], null);
  assert.match(await f.cli(id), /not reported|unknown|unavailable/i);
  await f.emit(id, []);
  const overview = await f.api('GET', `/overview?project=${f.project}`);
  usage(await f.emit(id, [assistant('observed-zero', counts(0, 0, 0, 1))]), 'provisional', [0, 0, 0, null], null);
  const live = await f.api('GET', `/agents?project=${f.project}`);
  usage(live.items.find(a => a.id === id), 'provisional', [0, 0, 0, null], null);
  assert.notEqual(live.revision, before.revision, 'state-only accounting changes invalidate cached agent pages');
  const refreshed = await f.api('GET', `/overview?project=${f.project}&since=${encodeURIComponent(overview.revision)}`);
  assert.notEqual(refreshed.unchanged, true, 'ledger-only accounting changes invalidate the outer overview');
  assert.notEqual(refreshed.revisions.agents, overview.revisions.agents, 'the refreshed overview exposes the changed agent revision');
  const agent = await f.finish(id, [result(counts(0, 0, 0, 0))]);
  usage(agent, 'final', [0, 0, 0, 0], 0);
}));

test('Claude live snapshots deduplicate blocks and cumulative output, then reconcile final usage once', async () => fixture(async f => {
  const id = await f.launch();
  let agent = await f.emit(id, [assistant('message-a', counts(10, 20, 30, 1)), assistant('message-a', counts(10, 20, 30, 1))]);
  usage(agent, 'provisional', [10, 20, 30, null], null);
  assert.ok(f.runs(id)[0].args.includes('--include-partial-messages'));
  agent = await f.emit(id, [start('message-a', counts(10, 20, 30, 1)), delta(3), delta(5), delta(5), assistant('message-a', counts(10, 20, 30, 1))]);
  usage(agent, 'provisional', [10, 20, 30, 5], 65);
  agent = await f.emit(id, [start('message-b', counts(40, 0, 10, 1))]);
  usage(agent, 'provisional', [50, 20, 40, null], null);
  agent = await f.emit(id, [delta(7), assistant('message-b', counts(40, 0, 10, 1))]);
  usage(agent, 'provisional', [50, 20, 40, 12], 122);
  agent = await f.finish(id, [result(counts(12, 18, 29, 8)), result(counts(12, 18, 29, 8))]);
  usage(agent, 'final', [12, 18, 29, 8], 67);
}));

test('Claude ignores subagent usage and adds only each resumed invocation result, not modelUsage session totals', async () => fixture(async f => {
  const id = await f.launch();
  let agent = await f.emit(id, [assistant('child', counts(900, 900, 900, 900), { parent_tool_use_id: 'native-child' }), assistant('main', counts(2, 3, 4, 1))]);
  usage(agent, 'provisional', [2, 3, 4, null], null);
  agent = await f.finish(id, [result(counts(2, 3, 4, 5))]); usage(agent, 'final', [2, 3, 4, 5], 14);
  await f.next(id);
  agent = await f.emit(id, [assistant('resumed-main', counts(7, 11, 13, 1))]);
  usage(agent, 'provisional', [9, 14, 17, null], null);
  agent = await f.finish(id, [{ ...result(counts(7, 11, 13, 17)), modelUsage: { synthetic: { inputTokens: 9000, cacheCreationInputTokens: 9000, cacheReadInputTokens: 9000, outputTokens: 9000 } } }]);
  usage(agent, 'final', [9, 14, 17, 22], 62);
  assert.equal(f.runs(id)[1].session, f.runs(id)[0].session);
  assert.ok(f.runs(id)[1].args.includes('--resume'));
}));

test('missing Claude usage preserves known values without claiming a complete total', async () => fixture(async f => {
  const id = await f.launch();
  await f.emit(id, [assistant('incomplete', { input_tokens: 12, cache_read_input_tokens: 7 })]);
  const agent = await f.finish(id, [{ type: 'result', subtype: 'success', is_error: false }]);
  usage(agent, 'partial', [12, null, 7, null], null);
}));

test('an interrupted later Claude response does not discard output already reported for earlier messages', async () => fixture(async f => {
  const id = await f.launch();
  await f.emit(id, [start('completed-response', counts(10, 20, 30, 1)), delta(5)]);
  usage(await f.emit(id, [start('interrupted-response', counts(40, 0, 10, 1))]), 'provisional', [50, 20, 40, null], null);
  const agent = await f.finish(id);
  usage(agent, 'partial', [50, 20, 40, 5], null);
}));

test('a zeroed Claude crash result preserves observed counts and retry does not hide the historical gap', async () => fixture(async f => {
  const id = await f.launch();
  await f.emit(id, [start('interrupted', counts(4, 5, 6, 1)), delta(8)]);
  let agent = await f.finish(id, [{ ...result(counts(0, 0, 0, 0)), subtype: 'error_during_execution', is_error: true, errors: ['Synthetic interrupted response'] }], 1);
  assert.equal(agent.state, 'crashed'); usage(agent, 'partial', [4, 5, 6, 8], 23);
  await f.next(id);
  agent = await f.finish(id, [result(counts(10, 20, 30, 40))]);
  usage(agent, 'partial', [14, 25, 36, 48], 123);
}));

test('a nonzero Claude error aggregate cannot erase live usage or claim finalized coverage', async () => fixture(async f => {
  const failed = { ...result(counts(1, 2, 3, 4)), subtype: 'error_max_budget_usd', is_error: true, errors: ['Synthetic execution budget interrupted the response'] };
  const id = await f.launch();
  await f.emit(id, [start('crossed-budget', counts(10, 20, 30, 1)), delta(8)]);
  let agent = await f.finish(id, [failed], 1);
  usage(agent, 'partial', [10, 20, 30, 8], 68);
  const only = await f.launch();
  agent = await f.finish(only, [failed], 1);
  usage(agent, 'partial', [1, 2, 3, 4], 10);
}));

test('pausing and restarting retain partial usage instead of resetting counters', async () => fixture(async f => {
  const id = await f.launch();
  await f.emit(id, [start('paused', counts(3, 4, 5, 1)), delta(6)]);
  await f.api('POST', `/agents/${id}/pause`, {});
  await until(async () => !(await f.view(id)).stopping, 'paused turn cleanup');
  usage(await f.view(id), 'partial', [3, 4, 5, 6], 18);
  await f.restart(); usage(await f.view(id), 'partial', [3, 4, 5, 6], 18);
  await f.next(id);
  const agent = await f.finish(id, [result(counts(7, 8, 9, 10))]);
  usage(agent, 'partial', [10, 12, 14, 16], 52);
}));

test('a server restart interrupts working accounting without losing or counting its messages twice', async () => fixture(async f => {
  const id = await f.launch();
  await f.emit(id, [start('restart-interruption', counts(3, 4, 5, 1)), delta(6)]);
  await f.restart();
  const paused = await f.view(id);
  assert.equal(paused.state, 'paused'); assert.equal(paused.pause_reason, 'restart');
  usage(paused, 'partial', [3, 4, 5, 6], 18);
  await f.next(id);
  usage(await f.finish(id, [result(counts(7, 8, 9, 10))]), 'partial', [10, 12, 14, 16], 52);
}));

test('Codex absent usage never overwrites known counters and explicitly reported zeros remain valid', async () => fixture(async f => {
  const id = await f.launch('codex');
  let agent = await f.emit(id, [native({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 9 })]);
  usage(agent, 'provisional', [55, 5, 40, 9], 109);
  agent = await f.emit(id, [native(null), { type: 'event_msg', payload: { type: 'token_count', info: null } }, { type: 'turn.completed' }]);
  usage(agent, 'provisional', [55, 5, 40, 9], 109);
  agent = await f.finish(id); usage(agent, 'partial', [55, 5, 40, 9], 109);
  const zero = await f.launch('codex');
  agent = await f.finish(zero, [{ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 } }]);
  usage(agent, 'final', [0, 0, 0, 0], 0);
}));

test('Codex final session totals supersede duplicate live observations and reject late stale native snapshots', async () => fixture(async f => {
  const id = await f.launch('codex');
  const initial = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 9 };
  await f.emit(id, [native(initial), native(initial)], true);
  const final = { input_tokens: 180, cached_input_tokens: 70, cache_write_input_tokens: 0, output_tokens: 20 };
  await f.emit(id, [{ type: 'turn.completed', usage: final }]);
  await f.emit(id, [native(initial)], true);
  let agent = await f.finish(id); usage(agent, 'final', [110, 0, 70, 20], 200);
  await f.next(id);
  await f.emit(id, [native(final)], true);
  const next = { input_tokens: 240, cached_input_tokens: 95, cache_write_input_tokens: 0, output_tokens: 35 };
  agent = await f.finish(id, [{ type: 'turn.completed', usage: next }]);
  usage(agent, 'final', [145, 0, 95, 35], 275);
}));

test('Codex optional cache-write remains unknown without hiding a reported input-plus-output total', async () => fixture(async f => {
  const id = await f.launch('codex');
  const agent = await f.finish(id, [{ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 7 } }]);
  usage(agent, 'final', [null, null, 20, 7], 57);
}));

test('a final Codex snapshot does not retain an omitted breakdown from an older snapshot', async () => fixture(async f => {
  const id = await f.launch('codex');
  await f.emit(id, [native({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 9 })]);
  const agent = await f.finish(id, [{ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 50, output_tokens: 12 } }]);
  usage(agent, 'final', [null, null, 50, 12], 132);
}));

test('a reported zero Codex final total clears older positive breakdowns when those fields are omitted', async () => fixture(async f => {
  const id = await f.launch('codex');
  await f.emit(id, [native({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 9 })]);
  const agent = await f.finish(id, [{ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }]);
  usage(agent, 'final', [null, null, null, 0], 0);
}));

test('Codex adopts a reported new session and resumes its absolute totals without counting an old prefix twice', async () => fixture(async f => {
  const id = await f.launch('codex');
  usage(await f.finish(id, [{ type: 'turn.completed', usage: { input_tokens: 8, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2 } }]), 'final', [8, 0, 0, 2], 10);
  await f.next(id);
  assert.equal(f.runs(id)[1].session, f.runs(id)[0].session);
  const session = '44444444-4444-4444-8444-444444444444';
  await f.emit(id, [{ type: 'thread.started', thread_id: session }]);
  const second = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 };
  usage(await f.emit(id, [native(second)], true, session), 'provisional', [9, 0, 0, 3], 12);
  const agent = await f.finish(id, [{ type: 'turn.completed', usage: second }]);
  usage(agent, 'final', [9, 0, 0, 3], 12);
  await f.next(id);
  assert.equal(f.runs(id)[2].session, session, 'the next command resumes the newly reported native session');
  assert.equal((await f.view(id)).session, session);
  const latest = { input_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 };
  usage(await f.emit(id, [native(latest)], true), 'provisional', [10, 0, 0, 3], 13);
  usage(await f.finish(id, [{ type: 'turn.completed', usage: latest }]), 'final', [10, 0, 0, 3], 13);
}));
