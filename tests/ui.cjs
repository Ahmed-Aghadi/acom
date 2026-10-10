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
    max_lock_ttl_secs: 900,
    allow_agent_model_change: false, allow_agent_effort_change: false, crash_retries: {},
    usage_poll_secs: 120,
    prompts: { launch:'Launch guidance', wake:'Wake guidance', resume:'Resume guidance' },
  };
}

async function fixture(run) {
  const data = { settings: settings(), agents: [], threads: [], reads: {}, agentLogs: {}, detailRequests: [], projects: [{ id: 1, name: 'example', path: '/projects/example', config: 2 }, { id: 2, name: 'other', path: '/projects/other', config: 2 }], requests: [], hardLimit: false };
  data.configs = [{ id: 1, name: 'Default', settings: settings() }, { id: 2, name: 'Mine', settings: data.settings }];
  data.folders = { '/home/example': { path:'/home/example', parent:'/home', home:'/home/example', entries:[{name:'work',path:'/home/example/work',directory:true},{name:'note.txt',path:'/home/example/note.txt',directory:false}] }, '/home/example/work':{path:'/home/example/work',parent:'/home/example',home:'/home/example',entries:[]} };
  const configs = () => data.configs.map(c => ({ ...c, projects: data.projects.filter(p => p.config === c.id).map(p => p.id) }));
  const effective = p => p?.config == null && p ? p.custom : data.configs.find(c => c.id === (p?.config ?? 1)).settings;
  const unread = t => t.members.includes(0) ? t.messages.filter(m => m.sender !== 0 && !m.outside_membership && m.id > (data.reads[t.id] || 0)).length : 0;
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
      return send({ ...data, projects: data.projects.map(p => ({ ...p, unread: data.threads.filter(t => t.project === p.id).reduce((n, t) => n + unread(t), 0) })), configs: configs(), settings: effective(project), threads: data.threads.filter(t => t.project === project?.id).map(t => ({ ...t, messages: t.messages.length, unread: unread(t) })), agents: data.agents.filter(a => a.project === project?.id), model_catalog: catalog, locks: [], activity: [], limits: { usage: data.usage || [], checks:data.checks || [], limits: effective(project).limits }, project, url: `http://127.0.0.1:${server.address().port}` });
    }
    if(req.url.startsWith('/folders')) {
      if(req.method==='GET') {
        const p=new URL(req.url,'http://localhost').searchParams.get('path') || '/home/example';
        if(!data.folders[p]) {res.statusCode=400;return send({error:'Cannot open folder'});}
        return send(data.folders[p]);
      }
      if(!body.name || body.name.includes('/') || body.name==='..') {res.statusCode=400;return send({error:'Give a folder name, not a path'});}
      const p=body.parent+'/'+body.name;
      data.folders[p]={path:p,parent:body.parent,home:'/home/example',entries:[]};
      data.folders[body.parent].entries.push({name:body.name,path:p,directory:true});
      return send({path:p});
    }
    if(req.url==='/usage/check') return send({});
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
      if (id === 1) { res.statusCode = 403; return send({error:'Default is read-only'}); }
      if (req.url.endsWith('/remove')) data.configs = data.configs.filter(c => c.id !== id);
      else {
        Object.assign(data.configs.find(c => c.id === id), body);
        if (id === 2) data.settings = body.settings;
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
    if (req.url === '/agent-config') {
      Object.assign(data.agents.find(a => a.id === body.id), {model:body.model,effort:body.effort});
      return send({});
    }
    if (/^\/agents\/\d+\/resume$/.test(req.url)) {
      Object.assign(data.agents.find(a => a.id === Number(req.url.split('/')[2])), {state:'working',pause_reason:null,problem:null});
      return send({warnings:[]});
    }
    if (/^\/agents\/\d+(\/log\?lines=100)?$/.test(req.url)) {
      const id = Number(req.url.split('/')[2]);
      data.detailRequests.push(req.url);
      const value = req.url.includes('/log') ? { lines: [...(data.agentLogs[id] || [])] } : { ...data.agents.find(a => a.id === id) };
      if (data.detailDelay) await new Promise(resolve => setTimeout(resolve, data.detailDelay));
      if (data.detailFailure) { res.statusCode = 503; return send({ error: 'Offline' }); }
      return send(value);
    }
    if (req.url === '/threads') {
      const t = { id: data.threads.length + 1, ...body, members:[...(body.include_user === false ? [] : [0]),...(body.members || [])], messages: [] };
      data.threads.push(t);
      return send({ id: t.id });
    }
    if (req.url.startsWith('/threads/')) {
      const t=data.threads.find(t=>t.id===Number(req.url.split('/')[2]));
      if(req.url.endsWith('/read')) {
        if(data.readDelay) await new Promise(resolve => setTimeout(resolve, data.readDelay));
        if(data.readFailure) {res.statusCode=503;return send({error:'Offline'});}
        data.reads[t.id]=Math.max(data.reads[t.id] || 0,body.message);
        return send({last_read:data.reads[t.id],unread:unread(t)});
      }
      if(req.url.endsWith('/user')) t.members=body.joined ? [...new Set([0,...t.members])] : t.members.filter(id=>id!==0);
      if(req.url.endsWith('/members')) t.members=[...new Set([...t.members,...body.members])];
      return send({...t,last_read:data.reads[t.id] || 0,unread:unread(t)});
    }
    if (req.url === '/messages') {
      if (data.messageDelay) await new Promise(resolve => setTimeout(resolve, data.messageDelay));
      if (data.messageFailure) { res.statusCode = 503; return send({error:'Message send failed'}); }
      const t = data.threads.find(t => t.id === body.thread);
      t.members=[...new Set([0,...t.members])];
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
  await page.locator('#thread-form details summary').click();
  await page.locator('#thread-form [name=members]').fill('1, group:review');
  await page.locator('#thread-form button.primary').click();
  await page.locator('#message-form').waitFor();
  assert.equal(await page.locator('#thread-form [name=title]').inputValue(), '');
  assert.deepEqual(data.threads[0].members, [0, '1', 'group:review']);
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
  await page.locator('[data-thread-filter=all]').click();
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
  assert.equal(await page.locator('[form=settings-form]').isDisabled(), true);
  await page.locator('[data-prompt-editor] summary').click();
  await page.locator('[name=prompt_launch]').fill('Changed launch guidance');
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

test('replacement, limit and crash reasons remain visible with matching controls', async () => fixture(async (page, data) => {
  data.agents = [
    { id: 1, name: 'Replaced agent', project: 1, state: 'replaced', problem: 'Prior stream failure <example>', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
    { id: 2, name: 'Limit agent', project: 1, state: 'paused', pause_reason: 'limit', problem: 'Usage limit reached' },
    { id: 3, name: 'Crash agent', project: 1, state: 'crashed', problem: 'Stream disconnected' },
  ];
  await page.reload();
  await page.locator('[data-agent="1"]').waitFor();
  assert.equal(await page.locator('[data-agent="1"] .problem').textContent(), 'Previous crash: Prior stream failure <example>');
  assert.deepEqual(await page.locator('[data-agent="1"] [data-action]').evaluateAll(buttons => buttons.map(button => button.dataset.action)), ['details']);
  assert.equal(await page.locator('[data-agent="1"] .pill').textContent(), 'replaced');
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
  assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '8');
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
  await page.waitForFunction(() => document.querySelector('#config-select')?.value === '2');
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
  assert.equal(data.projects[0].config, 3);
  assert.equal(data.configs[2].settings.limits.active.hard, 12);
  assert.equal(data.settings.limits.active.hard, 8);
  assert.equal(await page.locator('#remove-config').isDisabled(), true);
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('#config-select')?.value === '2');
  await page.locator('#config-select').selectOption('3');
  await saveSettings(page);
  assert.deepEqual(data.projects.map(p => p.config), [3, 3]);
  await page.locator('[name=config_name]').fill('Bigger jobs');
  await saveSettings(page);
  assert.equal(data.configs[2].name, 'Bigger jobs');
  for (const project of ['1', '2']) {
    await page.locator('#project-select').selectOption(project);
    await page.waitForFunction(() => !!document.querySelector('#config-select'));
    await page.locator('#config-select').selectOption('1');
    await saveSettings(page);
  }
  await page.locator('#config-select').selectOption('3');
  assert.equal(await page.locator('#remove-config').isEnabled(), true);
  page.once('dialog', d => d.accept()); await page.locator('#remove-config').click();
  await page.waitForFunction(() => !document.querySelector('#config-select option[value="3"]'));
  assert.equal(data.configs.length, 2);
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
  assert.equal(data.configs.length, 2);
  assert.equal(data.projects[0].config, 2);
}));

test('project/config switches ask before discarding drafts, and cancelled switches keep them', async () => fixture(async page => {
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-limit=active] [name=hard]').fill('9');
  for (const selector of ['#project-select', '#config-select']) {
    page.once('dialog', d => d.dismiss());
    await page.locator(selector).selectOption(selector === '#project-select' ? '2' : 'custom');
    assert.equal(await page.locator(selector).inputValue(), selector === '#project-select' ? '1' : '2');
    assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '9');
  }
  page.once('dialog', d => d.accept());
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('[data-limit=active] [name=hard]')?.value === '8');
}));

test('config selection alone survives polling and switches without discard confirmations', async () => fixture(async (page, data) => {
  let dialogs = 0;
  page.on('dialog', dialog => { dialogs++; dialog.dismiss(); });
  await page.locator('[data-page=settings]').click();
  for (const config of ['1','2','1','2','1']) {
    await page.locator('#config-select').selectOption(config);
    await page.evaluate(() => refresh());
    assert.equal(await page.locator('#config-select').inputValue(), config);
    assert.equal(await page.evaluate(() => state.editor.dirty), false);
  }
  assert.equal(dialogs, 0);
  assert.equal(data.requests.length, 0, 'selection requires explicit Save to apply');
  assert.equal(await page.locator('[form=settings-form]').isEnabled(), true);
  await saveSettings(page);
  assert.equal(data.projects[0].config, 1);
  assert.deepEqual(data.requests, [{url:'/projects/1/config',method:'PUT',body:{config:1}}]);
  assert.equal(await page.locator('[form=settings-form]').isDisabled(), true);
  await page.locator('#config-select').selectOption('2');
  await page.locator('#config-select').selectOption('1');
  assert.equal(dialogs, 0);
  assert.equal(await page.locator('[form=settings-form]').isDisabled(), true);
}));

test('Save reflects semantic settings, names and bindings; reverted edits leave the applied config unchanged', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  const save = page.locator('[form=settings-form]');
  assert.equal(await save.isDisabled(), true);
  assert.equal(await page.locator('#config-applied').textContent(), 'Applied configuration: Mine');
  await page.locator('[data-limit=active] [name=hard]').fill('9');
  assert.equal(await save.isEnabled(), true);
  await page.locator('[data-limit=active] [name=hard]').fill('08');
  assert.equal(await save.isDisabled(), true, 'numeric spelling alone is not a settings change');
  await page.locator('[name=config_name]').fill('Mine renamed');
  assert.equal(await save.isEnabled(), true);
  await page.locator('[name=config_name]').fill(' Mine ');
  assert.equal(await save.isDisabled(), true, 'names are trimmed by the backend');
  await page.locator('[name=auto_resume]').uncheck();
  assert.equal(await save.isEnabled(), true);
  await page.locator('[name=auto_resume]').check();
  assert.equal(await save.isDisabled(), true);
  await page.locator('#config-select').selectOption('1');
  assert.equal(await save.isEnabled(), true);
  assert.equal(await page.locator('#config-applied').textContent(), 'Applied configuration: Mine');
  await page.locator('#config-select').selectOption('2');
  assert.equal(await save.isDisabled(), true);
  await page.locator('#add-retry-rule').click();
  assert.equal(await save.isEnabled(), true);
  await page.locator('[data-remove-retry]').click();
  assert.equal(await save.isDisabled(), true);
  await page.locator('#config-select').selectOption('custom');
  assert.equal(await save.isEnabled(), true, 'Custom is a real binding change even with matching settings');
  await page.locator('#config-select').selectOption('2');
  assert.equal(await save.isDisabled(), true);
  assert.deepEqual(data.requests, []);
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('#config-select')?.value === '2');
  assert.equal(await save.isDisabled(), true);
}));

test('Default is read-only, copied settings are editable, and busy restoration preserves read-only controls', async () => fixture(async (page, data) => {
  data.settings.limits.active.hard = 9;
  data.writeDelay = 250;
  const originalDefault = structuredClone(data.configs[0].settings);
  await page.reload(); await page.locator('[data-page=settings]').click();
  await page.locator('#config-select').selectOption('1');
  assert.match(await page.locator('#config-scope').textContent(), /Default is read-only.*Selection is not applied yet/);
  assert.equal(await page.locator('#config-select').isEnabled(), true);
  assert.equal(await page.locator('#save-config-as').isEnabled(), true);
  for (const selector of ['[data-limit=active] [name=hard]','[name=auto_resume]','[name=prompt_launch]','[data-harness=codex] [name=model]','#add-retry-rule']) {
    assert.equal(await page.locator(selector).isDisabled(), true, selector);
  }
  await saveSettings(page);
  assert.equal(await page.locator('[data-limit=active] [name=hard]').isDisabled(), true);
  assert.equal(await page.locator('[name=prompt_launch]').isDisabled(), true);
  assert.equal(await page.locator('#config-select').isEnabled(), true);
  assert.equal(await page.locator('#save-config-as').isEnabled(), true);
  await page.locator('#save-config-as').click();
  await page.locator('#config-form [name=name]').fill('Personal');
  await page.locator('#config-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#config-dialog').open);
  assert.equal(data.projects[0].config, 3);
  assert.equal(await page.locator('[data-limit=active] [name=hard]').isEnabled(), true);
  await page.locator('[data-limit=active] [name=hard]').fill('12'); await saveSettings(page);
  assert.equal(data.configs[2].settings.limits.active.hard, 12);
  assert.deepEqual(data.configs[0].settings, originalDefault);
  assert.equal(data.settings.limits.active.hard, 9, 'Mine persists independently of Default and copies');
  assert.equal(data.requests.some(request => request.url === '/configs/1'), false);
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

test('without projects Default is read-only while Mine and copied configs remain editable', async () => fixture(async (page, data) => {
  data.projects = []; await page.reload();
  await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator('[data-limit=active] [name=hard]').isDisabled(), true);
  assert.equal(await page.locator('[form=settings-form]').isDisabled(), true);
  await page.locator('#config-select').selectOption('2');
  await page.locator('[data-limit=active] [name=hard]').fill('9');
  await saveSettings(page);
  assert.equal(data.settings.limits.active.hard, 9);
  await page.locator('#save-config-as').click();
  await page.locator('#config-form [name=name]').fill('Unused');
  await page.locator('#config-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#config-dialog').open);
  assert.equal(await page.locator('#config-select').inputValue(), '3');
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
  assert.equal(data.projects[0].config, 2);
  assert.equal(data.settings.limits.active.hard, 9);
}));

test('folder browsing starts at home, navigates, creates and chooses a new folder', async () => fixture(async (page,data)=> {
  await page.locator('[data-open=project-dialog]').click();
  await page.locator('#browse-project').click();
  await page.waitForFunction(()=>document.querySelector('#folder-path').textContent==='/home/example');
  assert.match(await page.locator('#folder-list').textContent(),/note.txt.*File/);
  await page.locator('[data-folder="/home/example/work"]').click();
  await page.waitForFunction(()=>document.querySelector('#folder-path').textContent==='/home/example/work');
  await page.locator('#folder-form [name=name]').fill('../unsafe');
  await page.locator('#folder-form [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#folder-error').textContent.includes('not a path'));
  await page.locator('#folder-form [name=name]').fill('new project');
  await page.locator('#folder-form [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#folder-path').textContent.endsWith('/new project'));
  await page.locator('#folder-use').click();
  assert.equal(await page.locator('#project-form [name=path]').inputValue(),'/home/example/work/new project');
  await page.locator('#project-form button.primary').click();
  await page.waitForFunction(()=>!document.querySelector('#project-dialog').open);
  assert.equal(data.projects.at(-1).path,'/home/example/work/new project');
}));

test('thread member picker is searchable and supports active/all selections without typing IDs',async()=>fixture(async(page,data)=> {
  data.agents=[{id:1,project:1,name:'Reviewer',state:'working',harness:'codex',model:'gpt-6-luna'}, {id:2,project:1,name:'Writer',state:'paused',harness:'claude',model:'claude-sonnet-5-5'}];
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-open=thread-dialog]').click();
  await page.locator('#thread-form [name=title]').fill('Easy members');
  await page.locator('[data-member-pick=active]').click();
  assert.equal(await page.locator('[name=member][value="1"]').isChecked(),true);
  assert.equal(await page.locator('[name=member][value="2"]').isChecked(),false);
  await page.locator('[data-member-search]').fill('Writer');
  assert.equal(await page.locator('[data-member-row]').filter({hasText:'Reviewer'}).isVisible(),false);
  await page.locator('[name=member][value="2"]').check();
  await page.locator('#thread-form button.primary').click();
  await page.locator('#message-form').waitFor();
  assert.deepEqual(data.requests.find(r=>r.url==='/threads').body.members,['1','2']);
  assert.equal(data.requests.find(r=>r.url==='/threads').body.include_user,true);
}));

test('thread filters distinguish participation; joining, leaving and adding members work',async()=>fixture(async(page,data)=> {
  data.agents=[{id:1,project:1,name:'One',state:'idle'},{id:2,project:1,name:'Two',state:'paused'}];
  data.threads=[{id:1,project:1,title:'Mine',members:[0,1],messages:[]},{id:2,project:1,title:'Agents talking',members:[1],messages:[]}];
  await page.reload(); await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('[data-thread]').count(),1);
  await page.locator('[data-thread-filter=all]').click();
  assert.equal(await page.locator('[data-thread]').count(),2);
  await page.locator('[data-thread="2"]').click();
  await page.locator('#thread-membership').waitFor();
  assert.equal(await page.locator('#thread-membership').textContent(),'Join thread');
  await page.locator('#thread-membership').click();
  await page.waitForFunction(()=>document.querySelector('#thread-membership').textContent==='Leave thread');
  assert.ok(data.threads[1].members.includes(0));
  await page.locator('#add-thread-members').click();
  assert.equal(await page.locator('#add-member-picker [name=member]').count(),1);
  await page.locator('#add-member-picker [name=member]').check();
  await page.locator('#members-form button.primary').click();
  await page.waitForFunction(()=>!document.querySelector('#members-dialog').open);
  assert.ok(data.threads[1].members.includes('2'));
  await page.locator('#thread-membership').click();
  await page.waitForFunction(()=>document.querySelector('#thread-membership').textContent==='Join thread');
  await page.locator('[data-thread-filter=agents]').click();
  assert.equal(await page.locator('[data-thread]').count(),1);
}));

test('live thread creation sends explicit state/group filters, retains user choice and never sends fixed members', async () => fixture(async (page, data) => {
  await page.locator('[data-page=threads]').click();
  const cases = [
    {states:['working'],groups:'',include:true},
    {states:['idle'],groups:'',include:true},
    {states:['working','idle'],groups:'review, writing',include:false},
    {states:['paused','done'],groups:'review',include:true},
    {states:[],groups:'review',include:true},
  ];
  for (const [index, c] of cases.entries()) {
    await page.locator('[data-open=thread-dialog]').click();
    await page.locator('#thread-form [name=title]').fill(`Live ${index}`);
    await page.locator('#thread-mode').selectOption('live');
    for (const input of await page.locator('[name=watch_state]').all()) await input.setChecked(c.states.includes(await input.inputValue()));
    await page.locator('[name=watch_groups]').fill(c.groups);
    await page.locator('[name=include_user]').setChecked(c.include);
    assert.equal(await page.locator('#thread-fixed-members').isHidden(), true);
    assert.equal(await page.locator('#thread-form [name=members]').isDisabled(), true);
    await page.locator('#thread-form button.primary').click();
    await page.waitForFunction(id => document.querySelector('#message-form')?.dataset.draftThread === String(id), index + 1);
    const request = data.requests.filter(r => r.url === '/threads').at(-1).body;
    assert.deepEqual([...request.watch].sort(), [...c.states,...c.groups.split(',').map(g=>g.trim()).filter(Boolean).map(g=>`group:${g}`)].sort());
    assert.equal(Object.hasOwn(request, 'members'), false);
    assert.equal(request.include_user, c.include);
    assert.match(await page.locator('#thread-watch').textContent(), /Live filters:/);
    assert.equal(await page.locator('#add-thread-members').isHidden(), true);
    assert.equal(await page.locator('#thread-mode').inputValue(), 'fixed');
  }
}));

test('empty live filters are rejected locally and switching back to fixed members drops watch fields', async () => fixture(async (page, data) => {
  await page.locator('[data-page=threads]').click();
  await page.locator('[data-open=thread-dialog]').click();
  await page.locator('#thread-form [name=title]').fill('Chosen members');
  await page.locator('#thread-mode').selectOption('live');
  await page.locator('[name=watch_state][value=working]').uncheck();
  await page.locator('[name=watch_state][value=idle]').uncheck();
  await page.locator('#thread-form button.primary').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('at least one state or group'));
  assert.deepEqual(data.requests, []);
  await page.locator('[name=watch_groups]').fill('review');
  await page.locator('#thread-mode').selectOption('fixed');
  await page.locator('#thread-form button.primary').click();
  await page.locator('#message-form').waitFor();
  assert.deepEqual(data.requests.find(r => r.url === '/threads').body, {project:1,title:'Chosen members',members:[],include_user:true});
}));

test('live threads expose escaped membership history and mark outside-membership messages without counting them unread', async () => fixture(async (page, data) => {
  data.threads = [conversation([{...incoming(1,'Before you joined'),outside_membership:true},{...incoming(2,'Current reply'),membership_unknown:true}], {
    watch:['working','idle','group:review'],events_more:true,
    events:[{id:1,at:1,kind:'thread.joined',agent:1,actor:'user',details:{reason:'group <review> matched'}}],
  })];
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.locator('[data-thread="1"]').click();
  await page.locator('#thread-history').waitFor();
  assert.equal(await page.locator('#add-thread-members').isHidden(), true);
  assert.equal(await page.locator('#thread-membership').textContent(), 'Leave thread');
  assert.equal(await page.locator('[data-message="1"] .pill').textContent(), 'Outside your membership');
  assert.match(await page.locator('[data-message="2"] .message-head').textContent(), /Membership at send time unknown/);
  assert.equal(await page.locator('[data-message="2"] .pill').count(), 0);
  assert.match(await page.locator('#unread-total').textContent(), /1 unread/);
  await page.locator('#thread-history summary').click();
  assert.match(await page.locator('#thread-events').textContent(), /agent 1 joined.*group <review> matched/);
  assert.match(await page.locator('#thread-events').textContent(), /Earlier membership events are not shown/);
  assert.equal(await page.locator('#thread-events review').count(), 0);
  data.threads[0].events.push({id:2,at:2,kind:'thread.left',agent:1,actor:'system',details:{reason:'state changed'}});
  data.threads[0].members = [0];
  await page.evaluate(() => refresh());
  assert.match(await page.locator('#thread-events').textContent(), /agent 1 left.*state changed/);
  assert.equal(await page.locator('#thread-history').evaluate(el=>el.open), true, 'polling preserves the opened history');
  await page.evaluate(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  assert.equal(data.reads[1], 2);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length, 1);
  await page.locator('#thread-membership').click();
  await page.waitForFunction(() => document.querySelector('#thread-membership').textContent === 'Join thread');
  assert.equal(await page.locator('#add-thread-members').isHidden(), true);
}));

test('prompt guidance is literal and polling/recovery settings persist in configs',async()=>fixture(async(page,data)=> {
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-prompt-editor] summary').click();
  const text='Keep {task}, {updates}, $HOME and <tag> literal.';
  await page.locator('[name=prompt_resume]').fill(text);
  await page.locator('[name=usage_poll_secs]').fill('45');
  await page.locator('[name=auto_resume]').uncheck();
  await saveSettings(page); await page.reload(); await page.locator('[data-page=settings]').click();
  await page.locator('[data-prompt-editor] summary').click();
  assert.equal(await page.locator('[name=prompt_resume]').inputValue(),text);
  assert.equal(data.settings.prompts.resume,text);
  assert.equal(await page.locator('[name=usage_poll_secs]').inputValue(),'45');
  assert.equal(await page.locator('[name=auto_resume]').isChecked(),false);
}));

test('usage details show expired readings as unconfirmed and offer a status check',async()=>fixture(async(page,data)=> {
  data.settings.limits.usage={codex:{soft:null,hard:null}};
  data.usage=[{provider:'codex',win:'primary',used_pct:100,resets_at:Math.floor(Date.now()/1000)-60}];
  data.checks=[{provider:'codex',checked_at:1,next_check:Math.floor(Date.now()/1000)+30,error:'Provider unavailable'}];
  await page.reload(); await page.locator('[data-usage=codex]').click();
  assert.match(await page.locator('#usage-details').textContent(),/100%.*awaiting confirmation/s);
  assert.match(await page.locator('#usage-details').textContent(),/Provider unavailable/);
  await page.locator('[data-check-usage=codex]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Usage check scheduled');
  assert.equal(data.requests.at(-1).url,'/usage/check');
}));

test('a previously rejected model has an explicit warning and no silent replacement',async()=>fixture(async(page,data)=> {
  data.agents=[{id:1,project:1,state:'crashed',harness:'codex',model:'gpt-6.1-sol',problem:'Model not supported with this account'}];
  await page.reload(); await openLaunch(page); await page.locator('#launch-harness').selectOption('codex');
  assert.equal(await page.locator('#launch-model').inputValue(),'gpt-6.1-sol');
  assert.match(await page.locator('#launch-model-warning').textContent(),/previous launch rejected/);
  await page.locator('#launch-model').selectOption('gpt-6-luna');
  assert.equal(await page.locator('#launch-model-warning').isHidden(),true);
  assert.equal(data.requests.length,0);
}));

test('model errors offer an explicit alternative launch while retaining the original agent',async()=>fixture(async(page,data)=> {
  data.agents=[{id:1,project:1,name:'Unavailable',state:'crashed',harness:'codex',model:'gpt-6.1-sol',task:'Original task',problem:'Model not supported with this account'}];
  await page.reload();
  assert.equal(await page.locator('[data-action=resume]').textContent(),'Retry same model');
  await page.locator('[data-action=another-model]').click();
  assert.equal(await page.locator('#launch-form [name=task]').inputValue(),'Original task');
  assert.equal(await page.locator('#launch-harness').inputValue(),'codex');
  await page.locator('#launch-model').selectOption('gpt-6-luna');
  await page.locator('#launch-form button.primary').click();
  await page.waitForFunction(()=>!document.querySelector('#launch-dialog').open);
  assert.equal(data.requests.at(-1).body.model,'gpt-6-luna');
  assert.equal(data.agents[0].model,'gpt-6.1-sol');
}));

test('generic crashed turns offer same-model retry and explicit alternative without changing paused controls', async () => fixture(async (page, data) => {
  data.agents = [
    {id:1,project:1,name:'Failed turn',state:'crashed',harness:'codex',model:'gpt-6.1-sol',effort:'high',task:'Continue the original task',problem:'Stream failed: cyber-risk error'},
    {id:2,project:1,name:'Quota pause',state:'paused',pause_reason:'limit',harness:'codex',model:'gpt-6.1-sol',effort:'high'},
    {id:3,project:1,name:'Manual pause',state:'paused',pause_reason:'user',harness:'claude',model:'claude-opus-5-5',effort:'medium'},
  ];
  await page.reload();
  const crash = page.locator('[data-agent="1"]');
  assert.equal(await crash.locator('[data-action=resume]').textContent(), 'Retry same model');
  assert.equal(await crash.locator('[data-action=another-model]').textContent(), 'Launch another model…');
  assert.equal(await page.locator('[data-agent="2"] [data-action=resume]').textContent(), 'Resume');
  assert.equal(await page.locator('[data-agent="3"] [data-action=resume]').textContent(), 'Resume');
  await crash.locator('[data-action=another-model]').click();
  assert.equal(await page.locator('#launch-harness').inputValue(), 'codex');
  assert.equal(await page.locator('#launch-form [name=task]').inputValue(), 'Continue the original task');
  assert.equal(data.requests.length, 0, 'opening an alternative does not relaunch or rewrite the original');
  await page.locator('[data-close=launch-dialog]').click();
  await crash.locator('[data-action=resume]').click();
  await page.waitForFunction(() => document.querySelector('[data-agent="1"] .pill').textContent === 'working');
  assert.deepEqual(data.requests.at(-1), {url:'/agents/1/resume',method:'POST',body:{}});
  assert.equal(data.agents[0].model, 'gpt-6.1-sol');
}));

test('cancelling member selection preserves a draft only within its project',async()=>fixture(async(page,data)=> {
  data.agents=[{id:1,project:1,name:'First',state:'working'},{id:2,project:2,name:'Second',state:'idle'}];
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-open=thread-dialog]').click();
  await page.locator('[name=member][value="1"]').check();
  await page.locator('[name=include_user]').uncheck();
  await page.locator('[data-close=thread-dialog]').click();
  await page.locator('[data-open=thread-dialog]').click();
  assert.equal(await page.locator('[name=member][value="1"]').isChecked(),true);
  assert.equal(await page.locator('[name=include_user]').isChecked(),false);
  await page.locator('[data-close=thread-dialog]').click();
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(()=>document.querySelector('#project-path').textContent==='/projects/other');
  await page.locator('[data-open=thread-dialog]').click();
  assert.equal(await page.locator('[name=member][value="2"]').isChecked(),false);
  assert.equal(await page.locator('[name=include_user]').isChecked(),true);
}));

const incoming = (id, text = `Message ${id}`) => ({ id, sender: 1, text, at: 1 });
const conversation = (messages, extra = {}) => ({ id: 1, project: 1, title: 'Review', members: [0, 1], messages, ...extra });

test('unread badges span projects, exclude own and agent-only messages, and persist across reloads', async () => fixture(async (page, data) => {
  data.threads = [
    conversation([incoming(1), { ...incoming(2), sender: 0 }]),
    conversation([incoming(3)], { id: 2, project: 2 }),
    conversation([incoming(4)], { id: 3, members: [1] }),
  ];
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#unread-total').textContent === '2 unread');
  await page.setViewportSize({width:375,height:800});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.match(await page.title(), /^\(2\)/);
  assert.match(await page.locator('#project-select option[value="2"]').textContent(), /1 unread/);
  await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread-filter=unread]').click();
  assert.equal(await page.locator('.thread-row').count(), 1);
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').textContent === '1 unread');
  assert.equal(data.reads[1], 2);
  assert.equal(await page.locator('.thread-row').count(), 0);
  await page.reload();
  await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('.thread-row').count(), 0);
  assert.equal(data.reads[2], undefined);
  await page.locator('#project-select').selectOption('2');
  await page.locator('[data-thread="2"]').waitFor();
  await page.locator('[data-thread="2"]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  assert.doesNotMatch(await page.title(), /^\(/);
}));

test('closing a thread keeps membership and read history while future messages stay unread until reopened', async () => fixture(async (page, data) => {
  data.threads = [conversation([incoming(1)])];
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  assert.equal(data.reads[1], 1);
  await page.locator('#close-thread').click();
  assert.equal(await page.locator('#thread-main').textContent(), 'Select a thread');
  assert.equal(await page.locator('.thread-row.active').count(), 0);
  assert.deepEqual(data.threads[0].members, [0, 1]);
  assert.equal(data.reads[1], 1, 'closing does not undo an acknowledged read');
  const readsBefore = data.requests.filter(r => r.url.endsWith('/read')).length;
  data.threads[0].messages.push(incoming(2, 'After closing'));
  // Normal polling updates badges, but must not reopen or acknowledge the thread.
  await page.waitForFunction(() => document.querySelector('#unread-total').textContent === '1 unread');
  await page.waitForTimeout(2100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await page.locator('#thread-main').textContent(), 'Select a thread');
  assert.equal(data.reads[1], 1);
  assert.equal(data.requests.filter(r => r.url.endsWith('/read')).length, readsBefore);
  assert.equal(data.requests.filter(r => r.url.endsWith('/user')).length, 0, 'Close is not Leave');
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  assert.equal(data.reads[1], 2);
  assert.equal(await page.locator('[data-message="2"] .message-text').textContent(), 'After closing');
}));

test('X dismissal preserves separate thread and project drafts across switching and reload without confirmation', async () => fixture(async (page, data) => {
  data.threads = [conversation([]), conversation([], {id:2,title:'Other thread'}), conversation([], {id:3,project:2,title:'Other project'})];
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Keep my draft');
  let confirmations = 0;
  page.on('dialog', dialog => { confirmations++; dialog.dismiss(); });
  assert.equal(await page.getByRole('button',{name:'Close conversation'}).textContent(), '×');
  await page.locator('[data-thread="2"]').click();
  await page.waitForFunction(() => document.querySelector('#message-form')?.dataset.draftThread === '2');
  assert.equal(await page.locator('#message-form textarea').inputValue(), '');
  await page.locator('#message-form textarea').fill('Second thread draft');
  await page.locator('#close-thread').click();
  assert.equal(await page.locator('#thread-main').textContent(), 'Select a thread');
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Keep my draft');
  await page.locator('#project-select').selectOption('2');
  await page.locator('[data-thread="3"]').click();
  await page.locator('#message-form textarea').fill('Other project draft');
  await page.reload(); await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('#thread-main').textContent(), 'Select a thread');
  await page.locator('[data-thread="3"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Other project draft');
  await page.locator('#project-select').selectOption('1');
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Keep my draft');
  await page.locator('[data-thread="2"]').click();
  await page.waitForFunction(() => document.querySelector('#message-form')?.dataset.draftThread === '2');
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Second thread draft');
  assert.equal(confirmations, 0);
  assert.deepEqual(data.threads[0].members, [0, 1]);
  assert.equal(data.requests.length, 0);
}));

test('failed sends keep persistent drafts and successful sends clear only the submitted draft', async () => fixture(async (page, data) => {
  data.threads = [conversation([])]; data.messageFailure = true;
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Unsent message');
  await page.locator('#message-form button').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Message send failed');
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Unsent message');
  data.messageFailure = false;
  await page.locator('#message-form button').click();
  await page.waitForFunction(() => document.querySelector('#message-form textarea').value === '');
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), '');
  assert.equal(data.threads[0].messages[0].text, 'Unsent message');
}));

test('a delayed successful send preserves newer text even when the pane is closed and reopened', async () => fixture(async (page, data) => {
  data.threads = [conversation([])]; data.messageDelay = 600;
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Submitted snapshot');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/messages');
  await page.locator('#message-form button').click();
  await page.locator('#message-form textarea').fill('Newer draft');
  await page.locator('#close-thread').click();
  await response;
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Newer draft');
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Newer draft');
  assert.deepEqual(data.threads[0].messages.map(m => m.text), ['Submitted snapshot']);
  const secondResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/messages');
  await page.locator('#message-form button').click();
  await page.locator('#message-form textarea').fill('');
  await page.locator('#message-form textarea').fill('Newer draft');
  await secondResponse;
  await page.waitForFunction(() => !document.querySelector('#message-form button').disabled);
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Newer draft', 'new input is retained even if it matches the submitted text');
}));

test('unavailable browser storage keeps drafts in-tab and reports the persistence limit without breaking the UI', async () => fixture(async (page, data) => {
  data.threads = [conversation([])];
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {get() {throw new Error('Storage blocked');}}));
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('In-tab draft');
  assert.match(await page.locator('#toast').textContent(), /browser storage is unavailable/);
  await page.locator('#close-thread').click();
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'In-tab draft');
  await page.locator('[data-thread-filter=all]').click();
  assert.equal(data.requests.length, 0);
}));

test('a pending thread fetch cannot reopen or auto-read a thread after Close', async () => fixture(async (page, data) => {
  data.threads = [conversation([incoming(1)])];
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/threads/1', async route => { await gate; await route.continue(); });
  data.threads[0].messages.push(incoming(2, 'While fetch was pending'));
  const pending = page.waitForRequest(r => new URL(r.url()).pathname === '/threads/1');
  await page.evaluate(() => { window.pendingThread = refreshThread(); });
  await pending;
  await page.locator('#close-thread').click();
  release();
  await page.evaluate(async () => { await window.pendingThread; });
  await page.unroute('**/threads/1');
  await page.evaluate(() => refresh());
  assert.equal(await page.locator('#thread-main').textContent(), 'Select a thread');
  assert.match(await page.locator('#unread-total').textContent(), /1 unread/);
  assert.equal(data.reads[1], 1);
  assert.deepEqual(data.threads[0].members, [0, 1]);
  assert.equal(data.requests.filter(r => r.url.endsWith('/read')).length, 1);
}));

test('background, other pages and dialogs do not clear unread messages', async () => fixture(async (page, data) => {
  data.threads = [conversation([])];
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Keep my draft');
  await page.evaluate(() => { document.hasFocus = () => false; });
  data.threads[0].messages.push(incoming(1));
  await page.evaluate(() => refresh());
  assert.equal(data.reads[1], undefined);
  assert.match(await page.locator('#thread-unread').textContent(), /1 unread/);
  await page.evaluate(() => {
    delete document.hasFocus;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.dispatchEvent(new Event('focus'));
  });
  await page.evaluate(() => refresh());
  assert.equal(data.reads[1], undefined);
  await page.locator('[data-page=overview]').click();
  await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => refresh());
  assert.equal(data.reads[1], undefined);
  await page.evaluate(() => document.querySelector('#thread-dialog').showModal());
  await page.evaluate(async () => {
    document.querySelector('#page-overview').classList.remove('active');
    document.querySelector('#page-threads').classList.add('active');
    await refresh();
  });
  assert.equal(data.reads[1], undefined);
  await page.locator('[data-close=thread-dialog]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  assert.equal(data.reads[1], 1);
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Keep my draft');
}));

test('scrolling history leaves new messages unread until jumping to latest', async () => fixture(async (page, data) => {
  data.threads = [conversation(Array.from({ length: 30 }, (_, i) => incoming(i + 1, 'History\n'.repeat(4))))];
  data.reads[1] = 30;
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Unsent reply');
  await page.locator('#messages').evaluate(el => { el.scrollTop = 100; });
  await page.waitForTimeout(100);
  data.threads[0].messages.push(incoming(31, '<script>unsafe()</script>'));
  // Let the normal live poll deliver the new message.
  await page.locator('[data-message="31"]').waitFor();
  assert.equal(data.reads[1], 30);
  assert.equal(await page.locator('#messages').evaluate(el => el.scrollTop), 100);
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Unsent reply');
  assert.equal(await page.locator('[data-message="31"] script').count(), 0);
  await page.locator('#thread-unread').click();
  await page.waitForFunction(() => document.querySelector('#thread-unread').hidden);
  assert.equal(data.reads[1], 31);
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Unsent reply');
}));

test('a failed read acknowledgement keeps badges and retries without losing the draft', async () => fixture(async (page, data) => {
  data.threads = [conversation([incoming(1)])]; data.readFailure = true;
  await page.reload(); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#thread-read-error').waitFor();
  assert.equal(data.reads[1], undefined);
  assert.match(await page.locator('#unread-total').textContent(), /1 unread/);
  await page.locator('#message-form textarea').fill('Still here');
  data.readFailure = false;
  await page.waitForFunction(() => document.querySelector('#thread-read-error').hidden);
  assert.equal(data.reads[1], 1);
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Still here');
}));

test('a delayed read acknowledgement cannot clear a reply absent from its snapshot', async () => fixture(async (page, data) => {
  data.threads = [conversation([incoming(1)])]; data.readDelay = 800;
  await page.reload(); await page.locator('[data-page=threads]').click();
  const ack = page.waitForRequest(r => r.url().endsWith('/read'));
  await page.locator('[data-thread="1"]').click(); await ack;
  await page.evaluate(() => { document.hasFocus = () => false; });
  data.threads[0].messages.push(incoming(2, 'Reply after the snapshot'));
  await page.evaluate(() => refresh());
  await page.waitForFunction(() => document.querySelector('#thread-unread').textContent.startsWith('1 unread'));
  assert.equal(data.reads[1], 1);
  assert.match(await page.locator('#unread-total').textContent(), /1 unread/);
  assert.equal(data.requests.filter(r => r.url.endsWith('/read')).at(-1).body.message, 1);
  data.readDelay = 0;
  await page.evaluate(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  assert.equal(data.reads[1], 2);
}));

test('open details update status and logs, preserve history scroll and recover from errors', async () => fixture(async (page, data) => {
  data.agents = [{ id: 1, project: 1, name: 'Worker', state: 'working', status: 'Starting', locks: [], lost_locks: [] }];
  data.agentLogs[1] = Array.from({ length: 80 }, (_, i) => `Line ${i}`);
  await page.reload(); await page.locator('[data-action=details]').click();
  await page.waitForFunction(() => document.querySelector('#agent-detail-status').textContent.startsWith('Live'));
  assert.equal(await page.locator('#agent-log').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 20), true);
  await page.locator('#agent-log').evaluate(el => { el.scrollTop = 35; });
  data.delays = {1:3000}; // Details must not wait for a slow overview response.
  data.agents[0].status = 'Running tests'; data.agents[0].state = 'idle';
  data.agentLogs[1].push('<img src=x onerror=unsafe()>');
  await page.waitForFunction(() => document.querySelector('#agent-log').textContent.includes('<img'));
  assert.match(await page.locator('#agent-details').textContent(), /Running tests/);
  assert.match(await page.locator('#agent-details').textContent(), /idle/);
  assert.equal(await page.locator('#agent-log img').count(), 0);
  assert.equal(await page.locator('#agent-log').evaluate(el => el.scrollTop), 35);
  data.delays = {};
  data.detailFailure = true;
  await page.waitForFunction(() => document.querySelector('#agent-detail-status').textContent.includes('Updates unavailable'));
  assert.match(await page.locator('#agent-log').textContent(), /<img/);
  data.detailFailure = false; data.agentLogs[1].push('Recovered');
  await page.waitForFunction(() => document.querySelector('#agent-log').textContent.endsWith('Recovered'));
  await page.locator('#agent-dialog button[value=cancel]').click();
  await page.waitForTimeout(100);
  const requests = data.detailRequests.length;
  await page.waitForTimeout(2200);
  assert.equal(data.detailRequests.length, requests, 'closed details stop fetching');
}));

test('closing pending details and opening another agent ignores old responses', async () => fixture(async (page, data) => {
  data.agents = [1, 2].map(id => ({ id, project: 1, name: `Worker ${id}`, state: 'working' }));
  data.agentLogs = { 1: ['Old log'], 2: ['New log'] };
  await page.reload(); data.detailDelay = 1000;
  await page.locator('[data-action=details][data-id="1"]').click();
  await page.locator('#agent-dialog button[value=cancel]').click();
  data.detailDelay = 0;
  await page.locator('[data-action=details][data-id="2"]').click();
  await page.waitForFunction(() => document.querySelector('#agent-title').textContent === 'Worker 2 · #2');
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#agent-title').textContent(), 'Worker 2 · #2');
  assert.equal(await page.locator('#agent-log').textContent(), 'New log');
  assert.equal(await page.locator('#agent-dialog').isVisible(), true);
  await page.locator('#agent-dialog button[value=cancel]').click();
  data.detailDelay = 800;
  await page.locator('[data-action=details][data-id="1"]').click();
  await page.locator('#agent-dialog button[value=cancel]').click();
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#agent-dialog').isVisible(), false);
}));

test('Claude windows display and save independent thresholds, including older saved configs', async () => fixture(async (page, data) => {
  data.settings.limits.usage.claude = {soft:50,hard:90};
  data.usage = [{provider:'claude',win:'five_hour',used_pct:60,resets_at:Date.now()/1000+3600},{provider:'claude',win:'seven_day',used_pct:95,resets_at:Date.now()/1000+86400}];
  await page.reload();
  assert.match(await page.locator('[data-window=five_hour] .meter-label').textContent(), /5-hour.*60%/);
  assert.match(await page.locator('[data-window=seven_day] .meter-label').textContent(), /Weekly.*95%/);
  assert.equal(await page.locator('[data-window=five_hour] .fill.warn').count(), 1);
  assert.equal(await page.locator('[data-window=seven_day] .fill.hard').count(), 1);
  assert.match(await page.locator('[data-window=five_hour] .meta').textContent(), /resets/);
  await page.locator('[data-page=settings]').click();
  const five = page.locator('[data-limit="usage.claude_five_hour"]');
  const weekly = page.locator('[data-limit="usage.claude_seven_day"]');
  assert.equal(await five.locator('[name=hard]').inputValue(), '90');
  assert.equal(await weekly.locator('[name=hard]').inputValue(), '90');
  await five.locator('[name=soft]').fill('20'); await five.locator('[name=hard]').fill('80');
  await weekly.locator('[name=soft]').fill('75'); await weekly.locator('[name=hard]').fill('85');
  await saveSettings(page);
  assert.deepEqual(data.settings.limits.usage.claude_five_hour, {soft:20,hard:80});
  assert.deepEqual(data.settings.limits.usage.claude_seven_day, {soft:75,hard:85});
  assert.equal(data.settings.limits.usage.claude, undefined);
  await page.reload(); await page.locator('[data-page=settings]').click();
  assert.equal(await weekly.locator('[name=hard]').inputValue(), '85');
  data.usage = [data.usage[0]];
  await page.evaluate(() => refresh());
  assert.match(await page.locator('[data-window=seven_day] .meter-label').textContent(), /unknown/);
  await page.setViewportSize({width:375,height:800});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}));

test('maximum lock TTL is required, positive and persists; older settings get a finite default', async () => fixture(async (page, data) => {
  delete data.settings.max_lock_ttl_secs;
  await page.reload();
  await page.locator('[data-page=settings]').click();
  const ttl = page.locator('[name=max_lock_ttl_secs]');
  assert.equal(await ttl.inputValue(), '900');
  for (const value of ['', '0', '-1', '1.5', '4294967296']) {
    await ttl.fill(value);
    assert.equal(await ttl.evaluate(el => el.checkValidity()), false);
    const writes = data.requests.length;
    await page.locator('[form=settings-form]').click();
    assert.equal(data.requests.length, writes);
  }
  await ttl.fill('120');
  await page.evaluate(() => refresh());
  assert.equal(await ttl.inputValue(), '120');
  await saveSettings(page);
  assert.equal(data.settings.max_lock_ttl_secs, 120);
  await page.reload(); await page.locator('[data-page=settings]').click();
  assert.equal(await ttl.inputValue(), '120');
}));

test('agent self-change permissions are independent opt-ins and retry rules are explicit', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  const form = page.locator('#settings-form');
  assert.equal(await form.locator('[name=allow_agent_model_change]').isChecked(), false);
  assert.equal(await form.locator('[name=allow_agent_effort_change]').isChecked(), false);
  assert.equal(await form.locator('[data-retry-rule]').count(), 0);
  await form.locator('[name=allow_agent_effort_change]').check();
  await saveSettings(page);
  assert.equal(data.settings.allow_agent_model_change, false);
  assert.equal(data.settings.allow_agent_effort_change, true);
  assert.deepEqual(data.settings.crash_retries, {});
  await form.locator('[name=allow_agent_model_change]').check();
  await form.locator('[name=allow_agent_effort_change]').uncheck();
  await form.locator('#add-retry-rule').click();
  const rule = form.locator('[data-retry-rule]').first();
  await rule.locator('[name=retry_source]').selectOption('claude-opus-5-5');
  await rule.locator('[name=retry_harness]').selectOption('codex');
  await rule.locator('[name=retry_model]').selectOption('gpt-6-luna');
  assert.equal(await rule.locator('[name=same_model_retries]').inputValue(), '0');
  await rule.locator('[name=same_model_retries]').fill('2');
  assert.equal(await rule.locator('[name=retry_effort]').count(), 0);
  await page.evaluate(() => refresh());
  assert.equal(await rule.locator('[name=retry_model]').inputValue(), 'gpt-6-luna');
  await saveSettings(page);
  assert.equal(data.settings.allow_agent_model_change, true);
  assert.equal(data.settings.allow_agent_effort_change, false);
  assert.deepEqual(data.settings.crash_retries, {'claude-opus-5-5':{harness:'codex',model:'gpt-6-luna',same_model_retries:2}});
  await page.reload(); await page.locator('[data-page=settings]').click();
  assert.equal(await rule.locator('[name=retry_model]').inputValue(), 'gpt-6-luna');
  assert.equal(await rule.locator('[name=retry_effort]').count(), 0);
  assert.equal(await rule.locator('[name=same_model_retries]').inputValue(), '2');
  assert.equal(await page.locator('[form=settings-form]').isDisabled(), true);
  assert.deepEqual(data.settings.crash_retries, {'claude-opus-5-5':{harness:'codex',model:'gpt-6-luna',same_model_retries:2}});
  await rule.locator('[data-remove-retry]').click(); await saveSettings(page);
  assert.deepEqual(data.settings.crash_retries, {});
}));

test('retry model choices exclude the source and update when source or provider changes', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  await page.locator('#add-retry-rule').click();
  const rule = page.locator('[data-retry-rule]').first();
  const source = rule.locator('[name=retry_source]'), model = rule.locator('[name=retry_model]');
  assert.equal(await source.inputValue(), 'claude-sonnet-5-5');
  assert.equal(await model.locator('option[value="claude-sonnet-5-5"]').count(), 0);
  assert.equal(await model.inputValue(), 'claude-opus-5-5');
  await source.selectOption('claude-opus-5-5');
  assert.equal(await model.locator('option[value="claude-opus-5-5"]').count(), 0);
  assert.equal(await model.inputValue(), 'claude-sonnet-5-5');
  await rule.locator('[name=retry_harness]').selectOption('codex');
  await model.selectOption('gpt-6-luna');
  await source.selectOption('gpt-6-luna');
  assert.equal(await model.locator('option[value="gpt-6-luna"]').count(), 0);
  assert.notEqual(await model.inputValue(), 'gpt-6-luna');
  await source.selectOption('claude-opus-5-5');
  assert.equal(await model.locator('option[value="gpt-6-luna"]').count(), 1);
  await model.selectOption('gpt-6-luna');
  await page.evaluate(() => refresh());
  assert.equal(await model.inputValue(), 'gpt-6-luna');
  await saveSettings(page);
  assert.deepEqual(data.settings.crash_retries, {'claude-opus-5-5':{harness:'codex',model:'gpt-6-luna',same_model_retries:0}});
}));

test('crash recovery retry counts are bounded integers and effort behavior is explained', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  const form = page.locator('#settings-form');
  assert.match(await form.textContent(), /Crash recovery.*count excludes the original turn; zero goes straight to the replacement/);
  assert.match(await form.textContent(), /Successful responses, including refusals, do not trigger recovery\. Manual\/usage pauses are separate/);
  assert.match(await form.textContent(), /ultra maps to max when supported/);
  assert.match(await form.textContent(), /Haiku 4\.5.*medium placeholder.*omits the effort flag.*Allowed-effort restrictions/);
  await page.locator('#add-retry-rule').click();
  const retries = page.locator('[name=same_model_retries]');
  for (const value of ['-1','1.5','4294967296','']) {
    await retries.fill(value);
    assert.equal(await retries.evaluate(el => el.checkValidity()), false);
    const writes = data.requests.length;
    await page.locator('[form=settings-form]').click();
    assert.equal(data.requests.length, writes);
  }
  await retries.fill('4294967295');
  assert.equal(await retries.evaluate(el => el.checkValidity()), true);
  await page.evaluate(() => refresh());
  assert.equal(await retries.inputValue(), '4294967295');
  await saveSettings(page);
  assert.equal(Object.values(data.settings.crash_retries)[0].same_model_retries, 4294967295);
}));

test('custom retry IDs cannot equal the source, including when editing the source', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  await page.locator('#add-retry-rule').click();
  const rule = page.locator('[data-retry-rule]').first();
  await rule.locator('[name=retry_source]').selectOption('__custom__');
  await rule.locator('[name=retry_custom_source]').fill('claude-opus-5-5');
  assert.equal(await rule.locator('[name=retry_model] option[value="claude-opus-5-5"]').count(), 0);
  await rule.locator('[name=retry_custom_source]').fill('future-source');
  await rule.locator('[name=retry_model]').selectOption('__custom__');
  const target = rule.locator('[name=retry_custom_model]');
  await target.fill(' future-source ');
  assert.equal(await target.evaluate(el => el.validationMessage), 'Choose a different replacement model.');
  const writes = data.requests.length;
  await page.locator('[form=settings-form]').click();
  assert.equal(data.requests.length, writes);
  await target.fill('future-target');
  assert.equal(await target.evaluate(el => el.validationMessage), '');
  await rule.locator('[name=retry_custom_source]').fill('future-target');
  assert.equal(await target.evaluate(el => el.validationMessage), 'Choose a different replacement model.');
  await rule.locator('[name=retry_source]').selectOption('claude-sonnet-5-5');
  assert.equal(await target.evaluate(el => el.validationMessage), '');
}));

test('retry rules support custom IDs and reject duplicate source models without writes', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  await page.locator('#add-retry-rule').click();
  const rule = page.locator('[data-retry-rule]').first();
  await rule.locator('[name=retry_source]').selectOption('__custom__');
  await rule.locator('[name=retry_custom_source]').fill('future-source');
  await rule.locator('[name=retry_model]').selectOption('__custom__');
  await rule.locator('[name=retry_custom_model]').fill('future-target');
  const beforeGrant = data.requests.length;
  await page.locator('[form=settings-form]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('allow its model in Harnesses'));
  assert.equal(data.requests.length, beforeGrant, 'a retry cannot implicitly allow its target');
  const harness = page.locator('[data-harness=claude]');
  await harness.locator('.model-picker summary').click();
  await harness.locator('[name=add_model]').fill('future-target');
  await harness.locator('[data-add-model]').click();
  await saveSettings(page);
  assert.equal(data.settings.crash_retries['future-source'].model, 'future-target');
  await page.reload(); await page.locator('[data-page=settings]').click();
  assert.equal(await rule.locator('[name=retry_source]').inputValue(), 'future-source');
  assert.equal(await rule.locator('[name=retry_model]').inputValue(), 'future-target');
  await page.locator('#add-retry-rule').click();
  const second = page.locator('[data-retry-rule]').last();
  await second.locator('[name=retry_source]').selectOption('__custom__');
  await second.locator('[name=retry_custom_source]').fill('future-source');
  const writes = data.requests.length;
  await page.locator('[form=settings-form]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Only one retry rule'));
  assert.equal(data.requests.length, writes);
}));

test('Fable weekly usage has an independent meter and no inherited legacy threshold', async () => fixture(async (page, data) => {
  data.settings.limits.usage.claude = {soft:50,hard:90};
  data.usage = [{provider:'claude',win:'seven_day_fable',used_pct:80,resets_at:Date.now()/1000+86400}];
  await page.reload();
  assert.match(await page.locator('[data-window=seven_day_fable] .meter-label').textContent(), /Fable weekly.*80%/);
  assert.equal(await page.locator('[data-window=seven_day_fable] .fill.warn').count(), 0);
  await page.locator('[data-window=seven_day_fable]').click();
  assert.match(await page.locator('#usage-details').textContent(), /Fable weekly: 80%/);
  await page.locator('#usage-dialog button').filter({hasText:'Close'}).click();
  await page.locator('[data-page=settings]').click();
  const fable = page.locator('[data-limit="usage.claude_seven_day_fable"]');
  assert.equal(await fable.locator('[name=hard]').inputValue(), '');
  await fable.locator('[name=soft]').fill('60'); await fable.locator('[name=hard]').fill('95');
  await saveSettings(page);
  assert.deepEqual(data.settings.limits.usage.claude_seven_day_fable, {soft:60,hard:95});
  assert.deepEqual(data.settings.limits.usage.claude_seven_day, {soft:50,hard:90});
  await page.evaluate(() => refresh());
  assert.equal(await page.locator('[data-window=seven_day_fable] .fill.warn').count(), 1);
  await page.setViewportSize({width:375,height:800});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}));

test('agent details preserve model drafts while polling and save provider-fixed next-turn changes', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'ultra'}];
  await page.reload(); await page.locator('[data-action=details]').click();
  const config = page.locator('#agent-config');
  await config.locator('#save-agent-config').waitFor();
  assert.match(await config.textContent(), /current turn is not interrupted/);
  await config.locator('[name=agent_model]').selectOption('gpt-6-luna');
  assert.equal(await config.locator('[name=agent_effort] option[value=ultra]').count(), 0);
  await config.locator('[name=agent_effort]').selectOption('max');
  await page.evaluate(() => refresh());
  assert.equal(await config.locator('[name=agent_model]').inputValue(), 'gpt-6-luna');
  await config.locator('#save-agent-config').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('saved for the next turn'));
  assert.deepEqual(data.requests.at(-1), {url:'/agent-config',method:'POST',body:{id:1,model:'gpt-6-luna',effort:'max'}});
  assert.equal(data.agents[0].state, 'working');
  assert.equal(data.agents[0].harness, 'codex');
  assert.equal(await config.locator('select option[value="claude-sonnet-5-5"]').count(), 0);
  await config.locator('[name=agent_model]').selectOption('__custom__');
  const writes = data.requests.length;
  await page.locator('#agent-dialog button[value=cancel]').click();
  assert.equal(await page.locator('#agent-dialog').isVisible(), false);
  assert.equal(data.requests.length, writes, 'close ignores an empty custom-model draft');
}));

test('agent details expose pending, blocked and replacement retry status safely', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'crashed',harness:'claude',model:'claude-opus-5-5',effort:'medium',retry:{source:'claude-opus-5-5',handled:0,replacement:null,blocked:null,same_model_attempts:1,effort:'medium',eligible_at:Date.now()/1000+120}}];
  await page.reload(); await page.locator('[data-action=details]').click();
  const details = page.locator('#agent-details');
  await details.locator('dt[data-key=retry]').waitFor();
  assert.match(await details.textContent(), /crash recovery.*Same-model retries: 1.*effort medium.*Pending; requires a configured rule/);
  assert.match(await details.textContent(), /Earliest retry:/);
  data.agents[0].effort = 'high';
  data.agents[0].retry.blocked = 'Usage limit <waiting>';
  await page.evaluate(() => refresh());
  assert.match(await details.textContent(), /Waiting: Usage limit <waiting>/);
  assert.match(await details.textContent(), /failed effort medium; requested effort high/);
  assert.equal(await details.locator('waiting').count(), 0);
  data.agents[0].retry.handled = 1;
  await page.evaluate(() => refresh());
  assert.match(await details.textContent(), /Stopped: Usage limit/);
  assert.doesNotMatch(await details.textContent(), /Earliest retry:/);
  data.agents[0].retry.blocked = null; data.agents[0].retry.replacement = 2;
  await page.evaluate(() => refresh());
  assert.match(await details.textContent(), /Replacement agent #2/);
  data.agents[0].retry.blocked = 'cannot start replacement';
  await page.evaluate(() => refresh());
  assert.match(await details.textContent(), /Replacement agent #2.*Stopped: cannot start replacement/);
}));

test('replaced agents expose history and replacement details without restart or configure controls', async () => fixture(async (page, data) => {
  data.agents = [
    {id:1,project:1,name:'Predecessor',state:'replaced',harness:'codex',model:'gpt-6.1-sol',effort:'high',conversation_history:'/history/old.jsonl',output_log:'/logs/old.jsonl',retry:{source:'gpt-6.1-sol',handled:1,replacement:2,blocked:null,same_model_attempts:0,effort:'high'}},
    {id:2,project:1,name:'Replacement',state:'working',harness:'claude',model:'claude-sonnet-5-5',effort:'high'},
  ];
  data.agentLogs[1] = ['Retained predecessor history'];
  await page.reload();
  assert.deepEqual(await page.locator('[data-agent="1"] [data-action]').evaluateAll(buttons => buttons.map(button => button.dataset.action)), ['details']);
  await page.locator('[data-agent="1"] [data-action=details]').click();
  await page.locator('#agent-details dt[data-key=retry]').waitFor();
  assert.match(await page.locator('#agent-details').textContent(), /\/history\/old.jsonl.*Replacement agent #2/s);
  assert.equal(await page.locator('#agent-log').textContent(), 'Retained predecessor history');
  assert.equal(await page.locator('#agent-config').textContent(), '');
  await page.locator('#agent-dialog button[value=cancel]').click();
  await page.locator('[data-agent="2"] [data-action=details]').click();
  await page.locator('#save-agent-config').waitFor();
  assert.equal(await page.locator('#save-agent-config').count(), 1);
  data.agents[1].state = 'replaced';
  data.agents[1].retry = {source:'claude-sonnet-5-5',handled:1,replacement:3,blocked:null};
  await page.evaluate(() => refresh());
  assert.equal(await page.locator('#save-agent-config').count(), 0, 'polling removes controls after replacement');
  assert.deepEqual(await page.locator('[data-agent="2"] [data-action]').evaluateAll(buttons => buttons.map(button => button.dataset.action)), ['details']);
  assert.equal(data.requests.length, 0);
}));

test('details polling preserves selected task text and defers selected log updates', async () => fixture(async (page, data) => {
  const task = `Don't replace this "task" <text> while counters change.`;
  data.agents = [{id:1,project:1,name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high',task,fresh_in:1}];
  data.agentLogs[1] = Array.from({length:80}, (_,i) => `Line ${i}`);
  await page.reload(); await page.locator('[data-action=details]').click();
  await page.locator('#agent-config [name=agent_model]').selectOption('gpt-6-luna');
  await page.locator('#agent-config [name=agent_effort]').selectOption('max');
  await page.evaluate(() => {
    const el = document.querySelector('dt[data-key=task]').nextElementSibling;
    window.selectedTaskNode = el;
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.querySelector('#agent-log').scrollTop = 35;
  });
  data.agents[0].fresh_in = 2; data.agents[0].status = 'Working'; data.agentLogs[1].push('New activity');
  await page.evaluate(() => refresh());
  await page.waitForFunction(() => document.querySelector('dt[data-key=fresh_in]').nextElementSibling.textContent === '2');
  assert.equal(await page.evaluate(() => document.querySelector('dt[data-key=task]').nextElementSibling === window.selectedTaskNode), true);
  assert.equal(await page.evaluate(() => getSelection().toString()), task);
  assert.equal(await page.locator('#agent-config [name=agent_model]').inputValue(), 'gpt-6-luna');
  assert.equal(await page.locator('#agent-config [name=agent_effort]').inputValue(), 'max');
  assert.equal(await page.locator('#agent-log').evaluate(el => el.scrollTop), 35);
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#agent-log'));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  const selectedLog = await page.evaluate(() => getSelection().toString());
  data.agentLogs[1].push('Deferred while selected'); data.agents[0].fresh_in = 3;
  await page.evaluate(() => refresh());
  assert.equal(await page.evaluate(() => getSelection().toString()), selectedLog);
  assert.equal((await page.locator('#agent-log').textContent()).includes('Deferred while selected'), false);
  await page.evaluate(() => { getSelection().removeAllRanges(); return refresh(); });
  await page.waitForFunction(() => document.querySelector('#agent-log').textContent.includes('Deferred while selected'));
  assert.equal(await page.locator('#agent-log').evaluate(el => el.scrollTop), 35);
}));

test('thread identifiers are visible and copyable for references in another conversation', async () => fixture(async (page, data) => {
  data.threads = [conversation([]),conversation([], {id:2,title:'Follow-up'})];
  await page.reload(); await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('[data-page=threads]').click();
  assert.match(await page.locator('[data-thread="1"] .meta').textContent(), /Thread #1/);
  await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('.thread-header > div.meta').textContent(), /Thread #1/);
  await page.locator('#copy-thread').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Copied thread #1');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'thread #1');
  await page.locator('[data-thread="2"]').click();
  await page.locator('#message-form textarea').fill('See thread #1');
  await page.locator('#message-form button').click();
  await page.locator('.message-text').waitFor();
  assert.equal(data.threads[1].messages[0].text, 'See thread #1');
}));

test('agent details expose native history and output paths; closed behavior is explained', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'closed',harness:'claude',conversation_history:'/home/example/.claude/projects/-work/session.jsonl',output_log:'/home/example/.acom/logs/1.jsonl'}];
  await page.reload(); await page.locator('[data-action=details]').click();
  await page.waitForFunction(() => document.querySelector('#agent-details').textContent.includes('conversation history'));
  assert.match(await page.locator('#agent-details').textContent(), /\/home\/example\/\.claude\/projects\/-work\/session.jsonl/);
  assert.match(await page.locator('#agent-details').textContent(), /\/home\/example\/\.acom\/logs\/1.jsonl/);
  await page.locator('#agent-dialog button[value=cancel]').click();
  await page.locator('[data-page=settings]').click();
  assert.match(await page.locator('[name=done_closes]').locator('..').locator('..').textContent(), /require explicit Reopen/);
}));
