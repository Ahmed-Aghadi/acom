// On-demand storage regressions. Uses disposable data and an empty provider PATH.
// ACOM_BINARY=/path/to/acom node --test tests/storage.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');
const allocated = file => Number(fs.lstatSync(file, { bigint: true }).blocks * 512n);
function allocatedTree(root) {
  const seen = new Set();
  const walk = file => {
    const stat = fs.lstatSync(file, { bigint: true }), key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) return 0;
    seen.add(key);
    return Number(stat.blocks * 512n) + (stat.isDirectory() ? fs.readdirSync(file).reduce((bytes, name) => bytes + walk(path.join(file, name)), 0) : 0);
  };
  return walk(root);
}

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-storage-api-'));
  const home = path.join(root, 'data'), userHome = path.join(root, 'user');
  const projectDirs = ['one', 'two', 'empty'].map(name => path.join(root, name));
  for (const dir of [home, userHome, path.join(root, 'empty-bin'), ...projectDirs]) fs.mkdirSync(dir);
  const env = { ...process.env, HOME: userHome, ACOM_HOME: home, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), PATH: path.join(root, 'empty-bin') };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(binary, ['serve', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => errors += chunk);
  const api = async (route, status = 200, body) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}`);
    return value;
  };
  let db;
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      if (child.exitCode !== null) throw Error(`Storage fixture exited: ${errors}`);
      try { if ((await fetch(base + '/catalog')).ok) break; } catch {}
      if (Date.now() > deadline) throw Error(`Storage fixture startup timed out: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const projects = [];
    for (const project of projectDirs) projects.push(await api('/projects', 200, { path: project }));
    db = new DatabaseSync(path.join(home, 'acom.db'));
    const insert = db.prepare('INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    insert.run(11, projects[0].id, 'First', 'Never launched', 'codex', 'gpt-6-sol', 'medium', 'closed', 0, 0);
    insert.run(22, projects[1].id, 'Second', 'Never launched', 'claude', 'claude-opus-5-5', 'high', 'closed', 0, 0);
    const logs = path.join(home, 'logs'); fs.mkdirSync(logs, { recursive: true });
    const snapshot = () => Object.fromEntries(['projects', 'agents', 'configs', 'activity', 'events', 'notices', 'locks', 'messages', 'threads', 'members', 'marks', 'user_reads', 'summary_cursors', 'update_deliveries'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    await run({ root, home, logs, projects, projectDirs, api, snapshot, db });
  } finally {
    db?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('storage reports are explicit fixed-shape reads and leave business state unchanged', async () => fixture(async ({ home, projects, api, snapshot }) => {
  const before = snapshot(), requested = Math.floor(Date.now() / 1000);
  const report = await api(`/storage?project=${projects[0].id}`);
  assert.deepEqual(Object.keys(report).sort(), ['home', 'project', 'started_at', 'completed_at', 'complete', 'limited', 'entries', 'skipped', 'bytes'].sort());
  assert.equal(report.home, home); assert.equal(report.project, projects[0].id);
  assert.equal(report.complete, true); assert.equal(report.limited, false); assert.equal(report.skipped, 0);
  assert.ok(Number.isSafeInteger(report.entries) && report.entries > 0);
  assert.ok(report.started_at >= requested && report.completed_at >= report.started_at && report.completed_at <= Date.now() / 1000);
  assert.equal(report.bytes.project_logs, 0);
  for (const value of Object.values(report.bytes)) assert.ok(Number.isSafeInteger(value) && value >= 0);
  assert.equal(report.bytes.total, report.bytes.all_project_logs + report.bytes.database + report.bytes.other);
  assert.ok(report.bytes.database > 0);
  const global = await api('/storage');
  assert.equal(global.project, null); assert.equal(global.bytes.project_logs, null);
  assert.deepEqual(snapshot(), before, 'measuring does not create history, acknowledge messages, change config or start agents');
}));

test('storage query validation rejects unknown, repeated and unavailable scope without mutations', async () => fixture(async ({ projects, api, snapshot }) => {
  const before = snapshot();
  for (const query of ['project=', 'project=0', 'project=-1', 'project=1.5', 'project=null', 'project=abc', 'project=9223372036854775808', `project=${projects[0].id}&project=${projects[0].id}`, 'limit=1', 'max_bytes=4096', 'offset=0', 'version=x', 'before=1', 'after=0', 'agent=11', 'project=%ZZ']) {
    const error = await api('/storage?' + query, 400);
    assert.match(error.error, /project|query|parameter|encoding|unknown|invalid/i, query);
  }
  await api('/storage?project=999999', 404);
  assert.deepEqual(snapshot(), before);
}));

test('storage uses allocated blocks, categorizes registered root logs, and never reads their contents', async () => fixture(async ({ home, logs, projects, projectDirs, api, snapshot }) => {
  const first = path.join(logs, '11.jsonl'), readable = path.join(logs, '11.txt'), second = path.join(logs, '22.err');
  const fd = fs.openSync(first, 'w');
  try { fs.ftruncateSync(fd, 32 * 1024 * 1024); fs.writeSync(fd, 'tail', 32 * 1024 * 1024 - 4); } finally { fs.closeSync(fd); }
  fs.writeFileSync(readable, 'Unreadable output is still measured by metadata.');
  fs.linkSync(readable, path.join(logs, '11.err'));
  fs.writeFileSync(second, Buffer.alloc(7000, 65));
  fs.writeFileSync(path.join(logs, '999.jsonl'), 'Orphan log belongs to Other.');
  fs.writeFileSync(path.join(logs, '11.jsonl.backup'), 'Not an agent output extension.');
  const nested = path.join(logs, 'old'); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, '11.jsonl'), 'Nested logs are not canonical agent logs.');
  fs.writeFileSync(path.join(home, 'acom.db.backup'), 'Not a database sidecar.');
  fs.writeFileSync(path.join(projectDirs[0], 'not-acom-data'), Buffer.alloc(1024 * 1024, 66));
  const old = new Date('2001-01-01T00:00:00Z'); fs.utimesSync(first, old, old); fs.utimesSync(readable, old, old);
  fs.chmodSync(readable, 0);
  const atimes = [first, readable].map(file => fs.statSync(file, { bigint: true }).atimeNs);
  const firstBytes = allocated(first) + allocated(readable), secondBytes = allocated(second), before = snapshot();
  assert.ok(allocated(first) < fs.statSync(first).size / 100, 'fixture is actually sparse');
  const one = await api(`/storage?project=${projects[0].id}`);
  assert.equal(one.complete, true); assert.equal(one.skipped, 0);
  assert.equal(one.bytes.project_logs, firstBytes, 'hardlinked outputs count once');
  assert.equal(one.bytes.all_project_logs, firstBytes + secondBytes);
  assert.equal(one.bytes.total, one.bytes.all_project_logs + one.bytes.database + one.bytes.other);
  assert.equal(one.bytes.total, allocatedTree(home), 'all files and directory blocks are included exactly once');
  const sharedBytes = fs.readdirSync(home).filter(name => ['acom.db', 'acom.db-wal', 'acom.db-shm', 'acom.db-journal'].includes(name)).reduce((n, name) => n + allocated(path.join(home, name)), 0);
  assert.equal(one.bytes.database, sharedBytes, 'SQLite sidecars are shared database storage');
  const two = await api(`/storage?project=${projects[1].id}`), empty = await api(`/storage?project=${projects[2].id}`);
  assert.equal(two.bytes.project_logs, secondBytes); assert.equal(empty.bytes.project_logs, 0);
  assert.deepEqual([first, readable].map(file => fs.statSync(file, { bigint: true }).atimeNs), atimes, 'no log contents read');
  assert.deepEqual(snapshot(), before);
}));

test('storage does not traverse symlinked log files, directories or external provider histories', async () => fixture(async ({ root, logs, projects, api }) => {
  const outside = path.join(root, 'native-history'); fs.mkdirSync(outside);
  const native = path.join(outside, 'conversation.jsonl'); fs.writeFileSync(native, Buffer.alloc(4 * 1024 * 1024, 65));
  const old = new Date('2001-01-01T00:00:00Z'); fs.utimesSync(outside, old, old); fs.utimesSync(native, old, old);
  fs.symlinkSync(native, path.join(logs, '11.jsonl'));
  fs.symlinkSync(outside, path.join(logs, 'native'));
  const atimes = [outside, native].map(file => fs.statSync(file, { bigint: true }).atimeNs);
  const report = await api(`/storage?project=${projects[0].id}`);
  assert.equal(report.bytes.project_logs, allocated(path.join(logs, '11.jsonl')));
  assert.equal(report.bytes.all_project_logs, report.bytes.project_logs, 'only the link itself, not its target, can be charged');
  assert.ok(report.bytes.total < allocated(native), 'external history is not charged to acom');
  assert.deepEqual([outside, native].map(file => fs.statSync(file, { bigint: true }).atimeNs), atimes, 'external trees and files are not opened');
}));
