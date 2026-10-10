// Explicitly opt in: this uses installed logins and spends provider usage.
// ACOM_MODEL_LIVE_TEST=1 node --test tests/models-live.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TURN_MS = 120000;
const sameModel = (a, b) => a === b || a?.replace(/-\d{8}$/, '') === b?.replace(/-\d{8}$/, '');
const selected = (harness, model, filter) => !filter || filter.split(',').some(part => part.trim() && `${harness}:${model}`.includes(part.trim()));
const lines = text => text.split('\n').flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const size = file => file && fs.existsSync(file) ? fs.statSync(file).size : 0;
function since(file, offset = 0) {
  if (!file || !fs.existsSync(file)) return [];
  return lines(fs.readFileSync(file).subarray(offset).toString('utf8'));
}
function evidence(harness, stdout, native) {
  const completion = harness === 'claude'
    ? stdout.some(e => e.type === 'result' && e.is_error === false && e.subtype === 'success')
    : stdout.some(e => e.type === 'turn.completed');
  const contexts = native.filter(e => e.type === 'turn_context').map(e => e.payload || {});
  const models = harness === 'claude'
    ? stdout.filter(e => e.type === 'assistant').map(e => e.message?.model).filter(Boolean)
    : contexts.map(e => e.model).filter(Boolean);
  const commands = harness === 'claude'
    ? stdout.flatMap(e => e.type === 'assistant' ? (e.message?.content || []).filter(c => c.type === 'tool_use').map(c => c.input?.command).filter(Boolean) : [])
    : stdout.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution' && e.item.exit_code === 0).map(e => e.item.command).filter(Boolean);
  return {
    completion,
    models: [...new Set(models)],
    model_source: harness === 'claude' ? 'stdout assistant.message.model' : 'native turn_context.payload.model',
    native_efforts: [...new Set(contexts.map(e => e.reasoning_effort || e.effort).filter(Boolean))],
    acom_commands: ['me', 'limits', 'done'].filter(command => commands.some(text => new RegExp(`\\bacom\\s+${command}\\b`).test(text))),
  };
}
function errorStatus(reason, state) {
  if (state === 'paused' && /limit|usage|quota|window/i.test(reason)) return 'quota';
  if (/model.*(?:not supported|unsupported|not found|does not exist|unavailable|not available|no access)|(?:unknown|unsupported|invalid) model|not supported.*(?:account|model)|do not have access.*model/i.test(reason)) return 'unavailable';
  return state === 'idle' || state === 'done' ? 'incomplete' : 'error';
}
function executable(name) {
  return (process.env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir || '.', name)).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
}
function readProcesses(file) {
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try { return db.prepare('SELECT id,pid FROM agents WHERE pid IS NOT NULL').all(); } finally { db.close(); }
}

test('process reader waits for a short exclusive SQLite write lock', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-model-reader-'));
  const file = path.join(root, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE agents(id INTEGER PRIMARY KEY,pid INTEGER); INSERT INTO agents VALUES(1,NULL)');
  db.close();
  const writer = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE; UPDATE agents SET pid=123 WHERE id=1');
    process.on('message', () => setTimeout(() => {
      db.exec('COMMIT'); db.close(); process.disconnect();
    }, 400));
    process.send('locked');
  `, file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = new Promise(resolve => writer.once('exit', resolve));
  let errors = '';
  writer.stderr.on('data', chunk => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => {
      writer.once('message', message => message === 'locked' ? resolve() : reject(Error(String(message))));
      writer.once('error', reject);
      writer.once('exit', () => reject(Error(errors || 'Writer exited before acquiring its lock')));
    });
    // Prove the lock exists before scheduling its release in the separate process.
    assert.throws(() => {
      const reader = new DatabaseSync(file, { readOnly: true });
      try { reader.prepare('SELECT id FROM agents').all(); } finally { reader.close(); }
    }, /database is locked/);
    writer.send('release');
    assert.deepEqual(readProcesses(file).map(row => ({ ...row })), [{ id: 1, pid: 123 }]);
    await exited;
    assert.equal(writer.exitCode, 0, errors);
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) { writer.kill('SIGKILL'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('model evidence needs actual completion and model metadata, not diagnostic items', () => {
  const warning = { type: 'item.completed', item: { type: 'error', message: 'warning' } };
  assert.equal(evidence('codex', [warning], []).completion, false);
  assert.deepEqual(evidence('codex', [warning, { type: 'turn.completed' }], [{ type: 'turn_context', payload: { model: 'gpt-6-sol', effort: 'max' } }]), {
    completion: true, models: ['gpt-6-sol'], model_source: 'native turn_context.payload.model', native_efforts: ['max'], acom_commands: [],
  });
  assert.equal(evidence('claude', [{ type: 'result', is_error: true, subtype: 'success' }], []).completion, false);
  assert.deepEqual(evidence('claude', [{ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001' } }], []).models, ['claude-haiku-4-5-20251001']);
  assert.deepEqual(evidence('codex', [{ type: 'item.completed', item: { type: 'command_execution', command: 'acom me && acom limits && acom done', exit_code: 0 } }], []).acom_commands, ['me', 'limits', 'done']);
  assert.deepEqual(evidence('codex', [{ type: 'item.completed', item: { type: 'command_execution', command: 'acom done', exit_code: 1 } }], []).acom_commands, []);
});

test('matrix filters and outcomes do not turn unsupported models into passes', () => {
  assert.ok(selected('codex', 'gpt-6-sol', 'claude-haiku,codex:gpt-6-sol'));
  assert.ok(!selected('claude', 'claude-opus-5', 'codex'));
  assert.ok(sameModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001'));
  assert.ok(!sameModel('gpt-6-sol', 'gpt-6-luna'));
  assert.equal(errorStatus('The model is not supported with this account', 'crashed'), 'unavailable');
  assert.equal(errorStatus('weekly usage limit reached', 'paused'), 'quota');
  assert.equal(errorStatus('shell permission denied', 'crashed'), 'error');
  assert.equal(errorStatus('database is locked', 'closed'), 'error');
});

test('all catalog models: tools, requested model, effort, and same-session reopen', { skip: process.env.ACOM_MODEL_LIVE_TEST !== '1' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-models-live-'));
  const state = path.join(root, 'state');
  const binary = fs.realpathSync(process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom'));
  const report = { started_at: new Date().toISOString(), root, binary, binary_modified_at: fs.statSync(binary).mtime.toISOString(), filter: process.env.ACOM_MODEL_FILTER || null, clients: {}, models: [] };
  const reportPath = path.join(root, 'results.json');
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  t.diagnostic(`Evidence preserved at ${root}`);
  save();
  for (const harness of ['claude', 'codex']) {
    const client = executable(harness);
    assert.ok(!fs.existsSync(path.join(path.dirname(binary), harness)), `Refusing a potentially shadowed ${harness} client beside acom`);
    const version = client ? spawnSync(client, ['--version'], { encoding: 'utf8', timeout: 10000 }) : null;
    report.clients[harness] = { executable: client || null, version: version?.stdout?.trim() || null, version_exit: version?.status ?? null };
  }
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ACOM_HOME: state };
  delete env.ACOM_ID; delete env.ACOM_URL;
  const stdout = fs.openSync(path.join(root, 'server.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(root, 'server.stderr.log'), 'a');
  const server = spawn(binary, ['serve', '--port', String(port)], { env, stdio: ['ignore', stdout, stderr] });
  let serverError;
  server.on('error', error => { serverError = error; });
  const alive = () => !serverError && server.exitCode === null && server.signalCode === null;
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const value = await res.json();
    if (!res.ok) throw Error(`${method} ${route}: ${value.error || JSON.stringify(value)}`);
    return value;
  };
  const processes = () => readProcesses(path.join(state, 'acom.db'));
  const stopped = id => !processes().some(p => id === undefined || p.id === id);
  const until = async (check, ms, label) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!alive()) throw Error(serverError?.message || 'Isolated server stopped; see server.stderr.log');
      const value = await check();
      if (value) return value;
      await sleep(200);
    }
    const error = Error(`Timed out: ${label}`); error.outcome = 'timeout'; throw error;
  };
  const stopAgent = async id => {
    const agent = await api(`/agents/${id}`);
    if (['working', 'idle', 'done'].includes(agent.state)) await api(`/agents/${id}/pause`, { locks: 'release' });
    await until(() => stopped(id), 15000, `agent ${id} termination`);
    if (agent.state !== 'closed' && agent.state !== 'replaced') await api(`/agents/${id}/close`, {});
  };
  const task = turn => `This is a tiny integration test, not a development task. Use a shell tool to ${turn === 1 ? "write exactly first-turn followed by one newline to proof.txt (printf 'first-turn\\n' > proof.txt)" : "append exactly second-turn followed by one newline to proof.txt (printf 'second-turn\\n' >> proof.txt)"} in this project. Run acom me and acom limits. Run acom done, then finish immediately. Do not launch helpers, change settings/model, inspect or edit other files, or do any other work. Only use the shell and the local acom commands needed for these steps.`;
  const inspectTurn = async (row, turn, effort, offsets) => {
    const agent = await until(async () => {
      const a = await api(`/agents/${row.agent_id}`);
      const agents = await api(`/agents?project=${row.project}`);
      if (agents.length !== 1) {
        const error = Error('Unexpected helper agent: stopping the isolated test'); error.fatal = true;
        try { await api('/pause-all', {}); } catch {}
        throw error;
      }
      return stopped(a.id) && !['working'].includes(a.state) ? a : false;
    }, TURN_MS, `${row.harness}:${row.model} turn ${turn}`);
    const raw = agent.output_log;
    const native = agent.conversation_history;
    const observed = evidence(row.harness, since(raw, offsets.stdout), since(native, offsets.native));
    const proof = path.join(row.project_path, 'proof.txt');
    const result = {
      state: agent.state, problem: agent.problem || null, pause_reason: agent.pause_reason || null,
      session: agent.session || null, requested_model: agent.model, requested_effort: agent.effort,
      turns: agent.turns, output_log: raw, conversation_history: native || null,
      stderr_log: path.join(state, 'logs', `${row.agent_id}.err`),
      stdout_offset: offsets.stdout, native_offset: offsets.native, ...observed,
      proof: fs.existsSync(proof) ? fs.readFileSync(proof, 'utf8') : null,
    };
    row[turn === 1 ? 'first' : 'second'] = result;
    save();
    if (agent.state !== 'closed') {
      const reason = agent.problem || agent.pause_reason || `Ended ${agent.state}, not closed by acom done`;
      const error = Error(reason); error.outcome = errorStatus(reason, agent.state); throw error;
    }
    assert.equal(result.turns, turn, 'Unexpected additional turn');
    assert.equal(result.requested_model, row.model);
    assert.equal(result.requested_effort, effort);
    assert.ok(result.session, 'No resumable session ID');
    assert.ok(native && fs.existsSync(native), 'No native conversation evidence');
    assert.ok(observed.completion, 'No successful completion event in this turn stdout');
    assert.deepEqual(observed.acom_commands, ['me', 'limits', 'done'], 'Missing acom identity/limits/done tool commands');
    assert.ok(observed.models.length, 'No actual model evidence for this turn');
    if (observed.models.some(model => !sameModel(model, row.model))) {
      const error = Error(`Actual model mismatch: ${observed.models.join(', ')}`); error.outcome = 'model_mismatch'; throw error;
    }
    for (const nativeEffort of observed.native_efforts) assert.equal(nativeEffort, effort, 'Native effort mismatch');
    assert.equal(result.proof, turn === 1 ? 'first-turn\n' : 'first-turn\nsecond-turn\n', 'Shell proof mismatch');
    return agent;
  };
  try {
    await until(async () => { try { return await api('/overview'); } catch { return false; } }, 15000, 'server startup');
    const overview = await api('/overview');
    report.model_catalog = overview.model_catalog;
    const models = Object.entries(overview.model_catalog).flatMap(([harness, catalog]) => catalog.map(model => ({ harness, ...model }))).filter(model => selected(model.harness, model.id, report.filter));
    assert.ok(models.length, 'Filter selected no catalog models');
    for (const model of models) {
      const row = { harness: model.harness, model: model.id, efforts: model.efforts, status: 'running', started_at: new Date().toISOString() };
      report.models.push(row); save();
      try {
        if (!report.clients[row.harness].executable) { const error = Error(`${row.harness} executable not installed`); error.outcome = 'unavailable'; throw error; }
        assert.ok(model.efforts.includes('medium'), 'Catalog model has no medium effort');
        row.project_path = path.join(root, `${row.harness}-${row.model}`);
        fs.mkdirSync(row.project_path);
        row.project = (await api('/projects', { path: row.project_path })).id;
        const settings = structuredClone(overview.settings);
        settings.auto_resume = false;
        settings.done_closes = true;
        settings.crash_retries = {};
        settings.usage_poll_secs = 3600;
        settings.limits.usage = {};
        settings.limits.active = { soft: null, hard: 1 };
        for (const h of Object.keys(settings.limits.active_per_harness)) settings.limits.active_per_harness[h] = { soft: null, hard: 1 };
        await api(`/projects/${row.project}/config`, { custom: settings }, 'PUT');
        const launch = await api('/agents', { project: row.project, harness: row.harness, model: row.model, effort: 'medium', task: task(1) });
        row.agent_id = launch.id;
        const first = await inspectTurn(row, 1, 'medium', { stdout: 0, native: 0 });
        const effort = model.efforts.includes('max') ? 'max' : 'medium';
        await api('/agent-config', { id: row.agent_id, effort });
        const offsets = { stdout: size(first.output_log), native: size(first.conversation_history) };
        row.second_offsets = offsets;
        const thread = await api('/threads', { project: row.project, title: 'Model integration reopen', members: [String(row.agent_id)] });
        await api('/messages', { thread: thread.id, text: task(2) });
        await sleep(300);
        const waiting = await api(`/agents/${row.agent_id}`);
        assert.equal(waiting.state, 'closed', 'A message woke a closed agent');
        assert.equal(waiting.turns, 1, 'A message started an unexpected turn');
        assert.ok(stopped(row.agent_id));
        await api(`/agents/${row.agent_id}/reopen`, {});
        const second = await inspectTurn(row, 2, effort, offsets);
        assert.equal(second.session, first.session, 'Reopen replaced the native session');
        row.status = 'pass';
      } catch (error) {
        row.status = error.outcome || errorStatus(error.message);
        row.reason = error.message.slice(0, 2000);
        // A launch can persist a crashed row before returning an error.
        if (!row.agent_id && row.project) {
          try { row.agent_id = (await api(`/agents?project=${row.project}`))[0]?.id; } catch {}
        }
        if (row.agent_id) {
          try {
            const a = await api(`/agents/${row.agent_id}`);
            row.failure = { state: a.state, problem: a.problem, pause_reason: a.pause_reason, session: a.session, output_log: a.output_log, conversation_history: a.conversation_history, stderr_log: path.join(state, 'logs', `${row.agent_id}.err`) };
          } catch {}
        }
        if (error.fatal) throw error;
      } finally {
        if (row.agent_id) {
          try { await stopAgent(row.agent_id); } catch (error) { row.cleanup_error = error.message; throw error; }
        }
        row.finished_at = new Date().toISOString(); save();
        t.diagnostic(JSON.stringify({ harness: row.harness, model: row.model, status: row.status, reason: row.reason || null }));
      }
    }
  } catch (error) {
    report.error = error.message; throw error;
  } finally {
    try {
      if (alive()) { await api('/pause-all', {}); await until(() => stopped(), 15000, 'all test harnesses stopped'); }
      else if (fs.existsSync(path.join(state, 'acom.db')) && !stopped()) throw Error('Server exited with test harnesses still running');
    } catch (error) {
      report.cleanup_error = error.message;
      // Only kill groups whose leader environment matches this isolated server/agent.
      for (const proc of processes()) {
        try {
          const vars = fs.readFileSync(`/proc/${proc.pid}/environ`).toString().split('\0');
          if (!vars.includes(`ACOM_URL=${url}`) || !vars.includes(`ACOM_ID=${proc.id}`)) throw Error('Cannot verify test process ownership');
          process.kill(-proc.pid, 'SIGKILL');
        } catch (failure) {
          if (failure.code !== 'ENOENT' && failure.code !== 'ESRCH') report.cleanup_error += `; agent ${proc.id}: ${failure.message}`;
        }
      }
      if (alive()) {
        try { await until(() => stopped(), 5000, 'killed test harnesses reaped'); } catch (failure) { report.cleanup_error += `; ${failure.message}`; }
      }
    }
    if (alive()) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      await Promise.race([exited, sleep(3000)]);
      if (alive()) { server.kill('SIGKILL'); await Promise.race([exited, sleep(3000)]); }
    }
    fs.closeSync(stdout); fs.closeSync(stderr);
    report.finished_at = new Date().toISOString();
    report.counts = report.models.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] || 0) + 1 }), {});
    save();
    t.diagnostic(`Results: ${JSON.stringify(report.counts)}; ${reportPath}`);
  }
  assert.ok(!report.cleanup_error, report.cleanup_error);
  const notPassed = report.models.filter(row => row.status !== 'pass');
  assert.equal(notPassed.length, 0, `Models not fully verified: ${notPassed.map(row => `${row.harness}:${row.model}=${row.status}`).join(', ')}. See ${reportPath}`);
});
