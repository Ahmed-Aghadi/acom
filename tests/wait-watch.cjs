// Isolated wait/CLI integration; no provider clients or credentials.
// ACOM_BINARY=/path/to/development/acom node --test tests/wait-watch.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-wait-watch-'));
  const home = path.join(root, 'state'), bin = path.join(root, 'empty-bin');
  fs.mkdirSync(bin);
  const env = { ...process.env, ACOM_HOME: home, PATH: bin,
    CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete env[key];
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(binary, ['serve', '--port', String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  server.stderr.on('data', chunk => errors += chunk);
  const children = new Set();
  let db;
  const api = async (method, route, body, expected = 200) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(value)}`);
    return value;
  };
  const startCli = args => {
    const child = spawn(binary, args, { cwd: root, env: { ...env, ACOM_URL: url, ACOM_ID: '1' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
    const result = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signal) => {
        clearTimeout(timeout); children.delete(child);
        resolve({ status, signal, stdout, stderr });
      });
    });
    return { child, result };
  };
  const until = async check => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await check()) return;
      await sleep(20);
    }
    throw Error('Timed out waiting for isolated fixture');
  };
  try {
    await until(async () => {
      if (server.exitCode !== null) throw Error(`Server exited: ${errors}`);
      try { return (await fetch(url + '/overview')).ok; } catch { return false; }
    });
    for (const name of ['one', 'two']) {
      const folder = path.join(root, name); fs.mkdirSync(folder);
      await api('POST', '/projects', { path: folder });
    }
    db = new DatabaseSync(path.join(home, 'acom.db'));
    db.exec('PRAGMA busy_timeout=5000');
    const insert = db.prepare("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(?,?,?,'fixture','claude','claude-opus-5','medium','working',0,0)");
    insert.run(1, 1, 'observer'); insert.run(2, 1, 'peer'); insert.run(3, 2, 'foreign');
    await run({ api, db, startCli, until, insert });
  } finally {
    for (const child of children) child.kill('SIGKILL');
    db?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      const timeout = setTimeout(() => server.kill('SIGKILL'), 10000);
      server.kill('SIGTERM');
      await exited; clearTimeout(timeout);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('wait watches integrate CLI cursors, live descriptors, stable ACKs and detail chunks', { timeout: 45000 }, async t => {
  await fixture(async ({ api, db, startCli, until, insert }) => {
    const cursor = () => Number(db.prepare('SELECT coalesce(max(id),0) id FROM events').get().id);
    await t.test('CLI snapshot baseline and additive dynamic watch return promptly', async () => {
      const baseline = await startCli(['agents', '--event-cursor']).result;
      assert.equal(baseline.status, 0, baseline.stderr);
      const after = Number(baseline.stdout.match(/Event cursor: (\d+)/)?.[1]);
      assert.ok(Number.isSafeInteger(after));
      const waiting = startCli(['wait', '--agents', 'all', '--states', 'crashed', '--status-text', '--after', String(after), '--timeout', '5s']);
      await until(async () => (await api('GET', '/agents/1')).waiting?.agents === 'all');
      const detail = await api('GET', '/agents/1');
      assert.equal(detail.state, 'working'); assert.equal(detail.waiting.status_text, true);
      assert.equal(detail.waiting.expires_at - detail.waiting.started_at, 5);
      assert.deepEqual(detail.waiting.states, ['crashed']);
      const listed = (await api('GET', '/agents?project=1')).items.find(agent => agent.id === 1);
      assert.ok(listed.waiting.remaining_secs >= 0 && listed.waiting.remaining_secs <= 5);
      db.exec("BEGIN IMMEDIATE; UPDATE agents SET state='crashed' WHERE id=2; UPDATE agents SET state='working',status_text='peer has news' WHERE id=2; UPDATE agents SET state='crashed' WHERE id=3; COMMIT");
      insert.run(4, 1, 'future peer');
      db.exec("UPDATE agents SET state='crashed' WHERE id=4");
      const thread = await api('POST', '/threads', { project: 1, title: 'normal message', members: ['1'] });
      await api('POST', '/messages', { thread: thread.id, text: 'normal messages stay additive' });
      const result = await waiting.result;
      assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
      assert.match(result.stdout, /agent 2 agent.state/); assert.match(result.stdout, /peer has news/);
      assert.doesNotMatch(result.stdout, /agent 3 /);
      // A later event can belong to the next batch if the first update already returned.
      const later = await api('POST', '/wait/1', { timeout: 1, agents: 'all', states: ['crashed'], status_text: true });
      const combined = result.stdout + later.text;
      assert.match(combined, /agent 4 agent.state/); assert.match(combined, /new message.*user/);
      if (later.delivery_id) await api('POST', '/wait/1/ack', { delivery_id: later.delivery_id });
      assert.equal((await api('GET', '/agents/1')).waiting, null);
      assert.equal(db.prepare('SELECT count(*) n FROM marks WHERE agent_id=1').get().n, 0, 'notification ACK does not handle messages');
    });

    await t.test('pending batch survives changed filters and explicit reset', async () => {
      const after = cursor();
      db.exec("UPDATE agents SET state='idle' WHERE id=2");
      const first = await api('POST', '/wait/1', { timeout: 1, agents: [2], after });
      assert.match(first.text, /"to":"idle"/);
      const replay = await api('POST', '/wait/1', { timeout: 1, agents: [4], states: ['done'], after: cursor() });
      assert.deepEqual(replay, first);
      await api('POST', '/wait/1/ack', { delivery_id: first.delivery_id });
      const noDuplicate = await api('POST', '/wait/1', { timeout: 1, agents: [2] });
      assert.equal(noDuplicate.timed_out, true);
    });

    await t.test('invalid watch types, caller scopes and cursors fail without registering', async () => {
      for (const body of [{ agents: null }, { agents: ['2'] }, { agents: [2.5] }, { agents: [1] },
        { agents: [3] }, { agents: 'all', states: ['busy'] }, { agents: 'all', after: cursor() + 1 },
        { agents: 'all', after: -1 }, { agents: 'all', status_text: 'true' }, { states: ['crashed'] }]) {
        await api('POST', '/wait/1', { timeout: 1, ...body }, 400);
        assert.equal((await api('GET', '/agents/1')).waiting, null);
      }
    });

    await t.test('oversized waiting detail remains readable across countdown ticks', async () => {
      db.prepare('UPDATE agents SET task=? WHERE id=1').run('large ☃ task '.repeat(1200));
      const waiting = startCli(['wait', '--timeout', '20s']);
      await until(async () => (await api('GET', '/agents/1?max_bytes=65536')).waiting !== null);
      const stub = await api('GET', '/agents/1?max_bytes=512');
      assert.equal(stub.truncated, true);
      let offset = 0, text = '';
      do {
        const chunk = await api('GET', `/agents/1?offset=${offset}&version=${stub.version}&max_bytes=4096`);
        text += chunk.chunk;
        if (offset === 0) await sleep(1100);
        if (!chunk.has_more) break;
        offset = chunk.next_offset;
      } while (true);
      const detail = JSON.parse(text);
      assert.ok(detail.waiting); assert.equal(Object.hasOwn(detail.waiting, 'remaining_secs'), false);
      assert.equal(detail.task, 'large ☃ task '.repeat(1200));
      await api('POST', '/messages', { thread: 1, text: 'finish waiting' });
      assert.equal((await waiting.result).status, 0);
    });
  });
});
