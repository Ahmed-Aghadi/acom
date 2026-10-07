// Browser regressions for the actual page, with a small API fixture (no paid agents).
// npm install --no-save --package-lock=false playwright && npx playwright install chromium
// node --test tests/ui.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const catalog = {
  claude: [{ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'] }, { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'max'] }],
  codex: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'ultra'] }, { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: ['low', 'medium', 'high', 'ultra'] }, { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'medium', 'high', 'max'] }],
};
function settings() {
  return {
    harnesses: Object.fromEntries(Object.entries(catalog).map(([name, models]) => [name, {
      enabled: true, models: models.map(x => x.id), model: models[0].id,
      efforts: ['low', 'medium', 'high'], effort: 'medium',
      flags: [name === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox'],
    }])),
    limits: { active: { soft: 6, hard: 8 }, active_per_harness: {}, usage: {}, context: { soft: null, hard: 200000 } },
    auto_resume: true, done_closes: true,
  };
}

async function fixture(run) {
  const data = { settings: settings(), agents: [], threads: [], projects: [{ id: 1, name: 'example', path: '/projects/example' }, { id: 2, name: 'other', path: '/projects/other' }], requests: [], hardLimit: false };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (req.method !== 'GET') data.requests.push({ url: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    const send = value => res.end(JSON.stringify(value));
    if (new URL(req.url, 'http://localhost').pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(fs.readFileSync(path.join(__dirname, '../src/ui.html')));
    }
    if (req.url.startsWith('/overview')) {
      const id = Number(new URL(req.url, 'http://localhost').searchParams.get('project'));
      const project = data.projects.find(p => p.id === id) || data.projects[0] || null;
      if (data.delays?.[id]) await new Promise(resolve => setTimeout(resolve, data.delays[id]));
      return send({ ...data, threads: data.threads.filter(t => t.project === project?.id).map(t => ({ ...t, messages: t.messages.length })), agents: data.agents.filter(a => a.project === project?.id), model_catalog: catalog, locks: [], activity: [], limits: { usage: [], limits: data.settings.limits }, project, url: `http://127.0.0.1:${server.address().port}` });
    }
    if (req.url === '/projects') {
      const p = { id: Math.max(0, ...data.projects.map(p => p.id)) + 1, path: body.path, name: body.path.split('/').at(-1) };
      data.projects.push(p);
      return send({ id: p.id });
    }
    if (/^\/projects\/\d+\/remove$/.test(req.url)) {
      data.projects = data.projects.filter(p => p.id !== Number(req.url.split('/')[2]));
      return send({});
    }
    if (req.url === '/settings') {
      if (body) data.settings = body.settings;
      return send(data.settings);
    }
    if (req.url === '/agents') {
      if (data.hardLimit && !body.force) { res.statusCode = 409; return send({ error: 'hard limit reached: confirm to continue' }); }
      return send({ id: 1, warnings: [] });
    }
    if (req.url === '/threads') {
      const t = { id: data.threads.length + 1, ...body, messages: [] };
      data.threads.push(t);
      return send({ id: t.id });
    }
    if (req.url.startsWith('/threads/')) return send(data.threads.find(t => t.id === Number(req.url.split('/')[2])));
    if (req.url === '/messages') {
      const t = data.threads.find(t => t.id === body.thread);
      t.messages.push({ id: t.messages.length + 1, sender: 0, at: Date.now() / 1000, text: body.text });
      return send({});
    }
    res.statusCode = 404; send({ error: 'not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'live');
    await run(page, data);
    assert.deepEqual(errors, [], 'no uncaught page errors');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
const openLaunch = page => page.locator('[data-open="launch-dialog"]').click();
const saveSettings = async page => {
  await page.locator('[form="settings-form"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Settings saved');
};

test('empty dialogs cancel without validation or writes; Task is still required', async () => fixture(async (page, data) => {
  assert.equal(await page.locator('#project-path').textContent(), '/projects/example');
  assert.equal(await page.title(), 'example · acom');
  await openLaunch(page);
  assert.match(await page.locator('#launch-project').textContent(), /\/projects\/example/);
  await page.locator('#launch-form button.primary').click();
  assert.equal(await page.locator('#launch-dialog').isVisible(), true);
  await page.locator('[data-close="launch-dialog"]').click();
  assert.equal(await page.locator('#launch-dialog').isVisible(), false);
  await page.locator('[data-page="threads"]').click();
  await page.locator('[data-open="thread-dialog"]').click();
  await page.locator('[data-close="thread-dialog"]').click();
  assert.equal(await page.locator('#thread-dialog').isVisible(), false);
  assert.deepEqual(data.requests, []);
}));

test('launch and forced launch close and reset after async responses', async () => fixture(async (page, data) => {
  for (const force of [false, true]) {
    data.hardLimit = force;
    if (force) page.once('dialog', dialog => dialog.accept());
    await openLaunch(page);
    await page.locator('#launch-form [name=task]').fill('Run tests');
    await page.locator('#launch-form button.primary').click();
    await page.waitForFunction(() => !document.querySelector('#launch-dialog').open);
    assert.equal(await page.locator('#launch-form [name=task]').inputValue(), '');
    assert.equal(data.requests.at(-1).body.task, 'Run tests');
    assert.equal(data.requests.at(-1).body.force || false, force);
    assert.equal(await page.locator('#launch-form button.primary').isEnabled(), true);
  }
}));

test('thread creation resets the form and opens a working composer', async () => fixture(async (page, data) => {
  await page.locator('[data-page="threads"]').click();
  await page.locator('[data-open="thread-dialog"]').click();
  await page.locator('#thread-form [name=title]').fill('Review');
  await page.locator('#thread-form [name=members]').fill('1, group:review');
  await page.locator('#thread-form button.primary').click();
  await page.locator('#message-form').waitFor();
  assert.equal(await page.locator('#thread-form [name=title]').inputValue(), '');
  assert.deepEqual(data.threads[0].members, ['1', 'group:review']);
  await page.locator('#message-form textarea').fill('Check the fix');
  await page.locator('#message-form button').click();
  await page.locator('.message-text').waitFor();
  assert.equal(await page.locator('.message-text').textContent(), 'Check the fix');
  assert.equal(await page.locator('#message-form textarea').inputValue(), '');
}));

test('model/effort selections and custom defaults persist; polling preserves drafts', async () => fixture(async (page, data) => {
  await page.locator('[data-page="settings"]').click();
  const root = page.locator('[data-harness="codex"]');
  assert.match(await root.locator('[name=model]').textContent(), /GPT-5.6 Terra · gpt-5.6-terra/);
  await root.locator('[name=model]').selectOption('gpt-5.6-terra');
  await root.locator('.model-picker summary').click();
  await root.locator('[name=allowed_model][value="gpt-6.1-sol"]').uncheck();
  await root.locator('[name=add_model]').fill('gpt-next');
  await root.locator('[data-add-model]').click();
  await root.locator('[name=model]').selectOption('gpt-next');
  await root.locator('[name=allowed_effort][value=high]').uncheck();
  await page.waitForTimeout(2100);
  assert.equal(await root.locator('[name=model]').inputValue(), 'gpt-next');
  await saveSettings(page);
  assert.deepEqual(data.settings.harnesses.codex.models, ['gpt-5.6-terra', 'gpt-6-luna', 'gpt-next']);
  assert.equal(data.settings.harnesses.codex.model, 'gpt-next');
  assert.deepEqual(data.settings.harnesses.codex.efforts, ['low', 'medium']);
  assert.deepEqual(data.settings.harnesses.codex.flags, ['--dangerously-bypass-approvals-and-sandbox']);
  await root.locator('[name=model]').selectOption('__custom__');
  await root.locator('[name=custom_model]').fill('gpt-future');
  await saveSettings(page);
  assert.equal(data.settings.harnesses.codex.model, 'gpt-future');
  assert.ok(data.settings.harnesses.codex.models.includes('gpt-future'));
  await page.reload();
  await page.locator('[data-page="settings"]').click();
  await root.locator('[name=model] option[value="gpt-future"]').waitFor({ state: 'attached' });
  assert.equal(await root.locator('[name=model]').inputValue(), 'gpt-future');
}));

test('custom launch uses the full ID without mutating settings', async () => fixture(async (page, data) => {
  await openLaunch(page);
  await page.locator('#launch-harness').selectOption('codex');
  await page.locator('#launch-model').selectOption('__custom__');
  await page.locator('#launch-custom-model').fill('gpt-new-release');
  await page.locator('#launch-form [name=task]').fill('Test a new model');
  await page.locator('#launch-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#launch-dialog').open);
  assert.equal(data.settings.harnesses.codex.models.includes('gpt-new-release'), false);
  assert.equal(data.requests.filter(r => r.url === '/settings').length, 0);
  assert.equal(data.requests.at(-1).body.model, 'gpt-new-release');
  assert.equal(data.requests.at(-1).body.harness, 'codex');
  assert.equal('custom_model' in data.requests.at(-1).body, false);
}));

test('project switching isolates threads; launch can target a different project', async () => fixture(async (page, data) => {
  data.threads.push({ id: 1, project: 1, title: 'First project', members: [], messages: [] });
  await page.reload();
  await page.locator('[data-page="threads"]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form').waitFor();
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('#project-path').textContent === '/projects/other');
  assert.equal(new URL(page.url()).searchParams.get('project'), '2');
  assert.equal(await page.locator('#thread-list [data-thread]').count(), 0);
  assert.equal(await page.locator('#message-form').count(), 0);
  await openLaunch(page);
  assert.equal(await page.locator('#launch-project-select').inputValue(), '2');
  await page.locator('#launch-project-select').selectOption('1');
  assert.match(await page.locator('#launch-project').textContent(), /\/projects\/example/);
  await page.locator('#launch-form [name=task]').fill('Different project');
  await page.locator('#launch-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#launch-dialog').open);
  assert.equal(data.requests.at(-1).body.project, 1);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-select').value === '2');
  assert.equal(await page.locator('#project-path').textContent(), '/projects/other');
}));

test('empty project list prompts for a folder; add and remove never delete files', async () => fixture(async (page, data) => {
  data.projects = [];
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-select').disabled);
  await openLaunch(page);
  assert.equal(await page.locator('#project-dialog').isVisible(), true);
  await page.locator('[data-close="project-dialog"]').click();
  assert.equal(data.requests.length, 0);
  await page.locator('[data-open="project-dialog"]').click();
  await page.locator('#project-form [name=path]').fill('/projects/new');
  await page.locator('#project-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#project-dialog').open);
  assert.equal(await page.locator('#project-path').textContent(), '/projects/new');
  assert.equal(await page.locator('#project-form [name=path]').inputValue(), '');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#remove-project').click();
  await page.waitForFunction(() => document.querySelector('#project-select').disabled);
  assert.equal(data.requests.at(-1).url, '/projects/1/remove');
}));

test('launch effort choices follow the selected model capabilities', async () => fixture(async page => {
  await openLaunch(page);
  await page.locator('#launch-harness').selectOption('codex');
  await page.locator('#launch-effort').selectOption('ultra');
  await page.locator('#launch-model').selectOption('gpt-6-luna');
  assert.equal(await page.locator('#launch-effort option[value=ultra]').count(), 0);
  assert.equal(await page.locator('#launch-effort').inputValue(), 'medium');
  await page.locator('#launch-model').selectOption('__custom__');
  assert.equal(await page.locator('#launch-effort option[value=ultra]').count(), 1);
}));

test('settings preserve quoted argument boundaries and reject unclosed quotes', async () => fixture(async (page, data) => {
  const flags = ['--allowedTools', 'Bash(cargo *)', '--config', 'key="quoted"', 'back\\slash'];
  data.settings.harnesses.claude.flags = flags;
  await page.reload();
  await page.locator('[data-page="settings"]').click();
  const input = page.locator('[data-harness=claude] [name=flags]');
  await input.waitFor();
  await saveSettings(page);
  assert.deepEqual(data.settings.harnesses.claude.flags, flags);
  const writes = data.requests.length;
  await input.fill('--allowedTools "unclosed');
  await page.locator('[form="settings-form"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Unclosed quote in launch flags.');
  assert.equal(data.requests.length, writes);
  assert.equal(await page.locator('[form="settings-form"]').isEnabled(), true);
}));

test('an older overview response cannot switch the UI back to another project', async () => fixture(async (page, data) => {
  data.delays = { 1: 350 };
  await page.locator('#project-select').selectOption('2');
  await page.locator('#project-select').selectOption('1');
  await page.locator('#project-select').selectOption('2');
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#project-path').textContent(), '/projects/other');
  assert.equal(await page.locator('#project-select').inputValue(), '2');
}));

test('project and model strings are text, not injected markup', async () => fixture(async (page, data) => {
  const id = 'x"><img/src=x/onerror=window.pwned=1>';
  data.settings.harnesses.codex.models.push(id);
  data.projects[0].name = '<img src=x onerror=window.pwned=1>';
  await page.reload();
  await page.locator('[data-page="settings"]').click();
  const root = page.locator('[data-harness=codex]');
  await root.locator('.model-picker summary').click();
  await root.locator('[name=allowed_model]').last().waitFor();
  assert.equal(await root.locator('[name=allowed_model]').last().inputValue(), id);
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
}));

test('flag, limit and crash reasons are visible and flagged resume keeps the model', async () => fixture(async (page, data) => {
  data.agents = [
    { id: 1, name: 'Flagged agent', project: 1, state: 'paused', pause_reason: 'flagged', problem: 'Model refused <example>', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
    { id: 2, name: 'Limit agent', project: 1, state: 'paused', pause_reason: 'limit', problem: 'Usage limit reached' },
    { id: 3, name: 'Crash agent', project: 1, state: 'crashed', problem: 'Stream disconnected' },
  ];
  await page.reload();
  await page.locator('[data-agent="1"]').waitFor();
  assert.equal(await page.locator('[data-agent="1"] .problem').textContent(), 'Flagged: Model refused <example>');
  assert.equal(await page.locator('[data-agent="1"] [data-action=resume]').textContent(), 'Resume same model');
  assert.equal(await page.locator('[data-agent="1"] .pill').textContent(), 'paused · flagged');
  assert.equal(await page.locator('[data-agent="2"] .problem').textContent(), 'Usage limit: Usage limit reached');
  assert.equal(await page.locator('[data-agent="3"] .problem').textContent(), 'Crashed: Stream disconnected');
}));

test('project identity and settings fit a narrow screen', async () => fixture(async (page, data) => {
  data.projects[0].path = '/projects/' + 'long-folder-name-'.repeat(10);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-harness=codex]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await openLaunch(page);
  assert.ok(await page.evaluate(() => document.querySelector('#launch-dialog').scrollWidth <= document.querySelector('#launch-dialog').clientWidth));
}));
