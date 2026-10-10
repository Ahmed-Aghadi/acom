// API, CLI and process regressions; the fake harness never calls a model provider.
// cargo build && node --test tests/server.cjs
// ACOM_BROWSER_TEST=1 node --test tests/server.cjs also drives the real page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { spawn, spawnSync } = require('node:child_process');
const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');
const startupDiagnostic={type:'item.completed',item:{id:'item_0',type:'error',message:'`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.'}};

async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

async function freePort() {
  const probe=net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  return port;
}

test('single server scopes projects, preserves settings and supervises first/resumed turns', async () => {
  // acom prepends its executable directory to child PATH. Reject any client
  // there before starting the isolated server, even when ACOM_BINARY is overridden.
  const executableDir=path.dirname(fs.realpathSync(binary));
  for(const client of ['codex','claude']) assert.equal(fs.existsSync(path.join(executableDir,client)),false,`${client} must not shadow the isolated fake client`);
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
  const args = process.argv.slice(2), id = Number(process.env.ACOM_ID), claude = path.basename(process.argv[1]) === 'claude';
  const resume = claude ? args.includes('--resume') : args[1] === 'resume';
  const model = args[args.indexOf(claude ? '--model' : '-m') + 1];
  const previous=fs.existsSync(path.join(process.env.ACOM_HOME,'runs.jsonl')) ? fs.readFileSync(path.join(process.env.ACOM_HOME,'runs.jsonl'),'utf8').split('\\n').slice(0,-1).map(JSON.parse).filter(r=>r.id===id) : [];
  const task=previous[0]?.prompt || prompt;
  const membership_snapshot=task.includes('MEMBERSHIP_HOLD_TEST') || task.includes('NEXT_TURN_') || task.includes('Project B defaults') ? {
    state:(await fetch(process.env.ACOM_URL+'/agents/'+id).then(r=>r.json())).state,
    threads:(await fetch(process.env.ACOM_URL+'/threads?agent='+id).then(r=>r.json())).map(t=>t.id)
  } : undefined;
  fs.appendFileSync(path.join(process.env.ACOM_HOME, 'runs.jsonl'), JSON.stringify({ id, args, prompt, model, pid:process.pid, at:Date.now(), harness:claude?'claude':'codex', cwd: process.cwd(), resume, membership_snapshot }) + '\\n');
  const session = claude ? args[args.indexOf(resume?'--resume':'--session-id')+1] : resume ? args.at(-2) : crypto.randomUUID();
  if(!task.includes('NEXT_TURN_NO_SESSION')) {
    console.log(JSON.stringify(claude ? {type:'system',subtype:'init',session_id:session} : { type: 'thread.started', thread_id: session }));
    const sessions=path.join(process.env.CODEX_HOME,'sessions','2026','10','08'); fs.mkdirSync(sessions,{recursive:true});
    fs.appendFileSync(path.join(sessions,'rollout-'+session+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id:session}})+'\\n');
  }
  if(task.includes('LATE_FAILURE_PIPE_TEST')) {
    const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify("setTimeout(()=>console.log(JSON.stringify({type:'turn.failed',error:{message:'Delayed background failure'}})),500);setInterval(()=>{},1000)")}],{stdio:['ignore','inherit','ignore']});
    fs.writeFileSync(path.join(process.env.ACOM_HOME,'late-failure-child-'+id),String(child.pid)); child.unref(); return;
  }
  if(task.includes('NEXT_TURN_FAIL_OWN_HISTORY') && claude) {
    while(!fs.existsSync(path.join(process.env.ACOM_HOME,'release-'+id))) await new Promise(resolve=>setTimeout(resolve,25));
    console.log(JSON.stringify({type:'turn.completed'})); return;
  }
  if (task.includes('NEXT_TURN_') && !claude) {
    if(previous.length===0) {
      if(task.includes('NEXT_TURN_REPLACE_CHILD') || task.includes('NEXT_TURN_LATE_')) {
        const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','ignore']});
        fs.writeFileSync(path.join(process.env.ACOM_HOME,'replacement-child-'+id),String(child.pid)); child.unref();
      }
      if(!task.includes('NEXT_TURN_LATE_')) while(!fs.existsSync(path.join(process.env.ACOM_HOME,'release-'+id))) await new Promise(resolve=>setTimeout(resolve,25));
      if(task.includes('NEXT_TURN_FAIL')) { console.log(JSON.stringify({type:'turn.failed',error:{message:'Controlled first-turn failure'}})); return; }
    } else {
      if(task.includes('NEXT_TURN_FAIL_OWN_HISTORY') && previous.length%2===1) while(!fs.existsSync(path.join(process.env.ACOM_HOME,'release-'+id+'-'+previous.length))) await new Promise(resolve=>setTimeout(resolve,25));
      const inbox=await fetch(process.env.ACOM_URL+'/inbox/'+id+'?mark=new').then(r=>r.json());
      const ids=inbox.filter(m=>!m.outside_membership).map(m=>m.id);
      if(ids.length) await fetch(process.env.ACOM_URL+'/marks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent:id,ids,mark:'handled'})});
    }
    if(previous.length && !(task.includes('NEXT_TURN_FAIL_OWN_HISTORY') && previous.length%2===1) || task.includes('NEXT_TURN_DONE')) {
      await new Promise(resolve=>setTimeout(resolve,300));
      await fetch(process.env.ACOM_URL+'/agents/'+id+'/done',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    }
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}})); return;
  }
  if (prompt.includes('CRASH_TEST') && !resume) { process.exitCode=1; return; }
  if (prompt.includes('REROUTE_TEST') && !resume) console.log(JSON.stringify({ type: 'model_reroute', from_model: 'gpt-6.1-sol', to_model: 'gpt-other', reason: 'high_risk_cyber_activity' }));
  if (prompt.includes('POLICY_TEST') && !resume) console.log(JSON.stringify({ type: 'turn.failed', error: { code: 'policy_violation', message: 'request blocked under the usage policy' } }));
  if (prompt.includes('LIMIT_TEST') && !resume) console.log(JSON.stringify({type:'turn.failed',error:{code:'usage_limit_reached',message:'Subscription usage limit reached'}}));
  if (prompt.includes('REFUSAL_OK_TEST')) console.log(JSON.stringify({type:'refusal',message:'Cannot complete this request'}));
  if (prompt.includes('UNSUPPORTED_TEST')) { console.log(JSON.stringify({type:'turn.failed',error:{message:JSON.stringify({error:{message:"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}})}})); process.exitCode=1;return; }
  if (['STARTUP_DIAGNOSTIC_TEST','STARTUP_DIAGNOSTIC_FAILURE_TEST','CYBER_FAILURE_TEST'].some(marker=>task.includes(marker))) console.log(JSON.stringify(${JSON.stringify(startupDiagnostic)}));
  if (task.includes('STARTUP_DIAGNOSTIC_FAILURE_TEST')) { process.exitCode=1; return; }
  if (task.includes('CYBER_FAILURE_TEST') && !resume) {
    const message='This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.';
    console.log(JSON.stringify({type:'error',message})); console.log(JSON.stringify({type:'turn.failed',error:{message}})); process.exitCode=1; return;
  }
  if (task.includes('RETRY_COUNT_TEST') && model==='gpt-6-sol' || task.includes('RECOVER_ONCE_TEST') && previous.length%2===0 || task.includes('RETRY_CHAIN_TEST')) {
    const failure=claude ? {type:'result',is_error:true,result:'Temporary test failure'} : {type:'turn.failed',error:{message:'Temporary test failure'}};
    console.log(JSON.stringify(failure)); console.log(JSON.stringify(failure)); return;
  }
  if (prompt.includes('HANDOFF_TEST') && !claude) { await new Promise(r=>setTimeout(r,500)); console.log(JSON.stringify({type:'turn.failed',error:{message:'Temporary handoff failure'}})); return; }
  if (prompt.includes('SELF_CHANGE_TEST') && !resume) {
    await new Promise(r=>setTimeout(r,500));
    const configured=await fetch(process.env.ACOM_URL+'/agent-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,agent:id,model:'gpt-6-luna',effort:'high'})});
    if(!configured.ok) {process.exitCode=1;return;}
    console.log(JSON.stringify({type:'response.created',response:{model}}));
  }
  if (task.includes('MEMBERSHIP_HOLD_TEST')) {
    const released=path.join(process.env.ACOM_HOME,'release-'+id);
    while(!fs.existsSync(released)) await new Promise(resolve=>setTimeout(resolve,25));
  }
  await fetch(process.env.ACOM_URL + '/hook/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await new Promise(resolve => setTimeout(resolve, 2000));
  await fetch(process.env.ACOM_URL + '/agents/' + id + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));
});
}
`, { mode: 0o755 });
  fs.copyFileSync(path.join(bin,'codex'),path.join(bin,'claude'));
  let port=await freePort();
  let url=`http://127.0.0.1:${port}`;
  // No inherited PATH: a missing fake client must never fall through to a real provider.
  const env = { ...process.env, ACOM_HOME: home, CODEX_HOME:path.join(root,'codex'), CLAUDE_CONFIG_DIR:path.join(root,'no-credentials'), PATH: bin };
  delete env.ACOM_ID; delete env.ACOM_URL; delete env.CLAUDE_CODE_OAUTH_TOKEN;
  let server, stderr = '';
  const start = async (nextPort=port) => {
    port=nextPort; url=`http://127.0.0.1:${port}`;
    server = spawn(binary, ['serve', '--port', String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', chunk => stderr += chunk);
    await until(async () => {
      if (server.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
      try { return (await fetch(url + '/overview')).ok; } catch { return false; }
    }, 'server startup');
    assert.ok(storedConfigs().every(c=>c.id!==1 && c.name!=='Default'),'startup must not persist the virtual Default');
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
  const cli = (cwd, args, extra = {}, input) => {
    const result = spawnSync(binary, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', input });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  // A read can overlap appendFileSync; only newline-terminated records are complete.
  const runs = () => fs.existsSync(path.join(home, 'runs.jsonl')) ? fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8').split('\n').slice(0,-1).map(JSON.parse) : [];
  const storedConfigs = () => {
    const db=new DatabaseSync(path.join(home,'acom.db'),{readOnly:true});
    try { return db.prepare('SELECT id,name,settings FROM configs ORDER BY id').all().map(row=>({...row})); }
    finally { db.close(); }
  };
  const finished = (id, state = 'closed') => until(async () => (await api('GET', `/agents/${id}`)).state === state, `agent ${id} ${state}`);
  try {
    await start();
    assert.equal((await api('GET', '/overview')).project, null);
    await api('POST', '/agents', { harness: 'codex', task: 'Missing project' }, 400);
    const builtin = (await api('GET', '/configs')).find(c=>c.id===1);
    assert.equal(builtin.name,'Default');
    assert.deepEqual(storedConfigs(),[],'fresh database contains no saved Default settings');
    const defaults = structuredClone(builtin.settings);
    assert.equal(defaults.harnesses.codex.model,'gpt-6-sol');
    await api('PUT','/configs/1',{settings:defaults},409);
    await api('PUT','/configs/1',{name:'Changed Default',settings:defaults},409);
    await api('POST','/configs/1/remove',{},409);
    defaults.prompts={launch:'Literal {task} launch',wake:'Literal {updates} wake',resume:'Literal {updates} resume'};
    const mine=await api('POST','/configs',{name:'Mine',settings:defaults});
    assert.equal(mine.id,2,'the virtual Default reserves ID 1 without storing a config row');
    await api('PUT',`/configs/${mine.id}`,{name:'Default',settings:defaults},409);
    await api('POST','/configs',{name:'Default',settings:defaults},409);
    assert.deepEqual(storedConfigs().map(c=>({id:c.id,name:c.name})),[{id:mine.id,name:'Mine'}]);
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
    assert.equal(defaults.allow_agent_model_change,false);
    assert.equal(defaults.allow_agent_effort_change,false);
    assert.deepEqual(defaults.crash_retries,{});
    assert.equal(defaults.max_lock_ttl_secs,900);
    for (const ttl of [0,-1,1.5,4294967296,null]) {
      await api('PUT',`/configs/${mine.id}`,{settings:{...defaults,max_lock_ttl_secs:ttl}},400);
    }
    assert.match(cli(root,['models']),/Models and providers/);
    assert.match(cli(root,['models','--catalog']),/claude-haiku-5-5/);
    const reference=await fetch(url+'/models');
    assert.match(reference.headers.get('content-type'),/text\/plain/);
    assert.match(await reference.text(),/Unresolved cross-generation/);
    if (process.env.ACOM_BROWSER_TEST) await browserChecks(url, api, first, second, defaults, mine.id);
    const a = await api('POST', '/projects', { path: first });
    const b = await api('POST', '/projects', { path: second });
    for(const project of [a.id,b.id]) await api('PUT',`/projects/${project}/config`,{config:mine.id});
    const windowConfig = structuredClone(defaults);
    windowConfig.limits.usage.claude_five_hour = {soft:25,hard:75};
    windowConfig.limits.usage.claude_seven_day = {soft:60,hard:90};
    await api('PUT',`/configs/${mine.id}`,{settings:windowConfig});
    const windowView = await api('GET',`/overview?project=${a.id}`);
    assert.deepEqual(windowView.settings.limits.usage.claude_five_hour,{soft:25,hard:75});
    assert.deepEqual(windowView.settings.limits.usage.claude_seven_day,{soft:60,hard:90});
    assert.match(cli(first,['limits']),/claude five-hour unknown \(soft 25%, hard 75%\)/);
    assert.match(cli(first,['limits']),/claude weekly unknown \(soft 60%, hard 90%\)/);
    const invalid = structuredClone(windowConfig); invalid.limits.usage.claude_seven_day.hard = 101;
    await api('PUT',`/configs/${mine.id}`,{settings:invalid},400);
    await api('PUT',`/configs/${mine.id}`,{settings:defaults});
    assert.equal((await api('POST', '/projects', { path: first })).id, a.id);
    assert.equal((await api('GET', `/projects?path=${encodeURIComponent(path.join(first, 'child'))}`)).id, a.id);
    await api('POST', '/projects', { path: path.join(root, 'missing') }, 400);
    const duplicate = spawnSync(binary, ['serve', '--port', String(port + 1)], { env, encoding: 'utf8' });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already running/);
    const lifecycleProject=await lifecycleChecks({api,cli,runs,finished,start,stop,root,home,defaults});
    const followupProject=await followupChecks({api,cli,runs,finished,start,stop,root,home,bin,env,defaults,serverErrors:()=>stderr});
    await api('POST', '/agents', { project: a.id, harness: 'codex', model: 'gpt-6-luna', effort: 'ultra', task: 'Unsupported effort' }, 400);
    const boundedLocks=structuredClone(defaults); boundedLocks.max_lock_ttl_secs=60;
    await api('PUT',`/projects/${b.id}/config`,{custom:boundedLocks});
    const one = await api('POST', '/agents', { project: a.id, harness: 'codex', task: 'First project' });
    const two = await api('POST', '/agents', { project: b.id, harness: 'codex', model: 'custom-id', task: 'Second project' });
    await until(() => [one.id,two.id].every(id=>runs().some(r=>r.id===id)), 'both harnesses started');
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
      assert.match(run.prompt, new RegExp(`Lock TTL: maximum ${agent===one.id ? 900 : 60}s`));
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
    const ownLock=(await api('GET',`/locks?project=${b.id}`))[0];
    assert.ok(ownLock.expires_at>Math.floor(Date.now()/1000) && ownLock.expires_at<=Math.floor(Date.now()/1000)+60);
    for (const ttl of [0,-1,1.5,'10',true,61,Number.MAX_SAFE_INTEGER]) {
      await api('POST','/locks/acquire',{agent:two.id,name:'build',wait:0,ttl},400);
    }
    assert.equal((await api('GET',`/locks?project=${b.id}`))[0].expires_at,ownLock.expires_at,'invalid renewals preserve the lease');
    assert.match(cli(second,['lock','acquire','build','--ttl','30s'],{ACOM_ID:String(two.id)}),/renewed build, expires/);
    const overflow=spawnSync(binary,['lock','acquire','build','--ttl','18446744073709551615h'],{cwd:second,env:{...env,ACOM_ID:String(two.id)},encoding:'utf8'});
    assert.equal(overflow.status,1); assert.match(overflow.stderr,/bad duration/); assert.doesNotMatch(overflow.stderr,/panicked/);
    boundedLocks.max_lock_ttl_secs=10;
    await api('PUT',`/projects/${b.id}/config`,{custom:boundedLocks});
    const shortened=(await api('GET',`/locks?project=${b.id}`))[0].expires_at;
    assert.ok(shortened<=Math.floor(Date.now()/1000)+10);
    boundedLocks.max_lock_ttl_secs=120;
    await api('PUT',`/projects/${b.id}/config`,{custom:boundedLocks});
    assert.equal((await api('GET',`/locks?project=${b.id}`))[0].expires_at,shortened,'raising the ceiling never extends a held lock');
    assert.ok((await api('GET',`/locks?project=${a.id}`))[0].expires_at>shortened,'other project retains its ceiling');
    await api('PUT',`/projects/${b.id}/config`,{config:mine.id});
    await api('POST', '/threads', { project: a.id, title: 'Wrong project', members: [String(two.id)] }, 400);
    const thread = await api('POST', '/threads', { project: a.id, title: 'Review', members: [String(one.id)] });
    await api('POST', '/messages', { agent: two.id, thread: thread.id, text: 'Wrong project' }, 400);
    await api('POST', `/projects/${a.id}/remove`, {}, 409);
    await finished(one.id); await finished(two.id);
    const cliThread=await api('POST','/threads',{project:a.id,title:'CLI stdin delivery',members:[]});
    const actor={ACOM_ID:String(one.id),ACOM_URL:url};
    const multiline='First line from stdin\nSecond line from stdin\n';
    const acknowledged=cli(first,['send','--thread',String(cliThread.id)],actor,multiline);
    const sent=acknowledged.match(/^sent #(\d+) to thread (\d+)$/m);
    assert.ok(sent,'success reports the real message ID');
    assert.equal(Number(sent[2]),cliThread.id);
    const fromStdin=await api('GET',`/threads/${cliThread.id}`);
    assert.equal(fromStdin.messages.at(-1).id,Number(sent[1]));
    assert.equal(fromStdin.messages.at(-1).sender,one.id);
    assert.equal(fromStdin.messages.at(-1).text,multiline);
    assert.ok(fromStdin.members.includes(one.id),'sending joins the sender to the thread');
    assert.ok(fromStdin.members.includes(0));
    assert.equal(fromStdin.unread,1);
    assert.match(cli(first,['send','--thread',String(cliThread.id),'Positional','text'],actor),/^sent #\d+ to thread/m);
    const delivered=await api('GET',`/threads/${cliThread.id}`);
    assert.deepEqual(delivered.messages.map(m=>m.text),[multiline,'Positional text']);
    assert.ok(delivered.messages.every(m=>m.sender===one.id));
    assert.equal(delivered.unread,2);
    for(const failure of [
      {args:['send','--thread',String(cliThread.id),'--stdin'],input:multiline,error:/unexpected argument.*--stdin/},
      {args:['send','--thread',String(cliThread.id),'--invented-input'],input:multiline,error:/unexpected argument.*--invented-input/},
      {args:['send','--thread',String(cliThread.id)],input:' \n\t',error:/message is empty/},
      {args:['send','--thread','99999'],input:multiline,error:/no thread/},
    ]) {
      const failed=spawnSync(binary,failure.args,{cwd:first,env:{...env,...actor},encoding:'utf8',input:failure.input});
      assert.notEqual(failed.status,0,'failed sends return a failing exit status');
      assert.match(failed.stderr,failure.error);
      assert.doesNotMatch(failed.stdout,/sent #/,'failed sends never claim delivery');
      assert.equal((await api('GET',`/threads/${cliThread.id}`)).messages.length,2,'failed sends do not write a message');
    }
    await api('POST',`/threads/${cliThread.id}/read`,{message:delivered.messages.at(-1).id});
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
    await api('PUT', `/projects/${a.id}/config`, {config:mine.id});
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
    await api('PUT', `/projects/${a.id}/config`, {config:mine.id});
    for (const task of ['REROUTE_TEST', 'POLICY_TEST']) {
      const failed = await api('POST', '/agents', { project: a.id, harness: 'codex', task });
      await finished(failed.id,'crashed');
      const view = await api('GET', `/agents/${failed.id}`);
      assert.match(view.problem, /rerouted|usage policy/);
      await new Promise(resolve => setTimeout(resolve, 2100));
      assert.equal((await api('GET', `/agents/${failed.id}`)).state, 'crashed');
      assert.equal(runs().filter(r=>r.id===failed.id).length,1,'no rule means no automatic retry');
      await api('POST', `/agents/${failed.id}/resume`, {});
      await until(() => runs().filter(r => r.id === failed.id).length === 2, 'same-model resume');
      const resumed = runs().filter(r => r.id === failed.id)[1];
      assert.equal(resumed.args[resumed.args.indexOf('-m') + 1], defaults.harnesses.codex.model);
      await finished(failed.id);
      assert.equal((await api('GET', `/agents/${failed.id}`)).problem, null);
    }
    // Independent self-change permissions apply to next turn, never mid-command.
    const selfConfig=structuredClone(defaults); selfConfig.allow_agent_model_change=true; selfConfig.allow_agent_effort_change=true;
    await api('PUT',`/projects/${a.id}/config`,{custom:selfConfig});
    const self=await api('POST','/agents',{project:a.id,harness:'codex',task:'SELF_CHANGE_TEST'});
    await until(()=>runs().some(r=>r.id===self.id),'self-config first turn');
    await api('POST','/agent-config',{id:self.id,agent:self.id,model:'gpt-6-luna',effort:'ultra'},400);
    await api('POST','/agent-config',{id:self.id,agent:self.id,model:'claude-opus-5-5'},400);
    await api('POST','/agent-config',{id:self.id,agent:self.id,model:'custom-unallowed'},400);
    await finished(self.id);
    const selfBefore=await api('GET',`/agents/${self.id}`);
    assert.equal(selfBefore.model,'gpt-6-luna'); assert.equal(selfBefore.effort,'high');
    assert.equal(runs().filter(r=>r.id===self.id).length,1);
    const selfThread=await api('POST','/threads',{project:a.id,title:'Continue with changed configuration',members:[String(self.id)]});
    await api('POST','/messages',{thread:selfThread.id,text:'Continue'});
    await api('POST',`/agents/${self.id}/reopen`,{});
    await until(()=>runs().filter(r=>r.id===self.id).length===2,'self-change second turn');
    const selfRun=runs().filter(r=>r.id===self.id)[1];
    assert.equal(selfRun.model,'gpt-6-luna'); assert.equal(selfRun.resume,true);
    assert.match(selfRun.prompt,/Running configuration[\s\S]*gpt-6-luna \/ effort high/);
    await finished(self.id); assert.equal((await api('GET',`/agents/${self.id}`)).session,selfBefore.session);
    await api('PUT',`/projects/${a.id}/config`,{config:mine.id});

    // Explicit same-provider recovery preserves the failed turn, not queued choices.
    const retryConfig=structuredClone(defaults);
    retryConfig.crash_retries['gpt-6-sol']={harness:'codex',model:'gpt-6-luna'};
    retryConfig.limits.active.hard=0;
    retryConfig.limits.active.soft=null;
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    assert.equal((await api('GET',`/overview?project=${a.id}`)).settings.crash_retries['gpt-6-sol'].same_model_retries,0);
    const retry=await api('POST','/agents',{project:a.id,harness:'codex',effort:'high',task:'POLICY_TEST',force:true});
    await until(async()=>(await api('GET',`/agents/${retry.id}`)).retry?.blocked?.includes('Hard limit'),'retry waits for an active slot');
    assert.equal(runs().filter(r=>r.id===retry.id).length,1);
    await api('POST','/agent-config',{id:retry.id,effort:'low'});
    await stop(); await start(); // Preserve the failed effort, not the queued one.
    retryConfig.limits.active.hard=1;
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    await until(()=>runs().filter(r=>r.id===retry.id).length===2,'configured same-provider retry');
    const retryRuns=runs().filter(r=>r.id===retry.id);
    assert.equal(retryRuns[1].resume,true); assert.equal(retryRuns[1].model,'gpt-6-luna');
    assert.ok(retryRuns[1].args.includes('model_reasoning_effort="high"'));
    assert.equal((await api('GET',`/agents/${retry.id}`)).effort,'high');
    assert.equal(fs.existsSync(`/proc/${retryRuns[0].pid}`),false,'old process exited before retry');
    assert.match(retryRuns[1].prompt,/crash recovery/i);
    await finished(retry.id);
    retryConfig.limits.active=structuredClone(defaults.limits.active);

    // An unsupported ultra maps to max on Luna, unless max is disallowed.
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    const incompatible=await api('POST','/agents',{project:a.id,harness:'codex',effort:'ultra',task:'POLICY_TEST'});
    await until(()=>runs().filter(r=>r.id===incompatible.id).length===2,'ultra mapped to Luna max');
    assert.ok(runs().filter(r=>r.id===incompatible.id)[1].args.includes('model_reasoning_effort="max"'));
    assert.equal((await api('GET',`/agents/${incompatible.id}`)).effort,'max');
    await finished(incompatible.id);

    const forbiddenMapping=structuredClone(retryConfig);
    forbiddenMapping.harnesses.codex.efforts=forbiddenMapping.harnesses.codex.efforts.filter(e=>e!=='max');
    await api('PUT',`/projects/${a.id}/config`,{custom:forbiddenMapping});
    const disallowed=await api('POST','/agents',{project:a.id,harness:'codex',effort:'ultra',task:'POLICY_TEST'});
    await until(async()=>(await api('GET',`/agents/${disallowed.id}`)).retry?.blocked?.includes('effort'),'mapped max remains subject to project effort permissions');
    assert.equal(runs().filter(r=>r.id===disallowed.id).length,1);
    await api('POST',`/agents/${disallowed.id}/close`,{});
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});

    // Item diagnostics are visible notices, not failed turns or retry triggers.
    const diagnostic=await api('POST','/agents',{project:a.id,harness:'codex',task:'STARTUP_DIAGNOSTIC_TEST'});
    await finished(diagnostic.id);
    assert.equal((await api('GET',`/agents/${diagnostic.id}`)).problem,null);
    assert.equal(runs().filter(r=>r.id===diagnostic.id).length,1,'successful startup warnings do not trigger configured recovery');
    assert.deepEqual((await api('GET',`/history?project=${a.id}&agent=${diagnostic.id}&kind=agent.failed`)).events,[]);
    assert.ok((await api('GET',`/agents/${diagnostic.id}/log`)).lines.some(line=>line.includes(startupDiagnostic.item.message)),'startup diagnostics remain visible in the output log');
    const diagnosticFailure=await api('POST','/agents',{project:b.id,harness:'codex',task:'STARTUP_DIAGNOSTIC_FAILURE_TEST'});
    await finished(diagnosticFailure.id,'crashed');
    assert.equal((await api('GET',`/agents/${diagnosticFailure.id}`)).problem,'its process exited with an error','a warning alone is not invented as the cause of a nonzero exit');
    await api('POST',`/agents/${diagnosticFailure.id}/close`,{});

    // The parent already exited successfully when its stdout-owning descendant
    // reports failure. That late frame must stop the pipe owner, not hang forever.
    const lateFailure=await api('POST','/agents',{project:b.id,harness:'codex',task:'LATE_FAILURE_PIPE_TEST'});
    const lateChildFile=path.join(home,`late-failure-child-${lateFailure.id}`);
    await until(()=>fs.existsSync(lateChildFile),'late-failure descendant starts');
    const lateChild=Number(fs.readFileSync(lateChildFile,'utf8'));
    await finished(lateFailure.id,'crashed');
    assert.equal((await api('GET',`/agents/${lateFailure.id}`)).problem,'Delayed background failure');
    assert.equal(fs.existsSync(`/proc/${runs().find(r=>r.id===lateFailure.id).pid}`),false,'successful parent was reaped despite the inherited stdout pipe');
    await until(()=>!fs.existsSync(`/proc/${lateChild}/stat`) || fs.readFileSync(`/proc/${lateChild}/stat`,'utf8').includes(') Z '),'late-failure descendant is stopped');
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal(runs().filter(r=>r.id===lateFailure.id).length,1,'no configured rule means no invented automatic retry');
    await api('POST',`/agents/${lateFailure.id}/close`,{});

    // Duplicate error frames and the real cyber-risk wording are a single crash.
    const cyber=await api('POST','/agents',{project:a.id,harness:'codex',task:'CYBER_FAILURE_TEST'});
    await until(()=>runs().filter(r=>r.id===cyber.id).length===2,'cyber-risk process crash recovers');
    assert.equal(runs().filter(r=>r.id===cyber.id)[1].model,'gpt-6-luna');
    assert.match(runs().filter(r=>r.id===cyber.id)[1].prompt,/flagged for possible cybersecurity risk/);
    assert.ok(!runs().filter(r=>r.id===cyber.id)[1].prompt.includes(startupDiagnostic.item.message),'recovery context records the actual failure rather than the earlier hook warning');
    const cyberFailures=(await api('GET',`/history?project=${a.id}&agent=${cyber.id}&kind=agent.failed`)).events;
    assert.equal(cyberFailures.length,1);
    assert.match(cyberFailures[0].details.reason,/^This content was flagged for possible cybersecurity risk\./);
    await finished(cyber.id);
    assert.equal(runs().filter(r=>r.id===cyber.id).length,2,'duplicate terminal frames do not launch duplicate retries');
    const refusal=await api('POST','/agents',{project:a.id,harness:'codex',task:'REFUSAL_OK_TEST'});
    await finished(refusal.id);
    assert.equal(runs().filter(r=>r.id===refusal.id).length,1,'a normally completed refusal is not a crash');

    // Two retries means original + two same-session attempts, then replacement.
    retryConfig.crash_retries['gpt-6-sol'].same_model_retries=2;
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    const counted=await api('POST','/agents',{project:a.id,harness:'codex',task:'RETRY_COUNT_TEST'});
    await until(()=>runs().filter(r=>r.id===counted.id).length===2,'first same-model attempt');
    await finished(counted.id,'crashed');
    retryConfig.limits.active.hard=0; retryConfig.limits.active.soft=null;
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    await until(async()=>(await api('GET',`/agents/${counted.id}`)).retry?.blocked?.includes('Hard limit'),'second attempt waits within active limit');
    await stop(); await start();
    assert.equal(runs().filter(r=>r.id===counted.id).length,2,'restart does not bypass a waiting retry');
    retryConfig.limits.active=structuredClone(defaults.limits.active);
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    await until(()=>runs().filter(r=>r.id===counted.id).length===4,'persisted retry count reaches replacement');
    const countRuns=runs().filter(r=>r.id===counted.id);
    assert.deepEqual(countRuns.map(r=>r.model),['gpt-6-sol','gpt-6-sol','gpt-6-sol','gpt-6-luna']);
    assert.deepEqual(countRuns.map(r=>r.resume),[false,true,true,true]);
    for(let index=1;index<countRuns.length;index++) {
      assert.ok(countRuns[index].at-countRuns[index-1].at>=1900,'failures wait at least two seconds before the next attempt');
      assert.equal(fs.existsSync(`/proc/${countRuns[index-1].pid}`),false,'prior process exited before the next attempt');
    }
    await finished(counted.id);

    // Success starts a fresh retry budget on the next failed turn.
    retryConfig.crash_retries['gpt-6-sol'].same_model_retries=1;
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    const reset=await api('POST','/agents',{project:a.id,harness:'codex',task:'RECOVER_ONCE_TEST'});
    await finished(reset.id);
    assert.deepEqual(runs().filter(r=>r.id===reset.id).map(r=>r.model),['gpt-6-sol','gpt-6-sol']);
    const resetThread=await api('POST','/threads',{project:a.id,title:'A new turn after successful recovery',members:[String(reset.id)]});
    await api('POST','/messages',{thread:resetThread.id,text:'Continue with a fresh retry budget'});
    await api('POST',`/agents/${reset.id}/reopen`,{});
    await finished(reset.id);
    assert.deepEqual(runs().filter(r=>r.id===reset.id).map(r=>r.model),Array(4).fill('gpt-6-sol'));

    // An explicit manual retry also starts over rather than inheriting used attempts.
    const manual=await api('POST','/agents',{project:a.id,harness:'codex',task:'RETRY_COUNT_TEST'});
    await until(()=>runs().filter(r=>r.id===manual.id).length===2,'manual-reset first retry');
    await finished(manual.id,'crashed');
    await api('POST',`/agents/${manual.id}/resume`,{});
    await until(()=>runs().filter(r=>r.id===manual.id).length===4,'manual retry has a new same-model budget');
    assert.deepEqual(runs().filter(r=>r.id===manual.id).map(r=>r.model),Array(4).fill('gpt-6-sol'));
    await api('POST',`/agents/${manual.id}/close`,{});
    retryConfig.crash_retries['gpt-6-sol'].same_model_retries=0;

    // User pause and server shutdown remain pauses, not recovery triggers.
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    const paused=await api('POST','/agents',{project:a.id,harness:'codex',task:'USER_PAUSE_TEST'});
    await until(()=>runs().some(r=>r.id===paused.id),'pause fixture started');
    await api('POST',`/agents/${paused.id}/pause`,{});
    await new Promise(r=>setTimeout(r,2100));
    assert.equal((await api('GET',`/agents/${paused.id}`)).state,'paused');
    assert.equal(runs().filter(r=>r.id===paused.id).length,1);
    await api('POST',`/agents/${paused.id}/close`,{});
    const shutdown=await api('POST','/agents',{project:a.id,harness:'codex',task:'SERVER_STOP_TEST'});
    await until(()=>runs().some(r=>r.id===shutdown.id),'shutdown fixture started');
    await stop(); await start();
    await new Promise(r=>setTimeout(r,2100));
    assert.equal((await api('GET',`/agents/${shutdown.id}`)).state,'paused');
    assert.equal(runs().filter(r=>r.id===shutdown.id).length,1);
    await api('POST',`/agents/${shutdown.id}/close`,{});

    // Cross-provider handoff retains threads/marks, references the actual history,
    // starts a fresh native session, and leaves an inspectable replaced predecessor.
    retryConfig.crash_retries['gpt-6-sol']={harness:'claude',model:'claude-sonnet-5-5'};
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    const handoffActive=await api('POST','/threads',{project:a.id,title:'Dynamic handoff active',watch:['active','group:reviewers'],include_user:false});
    const handoffFailed=await api('POST','/threads',{project:a.id,title:'Dynamic handoff failures',watch:['crashed','group:reviewers'],include_user:false});
    const handoff=await api('POST','/agents',{project:a.id,harness:'codex',effort:'high',task:'HANDOFF_TEST',group:'reviewers'});
    await api('POST','/agent-config',{id:handoff.id,effort:'low'});
    const handoffThread=await api('POST','/threads',{project:a.id,title:'Inherited task',members:[String(handoff.id)]});
    const handoffMessage=await api('POST','/messages',{thread:handoffThread.id,text:'Context for replacement'});
    await api('POST','/marks',{agent:handoff.id,ids:[handoffMessage.id],mark:'in-progress'});
    const handed=await until(async()=>{const v=await api('GET',`/agents/${handoff.id}`);return v.retry?.replacement && v;},'cross-provider replacement');
    const replacement=handed.retry.replacement;
    await until(()=>runs().some(r=>r.id===replacement),'replacement launched');
    const replacementRun=runs().find(r=>r.id===replacement);
    const replacementHistory=await api('GET',`/history?project=${a.id}&agent=${replacement}&kind=agent.created`);
    assert.equal(replacementHistory.events.length,1);
    assert.equal(replacementHistory.events[0].actor,'acom','automatic replacement creation is not attributed to the user');
    assert.equal(replacementHistory.events[0].details.predecessor,handoff.id);
    assert.equal(replacementRun.harness,'claude'); assert.equal(replacementRun.resume,false);
    assert.equal(replacementRun.args[replacementRun.args.indexOf('--effort')+1],'high');
    assert.equal((await api('GET',`/agents/${replacement}`)).effort,'high');
    assert.ok(replacementRun.prompt.includes(handed.conversation_history));
    assert.ok(replacementRun.prompt.includes(handed.output_log));
    assert.match(replacementRun.prompt,new RegExp(`launched by agent ${handoff.id}`));
    assert.match(replacementRun.prompt,new RegExp(`thread #${handoffThread.id}`));
    assert.equal((await api('GET',`/agents/${replacement}`)).group,'reviewers');
    assert.deepEqual((await api('GET',`/threads/${handoffActive.id}`)).members,[replacement],'the committed replacement joins its live audience, not the predecessor');
    assert.deepEqual((await api('GET',`/threads/${handoffFailed.id}`)).members,[],'derived crashed membership is not inherited as a static pin');
    assert.ok((await api('GET',`/threads/${handoffThread.id}`)).members.includes(replacement));
    assert.ok((await api('GET',`/inbox/${replacement}?mark=in-progress`)).some(m=>m.id===handoffMessage.id));
    assert.doesNotMatch(replacementRun.prompt,/respect provider policies|evade refusal|prohibited work/i);
    await finished(replacement);
    assert.deepEqual((await api('GET',`/threads/${handoffActive.id}`)).members,[],'finished replacement leaves the live active audience');
    const predecessor=await api('GET',`/agents/${handoff.id}`);
    assert.equal(predecessor.state,'replaced');
    for(const action of ['resume','reopen','pause','close']) await api('POST',`/agents/${handoff.id}/${action}`,{},409);
    await api('POST','/agent-config',{id:handoff.id,model:'gpt-6-luna',effort:'medium'},409);
    await api('POST',`/agents/${handoff.id}/status`,{text:'Cannot edit a replaced agent'},409);
    await api('POST',`/agents/${handoff.id}/group`,{group:'Cannot move a replaced agent'},409);
    await api('POST',`/agents/${handoff.id}/done`,{},409);
    const unchangedPredecessor=await api('GET',`/agents/${handoff.id}`);
    assert.deepEqual(unchangedPredecessor.retry,predecessor.retry,'terminal operations preserve the replacement link and retry history');
    assert.equal(unchangedPredecessor.state,'replaced');
    assert.equal(unchangedPredecessor.session,predecessor.session);
    assert.equal(unchangedPredecessor.group,predecessor.group);
    assert.equal(unchangedPredecessor.status,predecessor.status);
    assert.ok((await api('GET',`/agents/${handoff.id}/log`)).lines.length>0,'replaced output remains readable');

    // Preparing a handoff is not replacement until its native process starts.
    fs.renameSync(path.join(bin,'claude'),path.join(bin,'claude-unavailable'));
    try {
      const failedHandoff=await api('POST','/agents',{project:a.id,harness:'codex',task:'HANDOFF_TEST'});
      const failedView=await until(async()=>{
        const view=await api('GET',`/agents/${failedHandoff.id}`);
        return view.retry?.handled && view.retry?.blocked && view;
      },'replacement spawn failure');
      assert.equal(failedView.state,'crashed','failed replacement leaves the predecessor recoverable');
      assert.match(failedView.problem,/Temporary handoff failure/);
      if(failedView.retry.replacement) {
        assert.equal((await api('GET',`/agents/${failedView.retry.replacement}`)).state,'crashed');
        assert.equal(runs().some(run=>run.id===failedView.retry.replacement),false,'missing client never starts a replacement process');
      }
      await api('POST',`/agents/${failedHandoff.id}/close`,{});
    } finally { fs.renameSync(path.join(bin,'claude-unavailable'),path.join(bin,'claude')); }

    for(const [model,expected] of [['claude-sonnet-5-5','max'],['claude-haiku-4-5','medium']]) {
      retryConfig.crash_retries['gpt-6-sol']={harness:'claude',model};
      await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
      const effortSource=await api('POST','/agents',{project:a.id,harness:'codex',effort:'ultra',task:'HANDOFF_TEST'});
      const targetId=await until(async()=>(await api('GET',`/agents/${effortSource.id}`)).retry?.replacement,`${model} mapped effort handoff`);
      await until(()=>runs().some(r=>r.id===targetId),'mapped effort replacement launched');
      const effortRun=runs().find(r=>r.id===targetId);
      assert.equal(effortRun.model,model);
      assert.equal((await api('GET',`/agents/${targetId}`)).effort,expected);
      if(expected==='medium') assert.equal(effortRun.args.includes('--effort'),false,'fixed-effort Haiku receives no artificial flag');
      else assert.equal(effortRun.args[effortRun.args.indexOf('--effort')+1],expected);
      assert.match(effortRun.prompt,new RegExp(`ultra[^\\n]*${expected}`));
      await finished(targetId);
    }

    // A -> B -> A cycle stops after B even across providers and server restart.
    retryConfig.crash_retries['gpt-6-sol']={harness:'claude',model:'claude-sonnet-5-5'};
    retryConfig.crash_retries['claude-sonnet-5-5']={harness:'codex',model:'gpt-6-sol'};
    await api('PUT',`/projects/${a.id}/config`,{custom:retryConfig});
    const cycle=await api('POST','/agents',{project:a.id,harness:'codex',task:'RETRY_CHAIN_TEST'});
    const cycleNext=await until(async()=>{const v=await api('GET',`/agents/${cycle.id}`);return v.retry?.replacement;},'cycle first replacement');
    await until(async()=>{const v=await api('GET',`/agents/${cycleNext}`);return v.retry?.blocked?.includes('cycle');},'cycle stopped');
    assert.equal(runs().filter(r=>r.id===cycle.id).length,1); assert.equal(runs().filter(r=>r.id===cycleNext).length,1);
    await stop(); await start();
    await new Promise(r=>setTimeout(r,1100));
    assert.equal(runs().filter(r=>r.id===cycleNext).length,1);
    assert.equal((await api('GET',`/agents/${handoff.id}`)).state,'replaced');
    assert.deepEqual((await api('GET',`/agents/${handoff.id}`)).retry,predecessor.retry,'replacement history survives restart');
    await api('PUT',`/projects/${a.id}/config`,{config:mine.id});

    const rejected=await api('POST','/agents',{project:a.id,harness:'codex',model:'gpt-6.1-sol',task:'UNSUPPORTED_TEST'});
    await until(async()=>(await api('GET',`/agents/${rejected.id}`)).state==='crashed','unsupported model error');
    assert.match((await api('GET',`/agents/${rejected.id}`)).problem,/^The 'gpt-6.1-sol' model is not supported/);
    const noCap=structuredClone(defaults); noCap.limits.usage.codex={soft:null,hard:null}; noCap.auto_resume=false; noCap.usage_poll_secs=15;
    noCap.crash_retries['gpt-6-sol']={harness:'codex',model:'gpt-6-luna',same_model_retries:2};
    await api('PUT',`/configs/${mine.id}`,{settings:noCap});
    const quota=(used,reset)=>({rateLimits:{primary:{usedPercent:used,resetsAt:reset}}});
    const subscription=path.join(home,'subscription.json');
    const resetAt=Math.floor(Date.now()/1000)+2;
    fs.writeFileSync(subscription,JSON.stringify(quota(100,resetAt)));
    const exhausted=await api('POST','/agents',{project:a.id,harness:'codex',task:'LIMIT_TEST'});
    await until(async()=>(await api('GET',`/agents/${exhausted.id}`)).pause_reason==='limit','harness subscription pause with no hard cap');
    await new Promise(resolve=>setTimeout(resolve,3200));
    assert.equal((await api('GET',`/agents/${exhausted.id}`)).state,'paused');
    assert.equal(runs().filter(r=>r.id===exhausted.id).length,1,'quota waits do not consume crash retries');
    const checks=fs.readFileSync(path.join(home,'checks.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(checks.some(c=>c.at>=resetAt*1000 && c.at<=(resetAt+2)*1000),'provider-reported reset gets an immediate check, not the periodic delay');
    noCap.usage_poll_secs=3600; await api('PUT',`/configs/${mine.id}`,{settings:noCap});
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
    noCap.usage_poll_secs=15; await api('PUT',`/configs/${mine.id}`,{settings:noCap});
    fs.writeFileSync(subscription,JSON.stringify(quota(0,Math.floor(Date.now()/1000)+3600)));
    await until(async()=>(await api('GET',`/limits?project=${a.id}`)).usage.filter(u=>u.provider==='codex').every(u=>u.used_pct===0),'periodic checks discover an early reset',20000);
    assert.equal((await api('GET',`/agents/${exhausted.id}`)).state,'paused','auto-resume is off');
    noCap.auto_resume=true; await api('PUT',`/configs/${mine.id}`,{settings:noCap});
    await until(()=>runs().filter(r=>r.id===exhausted.id).length===2,'automatic same-session recovery');
    const recovery=runs().filter(r=>r.id===exhausted.id)[1];
    assert.ok(recovery.resume); assert.match(recovery.prompt,/Commands may have only partially executed/);
    assert.match(recovery.prompt,/Literal \{updates\} resume/);
    assert.match(recovery.prompt,/codex 0% \(no limit\)/);
    assert.ok(recovery.prompt.lastIndexOf('## Limits and rules right now') > recovery.prompt.lastIndexOf('user changed the limits or rules'));
    await finished(exhausted.id); await api('PUT',`/configs/${mine.id}`,{settings:defaults});
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
    const otherThread = await api('POST', '/threads', { project: b.id, title: 'Independent done-only wake', watch: ['done'] });
    await api('POST', '/messages', { thread: otherThread.id, text: 'Use project B slot' });
    await until(() => runs().filter(r => r.id === scopedB.id).length === 2, 'project B wakes despite blocked project A');
    const doneWake=runs().filter(r=>r.id===scopedB.id)[1];
    assert.match(doneWake.prompt, /## Limits and rules right now/);
    const doneCoordination=doneWake.prompt.split('\n').find(line=>line.startsWith('[acom] Coordination:'));
    assert.match(doneCoordination,/\bleft 1\b/,'done-only membership leaves before the wake prompt is rendered');
    assert.match(doneCoordination,/\bpending 1\b/,'the triggering message remains pending after leaving its audience');
    assert.doesNotMatch(doneCoordination,/\bthreads [1-9]/,'summary describes the current working audience rather than the old done audience');
    assert.equal(doneWake.membership_snapshot.state,'working');
    assert.ok(!doneWake.membership_snapshot.threads.includes(otherThread.id));
    assert.deepEqual((await api('GET',`/threads/${otherThread.id}`)).members,[0]);
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
    await api('PUT',`/configs/${mine.id}`,{name:'Mine renamed',settings:defaults});
    const savedConfigRows=storedConfigs();
    await stop(); await start();
    assert.deepEqual(storedConfigs(),savedConfigRows,'restart leaves only named configs and preserves their exact saved settings');
    assert.equal((await api('GET', `/threads/${thread.id}`)).last_read, savedRead);
    assert.equal((await api('GET', `/threads/${thread.id}`)).unread, 1);
    assert.equal((await api('GET', `/overview?project=${a.id}`)).settings.auto_resume, false);
    assert.equal((await api('GET', `/overview?project=${b.id}`)).project.config, null);
    assert.equal((await api('GET', '/configs')).find(c => c.id === saved.id).name, 'Small renamed');
    assert.deepEqual((await api('GET','/configs')).find(c=>c.id===1).settings,builtin.settings,'Default stays built-in after configuration edits and restart');
    assert.equal((await api('GET','/configs')).find(c=>c.id===mine.id).name,'Mine renamed');
    assert.deepEqual((await api('GET','/configs')).find(c=>c.id===mine.id).settings,defaults,'startup preserves editable saved configurations');
    await api('PUT', `/projects/${b.id}/config`, { config: saved.id });
    assert.deepEqual((await api('GET', '/configs')).find(c => c.id === saved.id).projects, [a.id, b.id]);
    for (const p of [a.id, b.id]) await api('PUT', `/projects/${p}/config`, { config: mine.id });
    await api('POST', `/configs/${saved.id}/remove`, {});
    assert.deepEqual((await api('GET', '/projects')).map(p=>p.id).sort((a,b)=>a-b),[a.id,b.id,lifecycleProject.id,followupProject.id].sort((a,b)=>a-b));
    assert.equal(fs.existsSync(path.join(first, '.acom')), false);
    assert.equal(fs.existsSync(path.join(second, '.acom')), false);
    assert.equal(stderr.replaceAll('tick: database: TEST_HANDOFF_CANCEL_FAILURE\n',''),'','only the deliberately injected cancellation failure may reach stderr');
  } finally {
    await stop();
    // Failed assertions can leave a deliberately held fake turn alive after
    // SIGTERM. Validate its temp home and fake path before stopping its group.
    for(const {pid} of runs()) {
      try {
        const vars=fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0');
        const args=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
        if(vars.includes(`ACOM_HOME=${home}`) && args.some(arg=>arg===path.join(bin,'codex') || arg===path.join(bin,'claude'))) process.kill(-pid,'SIGKILL');
      } catch(error) { if(!['ENOENT','ESRCH'].includes(error.code)) throw error; }
    }
    for(const name of fs.readdirSync(home).filter(name=>/^(replacement|late-failure)-child-\d+$/.test(name))) {
      try {
        const pid=Number(fs.readFileSync(path.join(home,name),'utf8'));
        const vars=fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0');
        const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
        const group=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[2]);
        if(vars.includes(`ACOM_HOME=${home}`) && runs().some(run=>run.pid===group)) process.kill(-group,'SIGKILL');
      } catch(error) { if(!['ENOENT','ESRCH'].includes(error.code)) throw error; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function followupChecks({api,cli,runs,finished,start,stop,root,home,bin,env,defaults,serverErrors}) {
  const folder=path.join(root,'followups'); fs.mkdirSync(folder);
  const project=await api('POST','/projects',{path:folder});
  const config=structuredClone(defaults);
  config.done_closes=false; config.auto_resume=false;
  config.allow_agent_model_change=true; config.allow_agent_effort_change=true;
  const settings=custom=>api('PUT',`/projects/${project.id}/config`,{custom});
  await settings(config);
  const view=id=>api('GET',`/agents/${id}`);
  const captures=id=>runs().filter(r=>r.id===id);
  const events=async id=>(await api('GET',`/history?project=${project.id}&agent=${id}&limit=200`)).events;
  const launch=async (task,extra={})=>{
    const agent=await api('POST','/agents',{project:project.id,harness:'codex',model:'gpt-6-luna',effort:'low',task,...extra});
    await until(()=>captures(agent.id).length===1,`controlled turn ${agent.id} starts`);
    if(!task.includes('NEXT_TURN_NO_SESSION')) await until(async()=>(await view(agent.id)).session,`controlled turn ${agent.id} records its session`);
    return agent;
  };
  const release=id=>fs.writeFileSync(path.join(home,`release-${id}`),'');
  const configure=(id,extra,status=200)=>api('POST','/agent-config',{id,agent:id,...extra},status);
  const noFollowup=async (id,state)=>{
    await finished(id,state);
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal(captures(id).length,1,'cancelled or absent intent must not start another turn');
    assert.equal((await view(id)).continuation,null);
    assert.equal((await view(id)).replacement_request,null);
  };
  const rejectedCli=(id,args)=>{
    const result=spawnSync(binary,args,{cwd:folder,env:{...env,ACOM_ID:String(id)},encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.doesNotMatch(result.stdout,/queued|launched agent/);
    return result.stderr;
  };

  // The current turn never changes; latest explicit continuation wins and an
  // ordinary configure only updates the choice, not the queued instruction.
  const continuing=await launch('NEXT_TURN_CONTINUE latest wins');
  const session=(await view(continuing.id)).session;
  await configure(continuing.id,{model:'gpt-6-sol',effort:'medium',continuation:'Discarded earlier instruction'});
  assert.match(cli(folder,['configure','--model','gpt-6-sol','--continue','Use the latest continuation'],{ACOM_ID:String(continuing.id)}),/continuation queued/);
  assert.match(cli(folder,['configure','--effort','high'],{ACOM_ID:String(continuing.id)}),/does not schedule a turn/);
  assert.equal((await view(continuing.id)).continuation.text,'Use the latest continuation');
  assert.deepEqual((await view(continuing.id)).running_configuration,{model:'gpt-6-luna',effort:'low'});
  const stable=await events(continuing.id);
  for(const continuation of ['  ','x'.repeat(16001),17]) {
    await configure(continuing.id,{effort:'high',continuation},400);
    assert.deepEqual(await events(continuing.id),stable,'invalid input cannot add notices/events or mutate intent');
  }
  const pendingThread=await api('POST','/threads',{project:project.id,title:'Continuation pending delivery',members:[String(continuing.id)]});
  const pending=await api('POST','/messages',{thread:pendingThread.id,text:'Fold this message into the explicit continuation'});
  assert.equal(captures(continuing.id)[0].model,'gpt-6-luna');
  release(continuing.id);
  await until(()=>captures(continuing.id).length===2,'explicit same-session continuation starts');
  const next=captures(continuing.id)[1];
  assert.equal(next.resume,true); assert.equal(next.model,'gpt-6-sol');
  assert.ok(next.args.includes(session)); assert.ok(next.args.includes('model_reasoning_effort="high"'));
  assert.match(next.prompt,/Use the latest continuation/);
  assert.doesNotMatch(next.prompt,/Discarded earlier instruction/);
  assert.match(next.prompt,/\bpending 1\b/);
  assert.equal(next.membership_snapshot.state,'working');
  assert.equal(fs.existsSync(`/proc/${captures(continuing.id)[0].pid}`),false,'old process is reaped before its continuation');
  await finished(continuing.id,'done');
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(captures(continuing.id).length,2,'pending-message wake cannot duplicate the explicit continuation');
  assert.equal((await view(continuing.id)).session,session);
  assert.equal((await view(continuing.id)).running_configuration,null);
  assert.equal((await view(continuing.id)).continuation,null);
  assert.equal((await api('GET',`/messages/${pending.id}?agent=${continuing.id}`)).mark,'handled');
  const stateChanges=(await events(continuing.id)).filter(e=>e.kind==='agent.state').reverse().map(e=>e.details.to);
  assert.deepEqual(stateChanges,['working','idle','working','done'],'successful first exit does not mark the agent done before continuing');
  await configure(continuing.id,{effort:'medium',continuation:'Cannot schedule from done'},409);
  await api('POST',`/agents/${continuing.id}/close`,{});

  const plain=await launch('NEXT_TURN_PLAIN no scheduling');
  await configure(plain.id,{model:'gpt-6-sol',effort:'high'});
  release(plain.id); await noFollowup(plain.id,'idle');
  await api('POST',`/agents/${plain.id}/close`,{});

  const noSession=await launch('NEXT_TURN_NO_SESSION explicit continuation');
  await configure(noSession.id,{effort:'high',continuation:'Do not silently create a fresh session'});
  release(noSession.id); await noFollowup(noSession.id,'idle');
  assert.equal((await view(noSession.id)).session,null);
  assert.match((await view(noSession.id)).problem,/did not record a native session/);
  await api('POST',`/agents/${noSession.id}/close`,{});

  // Explicit done, user stops and actual failures cancel intent. Successful
  // exit is insufficient when a structured turn.failed was emitted.
  for(const action of ['fail','done','pause','close']) {
    const agent=await launch(`NEXT_TURN_${action==='fail' ? 'FAIL' : action==='done' ? 'DONE' : 'CANCEL'} ${action}`,action==='fail' ? {model:'gpt-6-sol'} : {});
    await configure(agent.id,{effort:'high',continuation:'This cancelled instruction must not run'});
    if(action==='pause') await api('POST',`/agents/${agent.id}/pause`,{locks:'release'});
    else if(action==='close') await api('POST',`/agents/${agent.id}/close`,{});
    else release(agent.id);
    await noFollowup(agent.id,{fail:'crashed',done:'done',pause:'paused',close:'closed'}[action]);
    assert.ok((await events(agent.id)).some(e=>e.kind==='agent.followup-cancelled'));
    if(action!=='close') await api('POST',`/agents/${agent.id}/close`,{});
  }
  const interrupted=await launch('NEXT_TURN_CANCEL restart');
  await configure(interrupted.id,{effort:'high',continuation:'Cancelled by restart'});
  await stop(); await start();
  await noFollowup(interrupted.id,'paused');
  release(interrupted.id);
  await api('POST',`/agents/${interrupted.id}/resume`,{});
  await finished(interrupted.id,'done');
  assert.equal(captures(interrupted.id).length,2);
  assert.doesNotMatch(captures(interrupted.id)[1].prompt,/## Continuation\n\nCancelled by restart/);
  await api('POST',`/agents/${interrupted.id}/close`,{});

  // Ready, blocked intent survives a restart without starting a provider turn.
  const waiting=await launch('NEXT_TURN_CONTINUE temporarily disabled');
  await configure(waiting.id,{model:'gpt-6-sol',continuation:'Continue after the model is allowed again'});
  const disabled=structuredClone(config); disabled.harnesses.codex.model='gpt-6-luna';
  disabled.harnesses.codex.models=disabled.harnesses.codex.models.filter(m=>m!=='gpt-6-sol');
  await settings(disabled); release(waiting.id);
  await until(async()=>{const a=await view(waiting.id); return a.state==='idle' && a.continuation?.blocked;},'blocked continuation is visible');
  assert.equal(captures(waiting.id).length,1);
  await stop(); await start();
  assert.equal((await view(waiting.id)).state,'idle');
  assert.equal((await view(waiting.id)).continuation.text,'Continue after the model is allowed again');
  await settings(config);
  await finished(waiting.id,'done');
  assert.equal(captures(waiting.id).length,2);
  await api('POST',`/agents/${waiting.id}/close`,{});

  // Warnings belong to this identity and committed replacement predecessors,
  // not coworkers, launchers or other agents that happen to share a project.
  const failed=await launch('NEXT_TURN_FAIL_OWN_HISTORY actual snapshot',{model:'gpt-6-sol'});
  await configure(failed.id,{model:'gpt-6-luna'});
  release(failed.id); await finished(failed.id,'crashed');
  const failure=(await events(failed.id)).find(e=>e.kind==='agent.failed');
  assert.equal(failure.details.model,'gpt-6-sol'); assert.equal(failure.details.harness,'codex');
  assert.equal((await view(failed.id)).model,'gpt-6-luna');
  const independent=await launch('NEXT_TURN_PLAIN independent coworker');
  await configure(independent.id,{model:'gpt-6-sol'});
  assert.equal((await view(independent.id)).model,'gpt-6-sol','an unrelated coworker does not inherit another identity\'s crash warning');
  release(independent.id); await finished(independent.id,'idle');
  await api('POST',`/agents/${independent.id}/close`,{});
  await api('POST',`/agents/${failed.id}/resume`,{});
  await until(()=>captures(failed.id).length===2,'same identity resumes with its queued unfailed model');
  assert.equal(captures(failed.id)[1].model,'gpt-6-luna');
  const warned=failed;
  const beforeWarn=await events(warned.id);
  const warning=await configure(warned.id,{model:'gpt-6-sol',continuation:'Only after acknowledgement'},409);
  assert.match(JSON.stringify(warning),/Previous crashes for codex\/gpt-6-sol/);
  assert.match(JSON.stringify(warning),/in your agent history/);
  assert.match(JSON.stringify(warning),/Controlled first-turn failure/);
  assert.equal((await view(warned.id)).model,'gpt-6-luna');
  assert.equal((await view(warned.id)).continuation,null);
  assert.deepEqual(await events(warned.id),beforeWarn);
  assert.match(rejectedCli(warned.id,['configure','--model','gpt-6-sol','--continue','Rejected CLI intent']),/Previous crashes for/);
  const helper=await api('POST','/agents',{agent:warned.id,harness:'codex',model:'gpt-6-luna',task:'NEXT_TURN_PLAIN independent helper'});
  await until(()=>captures(helper.id).length===1,'ordinary helper starts independently');
  await configure(helper.id,{model:'gpt-6-sol'});
  release(helper.id); await finished(helper.id,'idle');
  const helperOutput=cli(folder,['launch','--harness','codex','--model','gpt-6-sol','--task','Independent helper using predecessor failed model'],{ACOM_ID:String(warned.id)});
  assert.match(helperOutput,/launched agent \d+/,'ordinary launch creates a fresh identity without caller crash history');
  const cliHelperId=Number(helperOutput.match(/launched agent (\d+)/)[1]);
  const otherProvider=await api('POST','/agents',{agent:warned.id,harness:'claude',model:'claude-sonnet-5-5',task:'Different provider helper'});
  assert.match(cli(folder,['configure','--model','gpt-6-sol','--continue','Acknowledged continuation','--ack-crashes'],{ACOM_ID:String(warned.id)}),/continuation queued/);
  fs.writeFileSync(path.join(home,`release-${warned.id}-1`),'');
  await until(()=>captures(warned.id).length===3,'acknowledged own-history continuation starts');
  assert.match(captures(warned.id)[2].prompt,/Acknowledged continuation/);
  await configure(warned.id,{effort:'medium'}); // Same actual Sol model: effort changes do not warn.
  await finished(warned.id,'done');
  await api('POST','/agent-config',{id:warned.id,model:'gpt-6-luna'});
  await api('POST',`/agents/${warned.id}/close`,{});
  const ownHistoryThread=await api('POST','/threads',{project:project.id,title:'Continue this identity after success',members:[String(warned.id)],include_user:false});
  await api('POST','/messages',{thread:ownHistoryThread.id,text:'Continue after the successful acknowledged turn'});
  await api('POST',`/agents/${warned.id}/reopen`,{});
  await until(()=>captures(warned.id).length===4,'own history survives successful turns and explicit reopen');
  await configure(warned.id,{model:'gpt-6-sol'},409);
  await api('POST','/agent-config',{id:warned.id,model:'gpt-6-sol',effort:'medium'}); // User override is never gated.
  for(const id of [helper.id,cliHelperId,otherProvider.id]) await api('POST',`/agents/${id}/close`,{});

  const lineageRequest={harness:'claude',model:'claude-sonnet-5-5',effort:'high',task:'Continue this identity through another provider'};
  await api('POST',`/agents/${warned.id}/replacement`,lineageRequest);
  fs.writeFileSync(path.join(home,`release-${warned.id}-3`),'');
  await until(async()=>(await view(warned.id)).replacement,'own-history source receives a committed replacement');
  const descendant=(await view(warned.id)).replacement;
  await until(()=>captures(descendant).length===1,'own-history replacement holds its turn');
  const backToFailed={harness:'codex',model:'gpt-6-sol',effort:'medium',task:'Return to the earlier provider'};
  const beforeLineageGuard=await events(descendant);
  const lineageWarning=await api('POST',`/agents/${descendant}/replacement`,backToFailed,409);
  assert.match(JSON.stringify(lineageWarning),/Previous crashes for codex\/gpt-6-sol.*in your agent history/);
  assert.match(JSON.stringify(lineageWarning),new RegExp(`agent ${warned.id}, event`));
  assert.deepEqual(await events(descendant),beforeLineageGuard);
  assert.equal((await view(descendant)).replacement_request,null);
  assert.match(rejectedCli(descendant,['launch','--replace','--harness','codex','--model','gpt-6-sol','--task','Rejected lineage return']),/Previous crashes for/);
  assert.match(cli(folder,['launch','--replace','--harness','codex','--model','gpt-6-sol','--task','Acknowledged lineage return','--ack-crashes'],{ACOM_ID:String(descendant)}),/Replacement queued/);
  const doneOutput=cli(folder,['launch','--done','--harness','codex','--model','gpt-6-sol','--task','Distinct done-handoff helper'],{ACOM_ID:String(descendant)});
  const doneHelper=Number(doneOutput.match(/launched agent (\d+)/)[1]);
  assert.equal((await view(descendant)).replacement_request,null,'ordinary --done handoff cancels replacement, without inheriting its crash advisory');
  release(descendant); await finished(descendant,'done');
  await api('POST',`/agents/${descendant}/close`,{});
  await finished(doneHelper,'done'); await api('POST',`/agents/${doneHelper}/close`,{});

  // --replace is not an ordinary helper launch: nothing is created or replaced
  // while the predecessor is still working. Fixed memberships/marks transfer;
  // live membership follows the successor's own committed state and group.
  const live=await api('POST','/threads',{project:project.id,title:'Replacement live audience',watch:['active','group:reviewers'],include_user:false});
  const replacement=await launch('NEXT_TURN_REPLACE_CHILD deliberate',{name:'Carry name',group:'reviewers'});
  const fixed=await api('POST','/threads',{project:project.id,title:'Replacement fixed audience',members:[String(replacement.id)],include_user:false});
  const marked=await api('POST','/messages',{thread:fixed.id,text:'Carry the work mark'});
  await api('POST','/marks',{agent:replacement.id,ids:[marked.id],mark:'in-progress'});
  await api('POST','/locks',{project:project.id,name:'handoff-lock',about:'Locks do not transfer'});
  await api('POST','/locks/acquire',{agent:replacement.id,name:'handoff-lock',wait:0,ttl:30});
  await configure(replacement.id,{model:'gpt-6-sol',effort:'medium',continuation:'Superseded by replacement'});
  assert.deepEqual((await view(replacement.id)).running_configuration,{model:'gpt-6-luna',effort:'low'});
  const targetRequest={harness:'claude',model:'claude-sonnet-5-5',effort:'high',task:'Continue the deliberate handoff'};
  for(const invalid of [{...targetRequest,harness:'codex',model:'gpt-6-luna'},{...targetRequest,force:true},{...targetRequest,done:true}]) {
    await api('POST',`/agents/${replacement.id}/replacement`,invalid,400);
    assert.equal((await view(replacement.id)).continuation.text,'Superseded by replacement');
    assert.equal((await view(replacement.id)).replacement_request,null);
  }
  const beforeReplacement=await api('GET',`/agents?project=${project.id}`);
  const replacementOutput=cli(folder,['launch','--replace','--harness','claude','--model','claude-sonnet-5-5','--effort','high','--task',targetRequest.task],{ACOM_ID:String(replacement.id)});
  assert.match(replacementOutput,/Replacement queued/); assert.doesNotMatch(replacementOutput,/launched agent/);
  assert.equal((await view(replacement.id)).continuation,null);
  assert.equal((await view(replacement.id)).replacement_request.model,targetRequest.model);
  assert.equal((await view(replacement.id)).state,'working');
  assert.equal((await api('GET',`/agents?project=${project.id}`)).length,beforeReplacement.length);
  await api('POST',`/agents/${replacement.id}/replacement`,targetRequest,409);
  await configure(replacement.id,{effort:'medium'},409);
  const childFile=path.join(home,`replacement-child-${replacement.id}`);
  await until(()=>fs.existsSync(childFile),'replacement descendant started');
  const child=Number(fs.readFileSync(childFile,'utf8'));
  release(replacement.id);
  await until(async()=>(await view(replacement.id)).replacement,'deliberate replacement starts');
  const successorId=(await view(replacement.id)).replacement;
  await until(()=>captures(successorId).length===1,'replacement receives task');
  await until(async()=>(await view(successorId)).session,'replacement records its independent session');
  const successor=await view(successorId), target=captures(successorId)[0];
  assert.equal((await view(replacement.id)).state,'replaced');
  assert.equal(target.resume,false); assert.equal(target.harness,'claude'); assert.equal(target.model,targetRequest.model);
  assert.notEqual(successor.session,(await view(replacement.id)).session);
  assert.equal(successor.name,'Carry name'); assert.equal(successor.group,'reviewers');
  assert.equal(successor.effort,'high');
  assert.equal((await api('GET',`/locks?project=${project.id}`)).find(lock=>lock.name==='handoff-lock').holder,null);
  assert.match(target.prompt,/Continue the deliberate handoff/);
  assert.match(target.prompt,new RegExp(`You replace agent ${replacement.id} \\(codex / gpt-6-luna\\)`),'handoff names the actual exited model, not its queued choice');
  assert.match(target.prompt,/Conversation history:.*rollout-/);
  assert.match(target.prompt,/Output log:/); assert.match(target.prompt,/native context, locks and background processes do not transfer/);
  assert.doesNotMatch(target.prompt,/## Continuation\n\nSuperseded by replacement/);
  assert.equal(target.membership_snapshot.state,'working');
  assert.ok(target.membership_snapshot.threads.includes(live.id));
  assert.equal(fs.existsSync(`/proc/${captures(replacement.id)[0].pid}`),false);
  await until(()=>{try{return fs.readFileSync(`/proc/${child}/stat`,'utf8').split(' ')[2]==='Z';}catch(e){if(e.code==='ENOENT')return true;throw e;}},'predecessor background process is stopped');
  assert.deepEqual((await api('GET',`/threads/${live.id}`)).members,[successorId]);
  assert.ok((await api('GET',`/threads/${fixed.id}`)).members.includes(successorId));
  assert.equal((await api('GET',`/messages/${marked.id}?agent=${successorId}`)).mark,'in-progress');
  const created=(await events(successorId)).find(e=>e.kind==='agent.created');
  assert.equal(created.actor,`agent ${replacement.id}`); assert.equal(created.details.predecessor,replacement.id);
  assert.equal((await events(replacement.id)).filter(e=>e.kind==='agent.failed').length,0,'deliberate replacement is not recorded as a crash');
  await finished(successorId,'done'); await api('POST',`/agents/${successorId}/close`,{});

  // Queue after the successful parent has already been reaped but its descendant
  // still owns stdout. Both followup modes must release that pipe and make progress.
  for(const mode of ['CONTINUE','REPLACE']) {
    const source=await launch(`NEXT_TURN_LATE_${mode}`);
    await until(()=>!fs.existsSync(`/proc/${captures(source.id)[0].pid}`),'late-request source is already reaped');
    assert.equal((await view(source.id)).state,'working');
    const background=Number(fs.readFileSync(path.join(home,`replacement-child-${source.id}`),'utf8'));
    if(mode==='CONTINUE') {
      await configure(source.id,{effort:'high',continuation:'Continue after the parent exited'});
      await finished(source.id,'done');
      assert.equal(captures(source.id).length,2);
      assert.equal(captures(source.id)[1].resume,true);
      assert.match(captures(source.id)[1].prompt,/Continue after the parent exited/);
      await api('POST',`/agents/${source.id}/close`,{});
    } else {
      await api('POST',`/agents/${source.id}/replacement`,targetRequest);
      await until(async()=>(await view(source.id)).replacement,'late-request replacement starts');
      const target=(await view(source.id)).replacement;
      await finished(target,'done'); await api('POST',`/agents/${target}/close`,{});
    }
    await until(()=>!fs.existsSync(`/proc/${background}/stat`) || fs.readFileSync(`/proc/${background}/stat`,'utf8').includes(') Z '),'late-request descendant is stopped');
  }

  // Source releases its active slot at successful exit, but no new identity is
  // fabricated until target capacity becomes available.
  const capacity=await launch('NEXT_TURN_REPLACE capacity wait');
  const blocker=await launch('NEXT_TURN_PLAIN occupy capacity');
  release(blocker.id); await finished(blocker.id,'idle');
  const limited=structuredClone(config); limited.limits.active={soft:null,hard:1};
  await settings(limited);
  await api('POST',`/agents/${capacity.id}/replacement`,targetRequest);
  release(capacity.id);
  await until(async()=>{const a=await view(capacity.id);return a.state==='done' && a.replacement_request?.blocked;},'replacement waits for target capacity');
  const waitingCount=(await api('GET',`/agents?project=${project.id}`)).length;
  assert.equal((await view(capacity.id)).replacement,null);
  await stop(); await start();
  assert.equal((await view(capacity.id)).state,'done');
  assert.ok((await view(capacity.id)).replacement_request);
  assert.equal((await api('GET',`/agents?project=${project.id}`)).length,waitingCount);
  await api('POST',`/agents/${blocker.id}/close`,{});
  await until(async()=>(await view(capacity.id)).replacement,'replacement starts after capacity frees');
  const capacityTarget=(await view(capacity.id)).replacement;
  await finished(capacityTarget,'done'); await api('POST',`/agents/${capacityTarget}/close`,{});
  await settings(config);

  // Failure/stop cancellation does not become an accidental helper launch.
  for(const action of ['fail','done','pause','close','restart']) {
    const source=await launch(`NEXT_TURN_${action==='fail' ? 'FAIL' : action==='done' ? 'DONE' : 'REPLACE'} replacement ${action}`);
    const before=(await api('GET',`/agents?project=${project.id}`)).length;
    await api('POST',`/agents/${source.id}/replacement`,targetRequest);
    if(action==='restart') { await stop(); await start(); }
    else if(action==='pause') await api('POST',`/agents/${source.id}/pause`,{locks:'release'});
    else if(action==='close') await api('POST',`/agents/${source.id}/close`,{});
    else release(source.id);
    await noFollowup(source.id,{fail:'crashed',done:'done',pause:'paused',close:'closed',restart:'paused'}[action]);
    assert.equal((await api('GET',`/agents?project=${project.id}`)).length,before);
    if(action!=='close') await api('POST',`/agents/${source.id}/close`,{});
  }
  const spawnFailure=await launch('NEXT_TURN_REPLACE missing fake target');
  await api('POST',`/agents/${spawnFailure.id}/replacement`,targetRequest);
  const countBeforeFailure=(await api('GET',`/agents?project=${project.id}`)).length;
  fs.renameSync(path.join(bin,'claude'),path.join(bin,'claude.disabled'));
  try {
    release(spawnFailure.id);
    await until(async()=>{const a=await view(spawnFailure.id);return a.state==='idle' && a.problem;},'failed target spawn leaves original usable');
    assert.equal((await view(spawnFailure.id)).replacement,null);
    assert.equal((await view(spawnFailure.id)).replacement_request,null);
    assert.equal((await api('GET',`/agents?project=${project.id}`)).length,countBeforeFailure,'failed target creation is rolled back without an orphan');
    assert.equal((await events(spawnFailure.id)).filter(e=>e.kind==='agent.failed').length,0);
    assert.equal(captures(spawnFailure.id).length,1);
  } finally { fs.renameSync(path.join(bin,'claude.disabled'),path.join(bin,'claude')); }
  await api('POST',`/agents/${spawnFailure.id}/close`,{});

  // A start attempt is durable before spawning. Even when saving its cancellation
  // fails, restarting must retry the cleanup rather than spawn a successor again.
  const persistenceFailure=await launch('NEXT_TURN_REPLACE cancellation persistence');
  await api('POST',`/agents/${persistenceFailure.id}/replacement`,targetRequest);
  const beforePersistenceFailure=(await api('GET',`/agents?project=${project.id}`)).length;
  const dbAction=action=>{
    const db=new DatabaseSync(path.join(home,'acom.db'));
    try { db.exec('PRAGMA busy_timeout=5000'); return action(db); } finally { db.close(); }
  };
  const attempted=()=>dbAction(db=>db.prepare('SELECT attempted FROM agent_handoffs WHERE agent_id=?').get(persistenceFailure.id)?.attempted);
  dbAction(db=>db.exec(`CREATE TRIGGER reject_test_handoff_cancel BEFORE DELETE ON agent_handoffs WHEN OLD.agent_id=${persistenceFailure.id} BEGIN SELECT RAISE(ABORT,'TEST_HANDOFF_CANCEL_FAILURE'); END;`));
  fs.renameSync(path.join(bin,'claude'),path.join(bin,'claude.disabled'));
  try {
    release(persistenceFailure.id);
    await until(async()=>attempted()===1 && (await view(persistenceFailure.id)).state==='done','attempt persists despite rejected cancellation');
    await until(()=>serverErrors().includes('tick: database: TEST_HANDOFF_CANCEL_FAILURE'),'failed cancellation is retried as persistence only');
    assert.equal((await api('GET',`/agents?project=${project.id}`)).length,beforePersistenceFailure);
    fs.renameSync(path.join(bin,'claude.disabled'),path.join(bin,'claude'));
    await stop(); await start();
    assert.equal(attempted(),1);
    assert.equal((await view(persistenceFailure.id)).state,'done');
    assert.equal((await api('GET',`/agents?project=${project.id}`)).length,beforePersistenceFailure);
    dbAction(db=>db.exec('DROP TRIGGER reject_test_handoff_cancel'));
    await until(async()=>{const a=await view(persistenceFailure.id);return a.state==='idle' && a.problem && a.replacement_request===null;},'restart saves cancellation without launching a successor');
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal((await view(persistenceFailure.id)).replacement,null);
    assert.equal((await api('GET',`/agents?project=${project.id}`)).length,beforePersistenceFailure);
    assert.equal(captures(persistenceFailure.id).length,1);
    assert.equal((await events(persistenceFailure.id)).filter(e=>e.kind==='agent.failed').length,0);
  } finally {
    dbAction(db=>db.exec('DROP TRIGGER IF EXISTS reject_test_handoff_cancel'));
    if(fs.existsSync(path.join(bin,'claude.disabled'))) fs.renameSync(path.join(bin,'claude.disabled'),path.join(bin,'claude'));
  }
  await api('POST',`/agents/${persistenceFailure.id}/close`,{});
  for(const thread of await api('GET',`/threads?project=${project.id}`)) {
    const messages=(await api('GET',`/threads/${thread.id}`)).messages;
    if(messages.length) await api('POST',`/threads/${thread.id}/read`,{message:messages.at(-1).id});
  }
  return project;
}

async function lifecycleChecks({api,cli,runs,finished,start,stop,root,home,defaults}) {
  const folder=path.join(root,'lifecycle'); fs.mkdirSync(folder);
  const project=await api('POST','/projects',{path:folder});
  const config=structuredClone(defaults); config.done_closes=false; config.auto_resume=false;
  await api('PUT',`/projects/${project.id}/config`,{custom:config});
  const active=await api('POST','/threads',{project:project.id,title:'Live active audience',watch:['active']});
  const grouped=await api('POST','/threads',{project:project.id,title:'Live group audience',watch:['group:blue'],include_user:false});
  const combined=await api('POST','/threads',{project:project.id,title:'States and groups',watch:['working','idle','group:blue','group:green'],include_user:false});
  const done=await api('POST','/threads',{project:project.id,title:'Done audience',watch:['done'],include_user:false});
  const paused=await api('POST','/threads',{project:project.id,title:'Paused audience',watch:['paused'],include_user:false});
  const members=async thread=>(await api('GET',`/threads/${thread.id}`)).members;
  const history=(query='')=>api('GET',`/history?project=${project.id}${query}`);
  assert.deepEqual(await members(active),[0]);
  for(const thread of [grouped,combined,done,paused]) assert.deepEqual(await members(thread),[]);
  for(const watch of [['user'],['123'],['unknown'],['group:']]) {
    await api('POST','/threads',{project:project.id,title:'Invalid watch',watch},400);
  }
  await api('POST','/threads',{project:project.id,title:'Conflicting members',members:['active'],watch:['active']},400);
  const before=await api('POST','/messages',{thread:active.id,text:'Before the first membership'});
  const agent=await api('POST','/agents',{project:project.id,harness:'codex',group:'blue',task:'MEMBERSHIP_HOLD_TEST'});
  await until(()=>runs().some(r=>r.id===agent.id),'held lifecycle turn starts');
  const firstRun=runs().find(r=>r.id===agent.id);
  assert.equal(firstRun.membership_snapshot.state,'working','task input is delivered only after the working state commits');
  for(const thread of [active,grouped,combined]) assert.ok(firstRun.membership_snapshot.threads.includes(thread.id),'the committed membership is visible when the task reaches the harness');
  assert.match(firstRun.prompt,/\[acom\] Coordination:/,'launch receives compact coordination context');
  assert.deepEqual(await members(active),[0,agent.id]);
  for(const route of [`/threads/${active.id}/members`,`/threads/${active.id}/members/remove`]) {
    await api('POST',route,{members:[String(agent.id)]},409);
    assert.deepEqual(await members(active),[0,agent.id],'live membership cannot be manually pinned or removed');
  }
  for(const thread of [grouped,combined]) assert.deepEqual(await members(thread),[agent.id]);
  assert.deepEqual(await members(done),[]);
  const fixed=await api('POST','/threads',{project:project.id,title:'Fixed membership intervals',members:[String(agent.id)],include_user:false});
  const fixedInside=await api('POST','/messages',{thread:fixed.id,text:'Inside fixed membership'});
  await api('POST',`/threads/${fixed.id}/members/remove`,{members:[String(agent.id)]});
  assert.deepEqual(await members(fixed),[0]);
  const fixedGap=await api('POST','/messages',{thread:fixed.id,text:'Between fixed memberships'});
  await api('POST',`/threads/${fixed.id}/members`,{members:[String(agent.id)]});
  assert.deepEqual(await members(fixed),[0,agent.id]);
  await api('POST',`/threads/${fixed.id}/members/remove`,{members:['active']},400);
  const fixedInbox=await api('GET',`/inbox/${agent.id}?mark=new`);
  assert.equal(fixedInbox.find(m=>m.id===fixedInside.id)?.outside_membership,false);
  assert.equal(fixedInbox.find(m=>m.id===fixedGap.id)?.outside_membership,true);
  const fixedHistory=await history(`&thread=${fixed.id}&limit=200`);
  await api('POST',`/threads/${fixed.id}/members`,{members:[String(agent.id)]});
  assert.deepEqual(await history(`&thread=${fixed.id}&limit=200`),fixedHistory,'re-adding an existing member creates no event or interval');
  const unpinned=await api('POST','/threads',{agent:agent.id,title:'Creator is not pinned',watch:['done'],include_user:false});
  assert.deepEqual(await members(unpinned),[],'creating a live thread never pins the creator');
  const inside=await api('POST','/messages',{thread:active.id,text:'During active membership'});
  await api('POST',`/agents/${agent.id}/group`,{group:'red'});
  assert.deepEqual(await members(grouped),[]);
  assert.deepEqual(await members(combined),[],'groups constrain the OR of watched states');
  assert.deepEqual(await members(active),[0,agent.id]);
  const groupGap=await api('POST','/messages',{thread:grouped.id,text:'While outside the group'});
  await api('POST',`/agents/${agent.id}/group`,{group:'green'});
  assert.deepEqual(await members(grouped),[0]);
  assert.deepEqual(await members(combined),[agent.id],'groups combine with OR');
  await api('POST',`/agents/${agent.id}/group`,{group:'blue'});
  assert.deepEqual(await members(grouped),[0,agent.id]);
  const groupInside=await api('POST','/messages',{thread:grouped.id,text:'After rejoining the group'});
  await api('POST',`/agents/${agent.id}/done`,{});
  assert.equal((await api('GET',`/agents/${agent.id}`)).state,'working');
  assert.deepEqual(await members(active),[0,agent.id],'done request is not a state transition until the process finishes');
  fs.writeFileSync(path.join(home,`release-${agent.id}`),'');
  await finished(agent.id,'done');
  for(const thread of [active,grouped,combined]) assert.ok(!(await members(thread)).includes(agent.id));
  for(const thread of [done,unpinned]) assert.deepEqual(await members(thread),[agent.id]);
  const gap=await api('POST','/messages',{thread:active.id,text:'While resting outside active membership'});
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(runs().filter(r=>r.id===agent.id).length,1,'live active audience never wakes a done agent');
  const restingInbox=await api('GET',`/inbox/${agent.id}?mark=new`);
  assert.equal(restingInbox.filter(m=>m.id===inside.id).length,1,'previously delivered messages remain inspectable after leaving');
  assert.equal(restingInbox.find(m=>m.id===gap.id)?.outside_membership,true);
  await api('POST','/messages',{agent:agent.id,thread:active.id,text:'Outside-filter sender does not pin itself'});
  assert.deepEqual(await members(active),[0],'an outside-filter post does not join its sender');
  await api('POST',`/agents/${agent.id}/close`,{});
  await api('POST',`/agents/${agent.id}/reopen`,{});
  assert.equal((await api('GET',`/agents/${agent.id}`)).state,'idle','outside-interval catch-up does not force a new turn on rejoin');
  const afterRejoin=await api('POST','/messages',{thread:active.id,text:'New delivery after explicit rejoin'});
  await until(()=>runs().filter(r=>r.id===agent.id).length===2,'explicit rejoin turn starts');
  const rejoinRun=runs().filter(r=>r.id===agent.id)[1];
  assert.ok(rejoinRun.membership_snapshot.threads.includes(active.id));
  assert.match(rejoinRun.prompt,/\[acom\] Coordination:/,'rejoin receives a fresh coordination summary');
  assert.deepEqual(await members(active),[0,agent.id]);
  const inbox=await api('GET',`/inbox/${agent.id}?mark=new`);
  for(const [message,outside] of [[before,true],[inside,false],[gap,true],[groupGap,true],[groupInside,false],[afterRejoin,false]]) {
    assert.equal(inbox.find(m=>m.id===message.id)?.outside_membership,outside,`message ${message.id} records its membership interval`);
    const detail=await api('GET',`/messages/${message.id}?agent=${agent.id}`);
    assert.equal(detail.outside_membership,outside);
  }
  assert.match(cli(folder,['inbox'],{ACOM_ID:String(agent.id)}),/Before the first membership/);
  await finished(agent.id,'done');

  // Restarts must reconcile paused membership once, not create duplicate joins.
  const held=await api('POST','/agents',{project:project.id,harness:'codex',group:'blue',task:'MEMBERSHIP_HOLD_TEST restart'});
  await until(()=>runs().some(r=>r.id===held.id),'restart lifecycle turn starts');
  await api('POST','/locks',{project:project.id,name:'history-lock',about:'Structured lock events'});
  await api('POST','/locks/acquire',{agent:held.id,name:'history-lock',wait:0,ttl:30});
  await api('POST','/locks/release',{agent:held.id,name:'history-lock'});
  const previousPort=Number(fs.readFileSync(path.join(home,'port'),'utf8'));
  let nextPort=await freePort();
  while(nextPort===previousPort) nextPort=await freePort();
  const oldPid=runs().find(run=>run.id===held.id).pid;
  await stop(); await start(nextPort);
  assert.equal(Number(fs.readFileSync(path.join(home,'port'),'utf8')),nextPort);
  await until(()=>!fs.existsSync(`/proc/${oldPid}/stat`) || fs.readFileSync(`/proc/${oldPid}/stat`,'utf8').includes(') Z '),'changed-port restart stops its previously owned fake client');
  assert.equal((await api('GET',`/agents/${held.id}`)).state,'paused');
  assert.ok(!(await members(active)).includes(held.id));
  assert.deepEqual(await members(paused),[held.id]);
  const afterPause=(await history()).events;
  await stop(); await start();
  assert.deepEqual((await history()).events,afterPause,'unchanged restart does not duplicate lifecycle or membership events');
  await api('POST',`/agents/${held.id}/resume`,{});
  await until(()=>runs().filter(r=>r.id===held.id).length===2,'paused lifecycle turn resumes');
  assert.deepEqual(await members(paused),[]);
  assert.ok((await members(active)).includes(held.id));
  fs.writeFileSync(path.join(home,`release-${held.id}`),'');
  await finished(held.id,'done');

  // Both traversal directions use exclusive, stable event cursors.
  const all=[]; let beforeCursor;
  for(let pageCount=0;pageCount<200;pageCount++) {
    const page=await history(`&limit=3${beforeCursor ? `&before=${beforeCursor}` : ''}`);
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=16000);
    assert.ok(page.events.length<=3);
    for(const event of page.events) {
      assert.ok(event.project===project.id || event.project===null);
      if(all.length) assert.ok(event.id<all.at(-1).id,'backward cursor never repeats or skips ordering');
      all.push(event);
    }
    if(!page.has_more) break;
    assert.equal(page.next_before,page.events.at(-1).id);
    beforeCursor=page.next_before;
  }
  assert.ok(all.length>10,'lifecycle and membership changes have structured history');
  const ascending=[all.at(-1)]; let afterCursor=ascending[0].id;
  for(let pageCount=0;pageCount<200;pageCount++) {
    const page=await history(`&after=${afterCursor}&limit=4`);
    for(const event of page.events) {
      assert.ok(event.id>afterCursor);
      if(ascending.length) assert.ok(event.id>ascending.at(-1).id);
      ascending.push(event);
    }
    if(!page.has_more) break;
    assert.equal(page.next_after,page.events.at(-1).id);
    afterCursor=page.next_after;
  }
  assert.deepEqual(ascending.map(e=>e.id),all.map(e=>e.id).reverse(),'forward and backward history traverse the same complete event set');
  for(const query of ['&limit=0','&limit=201','&max_bytes=511','&max_bytes=65537','&before=1&after=2']) await api('GET',`/history?project=${project.id}${query}`,null,400);
  const selected=all.find(e=>e.agent===agent.id);
  assert.ok(selected);
  assert.equal((await api('GET',`/history/${selected.id}?project=${project.id}`)).id,selected.id);
  const agentHistory=await history(`&agent=${agent.id}&limit=200`);
  assert.ok(agentHistory.events.length>0);
  assert.ok(agentHistory.events.every(e=>e.agent===agent.id));
  const threadHistory=await history(`&thread=${active.id}&limit=200`);
  assert.ok(threadHistory.events.length>0);
  assert.ok(threadHistory.events.every(e=>e.thread===active.id));
  const lockHistory=await history('&lock=history-lock&limit=200');
  assert.ok(lockHistory.events.length>=2);
  assert.ok(lockHistory.events.every(e=>e.lock==='history-lock'));
  const kindHistory=await history(`&kind=${encodeURIComponent(selected.kind)}&limit=200`);
  assert.ok(kindHistory.events.length>0);
  assert.ok(kindHistory.events.every(e=>e.kind===selected.kind));
  const stable=await history(`&agent=${agent.id}&limit=200`);
  await api('POST',`/agents/${agent.id}/group`,{group:'blue'});
  assert.deepEqual(await history(`&agent=${agent.id}&limit=200`),stable,'a no-op group change emits no event');
  const longStatus='Status details '+ 'x'.repeat(4000);
  await api('POST',`/agents/${agent.id}/status`,{text:longStatus});
  const bounded=await history(`&agent=${agent.id}&limit=1&max_bytes=512`);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=512,'the byte budget covers the entire history response');
  assert.equal(bounded.events.length,1,'an oversized newest event still advances the cursor');
  assert.equal(bounded.events[0].truncated,true);
  assert.equal(bounded.next_before,bounded.events[0].id);
  const full=await api('GET',`/history/${bounded.events[0].id}?project=${project.id}`);
  assert.ok(JSON.stringify(full).includes(longStatus),'single-event lookup retains unabridged detail');
  for(const id of [agent.id,held.id]) await api('POST',`/agents/${id}/close`,{});
  const activeMessages=(await api('GET',`/threads/${active.id}`)).messages;
  await api('POST',`/threads/${active.id}/read`,{message:activeMessages.at(-1).id});
  await api('POST',`/projects/${project.id}/remove`,{},409);
  return project;
}

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
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#close-thread').click();
    await page.waitForFunction(()=>document.querySelector('#thread-main').textContent==='Select a thread');
    assert.equal(await page.locator('.thread-row.active').count(),0,'closing clears the selected thread');
    const closedMessage=await api('POST','/messages',{agent,thread,text:'Keep unread while the thread is closed'});
    await page.waitForFunction(thread=>document.querySelector(`[data-thread="${thread}"]`)?.textContent.includes('1 unread'),thread);
    await page.waitForTimeout(1200);
    assert.equal((await api('GET',`/threads/${thread}`)).unread,1,'closed panes never acknowledge new messages');
    assert.equal(await page.locator('#message-form').count(),0);
    await page.locator(`[data-thread="${thread}"]`).click();
    await page.locator(`[data-message="${closedMessage.id}"]`).waitFor();
    await until(async()=>(await api('GET',`/threads/${thread}`)).unread===0,'reopening marks the displayed message read');
    await page.locator('[data-page=overview]').click();
    await page.locator(`[data-action=details][data-id="${agent}"]`).click();
    await page.waitForFunction(() => document.querySelector('#agent-detail-status').textContent.startsWith('Live'));
    const details = await api('GET', `/agents/${agent}`);
    assert.ok((await page.locator('#agent-details').textContent()).includes(details.conversation_history));
    const selectedTask=await page.evaluate(()=>{
      const task=document.querySelector('#agent-details dt[data-key="task"]').nextElementSibling;
      window.selectedTaskNode=task;
      const range=document.createRange(); range.selectNodeContents(task);
      const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    await api('POST', `/agents/${agent}/status`, { text: 'Live status from the test harness' });
    fs.appendFileSync(path.join(home, 'logs', `${agent}.txt`), '\nLive log line from the test harness\n');
    await page.waitForFunction(() => document.querySelector('#agent-log').textContent.includes('Live log line from the test harness'));
    assert.match(await page.locator('#agent-details').textContent(), /Live status from the test harness/);
    assert.equal(await page.evaluate(()=>getSelection().toString()),selectedTask,'live status and activity updates preserve task selection');
    assert.equal(await page.evaluate(()=>window.selectedTaskNode===document.querySelector('#agent-details dt[data-key="task"]').nextElementSibling),true,'task field remains the same DOM node');
    await page.locator('#agent-dialog button[value=cancel]').click();
    await page.reload();
    assert.equal((await api('GET', `/threads/${thread}`)).unread, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

async function browserChecks(url, api, first, second, defaults, mineId) {
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
    assert.match(await page.locator('.thread-header .meta').first().textContent(),/Thread #\d+/);
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
    await page.locator('#config-select').selectOption(String(mineId));
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
    const editedMine=(await api('GET','/configs')).find(c=>c.id===mineId);
    assert.equal(editedMine.settings.limits.active.soft, null);
    assert.equal(editedMine.settings.prompts.resume,guidance);
    assert.equal(editedMine.settings.usage_poll_secs,45);
    await page.reload();
    await page.locator('[data-page=settings]').click();
    await cfg.locator('[name=model] option[value=custom-next]').waitFor({ state: 'attached' });
    assert.equal(await cfg.locator('[name=model]').inputValue(), 'custom-next');
    assert.equal(await active.locator('[name=soft]').inputValue(), '');
    await active.locator('[name=soft]').fill('9');
    await active.locator('[name=hard]').fill('8');
    await page.locator('[form=settings-form]').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes("soft can't be above hard"));
    assert.equal((await api('GET', '/configs')).find(c=>c.id===mineId).settings.limits.active.soft, null);
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
    await active.locator('[name=soft]').fill('');
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
    await api('PUT', `/configs/${mineId}`, { settings: defaults });
  } finally { await browser.close(); }
}
