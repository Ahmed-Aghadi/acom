// Capture the real UI with disposable sample data; no model turns or account credentials.
// Build acom first, then run with ACOM_BINARY, PLAYWRIGHT_MODULE and optionally PLAYWRIGHT_CHROMIUM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { scoped, projectHome } = require('../tests/fixture-workspace.cjs');

async function main() {
  const binary = fs.realpathSync(process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom'));
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  // acom adds its own directory to PATH; do not allow real clients there either.
  for (const client of ['claude', 'codex']) assert.ok(!fs.existsSync(path.join(path.dirname(binary), client)), `${client} must not be beside the capture binary`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-screenshots-'));
  const home = path.join(root, 'state'), projectDir = path.join(root, 'sample-app');
  const emptyBin = path.join(root, 'empty-bin');
  for (const dir of [home, projectDir, emptyBin]) fs.mkdirSync(dir);
  const env = { ...process.env, ACOM_HOME: home, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), PATH: emptyBin };
  for (const key of ['ACOM_ID', 'ACOM_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(binary, ['serve', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '', browser;
  server.stderr.on('data', chunk => errors += chunk);
  let project;
  const api = async (method, route, body) => {
    route = scoped(route, project?.id, body);
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(value)}`);
    return value;
  };
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${errors}`);
      try { if ((await fetch(base + '/overview')).ok) break; } catch (_) {}
      assert.ok(Date.now() < deadline, `Server did not start: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    project = await api('POST', '/projects', { path: projectDir });
    const runtimeHome = projectHome(home, project.id);
    const now = Math.floor(Date.now() / 1000);
    const registry = new DatabaseSync(path.join(home, 'global', 'acom.db'));
    try { registry.prepare('UPDATE workspace_projects SET path=?,name=? WHERE id=?').run('/workspace/sample-app', 'sample-app', project.id); }
    finally { registry.close(); }
    const db = new DatabaseSync(path.join(runtimeHome, 'acom.db'));
    try {
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('BEGIN');
      db.prepare('UPDATE projects SET path=?,name=? WHERE id=1').run('/workspace/sample-app', 'sample-app');
      db.exec('DELETE FROM activity WHERE project=1');
      const insert = db.prepare(`INSERT INTO agents(id,project,name,grp,task,harness,model,effort,state,status_text,pause_reason,pause_from,paused_at,launched_by,launched_at,turns)
        VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const agents = [
        [1, 'API implementation', 'Implementation', 'Implement cursor pagination and validate request parameters.', 'codex', 'gpt-6.1-sol', 'high', 'working', 'Adding cursor boundary tests', null, 42000, 14000, 60000, 4800, 6],
        [2, 'Security review', 'Review', 'Review authorization and error handling; report concrete findings.', 'claude', 'claude-opus-5-5', 'high', 'idle', 'Waiting for the pagination patch', null, 37000, 11000, 52000, 3200, 4],
        [3, 'Regression tests', 'Review', 'Exercise list, detail and retry flows against the sample API.', 'codex', 'gpt-6-sol', 'medium', 'paused', 'Regression suite ready for review', 'user', 28000, 9000, 30000, 2400, 3],
        [4, 'Documentation', 'Implementation', 'Document the new API and add a minimal usage example.', 'claude', 'claude-sonnet-5-5', 'medium', 'closed', 'Usage examples updated', null, 18000, 5000, 16000, 1800, 2],
      ];
      for (const [id, name, group, task, provider, model, effort, state, status, pause, context, fresh, cache, output, turns] of agents) {
        insert.run(id, name, group, task, provider, model, effort, state, status, pause, pause ? 'working' : null, pause ? now - 90 : null, 0, now - 1500 + id * 100, turns);
        db.prepare('INSERT INTO context_observations VALUES(?,?,?)').run(id, String(context), now);
        const values = [fresh, 0, cache, output], total = fresh + cache + output;
        const counts = { values, total }, empty = { values: [null, null, null, null], total: null };
        const last = tokens => ({ tokens, at: now });
        const ledger = { previous: provider === 'claude' ? counts : empty, previous_partial: false, session: null,
          codex: provider === 'codex' ? counts : empty, codex_complete: true, turn: null, updated_at: now,
          last_total: last(total), fields: [...values, total].map(value => ({ observed_at: now, state_at: now, last_known: last(value) })) };
        db.prepare('INSERT INTO agent_token_usage VALUES(?,?)').run(id, JSON.stringify(ledger));
      }
      db.prepare('INSERT INTO locks(project,name,about,created_at,holder,acquired_at,expires_at) VALUES(?,?,?,?,?,?,?)')
        .run(1, 'api-routes', 'Changes to shared API routes', now - 900, 1, now - 120, now + 780);
      const thread = db.prepare('INSERT INTO threads(id,project,title,created_by,created_at) VALUES(?,?,?,?,?)');
      const member = db.prepare('INSERT INTO members(thread_id,agent_id) VALUES(?,?)');
      for (const [id, title, owner, members] of [
        [1, 'Pagination handoff', 1, [0, 1, 2, 3]],
        [2, 'Release checklist', 0, [0, 1, 4]],
        [3, 'Review notes', 2, [2, 3]],
      ]) {
        thread.run(id, 1, title, owner, now - 900);
        for (const agent of members) member.run(id, agent);
      }
      const message = db.prepare('INSERT INTO messages(id,thread_id,sender,text,at) VALUES(?,?,?,?,?)');
      [
        [1, 1, 0, 'Keep the pagination change small. Coordinate the implementation and review here.', now - 720],
        [2, 1, 1, 'The cursor format is ready.\n\n- Adding boundary tests for missing or duplicated records.\n- Holding `api-routes` while I update the handlers.', now - 600],
        [3, 1, 2, 'Reviewed validation and permissions. Please cover an **invalid cursor** and a page-boundary check for missing or duplicated records.', now - 420],
        [4, 1, 3, 'The regression cases are ready. I will run them after the handler patch lands.', now - 240],
        [5, 1, 0, 'Agreed. Keep the existing request limits and document the continuation fields.', now - 120],
        [6, 2, 4, 'The usage examples now include page-boundary checks and bounded responses.', now - 180],
        [7, 3, 2, 'Review focus: validation, authorization and stable page boundaries.', now - 360],
      ].forEach(row => message.run(...row));
      db.exec('UPDATE members SET last_notified=(SELECT coalesce(max(id),0) FROM messages WHERE thread_id=members.thread_id) WHERE agent_id>0');
      db.prepare('INSERT INTO user_reads(thread_id,message_id) VALUES(?,?)').run(1, 1);
      const activity = db.prepare('INSERT INTO activity(project,at,actor,what) VALUES(?,?,?,?)');
      [
        [-1450, 'user', 'launched #1 API implementation'],
        [-1200, 'user', 'launched #2 Security review'],
        [-900, 'agent 1', 'created thread #1 Pagination handoff'],
        [-600, 'agent 1', 'acquired lock api-routes'],
        [-360, 'agent 2', 'finished its turn · idle'],
        [-240, 'user', 'paused #3 Regression tests'],
        [-180, 'agent 4', 'completed documentation · closed'],
        [-120, 'user', 'sent a message in thread #1'],
      ].forEach(([offset, actor, what]) => activity.run(1, now + offset, actor, what));
      db.exec('COMMIT');
    } finally { db.close(); }
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'en-US', timezoneId: 'UTC' });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${base}/?project=${project.id}`);
    await page.locator('#agents [data-agent]').nth(3).waitFor();
    await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'live');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.locator('#project-path').innerText(), '/workspace/sample-app');
    assert.equal(await page.locator('#agents [data-agent]').count(), 4);
    assert.equal(await page.locator('#usage').innerText().then(text => (text.match(/unknown/g) || []).length), 4);
    assert.doesNotMatch(await page.locator('body').innerText(), /\/home\/|\/tmp\/acom-/);
    const images = path.resolve(__dirname, '../docs/images');
    fs.mkdirSync(images, { recursive: true });
    await page.setViewportSize({ width: 1600, height: await page.evaluate(() => document.documentElement.scrollHeight) });
    await page.screenshot({ path: path.join(images, 'overview.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator('[data-page="threads"]').click();
    await page.locator('[data-thread-filter="all"]').click();
    await page.locator('[data-thread="1"]').click();
    await page.locator('#messages [data-message="5"]').waitFor();
    await page.locator('#messages').evaluate(node => node.scrollTop = 0);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(images, 'threads.png'), fullPage: true, animations: 'disabled' });
    await page.locator('#open-message-search').click();
    await page.locator('#message-search-form [name=query]').fill('boundary');
    await page.locator('#message-search-form button[type=submit]').click();
    await page.locator('#message-search-results [data-message-result]').nth(2).waitFor();
    assert.equal(await page.locator('#message-search-results [data-message-result]').count(), 3);
    assert.equal(await page.locator('#message-search-results [data-message-result]').evaluateAll(rows => new Set(rows.map(row => row.dataset.resultThread)).size), 2);
    assert.ok(await page.locator('#message-search-results mark').count() >= 3);
    await page.mouse.move(0, 0);
    await page.locator('#message-search-dialog').screenshot({ path: path.join(images, 'search.png'), animations: 'disabled' });
    assert.deepEqual(pageErrors, []);
    const agents = (await api('GET', `/agents?project=${project.id}`)).items;
    assert.deepEqual(agents.map(agent => agent.state).sort(), ['closed', 'idle', 'paused', 'working']);
    const inspected = new DatabaseSync(path.join(runtimeHome, 'acom.db'), { readOnly: true });
    try {
      assert.equal(inspected.prepare('SELECT count(*) AS started FROM agents WHERE pid IS NOT NULL OR session_id IS NOT NULL OR session_started<>0').get().started, 0);
      assert.equal(inspected.prepare("SELECT count(*) AS started FROM events WHERE kind='agent.turn-started'").get().started, 0);
    } finally { inspected.close(); }
    for (const dir of [path.join(runtimeHome, 'logs'), env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) {
      assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, `capture must not create harness logs or native files: ${dir}`);
    }
    console.log(`Captured dark overview.png, threads.png and search.png in ${images}; sample fixture only, no provider turns.`);
  } finally {
    try { if (browser) await browser.close(); }
    finally {
      if (server.exitCode === null && server.signalCode === null) {
        const stopped = new Promise(resolve => server.once('exit', resolve));
        server.kill('SIGTERM');
        const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
        await stopped; clearTimeout(timer);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
