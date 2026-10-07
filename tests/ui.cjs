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
  const data = { settings: settings(), agents: [], threads: [], projects: [{ id: 1, name: 'example', path: '/projects/example', config: 1 }, { id: 2, name: 'other', path: '/projects/other', config: 1 }], requests: [], hardLimit: false };
  data.configs = [{ id: 1, name: 'Default', settings: data.settings }];
  const configs = () => data.configs.map(c => ({ ...c, projects: data.projects.filter(p => p.config === c.id).map(p => p.id) }));
  const effective = p => p?.config == null && p ? p.custom : data.configs.find(c => c.id === (p?.config ?? 1)).settings;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (req.method !== 'GET') data.requests.push({ url: req.url, method: req.method, body });
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
      return send({ ...data, configs: configs(), settings: effective(project), threads: data.threads.filter(t => t.project === project?.id).map(t => ({ ...t, messages: t.messages.length })), agents: data.agents.filter(a => a.project === project?.id), model_catalog: catalog, locks: [], activity: [], limits: { usage: [], limits: effective(project).limits }, project, url: `http://127.0.0.1:${server.address().port}` });
    }
    if (req.url === '/projects') {
      const p = { id: Math.max(0, ...data.projects.map(p => p.id)) + 1, path: body.path, name: body.path.split('/').at(-1), config: 1 };
      data.projects.push(p);
      return send({ id: p.id });
    }
    if (/^\/projects\/\d+\/remove$/.test(req.url)) {
      data.projects = data.projects.filter(p => p.id !== Number(req.url.split('/')[2]));
      return send({});
    }
    if (req.url === '/configs') {
      if (req.method === 'GET') return send(configs());
      if (data.configs.some(c => c.name === body.name)) { res.statusCode = 409; return send({ error: 'Config name already exists' }); }
      const id = Math.max(...data.configs.map(c => c.id)) + 1;
      data.configs.push({ id, ...body }); return send({ id });
    }
    if (/^\/configs\/\d+(\/remove)?$/.test(req.url)) {
      if (data.writeDelay) await new Promise(resolve => setTimeout(resolve, data.writeDelay));
      const id = Number(req.url.split('/')[2]);
      if (req.url.endsWith('/remove')) data.configs = data.configs.filter(c => c.id !== id);
      else {
        Object.assign(data.configs.find(c => c.id === id), body);
        if (id === 1) data.settings = body.settings;
      }
      return send({});
    }
    if (/^\/projects\/\d+\/config$/.test(req.url)) {
      const p = data.projects.find(p => p.id === Number(req.url.split('/')[2]));
      Object.assign(p, body.custom ? { config: null, custom: body.custom } : { config: body.config });
      return send({});
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
  assert.equal(data.requests.filter(r => r.url.startsWith('/configs')).length, 0);
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

test('shared edits name affected projects; Custom starts from Default and stays isolated', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  assert.match(await page.locator('#config-scope').textContent(), /example \(#1\), other \(#2\)/);
  await page.locator('[data-limit=active] [name=hard]').fill('10');
  await saveSettings(page);
  assert.equal(data.settings.limits.active.hard, 10);
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('[data-limit=active] [name=hard]')?.value === '10');
  await page.locator('#config-select').selectOption('custom');
  assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '10');
  await page.locator('[data-limit=active] [name=soft]').fill('');
  await page.locator('[data-limit=active] [name=hard]').fill('2');
  await saveSettings(page);
  assert.equal(data.projects[1].config, null);
  assert.equal(data.projects[1].custom.limits.active.hard, 2);
  assert.equal(data.settings.limits.active.hard, 10);
  await page.reload(); await page.locator('[data-page=settings]').click();
  await page.waitForFunction(() => document.querySelector('#config-select')?.value === 'custom');
  assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '2');
  await page.locator('#project-select').selectOption('1');
  await page.waitForFunction(() => document.querySelector('#config-select')?.value === '1');
  assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '10');
  assert.doesNotMatch(await page.locator('#config-scope').textContent(), /other/);
}));

test('named configs can be saved, reused, renamed and removed only when unused', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-limit=active] [name=hard]').fill('12');
  await page.locator('#save-config-as').click();
  await page.locator('#config-form button.primary').click();
  assert.equal(await page.locator('#config-dialog').isVisible(), true);
  await page.locator('[data-close=config-dialog]').click();
  assert.equal(data.requests.length, 0);
  assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '12');
  await page.locator('#save-config-as').click();
  await page.locator('#config-form [name=name]').fill('Large jobs');
  await page.locator('#config-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#config-dialog').open);
  assert.equal(data.projects[0].config, 2);
  assert.equal(data.configs[1].settings.limits.active.hard, 12);
  assert.equal(data.settings.limits.active.hard, 8);
  assert.equal(await page.locator('#remove-config').isDisabled(), true);
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('#config-select')?.value === '1');
  await page.locator('#config-select').selectOption('2');
  await saveSettings(page);
  assert.deepEqual(data.projects.map(p => p.config), [2, 2]);
  await page.locator('[name=config_name]').fill('Bigger jobs');
  await saveSettings(page);
  assert.equal(data.configs[1].name, 'Bigger jobs');
  for (const project of ['1', '2']) {
    await page.locator('#project-select').selectOption(project);
    await page.waitForFunction(() => !!document.querySelector('#config-select'));
    await page.locator('#config-select').selectOption('1');
    await saveSettings(page);
  }
  await page.locator('#config-select').selectOption('2');
  assert.equal(await page.locator('#remove-config').isEnabled(), true);
  page.once('dialog', d => d.accept()); await page.locator('#remove-config').click();
  await page.waitForFunction(() => !document.querySelector('#config-select option[value="2"]'));
  assert.equal(data.configs.length, 1);
  assert.equal(await page.locator('#remove-config').count(), 0);
}));

test('duplicate config names keep the draft and dialog for correction', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-limit=active] [name=hard]').fill('9');
  await page.locator('#save-config-as').click();
  await page.locator('#config-form [name=name]').fill('Default');
  await page.locator('#config-form button.primary').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('already exists'));
  assert.equal(await page.locator('#config-dialog').isVisible(), true);
  assert.equal(await page.locator('#config-form button.primary').isEnabled(), true);
  assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '9');
  assert.equal(data.configs.length, 1);
  assert.equal(data.projects[0].config, 1);
}));

test('project/config switches ask before discarding drafts, and cancelled switches keep them', async () => fixture(async page => {
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-limit=active] [name=hard]').fill('9');
  for (const selector of ['#project-select', '#config-select']) {
    page.once('dialog', d => d.dismiss());
    await page.locator(selector).selectOption(selector === '#project-select' ? '2' : 'custom');
    assert.equal(await page.locator(selector).inputValue(), '1');
    assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '9');
  }
  page.once('dialog', d => d.accept());
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('[data-limit=active] [name=hard]')?.value === '8');
}));

test('launch loads the target project defaults and ignores stale target responses', async () => fixture(async (page, data) => {
  const custom = settings(); custom.harnesses.claude.enabled = false;
  custom.harnesses.codex.model = 'gpt-6-luna'; custom.harnesses.codex.effort = 'low';
  data.projects[1].config = null; data.projects[1].custom = custom;
  await openLaunch(page);
  await page.locator('#launch-project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('#launch-model').value === 'gpt-6-luna');
  assert.equal(await page.locator('#launch-harness').inputValue(), 'codex');
  assert.equal(await page.locator('#launch-harness option[value=claude]').count(), 0);
  assert.equal(await page.locator('#launch-effort').inputValue(), 'low');
  data.delays = { 1: 350 };
  await page.locator('#launch-project-select').selectOption('1');
  await page.locator('#launch-project-select').selectOption('2');
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#launch-model').inputValue(), 'gpt-6-luna');
  await page.locator('#launch-form [name=task]').fill('Scoped defaults');
  await page.locator('#launch-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#launch-dialog').open);
  assert.equal(data.requests.at(-1).body.model, 'gpt-6-luna');
  assert.equal(data.requests.at(-1).body.effort, 'low');
  assert.equal(data.requests.at(-1).body.project, 2);
}));

test('without projects Default remains editable and named configs can be created', async () => fixture(async (page, data) => {
  data.projects = []; await page.reload();
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-limit=active] [name=hard]').fill('9');
  await saveSettings(page);
  assert.equal(data.settings.limits.active.hard, 9);
  await page.locator('#save-config-as').click();
  await page.locator('#config-form [name=name]').fill('Unused');
  await page.locator('#config-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#config-dialog').open);
  assert.equal(await page.locator('#config-select').inputValue(), '2');
  assert.equal(data.projects.length, 0);
  assert.equal(data.requests.some(r => r.url.startsWith('/projects')), false);
}));

test('a project with no enabled harness cannot launch', async () => fixture(async (page, data) => {
  const custom = settings();
  for (const h of Object.values(custom.harnesses)) h.enabled = false;
  data.projects[1].config = null; data.projects[1].custom = custom;
  await openLaunch(page);
  await page.locator('#launch-project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('No harnesses are enabled'));
  assert.equal(await page.locator('#launch-form button.primary').isDisabled(), true);
  await page.locator('[data-close=launch-dialog]').click();
  assert.equal(data.requests.length, 0);
}));

test('polling cannot unlock project controls during a settings save', async () => fixture(async (page, data) => {
  data.writeDelay = 2400;
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-limit=active] [name=hard]').fill('9');
  await page.locator('[form=settings-form]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Saving settings…');
  await page.waitForTimeout(2100);
  for (const selector of ['#project-select', '#remove-project', '[data-open=project-dialog]', '[form=settings-form]']) {
    assert.equal(await page.locator(selector).isDisabled(), true, selector);
  }
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Settings saved');
  assert.equal(await page.locator('#project-select').isEnabled(), true);
  assert.equal(data.projects[0].config, 1);
  assert.equal(data.settings.limits.active.hard, 9);
}));
