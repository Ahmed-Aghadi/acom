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
  const databases=[];
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
    const projectHomes=projects.map(project=>path.join(home,'projects',project.id));
    const cores=projectHomes.map(projectHome=>{const db=new DatabaseSync(path.join(projectHome,'acom.db'));databases.push(db);return db;});
    const shared=new DatabaseSync(path.join(home,'global','shared.db'));databases.push(shared);
    const registry=new DatabaseSync(path.join(home,'global','acom.db'));databases.push(registry);
    cores[0].prepare('INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(11,1,?,?,?,?,?,?,0,0)').run('First','Never launched','codex','gpt-6-sol','medium','closed');
    cores[1].prepare('INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(11,1,?,?,?,?,?,?,0,0)').run('Second','Never launched','claude','claude-opus-5-5','high','closed');
    const logs=projectHomes.map(projectHome=>path.join(projectHome,'logs'));
    const readTables=(db,tables)=>Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const snapshot=()=>({projects:cores.map(db=>readTables(db,['projects','agents','activity','events','notices','locks','messages','threads','members','marks','user_reads','summary_cursors','update_deliveries'])),shared:readTables(shared,['configs','config_uses']),registry:readTables(registry,['workspace_projects'])});
    await run({root,home,logs,projectHomes,projects,projectDirs,api,snapshot,cores,shared,registry});
  } finally {
    for(const db of databases)db.close();
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
  assert.equal(report.bytes.total, categoryTotal(report.bytes));
  assert.ok(report.bytes.database > 0);
  const global = await api('/storage');
  assert.equal(global.project, null);for(const field of ['project','project_core','project_logs','project_metrics','project_native'])assert.equal(global.bytes[field],null);
  assert.deepEqual(snapshot(), before, 'measuring does not create history, acknowledge messages, change config or start agents');
}));

test('storage query validation rejects unknown, repeated and unavailable scope without mutations', async () => fixture(async ({ projects, api, snapshot }) => {
  const before = snapshot();
  for (const query of ['project=', 'project=0', 'project=-1', 'project=1.5', 'project=null', 'project=abc', 'project=9223372036854775808', `project=${projects[0].id}&project=${projects[0].id}`, 'limit=1', 'max_bytes=4096', 'offset=0', 'version=x', 'before=1', 'after=0', 'agent=11', 'project=%ZZ']) {
    const error = await api('/storage?' + query, 400);
    assert.match(error.error, /project|query|parameter|encoding|unknown|invalid/i, query);
  }
  await api('/storage?project=99999999-9999-4999-8999-999999999999', 404);
  assert.deepEqual(snapshot(), before);
}));

test('storage uses allocated blocks, project-local roots and independent categories without reading contents', async () => fixture(async ({ home, logs, projectHomes, projects, projectDirs, api, snapshot }) => {
  const first = path.join(logs[0], '11.jsonl'), readable = path.join(logs[0], '11.txt'), second = path.join(logs[1], '11.err');
  const fd = fs.openSync(first, 'w');
  try { fs.ftruncateSync(fd, 32 * 1024 * 1024); fs.writeSync(fd, 'tail', 32 * 1024 * 1024 - 4); } finally { fs.closeSync(fd); }
  fs.writeFileSync(readable, 'Unreadable output is still measured by metadata.');
  fs.linkSync(readable, path.join(logs[0], '11.err'));
  fs.writeFileSync(second, Buffer.alloc(7000, 65));
  const orphan=path.join(logs[0], '999.jsonl');fs.writeFileSync(orphan, 'A canonical log remains project data even when its agent record is absent.');
  fs.writeFileSync(path.join(logs[0], '11.jsonl.backup'), 'Not an agent output extension.');
  const nested = path.join(logs[0], 'old'); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, '11.jsonl'), 'Nested logs are not canonical agent logs.');
  fs.writeFileSync(path.join(home, 'acom.db.backup'), 'Not a database sidecar.');
  const nativeRoot=path.join(projectHomes[0],'native');fs.mkdirSync(nativeRoot,{recursive:true});const native=path.join(nativeRoot,'11.jsonl');fs.writeFileSync(native,'A synthetic archived native transcript.');
  const trash=path.join(home,'trash','retained');fs.mkdirSync(trash);fs.writeFileSync(path.join(trash,'metrics.db'),'Synthetic retained optional history.');
  fs.writeFileSync(path.join(projectDirs[0], 'not-acom-data'), Buffer.alloc(1024 * 1024, 66));
  const old = new Date('2001-01-01T00:00:00Z'); fs.utimesSync(first, old, old); fs.utimesSync(readable, old, old);
  fs.chmodSync(readable, 0);
  const atimes = [first, readable].map(file => fs.statSync(file, { bigint: true }).atimeNs);
  const firstBytes = allocated(first) + allocated(readable)+allocated(orphan), secondBytes = allocated(second), before = snapshot();
  assert.ok(allocated(first) < fs.statSync(first).size / 100, 'fixture is actually sparse');
  const one = await api(`/storage?project=${projects[0].id}`);
  assert.equal(one.complete, true); assert.equal(one.skipped, 0);
  assert.equal(one.bytes.project_logs, firstBytes, 'hardlinked outputs count once');
  assert.equal(one.bytes.all_project_logs, firstBytes + secondBytes);
  assert.equal(one.bytes.total, categoryTotal(one.bytes));
  assert.equal(one.bytes.total, allocatedTree(home), 'all files and directory blocks are included exactly once');
  const coreBytes=[path.join(home,'global'),...projectHomes].reduce((bytes,directory)=>bytes+fs.readdirSync(directory).filter(name=>/^(acom|shared)\.db(?:-(?:wal|shm|journal))?$/.test(name)).reduce((sum,name)=>sum+allocated(path.join(directory,name)),0),0);
  assert.equal(one.bytes.database,coreBytes,'per-project and shared SQLite core files/sidecars are one category');
  assert.equal(one.bytes.project_native,allocated(native));assert.ok(one.bytes.metrics>0);assert.ok(one.bytes.trash>0);
  const two = await api(`/storage?project=${projects[1].id}`), empty = await api(`/storage?project=${projects[2].id}`);
  assert.equal(two.bytes.project_logs, secondBytes); assert.equal(empty.bytes.project_logs, 0);
  assert.deepEqual([first, readable].map(file => fs.statSync(file, { bigint: true }).atimeNs), atimes, 'no log contents read');
  assert.deepEqual(snapshot(), before);
}));

test('storage does not traverse symlinked log files, directories or external provider histories', async () => fixture(async ({ root, logs, projects, api }) => {
  const outside = path.join(root, 'native-history'); fs.mkdirSync(outside);
  const native = path.join(outside, 'conversation.jsonl'); fs.writeFileSync(native, Buffer.alloc(4 * 1024 * 1024, 65));
  const old = new Date('2001-01-01T00:00:00Z'); fs.utimesSync(outside, old, old); fs.utimesSync(native, old, old);
  fs.symlinkSync(native, path.join(logs[0], '11.jsonl'));
  fs.symlinkSync(outside, path.join(logs[0], 'native'));
  const atimes = [outside, native].map(file => fs.statSync(file, { bigint: true }).atimeNs);
  const report = await api(`/storage?project=${projects[0].id}`);
  assert.equal(report.bytes.project_logs, allocated(path.join(logs[0], '11.jsonl')));
  assert.equal(report.bytes.all_project_logs, report.bytes.project_logs, 'only the link itself, not its target, can be charged');
  assert.ok(report.bytes.total < allocated(native), 'external history is not charged to acom');
  assert.deepEqual([outside, native].map(file => fs.statSync(file, { bigint: true }).atimeNs), atimes, 'external trees and files are not opened');
}));

function categoryTotal(bytes){return ['all_project_logs','database','metrics','native','trash','other'].reduce((sum,key)=>sum+bytes[key],0);}
