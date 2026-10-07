// API, CLI and process regressions; the fake harness never calls a model provider.
// cargo build && node --test tests/server.cjs
// ACOM_BROWSER_TEST=1 node --test tests/server.cjs also drives the real page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');

async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

test('single server scopes projects, preserves settings and supervises first/resumed turns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-test-'));
  const home = path.join(root, 'state'), bin = path.join(root, 'bin');
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  for (const dir of [home, bin, first, second, path.join(first, 'child')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', async () => {
  const args = process.argv.slice(2), id = Number(process.env.ACOM_ID);
  const resume = args[1] === 'resume';
  fs.appendFileSync(path.join(process.env.ACOM_HOME, 'runs.jsonl'), JSON.stringify({ id, args, prompt, cwd: process.cwd(), resume }) + '\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: resume ? args.at(-2) : crypto.randomUUID() }));
  if (prompt.includes('REROUTE_TEST') && !resume) console.log(JSON.stringify({ type: 'model_reroute', from_model: 'gpt-6.1-sol', to_model: 'gpt-other', reason: 'high_risk_cyber_activity' }));
  if (prompt.includes('POLICY_TEST') && !resume) console.log(JSON.stringify({ type: 'turn.failed', error: { code: 'policy_violation', message: 'request blocked under the usage policy' } }));
  await fetch(process.env.ACOM_URL + '/hook/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await new Promise(resolve => setTimeout(resolve, 2000));
  await fetch(process.env.ACOM_URL + '/agents/' + id + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));
});
`, { mode: 0o755 });
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ACOM_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.ACOM_ID; delete env.ACOM_URL;
  let server, stderr = '';
  const start = async () => {
    server = spawn(binary, ['serve', '--port', String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', chunk => stderr += chunk);
    await until(async () => {
      if (server.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
      try { return (await fetch(url + '/overview')).ok; } catch { return false; }
    }, 'server startup');
  };
  const stop = async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM'); await exited;
    }
  };
  const api = async (method, route, body, status = 200) => {
    const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await res.json();
    assert.equal(res.status, status, `${method} ${route}: ${JSON.stringify(result)}`);
    return result;
  };
  const cli = (cwd, args, extra = {}) => {
    const result = spawnSync(binary, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const runs = () => fs.existsSync(path.join(home, 'runs.jsonl')) ? fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const finished = id => until(async () => (await api('GET', `/agents/${id}`)).state === 'closed', `agent ${id} closed`);
  try {
    await start();
    assert.equal((await api('GET', '/overview')).project, null);
    await api('POST', '/agents', { harness: 'codex', task: 'Missing project' }, 400);
    const defaults = await api('GET', '/settings');
    assert.equal(defaults.done_closes, true);
    assert.deepEqual(defaults.harnesses.codex.flags, ['--dangerously-bypass-approvals-and-sandbox']);
    assert.deepEqual(defaults.harnesses.claude.flags, ['--dangerously-skip-permissions']);
    if (process.env.ACOM_BROWSER_TEST) await browserChecks(url, api, first, second, defaults);
    const a = await api('POST', '/projects', { path: first });
    const b = await api('POST', '/projects', { path: second });
    assert.equal((await api('POST', '/projects', { path: first })).id, a.id);
    assert.equal((await api('GET', `/projects?path=${encodeURIComponent(path.join(first, 'child'))}`)).id, a.id);
    await api('POST', '/projects', { path: path.join(root, 'missing') }, 400);
    const duplicate = spawnSync(binary, ['serve', '--port', String(port + 1)], { env, encoding: 'utf8' });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already running/);
    await api('POST', '/agents', { project: a.id, harness: 'codex', model: 'gpt-6-luna', effort: 'ultra', task: 'Unsupported effort' }, 400);
    const one = await api('POST', '/agents', { project: a.id, harness: 'codex', task: 'First project' });
    const two = await api('POST', '/agents', { project: b.id, harness: 'codex', model: 'custom-id', task: 'Second project' });
    await until(() => runs().length >= 2, 'both harnesses started');
    for (const [agent, project] of [[one.id, first], [two.id, second]]) {
      const run = runs().find(r => r.id === agent);
      assert.equal(run.cwd, project);
      assert.ok(run.args.includes('--dangerously-bypass-approvals-and-sandbox'));
      assert.ok(run.args.includes('--skip-git-repo-check'));
      assert.match(run.prompt, /only the user's messages wake/);
    }
    assert.deepEqual((await api('GET', `/overview?project=${a.id}`)).agents.map(x => x.id), [one.id]);
    assert.deepEqual((await api('GET', `/overview?project=${b.id}`)).agents.map(x => x.id), [two.id]);
    assert.match(cli(first, ['agents']), new RegExp(`agent ${one.id}`));
    assert.doesNotMatch(cli(first, ['agents']), new RegExp(`agent ${two.id}`));
    assert.doesNotMatch(cli(root, ['agents'], { ACOM_ID: String(one.id) }), new RegExp(`agent ${two.id}`));
    for (const p of [a.id, b.id]) await api('POST', '/locks', { project: p, name: 'build', about: 'Independent' });
    for (const agent of [one.id, two.id]) await api('POST', '/locks/acquire', { agent, name: 'build', wait: 0 });
    assert.equal((await api('GET', `/locks?project=${a.id}`))[0].holder, one.id);
    assert.equal((await api('GET', `/locks?project=${b.id}`))[0].holder, two.id);
    await api('POST', '/threads', { project: a.id, title: 'Wrong project', members: [String(two.id)] }, 400);
    const thread = await api('POST', '/threads', { project: a.id, title: 'Review', members: [String(one.id)] });
    await api('POST', '/messages', { agent: two.id, thread: thread.id, text: 'Wrong project' }, 400);
    await api('POST', `/projects/${a.id}/remove`, {}, 409);
    await finished(one.id); await finished(two.id);
    await api('POST', '/messages', { thread: thread.id, text: 'User wake' });
    await until(() => runs().filter(r => r.id === one.id).length === 2, 'resumed turn');
    assert.equal(runs().filter(r => r.id === one.id)[1].resume, true);
    assert.ok(runs().filter(r => r.id === one.id)[1].args.includes('--dangerously-bypass-approvals-and-sandbox'));
    await finished(one.id);
    assert.equal((await api('GET', `/locks?project=${a.id}`))[0].holder, null);
    for (const task of ['REROUTE_TEST', 'POLICY_TEST']) {
      const flagged = await api('POST', '/agents', { project: a.id, harness: 'codex', task });
      await until(async () => (await api('GET', `/agents/${flagged.id}`)).state === 'paused', 'flagged pause');
      const view = await api('GET', `/agents/${flagged.id}`);
      assert.equal(view.pause_reason, 'flagged');
      assert.match(view.problem, /rerouted|usage policy/);
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.equal((await api('GET', `/agents/${flagged.id}`)).state, 'paused');
      await api('POST', `/agents/${flagged.id}/resume`, {});
      await until(() => runs().filter(r => r.id === flagged.id).length === 2, 'same-model resume');
      const resumed = runs().filter(r => r.id === flagged.id)[1];
      assert.equal(resumed.args[resumed.args.indexOf('-m') + 1], defaults.harnesses.codex.model);
      await finished(flagged.id);
      assert.equal((await api('GET', `/agents/${flagged.id}`)).problem, null);
    }
    defaults.auto_resume = false;
    await api('PUT', '/settings', { settings: defaults });
    await stop(); await start();
    assert.equal((await api('GET', '/settings')).auto_resume, false);
    assert.equal((await api('GET', '/projects')).length, 2);
    assert.equal(fs.existsSync(path.join(first, '.acom')), false);
    assert.equal(fs.existsSync(path.join(second, '.acom')), false);
    assert.equal(stderr, '');
  } finally {
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function browserChecks(url, api, first, second, defaults) {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const add = async folder => {
    await page.locator('[data-open="project-dialog"]').click();
    await page.locator('#project-form [name=path]').fill(folder);
    await page.locator('#project-form button.primary').click();
    await page.waitForFunction(() => !document.querySelector('#project-dialog').open);
  };
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'live');
    await page.locator('[data-open="launch-dialog"]').click();
    assert.equal(await page.locator('#project-dialog').isVisible(), true);
    await page.locator('[data-close="project-dialog"]').click();
    await page.locator('[data-open="project-dialog"]').click();
    await page.locator('#project-form [name=path]').fill(first + '/missing');
    await page.locator('#project-form button.primary').click();
    await page.waitForFunction(() => document.querySelector('#toast').classList.contains('error'));
    assert.match(await page.locator('#toast').textContent(), /missing/);
    await page.locator('[data-close="project-dialog"]').click();
    await add(first); await add(second);
    const projects = await api('GET', '/projects');
    const firstId = projects.find(p => p.path === first).id;
    const secondId = projects.find(p => p.path === second).id;
    assert.equal(await page.locator('#project-path').textContent(), second);
    await api('POST', '/locks', { project: firstId, name: 'only-first', about: 'Project scope' });
    await page.locator('#project-select').selectOption(String(firstId));
    await page.locator('#locks code').waitFor();
    assert.equal(await page.locator('#locks code').textContent(), 'only-first');
    assert.equal(await page.locator('[data-action=free-lock]').count(), 0);
    await page.locator('#project-select').selectOption(String(secondId));
    await page.waitForFunction(() => document.querySelector('#locks').textContent.includes('No locks'));
    await page.locator('[data-open="launch-dialog"]').click();
    assert.equal(await page.locator('#launch-project-select').inputValue(), String(secondId));
    await page.locator('#launch-harness').selectOption('codex');
    await page.locator('#launch-model').selectOption('gpt-6-luna');
    assert.equal(await page.locator('#launch-effort option[value=ultra]').count(), 0);
    await page.locator('[data-close="launch-dialog"]').click();
    await page.locator('[data-page=settings]').click();
    const cfg = page.locator('[data-harness=codex]');
    await cfg.locator('.model-picker summary').click();
    await cfg.locator('[name=add_model]').fill('custom-next');
    await cfg.locator('[data-add-model]').click();
    await cfg.locator('[name=model]').selectOption('custom-next');
    const active = page.locator('[data-limit=active]');
    await active.locator('[name=soft]').fill('');
    await page.locator('[form=settings-form]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Settings saved');
    assert.equal((await api('GET', '/settings')).limits.active.soft, null);
    await page.reload();
    await page.locator('[data-page=settings]').click();
    await cfg.locator('[name=model] option[value=custom-next]').waitFor({ state: 'attached' });
    assert.equal(await cfg.locator('[name=model]').inputValue(), 'custom-next');
    assert.equal(await active.locator('[name=soft]').inputValue(), '');
    await active.locator('[name=soft]').fill('9');
    await active.locator('[name=hard]').fill('8');
    await page.locator('[form=settings-form]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes("soft can't be above hard"));
    assert.equal((await api('GET', '/settings')).limits.active.soft, null);
    for (const id of [firstId, secondId]) {
      await page.locator('#project-select').selectOption(String(id));
      page.once('dialog', d => d.accept());
      await page.locator('#remove-project').click();
      await page.waitForFunction(id => !Array.from(document.querySelector('#project-select').options).some(o => o.value === String(id)), id);
    }
    assert.equal(fs.existsSync(first), true); assert.equal(fs.existsSync(second), true);
    assert.deepEqual(errors, []);
    await api('PUT', '/settings', { settings: defaults });
  } finally { await browser.close(); }
}
