// Opt-in: uses the installed Codex login and spends subscription usage.
// ACOM_LIVE_TEST=1 node --test tests/live.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('real Codex model access, tools and same-conversation reopen', { skip: process.env.ACOM_LIVE_TEST !== '1' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acom-live-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, ACOM_HOME: path.join(root, 'state') };
  delete env.ACOM_ID; delete env.ACOM_URL;
  const binary = process.env.ACOM_BINARY || path.resolve(__dirname, '../target/debug/acom');
  const server = spawn(binary, ['serve', '--port', String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; server.stderr.on('data', chunk => errors += chunk);
  const url = `http://127.0.0.1:${port}`;
  const stopped = () => {
    const db=new DatabaseSync(path.join(env.ACOM_HOME,'acom.db'),{readOnly:true});
    try{return db.prepare('SELECT count(*) n FROM agents WHERE pid IS NOT NULL').get().n===0;}finally{db.close();}
  };
  const api = async (route, body) => {
    const res = await fetch(url + route, { method: body ? 'POST' : 'GET', headers: {'Content-Type':'application/json'}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await res.json(); assert.equal(res.status, 200, JSON.stringify(value)); return value;
  };
  const until = async (check, label) => {
    const deadline = Date.now()+120000;
    while(Date.now()<deadline) {
      if(server.exitCode!==null || server.signalCode!==null) throw Error(errors || 'Test server stopped');
      const result = await check(); if(result) return result;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw Error(`Timed out: ${label}`);
  };
  const ended = async id => until(async()=> {
    const a=await api(`/agents/${id}`);
    if(['paused','crashed'].includes(a.state)) throw Error(a.problem || a.pause_reason);
    return a.state==='closed' ? a : false;
  },`agent ${id} finished`);
  try {
    await until(async()=> {try{return (await fetch(url+'/overview')).ok;}catch{return false;}},'startup');
    const p=await api('/projects',{path:project});
    const rejected=await api('/agents',{project:p.id,harness:'codex',model:'gpt-6.1-sol',task:'Only run acom done and then finish. Do not change any files.'});
    const access=await until(async()=> {
      const a=await api(`/agents/${rejected.id}`); return ['closed','crashed','paused'].includes(a.state) && stopped() ? a : false;
    },'gpt-6.1-sol account access');
    assert.equal(access.model,'gpt-6.1-sol');
    if(access.state==='crashed') assert.match(access.problem,/not supported/);
    else assert.equal(access.state,'closed',access.problem);
    t.diagnostic(`gpt-6.1-sol: ${access.state}${access.problem ? ' — '+access.problem : ''}`);
    const model=process.env.ACOM_LIVE_MODEL || 'gpt-6-sol';
    const agent=await api('/agents',{project:p.id,harness:'codex',model,effort:'low',task:'Use a shell tool to write exactly first-turn\\n to proof.txt in this project. Run acom me and acom limits to check your identity and rules. Run acom done, then finish. Do not edit anything outside this project or launch helpers.'});
    const first=await ended(agent.id);
    assert.equal(fs.readFileSync(path.join(project,'proof.txt'),'utf8'),'first-turn\n');
    assert.ok(first.session);
    assert.ok(fs.existsSync(first.conversation_history));
    const active=await api('/threads',{project:p.id,title:'Live active audience',watch:['active']});
    assert.deepEqual((await api(`/threads/${active.id}`)).members,[0],'closed agents are outside live active filters');
    const thread=await api('/threads',{project:p.id,title:'Live wake',members:[String(agent.id)]});
    await api('/messages',{thread:thread.id,text:'Read your inbox. Append exactly second-turn\\n to proof.txt with a shell tool, run acom done, then finish. Do not edit anything outside this project or launch helpers.'});
    await new Promise(resolve=>setTimeout(resolve,1500));
    assert.equal((await api(`/agents/${agent.id}`)).state,'closed');
    assert.equal(fs.readFileSync(path.join(project,'proof.txt'),'utf8'),'first-turn\n');
    await api(`/agents/${agent.id}/reopen`,{});
    assert.ok((await api(`/threads/${active.id}`)).members.includes(agent.id),'reopening reconciles live membership before the turn');
    await until(async()=> (await api(`/agents/${agent.id}`)).turns>=2,'wake started');
    const second=await ended(agent.id);
    assert.equal(second.session,first.session);
    assert.equal(second.model,model);
    assert.equal(fs.readFileSync(path.join(project,'proof.txt'),'utf8'),'first-turn\nsecond-turn\n');
    assert.deepEqual((await api(`/threads/${active.id}`)).members,[0]);
    const history=await api(`/history?project=${p.id}&agent=${agent.id}&thread=${active.id}`);
    assert.ok(history.events.some(e=>e.kind==='thread.joined'));
    assert.ok(history.events.some(e=>e.kind==='thread.left'));
    t.diagnostic(`${model}: tools, identity/limits, done, no closed wake, live membership and same-session reopen passed`);
    const limits=await api('/limits');
    t.diagnostic(JSON.stringify({usage:limits.usage.map(w=>({provider:w.provider,window:w.win,used:w.used_pct,reset:w.resets_at})),checks:limits.checks.map(c=>({provider:c.provider,checked:!!c.checked_at,error:c.error}))}));
  } finally {
    try {
      await api('/pause-all',{});
      await until(stopped,'test harnesses stopped');
    } catch {}
    if(server.exitCode===null && server.signalCode===null) { const exited=new Promise(resolve=>server.once('exit',resolve)); server.kill('SIGTERM'); await exited; }
    fs.rmSync(root,{recursive:true,force:true});
  }
});
