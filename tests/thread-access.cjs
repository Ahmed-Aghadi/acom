// Thread audience policies and membership controls; no model providers.
// cargo build && node --test tests/thread-access.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { spawn, spawnSync } = require('node:child_process');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');

async function isolated(run) {
  for (const client of ['codex', 'claude']) {
    assert.equal(fs.existsSync(path.join(path.dirname(fs.realpathSync(binary)), client)), false,
      `${client} must not shadow the empty fixture PATH`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-thread-access-'));
  const home = path.join(root, 'state'), bin = path.join(root, 'bin'), projectDir = path.join(root, 'project');
  for (const dir of [home, bin, projectDir]) fs.mkdirSync(dir);
  const env = { ...process.env, ACOM_HOME: home, CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'no-credentials'), PATH: bin };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete env[key];
  let server, url;
  const stop = async () => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    const timeout = setTimeout(() => server.kill('SIGKILL'), 10000);
    server.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(timeout); }
  };
  const start = async () => {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    url = `http://127.0.0.1:${port}`;
    server = spawn(binary, ['serve', '--port', String(port)], { cwd: projectDir, env,
      stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    server.stderr.on('data', chunk => errors += chunk);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (server.exitCode !== null || server.signalCode !== null) throw Error(`Server exited: ${errors}`);
      try { if ((await fetch(url + '/overview')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error(`Server startup timed out: ${errors}`);
  };
  const request = async (method, route, body) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const api = async (method, route, body, status = 200) => {
    const result = await request(method, route, body);
    assert.equal(result.status, status, `${method} ${route}: ${JSON.stringify(result.value).slice(0, 1000)}`);
    return result.value;
  };
  const denied = async (method, route, body) => {
    const result = await request(method, route, body);
    assert.ok([400, 403, 404, 409].includes(result.status),
      `${method} ${route} must deny access: ${JSON.stringify(result.value).slice(0, 1000)}`);
    assert.equal(typeof result.value.error, 'string');
    return result.value;
  };
  const db = action => {
    const connection = new DatabaseSync(path.join(home, 'acom.db'));
    try { connection.exec('PRAGMA busy_timeout=5000'); return action(connection); }
    finally { connection.close(); }
  };
  const cli = (args, agent) => spawnSync(binary, args, { cwd: projectDir, encoding: 'utf8',
    timeout: 15000, env: { ...env, ACOM_URL: url, ...(agent === undefined ? {} : { ACOM_ID: String(agent) }) } });
  try {
    await start();
    const project = await api('POST', '/projects', { path: projectDir });
    db(connection => {
      const insert = connection.prepare("INSERT INTO agents(id,project,name,grp,task,harness,model,effort,state,launched_by,launched_at) VALUES(?,?,?,'team','closed access fixture','codex','gpt-6-sol','medium','closed',0,0)");
      for (let id = 1; id <= 4; id++) insert.run(id, project.id, `fixture ${id}`);
      const later = Math.floor(Date.now() / 1000) + 3600;
      for (const provider of ['claude', 'codex']) connection.prepare('UPDATE usage_checks SET next_check=? WHERE provider=?').run(later, provider);
    });
    const create = (extra = {}) => api('POST', '/threads', {
      project: project.id, title: 'audience fixture', members: ['1'], include_user: true, ...extra,
    });
    await run({ api, denied, db, cli, create, project, home, start, stop });
  } finally {
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('thread access and removal remain consistent across API, CLI and restart', async t => {
  await isolated(async f => {
    const { api, denied, db, cli, create, project } = f;
    const metadata = (id, agent) => api('GET', `/threads/${id}/metadata?agent=${agent}`);
    const members = (id, ids, agent = 0, remove = false) => api('POST',
      `/threads/${id}/members${remove ? '/remove' : ''}`, { agent, members: ids.map(String) });
    const send = (id, text, agent = 0) => api('POST', '/messages', { agent, thread: id, text });
    const list = (viewer, member) => api('GET', `/threads?project=${project.id}&viewer=${viewer}${member == null ? '' : `&agent=${member}`}`);
    const events = id => db(connection => connection.prepare('SELECT id,kind,agent FROM events WHERE thread=? ORDER BY id').all(id));
    const state = (agent, next) => db(connection => connection.prepare('UPDATE agents SET state=? WHERE id=?').run(next, agent));

    await t.test('default threads stay public/open and policy booleans are strict', async () => {
      const open = await create();
      assert.equal((await metadata(open.id, 2)).private, false);
      assert.equal((await metadata(open.id, 2)).joinable, true);
      const restricted = await create({ private: true, joinable: true });
      assert.equal((await metadata(restricted.id, 1)).private, true);
      assert.equal((await metadata(restricted.id, 1)).joinable, false);
      const before = db(connection => connection.prepare('SELECT count(*) n FROM threads').get().n);
      for (const field of ['private', 'joinable', 'include_user']) for (const value of [null, 0, 1, 'true', [], {}]) {
        await api('POST', '/threads', { project: project.id, title: 'invalid policy', [field]: value }, 400);
      }
      for (const agent of [null, '1', 1.5, true, -1, []]) {
        await api('POST', '/threads', { project: project.id, title: 'invalid actor', agent }, 400);
        await api('POST', `/threads/${restricted.id}/members`, { agent, members: ['2'] }, 400);
      }
      assert.deepEqual((await metadata(restricted.id, 0)).members, [0, 1]);
      assert.equal(db(connection => connection.prepare('SELECT count(*) n FROM threads').get().n), before);
      for (const flags of [{ private: true }, { joinable: false }]) {
        await denied('POST', '/threads', { project: project.id, title: 'invalid live audience', watch: ['closed'], ...flags });
      }
      for (const route of [`/threads?viewer=-1`, `/history?viewer=-1`, `/history/1?viewer=-1`]) {
        await api('GET', route, undefined, 400);
      }
    });

    await t.test('private outsiders cannot list or read messages, including record chunks', async () => {
      const secret = 'PRIVATE CONTENT MUST NOT LEAK';
      const thread = await create({ title: 'private hidden title', private: true });
      const message = await send(thread.id, secret + ' x'.repeat(2000));
      assert.ok((await list(1)).items.some(item => item.id === thread.id));
      for (const member of [undefined, 0, 1]) assert.ok(!(await list(2, member)).items.some(item => item.id === thread.id));
      for (const route of [`/threads/${thread.id}`, `/threads/${thread.id}/metadata`,
        `/threads/${thread.id}/messages`, `/messages/${message.id}`]) {
        for (const chunk of ['', '&offset=0&max_bytes=512', '&offset=10&max_bytes=512']) {
          const response = await denied('GET', `${route}?agent=2${chunk}`);
          assert.ok(!JSON.stringify(response).includes(secret));
        }
      }
      const preview = await api('GET', `/messages/${message.id}?agent=1&max_bytes=512`);
      assert.equal(preview.truncated, true);
      assert.equal(preview.next_offset, 0);
      const chunk = await api('GET', `/messages/${message.id}?agent=1&max_bytes=512&offset=0&version=${preview.version}`);
      assert.equal(typeof chunk.chunk, 'string');
      assert.equal((await api('GET', `/messages/${message.id}?agent=0`)).text.startsWith(secret), true);
    });

    await t.test('public closed threads remain readable without silently joining on send', async () => {
      const thread = await create({ joinable: false });
      const message = await send(thread.id, 'readable public message');
      assert.ok((await list(2)).items.some(item => item.id === thread.id));
      assert.equal((await api('GET', `/messages/${message.id}?agent=2`)).text, 'readable public message');
      await metadata(thread.id, 2);
      const before = events(thread.id);
      await denied('POST', '/messages', { agent: 2, thread: thread.id, text: 'must not self-join' });
      await denied('POST', `/threads/${thread.id}/members`, { agent: 2, members: ['2'] });
      assert.deepEqual(events(thread.id), before);
      assert.deepEqual((await metadata(thread.id, 0)).members, [0, 1]);
      await send(thread.id, 'current member can post', 1);
    });

    await t.test('only the local user may invite to restricted threads or remove other agents', async () => {
      for (const flags of [{ private: true }, { joinable: false }]) {
        const thread = await create(flags);
        await denied('POST', `/threads/${thread.id}/members`, { agent: 1, members: ['2'] });
        await denied('POST', `/threads/${thread.id}/members/remove`, { agent: 1, members: ['0'] });
        await denied('POST', `/threads/${thread.id}/members/remove`, { agent: 2, members: ['1'] });
        assert.deepEqual((await metadata(thread.id, 0)).members, [0, 1]);
        await members(thread.id, [2]);
        assert.deepEqual((await metadata(thread.id, 2)).members, [0, 1, 2]);
        await members(thread.id, [2], 0, true);
        assert.deepEqual((await metadata(thread.id, 0)).members, [0, 1]);
        await denied('POST', '/messages', { agent: 2, thread: thread.id, text: 'removed cannot post' });
      }
      const open = await create();
      await denied('POST', `/threads/${open.id}/members/remove`, { agent: 1, members: ['0'] });
      await members(open.id, [1], 1, true);
      assert.deepEqual((await metadata(open.id, 0)).members, [0]);
    });

    await t.test('the local user can manage private threads without joining', async () => {
      const thread = await create({ private: true, include_user: false });
      assert.deepEqual((await metadata(thread.id, 0)).members, [1]);
      assert.ok((await list(0)).items.some(item => item.id === thread.id));
      await members(thread.id, [2]);
      await api('POST', `/threads/${thread.id}/user`, { joined: true });
      await api('POST', `/threads/${thread.id}/user`, { joined: false });
      assert.deepEqual((await metadata(thread.id, 0)).members, [1, 2]);
      await denied('POST', `/threads/${thread.id}/user`, { agent: 2, joined: true });
    });

    await t.test('removal revokes old private inbox access but preserves marks and membership gaps', async () => {
      const thread = await create({ private: true });
      const inside = await send(thread.id, 'member message');
      await api('POST', '/marks', { agent: 1, ids: [inside.id], mark: 'handled' });
      assert.ok((await api('GET', '/inbox/1?mark=handled')).items.some(item => item.id === inside.id));
      const snapshot = await api('GET', '/inbox/1?mark=handled');
      await members(thread.id, [1], 0, true);
      const after = await api('GET', `/inbox/1?mark=handled&since=${snapshot.revision}`);
      assert.notEqual(after.unchanged, true);
      assert.ok(!after.items.some(item => item.id === inside.id));
      for (const route of [`/messages/${inside.id}?agent=1`, `/threads/${thread.id}?agent=1`]) await denied('GET', route);
      await denied('POST', '/marks', { agent: 1, ids: [inside.id], mark: 'in-progress' });
      const outside = await send(thread.id, 'outside membership message');
      await members(thread.id, [1]);
      const later = await send(thread.id, 'member again');
      assert.equal((await api('GET', `/messages/${inside.id}?agent=1`)).mark, 'handled');
      assert.equal((await api('GET', `/messages/${inside.id}?agent=1`)).outside_membership, false);
      assert.equal((await api('GET', `/messages/${outside.id}?agent=1`)).outside_membership, true);
      assert.equal((await api('GET', `/messages/${later.id}?agent=1`)).outside_membership, false);
    });

    await t.test('private history and receipts cannot be bypassed through another agent filter', async () => {
      const thread = await create({ title: 'private event title', private: true });
      await send(thread.id, 'private event message');
      const receipt = db(connection => Number(connection.prepare("INSERT INTO events(project,at,kind,actor,agent,thread,details) VALUES(?,0,'command.receipt','user',0,?,?)")
        .run(project.id, thread.id, JSON.stringify({ response: { members: [0, 1], private_note: 'private receipt marker' } })).lastInsertRowid));
      for (const route of [`/history?project=${project.id}&viewer=2`,
        `/history?project=${project.id}&viewer=2&agent=1`, `/history?project=${project.id}&viewer=2&agent=0`]) {
        const history = await api('GET', route);
        assert.ok(history.events.every(event => event.thread !== thread.id));
        assert.ok(!JSON.stringify(history).includes('private event title'));
      }
      await denied('GET', `/history?project=${project.id}&viewer=2&thread=${thread.id}`);
      for (const event of events(thread.id)) {
        await denied('GET', `/history/${event.id}?project=${project.id}&viewer=2`);
        await api('GET', `/history/${event.id}?project=${project.id}&viewer=1`);
      }
      await denied('GET', `/receipts/${receipt}?agent=2`);
      await denied('GET', `/receipts/${receipt}?agent=2&offset=0&max_bytes=512`);
      assert.equal((await api('GET', `/receipts/${receipt}?agent=1`)).details.response.private_note, 'private receipt marker');
      const peer = await api('GET', '/agents/1?agent=2');
      assert.ok(!peer.threads.some(item => item.id === thread.id));
      assert.equal(peer.output_log, null);
      assert.equal(peer.conversation_history, null);
      assert.ok((await api('GET', '/agents/1?agent=1')).threads.some(item => item.id === thread.id));
      assert.ok((await api('GET', '/agents/1?agent=0')).threads.some(item => item.id === thread.id));
    });

    await t.test('peer output logs are owner/self only', async () => {
      fs.writeFileSync(path.join(f.home, 'logs', '1.txt'), 'private output log marker\n');
      await denied('GET', '/agents/1/log?agent=2');
      assert.match((await api('GET', '/agents/1/log?agent=1')).text, /private output log marker/);
      assert.match((await api('GET', '/agents/1/log?agent=0')).text, /private output log marker/);
    });

    await t.test('live removals persist through state/group changes and restart; owner restores only matching agents', async () => {
      const live = await create({ members: [], watch: ['closed', 'group:team'] });
      assert.deepEqual((await metadata(live.id, 0)).members, [0, 1, 2, 3, 4]);
      await members(live.id, [1], 0, true);
      await members(live.id, [1], 0, true);
      assert.equal(events(live.id).filter(event => event.kind === 'thread.left' && event.agent === 1).length, 1);
      state(1, 'paused'); state(1, 'closed');
      db(connection => { connection.prepare('UPDATE agents SET grp=? WHERE id=1').run('elsewhere'); connection.prepare('UPDATE agents SET grp=? WHERE id=1').run('team'); });
      assert.ok(!(await metadata(live.id, 0)).members.includes(1));
      await members(live.id, [2], 2, true);
      state(2, 'paused'); state(2, 'closed');
      assert.ok(!(await metadata(live.id, 0)).members.includes(2));
      state(1, 'paused');
      const before = events(live.id);
      await denied('POST', `/threads/${live.id}/members`, { agent: 0, members: ['1', '2'] });
      assert.deepEqual(events(live.id), before, 'a mixed invalid restore must not partially add a matching member');
      assert.ok(!(await metadata(live.id, 0)).members.includes(2));
      state(1, 'closed');
      await f.stop(); await f.start();
      assert.ok(!(await metadata(live.id, 0)).members.includes(1));
      assert.ok(!(await metadata(live.id, 0)).members.includes(2));
      state(1, 'paused'); state(1, 'closed');
      assert.ok(!(await metadata(live.id, 0)).members.includes(1));
      await members(live.id, [1, 2]);
      await members(live.id, [1, 2]);
      assert.deepEqual((await metadata(live.id, 0)).members, [0, 1, 2, 3, 4]);
      assert.equal(events(live.id).filter(event => event.kind === 'thread.joined' && event.agent === 1).length, 2);
      state(1, 'paused'); state(1, 'closed');
      assert.ok((await metadata(live.id, 0)).members.includes(1));
      db(connection => connection.prepare("INSERT INTO agents(id,project,name,grp,task,harness,model,effort,state,launched_by,launched_at) VALUES(5,?,'new fixture','team','closed fixture','codex','gpt-6-sol','medium','closed',0,0)").run(project.id));
      assert.ok((await metadata(live.id, 0)).members.includes(5), 'ordinary new matching agents still join live threads');
    });

    await t.test('failed removal rolls back exclusion, intervals and history together', async () => {
      const live = await create({ members: [], watch: ['closed'] });
      const before = events(live.id);
      db(connection => connection.exec(`CREATE TRIGGER injected_remove_failure BEFORE DELETE ON members WHEN OLD.thread_id=${live.id} AND OLD.agent_id=1 BEGIN SELECT RAISE(ABORT,'atomic removal fixture'); END;`));
      try {
        await api('POST', `/threads/${live.id}/members/remove`, { agent: 0, members: ['1'] }, 500);
        assert.deepEqual(events(live.id), before);
        assert.ok((await metadata(live.id, 0)).members.includes(1));
      } finally { db(connection => connection.exec('DROP TRIGGER injected_remove_failure')); }
      state(1, 'paused'); state(1, 'closed');
      assert.ok((await metadata(live.id, 0)).members.includes(1), 'failed exclusion must not survive rollback');
    });

    await t.test('restart refreshes persisted live triggers and keeps threads without a policy public', async () => {
      const old = await create();
      const live = await create({ members: [], watch: ['closed'] });
      await members(live.id, [1], 0, true);
      await f.stop();
      db(connection => {
        connection.prepare('DELETE FROM thread_access WHERE thread_id=?').run(old.id);
        // Simulate the previous audience trigger, which did not know exclusions.
        connection.exec(`DROP TRIGGER agent_audience;
          CREATE TRIGGER agent_audience AFTER UPDATE OF state ON agents BEGIN
            INSERT OR IGNORE INTO members(thread_id,agent_id,last_notified)
              SELECT t.id,NEW.id,0 FROM threads t JOIN thread_filters f ON f.thread_id=t.id
              WHERE t.project=NEW.project AND EXISTS(SELECT 1 FROM json_each(f.states) WHERE value=NEW.state);
          END;`);
      });
      await f.start();
      assert.equal((await metadata(old.id, 2)).private, false);
      assert.equal((await metadata(old.id, 2)).joinable, true);
      await send(old.id, 'old public thread still self-joins', 2);
      state(1, 'paused'); state(1, 'closed');
      assert.ok(!(await metadata(live.id, 0)).members.includes(1), 'saved legacy trigger must not bypass exclusions after restart');
    });

    await t.test('open fixed threads retain ordinary self-joining and selector invitations', async () => {
      const thread = await create();
      await send(thread.id, 'open thread self-join', 2);
      assert.ok((await metadata(thread.id, 0)).members.includes(2));
      await api('POST', `/threads/${thread.id}/members`, { agent: 1, members: ['group:team'] });
      assert.ok((await metadata(thread.id, 0)).members.includes(3));
      const byAgent = await api('POST', '/threads', { agent: 2, title: 'agent private creator', private: true, members: ['1'] });
      assert.deepEqual((await metadata(byAgent.id, 2)).members, [1, 2]);
    });

    await t.test('coordination counts do not advertise inaccessible private messages', async () => {
      db(connection => connection.prepare("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(6,?,'count fixture','closed fixture','codex','gpt-6-sol','medium','closed',0,0)").run(project.id));
      const thread = await create({ private: true, members: ['6'] });
      await send(thread.id, 'revoked pending private message');
      await members(thread.id, [6], 0, true);
      assert.deepEqual((await api('GET', '/inbox/6')).items, []);
      // A database-only working fixture permits the notification endpoint; no
      // native process or provider launch is involved.
      state(6, 'working');
      try {
        const hook = await api('POST', '/hook/6', {});
        assert.doesNotMatch(hook.text, /\bpending \d/);
        assert.doesNotMatch(hook.text, /revoked pending private message/);
      } finally { state(6, 'closed'); }
    });

    await t.test('CLI private flags and caller context preserve server access rules', async () => {
      const created = cli(['thread', 'new', '--title', 'CLI private marker', '--members', '1', '--private']);
      assert.equal(created.status, 0, created.stderr);
      const id = Number(created.stdout.match(/thread (\d+)/)?.[1]);
      assert.ok(id > 0, created.stdout);
      const sent = cli(['send', '--thread', String(id), 'CLI secret body']);
      assert.equal(sent.status, 0, sent.stderr);
      for (const args of [['thread', 'read', String(id)], ['thread', 'details', String(id)],
        ['send', '--thread', String(id), 'cannot self-join'], ['thread', 'add', String(id), '2']]) {
        const result = cli(args, 2);
        assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout} ${result.stderr}`);
        assert.doesNotMatch(result.stdout, /CLI secret body/);
      }
      const listing = cli(['threads'], 2);
      assert.equal(listing.status, 0, listing.stderr);
      assert.doesNotMatch(listing.stdout, /CLI private marker/);
      const noJoin = cli(['thread', 'new', '--title', 'CLI public invite-only', '--members', '1', '--no-join']);
      assert.equal(noJoin.status, 0, noJoin.stderr);
      const publicId = Number(noJoin.stdout.match(/thread (\d+)/)?.[1]);
      assert.ok(publicId > 0, noJoin.stdout);
      assert.equal(cli(['thread', 'read', String(publicId)], 2).status, 0);
      assert.equal(cli(['send', '--thread', String(publicId), 'not invited'], 2).status, 1);
      for (const args of [['history', '--all-agents'], ['history', '--agent', '0']]) {
        const result = cli(args, 2);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout, /CLI private marker/);
      }
      const removed = cli(['thread', 'remove', String(id), '1']);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(cli(['thread', 'read', String(id)], 1).status, 1);
      const selfRemove = cli(['thread', 'remove', String(id), '0'], 2);
      assert.equal(selfRemove.status, 1);
    });
  });
});
