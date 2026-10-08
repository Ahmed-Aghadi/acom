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

async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
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
if (process.argv[2] === 'app-server') {
  let buffer=''; process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{
    buffer+=chunk; let i;
    while((i=buffer.indexOf('\\n'))>=0) {
      const line=buffer.slice(0,i); buffer=buffer.slice(i+1); const request=JSON.parse(line);
      if(request.method==='initialize') console.log(JSON.stringify({id:request.id,result:{}}));
      if(request.method==='account/rateLimits/read') {
        fs.appendFileSync(path.join(process.env.ACOM_HOME,'checks.jsonl'),JSON.stringify({at:Date.now()})+'\\n');
        const file=path.join(process.env.ACOM_HOME,'subscription.json');
        const value=fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {rateLimits:{primary:{usedPercent:0,resetsAt:Math.floor(Date.now()/1000)+3600}}};
        if(value.hang) {
          const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
          fs.writeFileSync(path.join(process.env.ACOM_HOME,'usage-child-pid'),String(child.pid)); return;
        }
        console.log(JSON.stringify({id:request.id,result:value}));
      }
    }
  });
} else {
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', async () => {
  const args = process.argv.slice(2), id = Number(process.env.ACOM_ID);
  const resume = args[1] === 'resume';
  fs.appendFileSync(path.join(process.env.ACOM_HOME, 'runs.jsonl'), JSON.stringify({ id, args, prompt, cwd: process.cwd(), resume }) + '\\n');
  const session = resume ? args.at(-2) : crypto.randomUUID();
  console.log(JSON.stringify({ type: 'thread.started', thread_id: session }));
  const sessions=path.join(process.env.CODEX_HOME,'sessions','2026','10','08'); fs.mkdirSync(sessions,{recursive:true});
  fs.appendFileSync(path.join(sessions,'rollout-'+session+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id:session}})+'\\n');
  if (prompt.includes('CRASH_TEST') && !resume) { process.exitCode=1; return; }
  if (prompt.includes('REROUTE_TEST') && !resume) console.log(JSON.stringify({ type: 'model_reroute', from_model: 'gpt-6.1-sol', to_model: 'gpt-other', reason: 'high_risk_cyber_activity' }));
  if (prompt.includes('POLICY_TEST') && !resume) console.log(JSON.stringify({ type: 'turn.failed', error: { code: 'policy_violation', message: 'request blocked under the usage policy' } }));
  if (prompt.includes('LIMIT_TEST') && !resume) console.log(JSON.stringify({type:'turn.failed',error:{code:'usage_limit_reached',message:'Subscription usage limit reached'}}));
  if (prompt.includes('UNSUPPORTED_TEST')) { console.log(JSON.stringify({type:'turn.failed',error:{message:JSON.stringify({error:{message:"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}})}})); process.exitCode=1;return; }
  await fetch(process.env.ACOM_URL + '/hook/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await new Promise(resolve => setTimeout(resolve, 2000));
  await fetch(process.env.ACOM_URL + '/agents/' + id + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));
});
}
`, { mode: 0o755 });
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ACOM_HOME: home, CODEX_HOME:path.join(root,'codex'), CLAUDE_CONFIG_DIR:path.join(root,'no-credentials'), PATH: `${bin}:${process.env.PATH}` };
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
  const finished = (id, state = 'closed') => until(async () => (await api('GET', `/agents/${id}`)).state === state, `agent ${id} ${state}`);
  try {
    await start();
    assert.equal((await api('GET', '/overview')).project, null);
    await api('POST', '/agents', { harness: 'codex', task: 'Missing project' }, 400);
    const defaults = (await api('GET', '/configs'))[0].settings;
    assert.equal(defaults.harnesses.codex.model,'gpt-6-sol');
    defaults.prompts={launch:'Literal {task} launch',wake:'Literal {updates} wake',resume:'Literal {updates} resume'};
    await api('PUT','/configs/1',{settings:defaults});
    const folder = await api('GET', '/folders');
    assert.equal(folder.path, fs.realpathSync(os.homedir()));
    fs.writeFileSync(path.join(first,'visible.txt'),'file listing, not file contents');
    fs.writeFileSync(path.join(first,'.hidden'),'hidden');
    const listing=await api('GET',`/folders?path=${encodeURIComponent(first)}`);
    assert.equal(listing.entries[0].directory,true);
    assert.ok(listing.entries.some(e=>e.name==='visible.txt' && !e.directory));
    assert.ok(!listing.entries.some(e=>e.name==='.hidden'));
    assert.ok((await api('GET',`/folders?path=${encodeURIComponent(first)}&hidden=1`)).entries.some(e=>e.name==='.hidden'));
    for(const name of ['', '.', '..', '../escape','x/y','x\\y']) await api('POST','/folders',{parent:first,name},400);
    const made=await api('POST','/folders',{parent:first,name:'new folder'});
    assert.equal(made.path,path.join(first,'new folder'));
    await api('POST','/folders',{parent:first,name:'new folder'},400);
    await api('GET',`/folders?path=${encodeURIComponent(path.join(first,'visible.txt'))}`,null,400);
    await api('POST','/usage/check',{provider:'unknown'},400);
    assert.equal(defaults.done_closes, true);
    assert.deepEqual(defaults.harnesses.codex.flags, ['--dangerously-bypass-approvals-and-sandbox']);
    assert.deepEqual(defaults.harnesses.claude.flags, ['--dangerously-skip-permissions']);
    if (process.env.ACOM_BROWSER_TEST) await browserChecks(url, api, first, second, defaults);
    const a = await api('POST', '/projects', { path: first });
    const b = await api('POST', '/projects', { path: second });
    const windowConfig = structuredClone(defaults);
    windowConfig.limits.usage.claude_five_hour = {soft:25,hard:75};
    windowConfig.limits.usage.claude_seven_day = {soft:60,hard:90};
    await api('PUT','/configs/1',{settings:windowConfig});
    const windowView = await api('GET',`/overview?project=${a.id}`);
    assert.deepEqual(windowView.settings.limits.usage.claude_five_hour,{soft:25,hard:75});
    assert.deepEqual(windowView.settings.limits.usage.claude_seven_day,{soft:60,hard:90});
    assert.match(cli(first,['limits']),/claude five-hour unknown \(soft 25%, hard 75%\)/);
    assert.match(cli(first,['limits']),/claude weekly unknown \(soft 60%, hard 90%\)/);
    const invalid = structuredClone(windowConfig); invalid.limits.usage.claude_seven_day.hard = 101;
    await api('PUT','/configs/1',{settings:invalid},400);
    await api('PUT','/configs/1',{settings:defaults});
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
      assert.match(run.prompt, /messages wait until the user explicitly reopens/);
      assert.match(run.prompt, /# acom guide/);
      assert.match(run.prompt, /Your agent ID is in `ACOM_ID`/);
      assert.match(run.prompt, /acom inbox/);
      assert.match(run.prompt, /acom lock acquire/);
      assert.ok(run.prompt.includes(project));
      assert.match(run.prompt,/Literal \{task\} launch/);
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
    const firstMessage = await api('POST', '/messages', { agent: one.id, thread: thread.id, text: 'Unread for the user' });
    const snapshot = await api('GET', `/threads/${thread.id}`);
    assert.equal(snapshot.unread, 1);
    assert.equal((await api('GET', `/threads?project=${a.id}`)).find(t => t.id === thread.id).unread, 1);
    assert.equal((await api('GET', `/overview?project=${a.id}`)).projects.find(p => p.id === a.id).unread, 1);
    // Agent reads and notification cursors must not clear the user's unread state.
    assert.match(cli(root, ['thread', 'read', String(thread.id)], { ACOM_ID: String(one.id), ACOM_URL: url }), /Unread for the user/);
    assert.equal((await api('GET', `/threads/${thread.id}`)).last_read, 0);
    await api('POST', `/threads/${thread.id}/read`, { agent: one.id, message: firstMessage.id }, 400);
    assert.equal((await api('GET', `/threads/${thread.id}`)).last_read, 0);
    const secondMessage = await api('POST', '/messages', { agent: one.id, thread: thread.id, text: 'Arrived after the snapshot' });
    assert.equal((await api('POST', `/threads/${thread.id}/read`, { message: snapshot.messages.at(-1).id })).unread, 1);
    assert.equal((await api('POST', `/threads/${thread.id}/read`, { message: 0 })).last_read, firstMessage.id);
    for (const message of [null, '1', 1.5, -1, 99999]) await api('POST', `/threads/${thread.id}/read`, { message }, 400);
    await api('POST', '/threads/99999/read', { message: 0 }, 404);
    assert.match(cli(first, ['thread', 'read', String(thread.id)]), /Arrived after the snapshot/);
    assert.equal((await api('GET', `/threads/${thread.id}`)).last_read, secondMessage.id);
    assert.equal((await api('GET', `/threads/${thread.id}`)).unread, 0);
    if (process.env.ACOM_BROWSER_TEST) await browserMessageChecks(url, api, a.id, one.id, thread.id, home);
    // Closed agents miss rule-change notices, so their next turn needs a fresh snapshot.
    const changedWhileClosed = structuredClone(defaults);
    changedWhileClosed.done_closes = false;
    changedWhileClosed.limits.usage.claude_five_hour = {soft:25,hard:75};
    changedWhileClosed.limits.usage.claude_seven_day = {soft:60,hard:90};
    await api('PUT', `/projects/${a.id}/config`, {custom:changedWhileClosed});
    const waiting = await api('POST', '/messages', { thread: thread.id, text: 'User wake' });
    assert.match(waiting.not_woken.find(a=>a.agent===one.id).reason,/user reopens/);
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal((await api('GET',`/agents/${one.id}`)).state,'closed');
    assert.equal(runs().filter(r=>r.id===one.id).length,1);
    const beforeReopen=await api('GET',`/agents/${one.id}`);
    assert.ok(fs.existsSync(beforeReopen.conversation_history));
    assert.ok(beforeReopen.conversation_history.includes(beforeReopen.session));
    assert.ok(fs.existsSync(beforeReopen.output_log));
    await api('POST',`/agents/${one.id}/reopen`,{});
    await until(() => runs().filter(r => r.id === one.id).length === 2, 'resumed turn');
    assert.equal(runs().filter(r => r.id === one.id)[1].resume, true);
    const reopenedPrompt = runs().filter(r=>r.id===one.id)[1].prompt;
    assert.match(reopenedPrompt,/Literal \{updates\} wake/);
    assert.doesNotMatch(reopenedPrompt, /# acom guide|user changed the limits or rules/);
    assert.match(reopenedPrompt, /claude five-hour unknown \(soft 25%, hard 75%\)/);
    assert.match(reopenedPrompt, /claude weekly unknown \(soft 60%, hard 90%\)/);
    assert.match(reopenedPrompt, /any new message in its threads wakes it again/);
    assert.ok(runs().filter(r => r.id === one.id)[1].args.includes('--dangerously-bypass-approvals-and-sandbox'));
    await finished(one.id, 'done');
    await api('POST', `/agents/${one.id}/close`, {});
    await api('PUT', `/projects/${a.id}/config`, {config:1});
    assert.equal((await api('GET', `/locks?project=${a.id}`))[0].holder, null);
    const crashed = await api('POST', '/agents', {project:a.id,harness:'codex',task:'CRASH_TEST'});
    await finished(crashed.id, 'crashed');
    const crashSession = (await api('GET', `/agents/${crashed.id}`)).session;
    assert.ok(crashSession);
    const changedWhileCrashed = structuredClone(defaults);
    changedWhileCrashed.limits.usage.claude_seven_day = {soft:35,hard:65};
    await api('PUT', `/projects/${a.id}/config`, {custom:changedWhileCrashed});
    await api('POST', `/agents/${crashed.id}/resume`, {});
    await until(() => runs().filter(r=>r.id===crashed.id).length===2, 'crash retry');
    const crashRetry = runs().filter(r=>r.id===crashed.id)[1];
    assert.ok(crashRetry.resume);
    assert.match(crashRetry.prompt, /Resumed at .* after an error/);
    assert.match(crashRetry.prompt, /Commands may have only partially executed/);
    assert.match(crashRetry.prompt, /Literal \{updates\} resume/);
    assert.match(crashRetry.prompt, /claude weekly unknown \(soft 35%, hard 65%\)/);
    assert.doesNotMatch(crashRetry.prompt, /# acom guide|user changed the limits or rules/);
    await finished(crashed.id);
    assert.equal((await api('GET', `/agents/${crashed.id}`)).session, crashSession);
    await api('PUT', `/projects/${a.id}/config`, {config:1});
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
    const rejected=await api('POST','/agents',{project:a.id,harness:'codex',model:'gpt-6.1-sol',task:'UNSUPPORTED_TEST'});
    await until(async()=>(await api('GET',`/agents/${rejected.id}`)).state==='crashed','unsupported model error');
    assert.match((await api('GET',`/agents/${rejected.id}`)).problem,/^The 'gpt-6.1-sol' model is not supported/);
    const noCap=structuredClone(defaults); noCap.limits.usage.codex={soft:null,hard:null}; noCap.auto_resume=false; noCap.usage_poll_secs=15;
    await api('PUT','/configs/1',{settings:noCap});
    const quota=(used,reset)=>({rateLimits:{primary:{usedPercent:used,resetsAt:reset}}});
    const subscription=path.join(home,'subscription.json');
    const resetAt=Math.floor(Date.now()/1000)+2;
    fs.writeFileSync(subscription,JSON.stringify(quota(100,resetAt)));
    const exhausted=await api('POST','/agents',{project:a.id,harness:'codex',task:'LIMIT_TEST'});
    await until(async()=>(await api('GET',`/agents/${exhausted.id}`)).pause_reason==='limit','harness subscription pause with no hard cap');
    await new Promise(resolve=>setTimeout(resolve,3200));
    assert.equal((await api('GET',`/agents/${exhausted.id}`)).state,'paused');
    const checks=fs.readFileSync(path.join(home,'checks.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(checks.some(c=>c.at>=resetAt*1000 && c.at<=(resetAt+2)*1000),'provider-reported reset gets an immediate check, not the periodic delay');
    noCap.usage_poll_secs=3600; await api('PUT','/configs/1',{settings:noCap});
    fs.writeFileSync(subscription,JSON.stringify({hang:true})); await api('POST','/usage/check',{provider:'codex'});
    await until(async()=>(await api('GET',`/limits?project=${a.id}`)).checks.some(c=>c.provider==='codex'&&c.error?.includes('timed out')),'a stalled usage probe times out',20000);
    assert.equal((await api('GET',`/agents/${exhausted.id}`)).state,'paused');
    if(os.platform()==='linux') {
      const child=Number(fs.readFileSync(path.join(home,'usage-child-pid'),'utf8'));
      await until(()=> !fs.existsSync(`/proc/${child}/stat`) || fs.readFileSync(`/proc/${child}/stat`,'utf8').includes(') Z '),'usage probe descendants stop too');
    }
    fs.writeFileSync(subscription,'{}'); await api('POST','/usage/check',{provider:'codex'});
    await until(async()=>(await api('GET',`/limits?project=${a.id}`)).checks.some(c=>c.provider==='codex'&&c.error),'unknown status does not clear quota');
    assert.equal((await api('GET',`/agents/${exhausted.id}`)).state,'paused');
    noCap.usage_poll_secs=15; await api('PUT','/configs/1',{settings:noCap});
    fs.writeFileSync(subscription,JSON.stringify(quota(0,Math.floor(Date.now()/1000)+3600)));
    await until(async()=>(await api('GET',`/limits?project=${a.id}`)).usage.filter(u=>u.provider==='codex').every(u=>u.used_pct===0),'periodic checks discover an early reset',20000);
    assert.equal((await api('GET',`/agents/${exhausted.id}`)).state,'paused','auto-resume is off');
    noCap.auto_resume=true; await api('PUT','/configs/1',{settings:noCap});
    await until(()=>runs().filter(r=>r.id===exhausted.id).length===2,'automatic same-session recovery');
    const recovery=runs().filter(r=>r.id===exhausted.id)[1];
    assert.ok(recovery.resume); assert.match(recovery.prompt,/Commands may have only partially executed/);
    assert.match(recovery.prompt,/Literal \{updates\} resume/);
    assert.match(recovery.prompt,/codex 0% \(no limit\)/);
    assert.ok(recovery.prompt.lastIndexOf('## Limits and rules right now') > recovery.prompt.lastIndexOf('user changed the limits or rules'));
    await finished(exhausted.id); await api('PUT','/configs/1',{settings:defaults});
    const solo=await api('POST','/threads',{project:a.id,title:'User notes',members:[]});
    assert.deepEqual((await api('GET',`/threads/${solo.id}`)).members,[0]);
    assert.match(cli(first,['thread','read',String(solo.id)]),/user/);
    await api('POST',`/threads/${solo.id}/user`,{joined:false});
    assert.deepEqual((await api('GET',`/threads/${solo.id}`)).members,[]);
    await api('POST','/messages',{thread:solo.id,text:'Posting joins me again'});
    assert.deepEqual((await api('GET',`/threads/${solo.id}`)).members,[0]);
    await api('GET', '/settings', null, 404);
    await api('POST', '/configs/1/remove', {}, 409);
    await api('POST', '/configs', { name: '  ', settings: defaults }, 400);
    await api('POST', '/configs', { name: 'Default', settings: defaults }, 409);
    const small = structuredClone(defaults);
    small.limits.active = { soft: null, hard: 1 };
    small.harnesses.codex.model = 'gpt-6-luna'; small.harnesses.codex.effort = 'low';
    small.harnesses.codex.models = ['gpt-6-luna']; small.harnesses.codex.efforts = ['low'];
    small.harnesses.codex.flags.push('--config', 'acom_test=true');
    small.limits.context = { soft: null, hard: 123456 };
    small.done_closes = false; small.auto_resume = false;
    const saved = await api('POST', '/configs', { name: 'Small', settings: small });
    await api('PUT', `/projects/${a.id}/config`, { config: saved.id });
    const custom = structuredClone(defaults);
    custom.limits.active = { soft: null, hard: 1 };
    custom.auto_resume = false; custom.done_closes = false;
    await api('PUT', `/projects/${b.id}/config`, { custom });
    await api('PUT', `/projects/${a.id}/config`, { config: saved.id, custom }, 400);
    await api('PUT', `/projects/${a.id}/config`, { config: 99999 }, 404);
    await api('POST', `/configs/${saved.id}/remove`, {}, 409);
    const scopedA = await api('POST', '/agents', { project: a.id, harness: 'codex', task: 'Project A defaults' });
    const scopedB = await api('POST', '/agents', { project: b.id, harness: 'codex', task: 'Project B defaults' });
    // Each hard-1 project gets a slot: there is no machine-wide hard-1 cap.
    for (const p of [a.id, b.id]) assert.equal((await api('GET', `/limits?project=${p}`)).active.total, 1);
    await api('POST', '/agents', { project: a.id, harness: 'codex', task: 'Over project cap' }, 409);
    await api('POST', '/agents', { agent: scopedA.id, project: b.id, harness: 'codex', model: 'gpt-6.1-sol', task: 'Disallowed helper' }, 400);
    await until(() => runs().some(r => r.id === scopedA.id), 'saved config harness started');
    const scopedRun = runs().find(r => r.id === scopedA.id);
    assert.equal(scopedRun.args[scopedRun.args.indexOf('-m') + 1], 'gpt-6-luna');
    assert.ok(scopedRun.args.includes('model_reasoning_effort="low"'));
    assert.ok(scopedRun.args.includes('acom_test=true'));
    assert.ok(scopedRun.args.includes('model_auto_compact_token_limit=123456'));
    assert.match(scopedRun.prompt, /any new message in its threads wakes/);
    await finished(scopedA.id, 'done'); await finished(scopedB.id, 'done');
    // A queued wake in a full project must not hold up a different project's wake.
    const blocker = await api('POST', '/agents', { project: a.id, harness: 'codex', task: 'Hold project A slot' });
    const configThread = await api('POST', '/threads', { project: a.id, title: 'Changed rules', members: [String(scopedA.id)] });
    await api('POST', '/messages', { thread: configThread.id, text: 'Wait for project A slot' });
    assert.ok((await api('GET', `/agents/${scopedA.id}`)).wake_queued_at);
    const otherThread = await api('POST', '/threads', { project: b.id, title: 'Independent wake', members: [String(scopedB.id)] });
    await api('POST', '/messages', { thread: otherThread.id, text: 'Use project B slot' });
    await until(() => runs().filter(r => r.id === scopedB.id).length === 2, 'project B wakes despite blocked project A');
    assert.match(runs().filter(r=>r.id===scopedB.id)[1].prompt, /## Limits and rules right now/);
    assert.equal((await api('GET', `/agents/${scopedA.id}`)).state, 'done');
    await finished(blocker.id, 'done');
    await until(() => runs().filter(r => r.id === scopedA.id).length === 2, 'project A wakes when its slot clears');
    await finished(scopedA.id, 'done'); await finished(scopedB.id, 'done');
    // Shared config edits propagate, while a project's custom config is unchanged.
    small.limits.active.hard = 2;
    await api('PUT', `/configs/${saved.id}`, { name: 'Small renamed', settings: small });
    assert.equal((await api('GET', `/overview?project=${a.id}`)).settings.limits.active.hard, 2);
    assert.equal((await api('GET', `/overview?project=${b.id}`)).settings.limits.active.hard, 1);
    assert.equal((await api('GET', '/configs'))[0].settings.limits.active.hard, 8);
    await api('POST', '/messages', { thread: configThread.id, text: 'Check changed settings' });
    await until(() => runs().filter(r => r.id === scopedA.id).length === 3, 'rule change delivered on wake');
    assert.match(runs().filter(r => r.id === scopedA.id)[2].prompt, /user changed the limits or rules/);
    const changedWake = runs().filter(r=>r.id===scopedA.id)[2].prompt;
    assert.match(changedWake.split('## Limits and rules right now').at(-1), /Active agents: \d+ \(soft none, hard 2\)/);
    assert.ok(changedWake.lastIndexOf('## Limits and rules right now') > changedWake.indexOf('user changed the limits or rules'));
    await finished(scopedA.id, 'done');
    const savedRead = (await api('GET', `/threads/${thread.id}`)).last_read;
    await api('POST', '/messages', { agent: one.id, thread: thread.id, text: 'Unread survives restart' });
    await stop(); await start();
    assert.equal((await api('GET', `/threads/${thread.id}`)).last_read, savedRead);
    assert.equal((await api('GET', `/threads/${thread.id}`)).unread, 1);
    assert.equal((await api('GET', `/overview?project=${a.id}`)).settings.auto_resume, false);
    assert.equal((await api('GET', `/overview?project=${b.id}`)).project.config, null);
    assert.equal((await api('GET', '/configs')).find(c => c.id === saved.id).name, 'Small renamed');
    await api('PUT', `/projects/${b.id}/config`, { config: saved.id });
    assert.deepEqual((await api('GET', '/configs')).find(c => c.id === saved.id).projects, [a.id, b.id]);
    for (const p of [a.id, b.id]) await api('PUT', `/projects/${p}/config`, { config: 1 });
    await api('POST', `/configs/${saved.id}/remove`, {});
    assert.equal((await api('GET', '/projects')).length, 2);
    assert.equal(fs.existsSync(path.join(first, '.acom')), false);
    assert.equal(fs.existsSync(path.join(second, '.acom')), false);
    assert.equal(stderr, '');
  } finally {
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function browserMessageChecks(url, api, project, agent, thread, home) {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${url}/?project=${project}`);
    await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'live');
    await api('POST', '/messages', { agent, thread, text: 'Live unread badge' });
    await page.waitForFunction(() => document.querySelector('#unread-total').textContent === '1 unread');
    await page.locator('[data-page=threads]').click(); await page.locator(`[data-thread="${thread}"]`).click();
    await until(async () => (await api('GET', `/threads/${thread}`)).unread === 0, 'browser persists read acknowledgement');
    await page.locator('#message-form textarea').fill('Preserve this draft');
    const message = await api('POST', '/messages', { agent, thread, text: 'Live reply in open thread' });
    await page.locator(`[data-message="${message.id}"]`).waitFor();
    await until(async () => (await api('GET', `/threads/${thread}`)).unread === 0, 'open thread clears new reply');
    assert.equal(await page.locator('#message-form textarea').inputValue(), 'Preserve this draft');
    await page.locator('[data-page=overview]').click();
    await page.locator(`[data-action=details][data-id="${agent}"]`).click();
    await page.waitForFunction(() => document.querySelector('#agent-detail-status').textContent.startsWith('Live'));
    const details = await api('GET', `/agents/${agent}`);
    assert.ok((await page.locator('#agent-details').textContent()).includes(details.conversation_history));
    await api('POST', `/agents/${agent}/status`, { text: 'Live status from the test harness' });
    fs.appendFileSync(path.join(home, 'logs', `${agent}.txt`), '\nLive log line from the test harness\n');
    await page.waitForFunction(() => document.querySelector('#agent-log').textContent.includes('Live log line from the test harness'));
    assert.match(await page.locator('#agent-details').textContent(), /Live status from the test harness/);
    await page.locator('#agent-dialog button').click();
    await page.reload();
    assert.equal((await api('GET', `/threads/${thread}`)).unread, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

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
    await page.locator('[data-open="project-dialog"]').click();
    await page.locator('#project-form [name=path]').fill('');
    await page.locator('#browse-project').click();
    await page.waitForFunction(p=>document.querySelector('#folder-path').textContent===p,fs.realpathSync(os.homedir()));
    await page.locator('[data-close=folder-dialog]').click();
    await page.locator('#project-form [name=path]').fill(first);
    await page.locator('#browse-project').click();
    await page.waitForFunction(p=>document.querySelector('#folder-path').textContent===p,first);
    assert.match(await page.locator('#folder-list').textContent(),/visible.txt/);
    await page.locator('#folder-form [name=name]').fill('browser folder');
    await page.locator('#folder-form [type=submit]').click();
    await page.waitForFunction(p=>document.querySelector('#folder-path').textContent===p,path.join(first,'browser folder'));
    assert.ok(fs.statSync(path.join(first,'browser folder')).isDirectory());
    await page.locator('#folder-up').click();
    await page.waitForFunction(p=>document.querySelector('#folder-path').textContent===p,first);
    await page.locator('#folder-use').click();
    await page.locator('#project-form button.primary').click();
    await page.waitForFunction(()=>!document.querySelector('#project-dialog').open);
    await add(second);
    const projects = await api('GET', '/projects');
    const firstId = projects.find(p => p.path === first).id;
    const secondId = projects.find(p => p.path === second).id;
    assert.equal(await page.locator('#project-path').textContent(), second);
    await page.locator('[data-page=threads]').click();
    await page.locator('[data-open=thread-dialog]').click();
    await page.locator('#thread-form [name=title]').fill('Browser notes');
    await page.locator('#thread-form button.primary').click();
    await page.locator('#thread-membership').waitFor();
    assert.match(await page.locator('.thread-header .meta').textContent(),/Thread #\d+/);
    assert.equal(await page.locator('#thread-membership').textContent(),'Leave thread');
    await page.locator('#thread-membership').click();
    await page.waitForFunction(()=>document.querySelector('#thread-membership').textContent==='Join thread');
    assert.equal(await page.locator('[data-thread]').count(),0);
    await page.locator('[data-thread-filter=all]').click();
    assert.equal(await page.locator('[data-thread]').count(),1);
    await page.locator('#thread-membership').click();
    await page.waitForFunction(()=>document.querySelector('#thread-membership').textContent==='Leave thread');
    await page.locator('[data-usage=codex]').click();
    await page.locator('[data-check-usage=codex]').click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Usage check scheduled');
    await page.locator('#usage-dialog button').filter({hasText:'Close'}).click();
    await page.locator('[data-page=overview]').click();
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
    await page.locator('[data-prompt-editor] summary').click();
    const guidance='Literal {task} {updates} <tag> $HOME';
    await page.locator('[name=prompt_resume]').fill(guidance);
    await page.locator('[name=usage_poll_secs]').fill('45');
    await page.locator('[form=settings-form]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Settings saved');
    assert.equal((await api('GET', '/configs'))[0].settings.limits.active.soft, null);
    assert.equal((await api('GET', '/configs'))[0].settings.prompts.resume,guidance);
    assert.equal((await api('GET', '/configs'))[0].settings.usage_poll_secs,45);
    await page.reload();
    await page.locator('[data-page=settings]').click();
    await cfg.locator('[name=model] option[value=custom-next]').waitFor({ state: 'attached' });
    assert.equal(await cfg.locator('[name=model]').inputValue(), 'custom-next');
    assert.equal(await active.locator('[name=soft]').inputValue(), '');
    await active.locator('[name=soft]').fill('9');
    await active.locator('[name=hard]').fill('8');
    await page.locator('[form=settings-form]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes("soft can't be above hard"));
    assert.equal((await api('GET', '/configs'))[0].settings.limits.active.soft, null);
    await active.locator('[name=soft]').fill('');
    await active.locator('[name=hard]').fill('2');
    await page.locator('#save-config-as').click();
    await page.locator('#config-form [name=name]').fill('Browser config');
    await page.locator('#config-form button.primary').click();
    await page.waitForFunction(() => !document.querySelector('#config-dialog').open);
    const named = (await api('GET', '/configs')).find(c => c.name === 'Browser config');
    assert.ok(named);
    assert.equal((await api('GET', `/overview?project=${secondId}`)).project.config, named.id);
    assert.equal((await api('GET', '/configs'))[0].settings.limits.active.hard, 8);
    await page.locator('#project-select').selectOption(String(firstId));
    await page.waitForFunction(() => document.querySelector('#config-select')?.value === '1');
    await page.locator('#config-select').selectOption(String(named.id));
    await page.locator('[form=settings-form]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Settings saved');
    assert.deepEqual((await api('GET', '/configs')).find(c => c.id === named.id).projects, [firstId, secondId]);
    await page.locator('#config-select').selectOption('custom');
    assert.equal(await active.locator('[name=hard]').inputValue(), '8');
    await active.locator('[name=hard]').fill('1');
    await page.locator('[form=settings-form]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Settings saved');
    assert.equal((await api('GET', `/overview?project=${firstId}`)).project.config, null);
    assert.equal((await api('GET', `/overview?project=${firstId}`)).settings.limits.active.hard, 1);
    assert.equal((await api('GET', `/overview?project=${secondId}`)).settings.limits.active.hard, 2);
    await page.reload(); await page.locator('[data-page=settings]').click();
    await page.waitForFunction(() => document.querySelector('#config-select')?.value === 'custom');
    assert.equal(await active.locator('[name=hard]').inputValue(), '1');
    for (const id of [firstId, secondId]) {
      page.once('dialog', d => d.accept());
      await page.locator('#project-select').selectOption(String(id));
      await page.waitForFunction(() => !!document.querySelector('#config-select'));
      page.removeAllListeners('dialog');
      page.once('dialog', d => d.accept());
      await page.locator('#remove-project').click();
      await page.waitForFunction(id => !Array.from(document.querySelector('#project-select').options).some(o => o.value === String(id)), id);
    }
    assert.equal(fs.existsSync(first), true); assert.equal(fs.existsSync(second), true);
    assert.deepEqual(errors, []);
    await api('POST', `/configs/${named.id}/remove`, {});
    await api('PUT', '/configs/1', { settings: defaults });
  } finally { await browser.close(); }
}
