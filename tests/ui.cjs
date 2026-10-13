// Browser regressions for the actual page, with a small API fixture (no paid agents).
// npm install --no-save --package-lock=false playwright && npx playwright install chromium
// node --test tests/ui.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
const reloadPage = async page => {
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'live');
};

async function fixture(run) {
  const data = { settings: settings(), agents: [], threads: [], reads: {}, agentLogs: {}, detailRequests: [], getRequests: [], projects: [{ id: 1, name: 'example', path: '/projects/example', config: 2 }, { id: 2, name: 'other', path: '/projects/other', config: 2 }], requests: [], hardLimit: false };
  data.configs = [{ id: 1, name: 'Default', settings: settings() }, { id: 2, name: 'Mine', settings: data.settings }];
  data.folders = { '/home/example': { path:'/home/example', parent:'/home', home:'/home/example', entries:[{name:'work',path:'/home/example/work',directory:true},{name:'note.txt',path:'/home/example/note.txt',directory:false}] }, '/home/example/work':{path:'/home/example/work',parent:'/home/example',home:'/home/example',entries:[]} };
  const configs = () => data.configs.map(c => ({ ...c, projects: data.projects.filter(p => p.config === c.id).map(p => p.id) }));
  const effective = p => p?.config == null && p ? p.custom : data.configs.find(c => c.id === (p?.config ?? 1)).settings;
  const unread = t => t.members.includes(0) ? t.messages.filter(m => m.sender !== 0 && !m.outside_membership && m.id > (data.reads[t.id] || 0)).length : 0;
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
  const projectRows = () => data.projects.map(p => ({...p, agents:data.agents.filter(a => a.project === p.id).length, active:data.agents.filter(a => a.project === p.id && ['working','idle'].includes(a.state)).length, unread:data.threads.filter(t => t.project === p.id).reduce((n,t) => n + unread(t),0)}));
  const collection = (key, project) => {
    if (key === 'projects') return projectRows();
    if (key === 'configs') return configs();
    if (key === 'threads') return data.threads.filter(t => t.project === project).map(t => ({...t,owner:t.owner ?? t.created_by ?? 0,user_member:t.members.includes(0),messages:t.messages.length,unread:unread(t)}));
    if (key === 'agents') return data.agents.filter(a => a.project === project).map(({task,problem,...a})=>({...a,stopping:!!a.stopping,replacement:a.replacement ?? (a.state==='replaced' ? a.retry?.replacement : null),replacement_pending:!!a.replacement_request,replacement_start_pending:!!a.replacement_start,task_preview:task,problem_preview:problem,has_problem:!!problem,model_unavailable:/model.*(not supported|not available|not found)|not supported.*account/i.test(problem || '')}));
    if (key === 'locks') return (data.locks || []).filter(lock=>lock.project == null || lock.project === project).map((lock,i)=>({id:i+1,...lock,holder_stopping:!!(lock.holder && (lock.holder_stopping || data.agents.find(agent=>agent.id===lock.holder)?.stopping))}));
    return (data[key] || []).filter(row => row.project == null || row.project === project).map((row,i) => ({id:i+1,...row}));
  };
  const revision = (key, project) => hash([key,['projects','configs'].includes(key)?null:project,collection(key,project)]);
  function paged(rows, params, rev, snapshot = true) {
    const limit = Math.min(Number(params.get('limit') || 50),data.pageLimit || 200), budget = Number(params.get('max_bytes') || 16000);
    if (snapshot && params.has('revision') && params.get('revision') !== rev) return {error:'collection changed; restart paging',status:409};
    if (params.get('since') === rev) return {unchanged:true,revision:rev};
    const through = params.has('through') ? Number(params.get('through')) : Math.max(0,...rows.map(row => row.id));
    const visible = rows.filter(row => row.id <= through), ascending = params.has('after');
    const candidates = visible.filter(row => (!params.has('before') || row.id < Number(params.get('before'))) && (!ascending || row.id > Number(params.get('after')))).sort((a,b) => ascending ? a.id-b.id : b.id-a.id);
    const envelope = items => ({items,has_more:items.length<candidates.length,next_before:ascending ? null : items.at(-1)?.id ?? null,next_after:ascending ? items.at(-1)?.id ?? null : null,through,revision:rev,total:visible.length});
    const items=[];
    for (const row of candidates.slice(0,limit)) {
      items.push(row);
      if (Buffer.byteLength(JSON.stringify(envelope(items))) > budget) {
        items.pop();
        if (!items.length) items.push({id:row.id,truncated:true,...Object.fromEntries(['project','thread','sender','at','kind','state','stopping','holder_stopping','user_member','unread','messages','private','joinable','owner','created_by','replacement','replacement_pending','replacement_start_pending'].filter(k => row[k] != null).map(k => [k,row[k]]))});
        break;
      }
    }
    return envelope(items);
  }
  function bounded(value, params) {
    const text=JSON.stringify(value), bytes=Buffer.byteLength(text), budget=Number(params.get('max_bytes') || 16000), version=hash(value);
    if (!params.has('offset')) return bytes <= budget ? value : {id:value.id,truncated:true,total_bytes:bytes,next_offset:0,version,format:'json'};
    const offset=Number(params.get('offset'));
    if (params.has('version') && params.get('version') !== version) return {error:'record changed; restart reading',status:409};
    const remaining=Buffer.from(text).subarray(offset).toString('utf8'), chars=Array.from(remaining);
    const envelope = count => {const chunk=chars.slice(0,count).join(''),end=offset+Buffer.byteLength(chunk);return {chunk,offset,next_offset:end,total_bytes:bytes,has_more:end<bytes,version,format:'json'};};
    let low=0,high=chars.length+1;
    while(low+1<high) {const mid=Math.floor((low+high)/2);if(Buffer.byteLength(JSON.stringify(envelope(mid)))<=budget)low=mid;else high=mid;}
    return envelope(low);
  }
  const releaseLocks = id => {
    const agent=data.agents.find(a=>a.id===id); if(agent)agent.locks=[];
    for(const lock of data.locks || [])if(lock.holder===id)Object.assign(lock,{holder:null,holder_name:null,acquired_at:null,expires_at:null});
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url,'http://localhost'), pathname = url.pathname, params = url.searchParams;
    if(req.method==='GET') data.getRequests.push(req.url);
    if (req.method !== 'GET') data.requests.push({ url: req.url, method: req.method, body });
    res.setHeader('Content-Type', 'application/json');
    const send = value => {if(value?.status && value?.error)res.statusCode=value.status;res.end(JSON.stringify(value));};
    if (new URL(req.url, 'http://localhost').pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(fs.readFileSync(path.join(__dirname, '../src/ui.html')));
    }
    if (req.url.startsWith('/overview')) {
      const id = Number(new URL(req.url, 'http://localhost').searchParams.get('project'));
      const project = data.projects.find(p => p.id === id) || data.projects[0] || null;
      if (data.delays?.[id]) await new Promise(resolve => setTimeout(resolve, data.delays[id]));
      const revisions = Object.fromEntries(['projects','configs','agents','threads','locks','activity'].map(key => [key,revision(key,project?.id)]));
      revisions.settings=hash([data.projects,configs()]);
      const restartPaused=data.agents.filter(a=>a.state==='paused' && a.pause_reason==='restart').length;
      const rev=hash([revisions,data.usage,data.checks,restartPaused]);
      if(params.get('since')===rev) return send({unchanged:true,revision:rev});
      return send(bounded({revision:rev,revisions,unread_total:projectRows().reduce((n,p)=>n+p.unread,0),restart_paused:restartPaused, limits:{usage:data.usage || [],checks:data.checks || [],limits:effective(project).limits},project:projectRows().find(p=>p.id===project?.id) || null,url:`http://127.0.0.1:${server.address().port}`},params));
    }
    if(req.method==='GET' && pathname==='/catalog') return send(bounded(catalog,params));
    if(req.method==='GET' && pathname==='/settings') {
      const id=Number(params.get('project')),project=data.projects.find(p=>p.id===id);
      if(data.delays?.[id])await new Promise(resolve=>setTimeout(resolve,data.delays[id]));
      return send(bounded(effective(project),params));
    }
    if(req.method==='GET' && /^\/(projects|configs|agents|threads|locks|activity)$/.test(pathname)) {
      const key=pathname.slice(1),project=Number(params.get('project')) || data.projects[0]?.id;
      return send(paged(collection(key,project),params,revision(key,project),key!=='activity'));
    }
    if(req.method==='GET' && /^\/(projects|configs|locks|activity)\/\d+$/.test(pathname)) {
      const [key,id]=pathname.slice(1).split('/'),project=Number(params.get('project')) || data.projects[0]?.id;
      return send(bounded(collection(key,project).find(row=>row.id===Number(id)),params));
    }
    if(req.method==='GET' && /^\/receipts\/\d+$/.test(pathname))return send(bounded(data.receipts[Number(pathname.split('/')[2])],params));
    if(req.url.startsWith('/folders')) {
      if(req.method==='GET') {
        const p=new URL(req.url,'http://localhost').searchParams.get('path') || '/home/example';
        if(!data.folders[p]) {res.statusCode=400;return send({error:'Cannot open folder'});}
        const folder=data.folders[p], rev=hash(folder);
        if(params.has('revision') && params.get('revision')!==rev)return send({status:409,error:'folder listing changed'});
        const key=e=>`${e.directory?'d':'f'}:${e.name}`,all=[...folder.entries].sort((a,b)=>key(a).localeCompare(key(b))),candidates=all.filter(e=>!params.has('after') || key(e)>params.get('after'));
        const entries=candidates.slice(0,Math.min(Number(params.get('limit') || 50),data.pageLimit || 200));
        return send({...folder,entries,has_more:entries.length<candidates.length,next_after:entries.length?key(entries.at(-1)):null,revision:rev,total:all.length});
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
      return send(data.launchResult || { id: 1, warnings: [] });
    }
    if (req.url === '/agent-config') {
      if (data.agentConfigError && !body.ack_crashes) {
        res.statusCode = data.agentConfigError.status; return send({error:data.agentConfigError.message});
      }
      if (data.agentConfigDelay) await new Promise(resolve => setTimeout(resolve, data.agentConfigDelay));
      const agent = data.agents.find(a => a.id === body.id);
      if (body.model != null) agent.model = body.model;
      if (body.effort != null) agent.effort = body.effort;
      if (typeof body.continuation === 'string') agent.continuation = {text:body.continuation,blocked:null};
      return send({});
    }
    if (/^\/agents\/\d+\/resume$/.test(req.url)) {
      const agent=data.agents.find(a => a.id === Number(req.url.split('/')[2]));
      if(agent.stopping)return send({status:409,error:'Agent is still stopping'});
      Object.assign(agent, {state:'working',pause_reason:null,problem:null});
      return send({warnings:[]});
    }
    if (req.url === '/resume-restart') {
      if(data.resumeRestartError)return send({status:503,error:data.resumeRestartError});
      const eligible=data.agents.filter(a=>a.state==='paused' && a.pause_reason==='restart');
      const ids=eligible.filter(a=>!data.resumeRestartFailures?.[a.id]).map(a=>a.id);
      for(const id of ids)Object.assign(data.agents.find(a=>a.id===id),{state:'working',pause_reason:null});
      return send(data.resumeRestartResult || {ids,warnings:data.resumeRestartWarnings || [],errors:eligible.filter(a=>data.resumeRestartFailures?.[a.id]).map(a=>data.resumeRestartFailures[a.id])});
    }
    if (/^\/agents\/\d+\/pause$/.test(req.url)) {
      if(Object.hasOwn(body,'locks'))return send({status:400,error:'Pause always releases locks; lock options are unsupported'});
      if(data.pauseError)return send({status:503,error:data.pauseError});
      const id=Number(req.url.split('/')[2]);
      Object.assign(data.agents.find(a => a.id === id), {state:'paused',pause_reason:'user',stopping:!!data.pauseStopping});
      if(!data.pauseStopping)releaseLocks(id);
      return send({});
    }
    if(req.url==='/pause-all') {
      if(data.pauseAllError)return send({status:503,error:data.pauseAllError});
      const ids=data.agents.filter(a=>['working','idle','done'].includes(a.state)).map(a=>a.id);
      for(const id of ids) {
        Object.assign(data.agents.find(a=>a.id===id),{state:'paused',pause_reason:'all',stopping:!!data.pauseStopping});
        if(!data.pauseStopping)releaseLocks(id);
      }
      return send({ids});
    }
    if (req.url === '/locks/free') {
      const lock=(data.locks || []).find(lock=>lock.project===body.project&&lock.name===body.name);
      if(Object.hasOwn(body,'expected_holder'))return send({status:400,error:'Frozen-lock release is unsupported'});
      if(lock?.holder_stopping || data.agents.find(agent=>agent.id===lock?.holder)?.stopping)return send({status:409,error:'Lock holder is still stopping'});
      if(lock) Object.assign(lock,{holder:null,holder_name:null,acquired_at:null,expires_at:null});
      return send({});
    }
    if (req.method==='GET' && /^\/agents\/\d+(\/log)?$/.test(pathname)) {
      const id = Number(pathname.split('/')[2]);
      data.detailRequests.push(req.url);
      let value;
      if(pathname.endsWith('/log')) {
        const text=(data.agentLogs[id] || []).join('\n'), raw=Buffer.from(text), total=raw.length, version=data.logVersions?.[id] || `log:${id}`,rev=hash([version,text]);
        if(params.has('version') && params.get('version')!==version)return send({status:409,error:'log changed'});
        if(Number(params.get('after'))>total)return send({status:409,error:'log truncated'});
        if(params.get('since')===rev && (!params.has('after') || Number(params.get('after'))===total))return send({unchanged:true,revision:rev,version,next_after:total,total_bytes:total});
        const ceiling=params.has('through')?Math.min(total,Number(params.get('through'))):total;
        let start=params.has('after')?Number(params.get('after')):0,end=params.has('before')?Number(params.get('before')):ceiling;
        if(!params.has('after') && !params.has('before'))start=total-Buffer.byteLength(text.split('\n').slice(-Number(params.get('lines') || 100)).join('\n'));
        const budget=Number(params.get('max_bytes') || 16000)-400;
        if(params.has('after'))end=Math.min(ceiling,start+budget);else start=Math.max(start,end-budget);
        while(start<end && (raw[start]&0xc0)===0x80)start++;
        while(end>start && end<total && (raw[end]&0xc0)===0x80)end--;
        value={text:raw.subarray(start,end).toString('utf8'),start,end,total_bytes:ceiling,next_before:start,next_after:end,has_more:params.has('after')?end<ceiling:start>0,eof:end===ceiling,version,revision:rev,start_partial:false,end_partial:false};
      } else value=bounded({...data.agents.find(a=>a.id===id)},params);
      if (data.detailDelay) await new Promise(resolve => setTimeout(resolve, data.detailDelay));
      if (data.detailFailure) { res.statusCode = 503; return send({ error: 'Offline' }); }
      return send(value);
    }
    if (req.url === '/threads') {
      const t = { id: data.threads.length + 1, created_by:0, owner:0, ...body, private:!!body.private, joinable:body.joinable !== false && !body.private, members:[...(body.include_user === false ? [] : [0]),...(body.members || [])], messages: [] };
      data.threads.push(t);
      return send({ id: t.id });
    }
    if (req.url.startsWith('/threads/')) {
      const t=data.threads.find(t=>t.id===Number(pathname.split('/')[2]));
      if(req.method==='GET') {
        const metadata={...t,owner:t.owner ?? t.created_by ?? 0,messages:undefined,last_read:data.reads[t.id] || 0,unread:unread(t),latest_message:Math.max(0,...t.messages.map(m=>m.id)),first_unread:unread(t)>0?t.messages.find(m=>m.sender!==0&&!m.outside_membership&&m.id>(data.reads[t.id] || 0)).id:null};
        if(pathname.endsWith('/metadata'))return send(bounded(metadata,params));
        const p=new URLSearchParams(params),first=t.messages.find(m=>m.sender!==0 && !m.outside_membership && m.id>(data.reads[t.id] || 0)),catchup=!p.has('before')&&!p.has('after')&&unread(t)>0;
        if(catchup)p.set('after',first.id-1);
        const messages=paged(t.messages,p,hash([t.messages,data.reads[t.id]]),false);
        if(pathname.endsWith('/messages'))return send({...messages,catchup});
        return send(bounded({...metadata,messages,catchup},params));
      }
      if(req.url.endsWith('/read')) {
        if(data.readDelay) await new Promise(resolve => setTimeout(resolve, data.readDelay));
        if(data.readFailure) {res.statusCode=503;return send({error:'Offline'});}
        data.reads[t.id]=Math.max(data.reads[t.id] || 0,body.message);
        return send({last_read:data.reads[t.id],unread:unread(t)});
      }
      if(req.url.endsWith('/user')) t.members=body.joined ? [...new Set([0,...t.members])] : t.members.filter(id=>id!==0);
      if(req.url.endsWith('/members/remove')) {
        if(data.removeMembersFailure) return send({status:409,error:'Members could not be removed'});
        const ids=new Set(body.members.map(Number)), removed=t.members.filter(id=>ids.has(Number(id)));
        t.members=t.members.filter(id=>!ids.has(Number(id)));
        if(t.watch?.length)t.excluded_members=[...new Set([...(t.excluded_members || []),...body.members.map(Number)])];
        for(const id of removed) (t.events ||= []).push({id:Math.max(0,...t.events.map(e=>e.id))+1,at:Date.now()/1000,kind:'thread.left',agent:Number(id),actor:'user',details:{reason:'Removed by user'}});
      }
      if(req.url.endsWith('/members')) {
        t.members=[...new Set([...t.members,...body.members])];
        if(t.watch?.length)t.excluded_members=(t.excluded_members || []).filter(id=>!body.members.map(Number).includes(Number(id)));
      }
      if(req.url.endsWith('/owner')) {
        if(data.ownerFailure) return send({status:503,error:'Ownership change unavailable'});
        if(!Number.isSafeInteger(body.owner) || body.owner<1 || !data.agents.some(agent=>agent.id===body.owner && agent.project===t.project && agent.state!=='replaced'))return send({status:400,error:'Choose an agent from this project'});
        const from=t.owner ?? t.created_by ?? 0;
        t.owner=body.owner;
        if(from!==body.owner) {
          (t.events ||= []).push({id:Math.max(0,...t.events.map(e=>e.id))+1,at:Date.now()/1000,kind:'thread.owner-changed',agent:body.owner,actor:'user',details:{from,to:body.owner}});
        }
        return send({owner:t.owner});
      }
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
    if(req.method==='GET' && /^\/messages\/\d+$/.test(pathname))return send(bounded(data.threads.flatMap(t=>t.messages).find(m=>m.id===Number(pathname.split('/')[2])),params));
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
  await reloadPage(page);
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
  await reloadPage(page);
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
  await reloadPage(page);
  await page.waitForFunction(() => document.querySelector('#project-select').value === '2');
  assert.equal(await page.locator('#project-path').textContent(), '/projects/other');
}));

test('empty project list prompts for a folder; add and remove never delete files', async () => fixture(async (page, data) => {
  data.projects = [];
  await reloadPage(page);
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
  await reloadPage(page);
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
  await reloadPage(page);
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
  await reloadPage(page);
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
  await reloadPage(page);
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
  await reloadPage(page); await page.locator('[data-page=settings]').click();
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
  await reloadPage(page); await page.locator('[data-page=settings]').click();
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
  data.projects = []; await reloadPage(page);
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  assert.deepEqual(data.requests.find(r => r.url === '/threads').body, {project:1,title:'Chosen members',members:[],include_user:true,private:false,joinable:true});
}));

test('thread creation distinguishes public open, public no-self-join and private access', async () => fixture(async (page, data) => {
  await page.locator('[data-page=threads]').click();
  for (const [index,access] of ['open','invite','private'].entries()) {
    await page.locator('[data-open=thread-dialog]').click();
    await page.locator('#thread-access').selectOption(access);
    await page.locator('#thread-form [name=title]').fill(`${access} conversation`);
    if (access === 'private') await page.locator('#thread-form [name=include_user]').uncheck();
    assert.equal(await page.locator('#thread-mode option[value=live]').evaluate(option=>option.disabled), access !== 'open');
    if (access === 'private') assert.match(await page.locator('#thread-access-help').textContent(), /Only member agents can read it.*always have access.*you or the thread owner can add members directly/);
    if (access === 'invite') assert.match(await page.locator('#thread-access-help').textContent(), /Anyone can read it.*you or the thread owner can add members directly/);
    await page.locator('#thread-form button.primary').click();
    await page.waitForFunction(id => state.thread?.id === id, index + 1);
    const body=data.requests.filter(r=>r.url==='/threads').at(-1).body;
    assert.equal(body.private, access === 'private');
    assert.equal(body.joinable, access === 'open');
    assert.equal(Object.hasOwn(body,'watch'), false);
    const label=access === 'private' ? 'Private · members only' : access === 'invite' ? 'Public · no self-join' : 'Public · open to join';
    assert.ok((await page.locator('.thread-header > div.meta').textContent()).includes(label));
    assert.ok((await page.locator(`[data-thread="${index+1}"] .meta`).textContent()).includes(label));
    assert.equal(await page.locator('#thread-access').inputValue(), 'open', 'successful creation resets access for the next thread');
  }
  assert.equal(data.threads.at(-1).members.includes(0), false, 'not including the user does not hide the administrative thread view');
}));

test('no-self-join access switches live membership to fixed without discarding its filter selections', async () => fixture(async (page, data) => {
  data.agents=[{id:1,project:1,name:'Reviewer',state:'working'}];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-open=thread-dialog]').click();
  await page.locator('#thread-member-picker [name=member][value="1"]').check();
  await page.locator('#thread-mode').selectOption('live');
  await page.locator('[name=watch_groups]').fill('review');
  await page.locator('#thread-access').selectOption('private');
  assert.equal(await page.locator('#thread-mode').inputValue(), 'fixed');
  assert.equal(await page.locator('#thread-live-filters').isHidden(), true);
  assert.match(await page.locator('#thread-mode-help').textContent(), /fixed members.*admit new agents automatically/);
  assert.equal(await page.locator('#thread-member-picker [name=member][value="1"]').isChecked(), true);
  await page.locator('#thread-access').selectOption('open'); await page.locator('#thread-mode').selectOption('live');
  assert.equal(await page.locator('[name=watch_groups]').inputValue(), 'review');
  await page.locator('#thread-access').selectOption('invite');
  await page.locator('#thread-form [name=title]').fill('Fixed no-self-join'); await page.locator('#thread-form button.primary').click();
  await page.waitForFunction(()=>state.thread?.id===1);
  const body=data.requests.find(r=>r.url==='/threads').body;
  assert.deepEqual(body.members,['1']);
  assert.equal(Object.hasOwn(body,'watch'),false);
  assert.equal(body.joinable,false);
}));

test('user removal includes members absent from the bounded agent preview and preserves messages and history', async () => fixture(async (page, data) => {
  data.pageLimit=1; data.agents=[1,2,3].map(id=>({id,project:1,name:`Worker ${id}`,state:'idle'}));
  data.threads=[conversation([incoming(1,'Existing conversation')],{members:[0,1,3],private:true,joinable:false})]; data.reads[1]=1;
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#remove-thread-members').click();
  assert.deepEqual(await page.locator('#remove-member-picker [name=member]').evaluateAll(nodes=>nodes.map(n=>Number(n.value))),[1,3]);
  assert.match(await page.locator('#remove-member-picker').textContent(), /Agent #1/);
  assert.equal(await page.locator('#remove-member-picker [name=member][value="0"]').count(),0);
  await page.locator('#remove-member-picker [data-member-search]').fill('1');
  assert.equal(await page.locator('#remove-member-picker [data-member-row]').filter({hasText:'Worker 3'}).isVisible(),false);
  await page.locator('#remove-member-picker [name=member][value="1"]').check();
  await page.locator('#remove-members-form button.danger').click();
  await page.waitForFunction(()=>!document.querySelector('#remove-members-dialog').open);
  assert.deepEqual(data.threads[0].members,[0,3]);
  assert.deepEqual(data.requests.find(r=>r.url==='/threads/1/members/remove').body,{members:['1']});
  assert.equal(await page.locator('[data-message="1"] .message-text').textContent(),'Existing conversation');
  await page.locator('#thread-history summary').click();
  assert.match(await page.locator('#thread-events').textContent(), /agent 1 left · by user.*Removed by user/);
  await page.locator('#remove-thread-members').click();
  assert.deepEqual(await page.locator('#remove-member-picker [name=member]').evaluateAll(nodes=>nodes.map(n=>Number(n.value))),[3]);
}));

test('live member removals explain durable exclusions and offer explicit restoration by ID', async () => fixture(async (page, data) => {
  data.threads=[conversation([],{watch:['working','idle'],excluded_members:[]})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#remove-thread-members').click();
  assert.match(await page.locator('#remove-members-help').textContent(),/stay excluded.*until explicitly added/);
  await page.locator('#remove-member-picker [name=member][value="1"]').check(); await page.locator('#remove-members-form button.danger').click();
  await page.waitForFunction(()=>!document.querySelector('#remove-members-dialog').open);
  assert.deepEqual(data.threads[0].excluded_members,[1]);
  assert.equal(await page.locator('#remove-thread-members').isDisabled(),true);
  assert.equal(await page.locator('#add-thread-members').textContent(),'Restore members');
  await page.locator('#add-thread-members').click();
  assert.equal(await page.getByRole('dialog',{name:'Restore thread members',exact:true}).count(),1);
  assert.match(await page.locator('#members-help').textContent(),/matching the live filters/);
  assert.match(await page.locator('#add-member-picker').textContent(),/Agent #1/);
  await page.locator('#add-member-picker [name=member][value="1"]').check(); await page.locator('#members-form button.primary').click();
  await page.waitForFunction(()=>!document.querySelector('#members-dialog').open);
  assert.deepEqual(data.threads[0].excluded_members,[]);
  assert.equal(await page.locator('#add-thread-members').isHidden(),true);
  assert.equal(await page.locator('#remove-thread-members').isDisabled(),false);
  assert.deepEqual(data.requests.find(r=>r.url==='/threads/1/members').body,{members:['1']});
}));

test('failed and empty member removals retain the dialog selection and do not retry mutations', async () => fixture(async (page, data) => {
  data.threads=[conversation([])]; data.removeMembersFailure=true;
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#remove-thread-members').click();
  assert.match(await page.locator('#remove-members-help').textContent(), /join again because this thread is open/);
  await page.locator('#remove-members-form button.danger').click();
  assert.equal(data.requests.filter(r=>r.url.endsWith('/members/remove')).length,0);
  await page.locator('#remove-member-picker [name=member][value="1"]').check(); await page.locator('#remove-members-form button.danger').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('could not be removed'));
  assert.equal(await page.locator('#remove-members-dialog').isVisible(),true);
  assert.equal(await page.locator('#remove-member-picker [name=member][value="1"]').isChecked(),true);
  assert.equal(await page.locator('#remove-members-form button.danger').isDisabled(),false);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/members/remove')).length,1);
  assert.deepEqual(data.threads[0].members,[0,1]);
}));

test('ownership can transfer directly to an off-page agent without changing membership or creator', async () => fixture(async (page, data) => {
  data.pageLimit=1; data.agents=[1,2,3].map(id=>({id,project:1,name:`Worker ${id}`,state:'idle'}));
  data.threads=[conversation([],{created_by:0,owner:0,private:true,joinable:false})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('.thread-header > div.meta').textContent(), /Owner: you/);
  await page.locator('#change-thread-owner').click();
  assert.equal(await page.getByRole('dialog',{name:'Change thread owner',exact:true}).count(),1);
  assert.match(await page.locator('#thread-owner-form').textContent(),/Ownership changes do not add or remove members/);
  assert.deepEqual(await page.locator('#thread-owner-options option').evaluateAll(nodes=>nodes.map(node=>Number(node.value))),[3]);
  await page.locator('#thread-owner-form [name=owner]').fill('2'); await page.locator('#thread-owner-form button.primary').click();
  await page.waitForFunction(()=>!document.querySelector('#thread-owner-dialog').open);
  assert.deepEqual(data.requests.find(r=>r.url==='/threads/1/owner').body,{owner:2});
  assert.equal(data.threads[0].owner,2);
  assert.equal(data.threads[0].created_by,0);
  assert.deepEqual(data.threads[0].members,[0,1]);
  assert.match(await page.locator('.thread-header > div.meta').textContent(),/Owner: #2/);
  await page.locator('#thread-history summary').click();
  assert.match(await page.locator('#thread-events').textContent(),/Owner changed: user → agent 2 · by user/);
  assert.equal(data.requests.filter(r=>/\/members(?:\/remove)?$/.test(r.url)).length,0);
}));

test('owner selection loads suggestions without clearing explicit IDs and rejects user or foreign-agent targets', async () => fixture(async (page, data) => {
  data.pageLimit=1; data.agents=[1,2,3].map(id=>({id,project:1,name:`Worker ${id}`,state:['closed','paused','crashed'][id-1]}));
  data.agents.push({id:4,project:2,name:'Other project agent',state:'idle'});
  data.agents.push({id:5,project:1,name:'Replaced agent',state:'replaced'});
  data.threads=[conversation([],{created_by:1})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('.thread-header > div.meta').textContent(),/Owner: #1/);
  await page.locator('#change-thread-owner').click();
  await page.locator('#thread-owner-form [name=owner]').fill('2');
  for (const count of [1,2,3]) {
    await page.locator('#thread-owner-dialog [data-more=agents]').click();
    await page.waitForFunction(count=>document.querySelectorAll('#thread-owner-options option').length===count,count);
  }
  assert.deepEqual(await page.locator('#thread-owner-options option').evaluateAll(nodes=>nodes.map(node=>Number(node.value))),[1,2,3]);
  assert.equal(await page.locator('#thread-owner-form [name=owner]').inputValue(),'2');
  await page.locator('#thread-owner-form [name=owner]').fill('0'); await page.locator('#thread-owner-form button.primary').click();
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,0);
  await page.locator('#thread-owner-form [name=owner]').fill('4'); await page.locator('#thread-owner-form button.primary').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Choose an agent from this project'));
  assert.equal(await page.locator('#thread-owner-dialog').isVisible(),true);
  assert.equal(await page.locator('#thread-owner-form [name=owner]').inputValue(),'4');
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,1);
  assert.equal(data.threads[0].owner,undefined);
}));

test('ownership errors retain input without retrying and transfers remain single-flight during polling', async () => fixture(async (page, data) => {
  data.agents=[{id:2,project:1,name:'Target',state:'idle'}]; data.threads=[conversation([])]; data.ownerFailure=true;
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#change-thread-owner').click(); await page.locator('#thread-owner-form [name=owner]').fill('2');
  await page.locator('#thread-owner-form button.primary').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Ownership change unavailable');
  assert.equal(await page.locator('#thread-owner-dialog').isVisible(),true);
  assert.equal(await page.locator('#thread-owner-form [name=owner]').inputValue(),'2');
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,1);
  data.ownerFailure=false;
  const pending=await holdRequest(page,'**/threads/1/owner');
  await page.locator('#thread-owner-form button.primary').click(); await pending.started;
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#thread-owner-form button.primary').isDisabled(),true);
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>!document.querySelector('#thread-owner-dialog').open);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,2);
  assert.equal(data.threads[0].owner,2);
}));

test('ownership history and names are escaped and selected ownership details survive polling', async () => fixture(async (page, data) => {
  data.agents=[{id:1,project:1,name:'<img src=x onerror="window.ownerUnsafe=true">',state:'idle'}];
  data.threads=[conversation([],{owner:1,events:[{id:1,at:1,kind:'thread.owner-changed',agent:1,actor:'<script>bad()</script>',details:{from:0,to:1,reason:'<b>new owner</b>'}}]})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('.thread-header > div.meta').textContent(),/Owner: #1 <img/);
  assert.equal(await page.locator('.thread-header img').count(),0);
  await page.locator('#thread-history summary').click();
  assert.match(await page.locator('#thread-events').textContent(),/Owner changed: user → agent 1.*<script>bad\(\)<\/script>.*<b>new owner<\/b>/);
  assert.equal(await page.locator('#thread-events script, #thread-events b').count(),0);
  const selected=await selectText(page,'.thread-header > div.meta');
  data.threads[0].owner=2; await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.waitForFunction(()=>document.querySelector('.thread-header > div.meta').textContent.includes('Owner: #2'));
  assert.equal(await page.evaluate(()=>window.ownerUnsafe),undefined);
}));

test('missing owner metadata never implies that the original creator or user still owns the thread', async () => fixture(async (page, data) => {
  data.threads=[conversation([],{created_by:1,owner:2})];
  await manualPolling(page); await reloadPage(page);
  await page.route(/\/threads\/1\/metadata(?:\?|$)/,async route=>{
    const response=await route.fetch(), body=await response.json(); delete body.owner;
    await route.fulfill({response,json:body});
  });
  await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('.thread-header > div.meta').textContent(),/Owner: unavailable/);
  assert.doesNotMatch(await page.locator('.thread-header > div.meta').textContent(),/Owner: #1|Owner: you/);
  await page.locator('#change-thread-owner').click();
  assert.equal(await page.locator('#thread-owner-current').textContent(),'Current owner: unavailable');
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,0);
}));

test('live threads expose escaped membership history and mark outside-membership messages without counting them unread', async () => fixture(async (page, data) => {
  data.threads = [conversation([{...incoming(1,'Before you joined'),outside_membership:true},{...incoming(2,'Current reply'),membership_unknown:true}], {
    watch:['working','idle','group:review'],events_more:true,
    events:[{id:1,at:1,kind:'thread.joined',agent:1,actor:'user',details:{reason:'group <review> matched'}}],
  })];
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.locator('[data-thread="1"]').click();
  await page.locator('#thread-history').waitFor();
  assert.equal(await page.locator('#add-thread-members').isHidden(), true);
  assert.equal(await page.locator('#thread-membership').textContent(), 'Leave thread');
  await page.locator('#thread-older').click();
  assert.equal(await page.locator('[data-message="1"] .pill').textContent(), 'Outside your membership');
  assert.match(await page.locator('[data-message="2"] .message-head').textContent(), /Membership at send time unknown/);
  assert.equal(await page.locator('[data-message="2"] .pill').count(), 0);
  assert.match(await page.locator('#unread-total').textContent(), /1 unread/);
  await page.locator('#thread-history summary').click();
  assert.match(await page.locator('#thread-events').textContent(), /agent 1 joined.*group <review> matched/);
  assert.match(await page.locator('#thread-events').textContent(), /Earlier thread events are not shown/);
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
  await saveSettings(page); await reloadPage(page); await page.locator('[data-page=settings]').click();
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
  await reloadPage(page); await page.locator('[data-usage=codex]').click();
  assert.match(await page.locator('#usage-details').textContent(),/100%.*awaiting confirmation/s);
  assert.match(await page.locator('#usage-details').textContent(),/Provider unavailable/);
  await page.locator('[data-check-usage=codex]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Usage check scheduled');
  assert.equal(data.requests.at(-1).url,'/usage/check');
}));

test('a previously rejected model has an explicit warning and no silent replacement',async()=>fixture(async(page,data)=> {
  data.agents=[{id:1,project:1,state:'crashed',harness:'codex',model:'gpt-6.1-sol',problem:'Model not supported with this account'}];
  await reloadPage(page); await openLaunch(page); await page.locator('#launch-harness').selectOption('codex');
  assert.equal(await page.locator('#launch-model').inputValue(),'gpt-6.1-sol');
  assert.match(await page.locator('#launch-model-warning').textContent(),/previous launch rejected/);
  await page.locator('#launch-model').selectOption('gpt-6-luna');
  assert.equal(await page.locator('#launch-model-warning').isHidden(),true);
  assert.equal(data.requests.length,0);
}));

test('model errors offer an explicit alternative launch while retaining the original agent',async()=>fixture(async(page,data)=> {
  data.agents=[{id:1,project:1,name:'Unavailable',state:'crashed',harness:'codex',model:'gpt-6.1-sol',task:'Original task',problem:'Model not supported with this account'}];
  await reloadPage(page);
  assert.equal(await page.locator('[data-action=resume]').textContent(),'Retry same model');
  await page.locator('[data-action=another-model]').click();
  await page.waitForFunction(() => document.querySelector('#launch-form [name=task]').value === 'Original task');
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
  await reloadPage(page);
  const crash = page.locator('[data-agent="1"]');
  assert.equal(await crash.locator('[data-action=resume]').textContent(), 'Retry same model');
  assert.equal(await crash.locator('[data-action=another-model]').textContent(), 'Launch another model…');
  assert.equal(await page.locator('[data-agent="2"] [data-action=resume]').textContent(), 'Resume');
  assert.equal(await page.locator('[data-agent="3"] [data-action=resume]').textContent(), 'Resume');
  await crash.locator('[data-action=another-model]').click();
  await page.waitForFunction(() => document.querySelector('#launch-form [name=task]').value === 'Continue the original task');
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page);
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
  await reloadPage(page);
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Unsent message');
  await page.locator('#message-form button').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Message send failed');
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Unsent message');
  data.messageFailure = false;
  await page.locator('#message-form button').click();
  await page.waitForFunction(() => document.querySelector('#message-form textarea').value === '');
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), '');
  assert.equal(data.threads[0].messages[0].text, 'Unsent message');
}));

test('a delayed successful send preserves newer text even when the pane is closed and reopened', async () => fixture(async (page, data) => {
  data.threads = [conversation([])]; data.messageDelay = 600;
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Submitted snapshot');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/messages');
  await page.locator('#message-form button').click();
  await page.locator('#message-form textarea').fill('Newer draft');
  await page.locator('#close-thread').click();
  await response;
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Newer draft');
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const threadPattern = /\/threads\/1\/messages(?:\?|$)/;
  await page.route(threadPattern, async route => { await gate; await route.continue(); });
  data.threads[0].messages.push(incoming(2, 'While fetch was pending'));
  const pending = page.waitForRequest(r => new URL(r.url()).pathname === '/threads/1/messages');
  await page.evaluate(() => { window.pendingThread = refreshThread(); });
  await pending;
  await page.locator('#close-thread').click();
  release();
  await page.evaluate(async () => { await window.pendingThread; });
  await page.unroute(threadPattern);
  await page.evaluate(() => refresh());
  assert.equal(await page.locator('#thread-main').textContent(), 'Select a thread');
  assert.match(await page.locator('#unread-total').textContent(), /1 unread/);
  assert.equal(data.reads[1], 1);
  assert.deepEqual(data.threads[0].members, [0, 1]);
  assert.equal(data.requests.filter(r => r.url.endsWith('/read')).length, 1);
}));

test('background, other pages and dialogs do not clear unread messages', async () => fixture(async (page, data) => {
  data.threads = [conversation([])];
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-page=threads]').click();
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
  await reloadPage(page); await page.locator('[data-action=details]').click();
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
  await reloadPage(page); data.detailDelay = 1000;
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
  await reloadPage(page);
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
  await reloadPage(page); await page.locator('[data-page=settings]').click();
  assert.equal(await weekly.locator('[name=hard]').inputValue(), '85');
  data.usage = [data.usage[0]];
  await page.evaluate(() => refresh());
  assert.match(await page.locator('[data-window=seven_day] .meter-label').textContent(), /unknown/);
  await page.setViewportSize({width:375,height:800});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}));

test('maximum lock TTL is required, positive and persists; older settings get a finite default', async () => fixture(async (page, data) => {
  delete data.settings.max_lock_ttl_secs;
  await reloadPage(page);
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
  await reloadPage(page); await page.locator('[data-page=settings]').click();
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
  await reloadPage(page); await page.locator('[data-page=settings]').click();
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
  await reloadPage(page); await page.locator('[data-page=settings]').click();
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
  await reloadPage(page);
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
  await reloadPage(page); await page.locator('[data-action=details]').click();
  const config = page.locator('#agent-config');
  await config.locator('#save-agent-config').waitFor();
  assert.match(await config.textContent(), /current turn is not interrupted/);
  await config.locator('[name=agent_model]').selectOption('gpt-6-luna');
  assert.equal(await config.locator('[name=agent_effort] option[value=ultra]').count(), 0);
  await config.locator('[name=agent_effort]').selectOption('max');
  await page.evaluate(() => refresh());
  assert.equal(await config.locator('[name=agent_model]').inputValue(), 'gpt-6-luna');
  await config.locator('#save-agent-config').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Model and effort saved');
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

test('details distinguish the actual running configuration from next-turn choices without clearing selections', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'working',harness:'codex',model:'gpt-6-luna',effort:'max',running_configuration:{model:'gpt-6.1-sol',effort:'ultra'}}];
  await reloadPage(page); await page.locator('[data-action=details]').click();
  const details = page.locator('#agent-details');
  const current = details.locator('dt[data-key=running_configuration] + dd');
  await current.waitFor();
  assert.equal(await details.locator('dt[data-key=model]').textContent(), 'next-turn model');
  assert.equal(await details.locator('dt[data-key=effort]').textContent(), 'next-turn effort');
  assert.equal(await details.locator('dt[data-key=model] + dd').textContent(), 'gpt-6-luna');
  assert.equal(await current.textContent(), 'codex / gpt-6.1-sol / effort ultra');
  await page.evaluate(() => {
    const el = document.querySelector('dt[data-key=running_configuration]').nextElementSibling;
    window.selectedConfiguration = el;
    const range = document.createRange(); range.selectNodeContents(el);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  data.agents[0].model = 'gpt-6-sol';
  data.agents[0].effort = 'high';
  await page.evaluate(() => refresh());
  assert.equal(await current.textContent(), 'codex / gpt-6.1-sol / effort ultra');
  assert.equal(await details.locator('dt[data-key=model] + dd').textContent(), 'gpt-6-sol');
  assert.equal(await page.evaluate(() => getSelection().toString()), 'codex / gpt-6.1-sol / effort ultra');
  data.agents[0].running_configuration = null;
  data.agents[0].state = 'idle';
  await page.evaluate(() => refresh());
  assert.equal(await current.textContent(), 'codex / gpt-6.1-sol / effort ultra', 'selected changed region waits for deselection');
  assert.equal(await page.evaluate(() => document.querySelector('dt[data-key=running_configuration]').nextElementSibling === window.selectedConfiguration), true);
  await page.evaluate(() => { getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  assert.equal(await current.textContent(), '— (no running turn)');
}));

test('continuation is an explicit working-agent opt-in and its pending instruction and blocked reason are visible safely', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
  await reloadPage(page); await page.locator('[data-action=details]').click();
  const config = page.locator('#agent-config');
  await config.locator('#save-agent-config').waitFor();
  assert.equal(await config.locator('[name=agent_continue]').isChecked(), false);
  assert.match(await config.textContent(), /alone does not start a turn/);
  await config.locator('[name=agent_continue]').check();
  await config.locator('[name=agent_continuation]').fill('   ');
  await config.locator('#save-agent-config').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Enter a continuation instruction.');
  assert.equal(data.requests.length, 0);
  await config.locator('[name=agent_continuation]').fill(' Continue <review> & finish ');
  await page.evaluate(() => refresh());
  assert.equal(await config.locator('[name=agent_continue]').isChecked(), true);
  assert.equal(await config.locator('[name=agent_continuation]').inputValue(), ' Continue <review> & finish ');
  await config.locator('#save-agent-config').click();
  await page.locator('dt[data-key=continuation]').waitFor();
  assert.deepEqual(data.requests.at(-1).body, {id:1,model:'gpt-6.1-sol',effort:'medium',continuation:'Continue <review> & finish'});
  assert.equal(await config.locator('[name=agent_continue]').isChecked(), false);
  const pending = page.locator('dt[data-key=continuation] + dd');
  assert.match(await pending.textContent(), /Continue <review> & finish.*One turn after/);
  assert.equal(await pending.locator('review').count(), 0);
  data.agents[0].continuation.blocked = 'Usage <waiting>';
  await page.evaluate(() => refresh());
  assert.match(await pending.textContent(), /Waiting: Usage <waiting>/);
  await config.locator('[name=agent_effort]').selectOption('high');
  await config.locator('#save-agent-config').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Model and effort saved');
  assert.equal(Object.hasOwn(data.requests.at(-1).body, 'continuation'), false);
  assert.equal(data.agents[0].continuation.text, 'Continue <review> & finish', 'ordinary configuration does not cancel a pending request');
  await config.locator('[name=agent_continue]').check();
  await config.locator('[name=agent_continuation]').fill('Use the latest instruction');
  await config.locator('#save-agent-config').click();
  await page.waitForFunction(() => document.querySelector('dt[data-key=continuation] + dd').textContent.includes('Use the latest instruction'));
  assert.deepEqual(data.agents[0].continuation, {text:'Use the latest instruction',blocked:null}, 'explicit continuation replaces the instruction and clears its old blocking reason');
  data.agents[0].state = 'idle'; data.agents[0].continuation = null;
  await page.evaluate(() => refresh());
  assert.equal(await config.locator('[name=agent_continue]').isDisabled(), true);
  assert.equal(await page.locator('dt[data-key=continuation]').count(), 0);
}));

test('a delayed configuration save keeps newer continuation drafts and rejects continuation after the turn stops', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
  data.agentConfigDelay = 500;
  await reloadPage(page); await page.locator('[data-action=details]').click();
  const config = page.locator('#agent-config');
  await config.locator('#save-agent-config').waitFor();
  await config.locator('[name=agent_continue]').check();
  await config.locator('[name=agent_continuation]').fill('Submitted continuation');
  await config.locator('#save-agent-config').click();
  await config.locator('[name=agent_continuation]').fill('Newer instruction draft');
  await page.waitForFunction(() => !document.querySelector('#save-agent-config').disabled);
  assert.equal(data.agents[0].continuation.text, 'Submitted continuation');
  assert.equal(await config.locator('[name=agent_continuation]').inputValue(), 'Newer instruction draft');
  assert.equal(await config.locator('[name=agent_continue]').isChecked(), true);
  data.agents[0].state = 'idle';
  await page.evaluate(() => refresh());
  const writes = data.requests.length;
  await config.locator('#save-agent-config').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Continuation requires a working agent'));
  assert.equal(data.requests.length, writes);
  assert.equal(await config.locator('[name=agent_continuation]').inputValue(), 'Newer instruction draft');
  await config.locator('[name=agent_continue]').uncheck();
  assert.equal(await config.locator('[name=agent_continue]').isDisabled(), true);
}));

test('own-history crash warnings require explicit confirmation before a single acknowledged configure retry', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
  data.agentConfigError = {status:409,message:'Previous crashes for gpt-6-luna in your own agent history/replacement lineage: agent 1, history /history/1.jsonl. Review before acknowledging.'};
  await reloadPage(page); await page.locator('[data-action=details]').click();
  const config = page.locator('#agent-config');
  await config.locator('#save-agent-config').waitFor();
  await config.locator('[name=agent_model]').selectOption('gpt-6-luna');
  await config.locator('[name=agent_effort]').selectOption('max');
  await config.locator('[name=agent_continue]').check();
  await config.locator('[name=agent_continuation]').fill('Review new task');
  let confirmations = 0;
  page.once('dialog', dialog => { confirmations++; const message = dialog.message(); dialog.dismiss(); assert.match(message, /own agent history\/replacement lineage.*agent 1.*history.*reviewed/is); });
  await config.locator('#save-agent-config').click();
  await page.waitForFunction(() => !document.querySelector('#save-agent-config').disabled);
  assert.equal(data.requests.length, 1);
  assert.equal(data.agents[0].model, 'gpt-6.1-sol');
  assert.equal(await config.locator('[name=agent_continuation]').inputValue(), 'Review new task');
  page.once('dialog', dialog => { confirmations++; dialog.accept(); });
  await config.locator('#save-agent-config').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('one continuation queued'));
  assert.equal(confirmations, 2);
  assert.equal(data.requests.length, 3);
  assert.equal(Object.hasOwn(data.requests[1].body, 'ack_crashes'), false);
  assert.deepEqual(data.requests[2].body, {...data.requests[1].body,ack_crashes:true});
  assert.equal(data.agents[0].model, 'gpt-6-luna');
  assert.equal(data.agents[0].continuation.text, 'Review new task');
}));

test('configure errors outside the specific HTTP409 prior-crash warning never prompt or retry', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
  await reloadPage(page); await page.locator('[data-action=details]').click();
  const config = page.locator('#agent-config');
  await config.locator('#save-agent-config').waitFor();
  let confirmations = 0;
  page.on('dialog', dialog => { confirmations++; dialog.dismiss(); });
  for (const error of [{status:409,message:'Usage limit: confirm after reset'}, {status:500,message:'Previous crashes for gpt-6-luna: unavailable history'}]) {
    data.agentConfigError = error;
    const count = data.requests.length;
    await config.locator('#save-agent-config').click();
    await page.waitForFunction(message => document.querySelector('#toast').textContent === message, error.message);
    assert.equal(data.requests.length, count + 1);
    assert.equal(Object.hasOwn(data.requests.at(-1).body,'ack_crashes'), false);
  }
  assert.equal(confirmations, 0);
}));

test('agent details expose pending, blocked and replacement retry status safely', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'crashed',harness:'claude',model:'claude-opus-5-5',effort:'medium',retry:{source:'claude-opus-5-5',handled:0,replacement:null,blocked:null,same_model_attempts:1,effort:'medium',eligible_at:Date.now()/1000+120}}];
  await reloadPage(page); await page.locator('[data-action=details]').click();
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
  assert.match(await details.textContent(), /Replacement agent #2/);
  assert.match(await details.textContent(), /Stopped: cannot start replacement/);
}));

test('details show queued cross-provider replacements and link the explicit successor', async () => fixture(async (page, data) => {
  data.agents = [
    {id:1,project:1,name:'Predecessor',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high',replacement_request:{harness:'claude',model:'claude-sonnet-5-5',blocked:null}},
    {id:2,project:1,name:'Old recovery target',state:'closed',harness:'claude',model:'claude-haiku-5-5',effort:'medium'},
    {id:3,project:1,name:'Successor',state:'working',harness:'claude',model:'claude-sonnet-5-5',effort:'high'},
  ];
  await reloadPage(page); await page.locator('[data-agent="1"] [data-action=details]').click();
  const details = page.locator('#agent-details');
  await details.locator('dt[data-key=replacement_request]').waitFor();
  assert.match(await details.textContent(), /pending replacement.*claude \/ claude-sonnet-5-5.*current turn exits/s);
  data.agents[0].state = 'done';
  data.agents[0].replacement_request.blocked = 'Hard <target> limit';
  await page.evaluate(() => refresh());
  assert.match(await details.textContent(), /Waiting: Hard <target> limit/);
  assert.equal(await details.locator('target').count(), 0);
  data.agents[0].state = 'replaced';
  data.agents[0].replacement_request = null;
  data.agents[0].replacement = 3;
  data.agents[0].retry = {source:'gpt-6.1-sol',handled:1,replacement:2,blocked:null};
  await page.evaluate(() => refresh());
  assert.equal(await details.locator('dt[data-key=replacement_request]').count(), 0);
  assert.equal(await page.locator('#save-agent-config').count(), 0);
  assert.equal(await details.locator('[data-action=details]').textContent(), 'Replacement agent #3');
  await details.locator('[data-action=details]').click();
  await page.waitForFunction(() => document.querySelector('#agent-details').textContent.includes('Successor'));
  assert.equal(await page.locator('#save-agent-config').count(), 1);
  assert.equal(data.requests.length, 0);
}));

test('replaced agents expose history and replacement details without restart or configure controls', async () => fixture(async (page, data) => {
  data.agents = [
    {id:1,project:1,name:'Predecessor',state:'replaced',harness:'codex',model:'gpt-6.1-sol',effort:'high',conversation_history:'/history/old.jsonl',output_log:'/logs/old.jsonl',retry:{source:'gpt-6.1-sol',handled:1,replacement:2,blocked:null,same_model_attempts:0,effort:'high'}},
    {id:2,project:1,name:'Replacement',state:'working',harness:'claude',model:'claude-sonnet-5-5',effort:'high'},
  ];
  data.agentLogs[1] = ['Retained predecessor history'];
  await reloadPage(page);
  assert.deepEqual(await page.locator('[data-agent="1"] [data-action]').evaluateAll(buttons => buttons.map(button => button.dataset.action)), ['details','details']);
  assert.equal(await page.locator('[data-agent="1"] [data-action=details][data-id="2"]').textContent(),'Replacement agent #2');
  await page.locator('[data-agent="1"] [data-action=details][data-id="1"]').click();
  await page.locator('#agent-details dt[data-key=replacement]').waitFor();
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
  assert.deepEqual(await page.locator('[data-agent="2"] [data-action]').evaluateAll(buttons => buttons.map(button => button.dataset.action)), ['details','details']);
  assert.equal(await page.locator('[data-agent="2"] [data-action=details][data-id="3"]').textContent(),'Replacement agent #3');
  assert.equal(data.requests.length, 0);
}));

test('details polling preserves selected task text and defers selected log updates', async () => fixture(async (page, data) => {
  const task = `Don't replace this "task" <text> while counters change.`;
  data.agents = [{id:1,project:1,name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high',task,fresh_in:1}];
  data.agentLogs[1] = Array.from({length:80}, (_,i) => `Line ${i}`);
  await reloadPage(page); await page.locator('[data-action=details]').click();
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

const selectText = async (page, selector) => page.evaluate(selector => {
  const node = document.querySelector(selector);
  const range = document.createRange(); range.selectNodeContents(node);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  window.selectedNode = node;
  return selection.toString();
}, selector);

test('polling preserves project-path selection and unchanged overview nodes while unrelated activity stays live', async () => fixture(async (page, data) => {
  data.projects[0].path = '/projects/example with "quotes" & spaces';
  data.agents = [{id:1,project:1,name:'Worker',state:'working',task:'Review "quotes" & escapes',status:'Starting'}];
  data.locks = [{name:'src/<file>',about:'Edit "quotes"',holder:1,holder_name:'Worker',acquired_at:1}];
  data.activity = [{at:1,actor:'user',what:'Initial activity'}];
  await reloadPage(page);
  const selected = await selectText(page, '#project-path');
  await page.evaluate(() => {
    window.overviewNodes = ['#project-path','#agents .agent','#locks tbody tr','#activity .event','#usage .meter'].map(selector=>document.querySelector(selector));
  });
  await page.waitForTimeout(2200); // A normal poll must not disturb text being copied.
  assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  assert.equal(await page.evaluate(() => window.overviewNodes.every(node=>node.isConnected)), true);
  data.projects[0].path = '/projects/new path';
  data.agents[0].status = 'Still live';
  data.activity.push({at:2,actor:'agent 1',what:'Independent activity'});
  await page.evaluate(() => refresh());
  assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  assert.equal(await page.evaluate(() => document.querySelector('#project-path') === window.selectedNode), true);
  assert.match(await page.locator('#agents').textContent(), /Still live/);
  assert.match(await page.locator('#activity').textContent(), /Independent activity/);
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForFunction(() => document.querySelector('#project-path').textContent === '/projects/new path');
  await selectText(page, '#project-path');
  data.projects[0].path = '/projects/transient'; await page.evaluate(() => refresh());
  data.projects[0].path = '/projects/new path'; await page.evaluate(() => refresh());
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#project-path').textContent(), '/projects/new path', 'reverted updates must cancel stale deferred values');
  await selectText(page, '#project-path');
  data.projects[0].path = '/projects/queued old project'; await page.evaluate(() => refresh());
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('#project-path').textContent === '/projects/other');
  assert.equal(await page.locator('#project-select').inputValue(), '2', 'explicit navigation does not retain stale selected-project content');
}));

test('selected agent, lock and activity regions defer only their changes and flush the latest value on deselection', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'working',status:'Initial status'}];
  data.locks = [{name:'src/main',about:'Initial purpose',holder:1,acquired_at:1}];
  data.activity = [{at:1,actor:'user',what:'Initial activity'}];
  await reloadPage(page);
  const cases = [
    {selector:'#agents .agent .meta[title]',root:'#agents',change:()=>{data.agents[0].status='Changed status';},latest:()=>{data.agents[0].status='Latest status';},expected:'Latest status'},
    {selector:'#locks tbody tr td:nth-child(2)',root:'#locks',change:()=>{data.locks[0].about='Changed purpose';},latest:()=>{data.locks[0].about='Latest purpose';},expected:'Latest purpose'},
    {selector:'#activity .event > div',root:'#activity',change:()=>{data.activity.push({at:40,actor:'acom',what:'Changed activity'});},latest:()=>{data.activity.push({at:41,actor:'acom',what:'Latest activity'});},expected:'Latest activity'},
  ];
  for (const [index, c] of cases.entries()) {
    const selected = await selectText(page, c.selector);
    c.change(); await page.evaluate(() => refresh());
    c.latest(); data.agents[0].context = index + 1;
    if (c.root !== '#activity') data.activity.push({at:index+2,actor:'acom',what:`Live event ${index}`});
    await page.evaluate(() => refresh());
    assert.equal(await page.evaluate(() => getSelection().toString()), selected);
    assert.equal(await page.evaluate(() => window.selectedNode.isConnected), true);
    assert.equal((await page.locator(c.root).textContent()).includes(c.expected), false);
    if (c.root !== '#activity') assert.match(await page.locator('#activity').textContent(), new RegExp(`Live event ${index}`));
    else assert.match(await page.locator('#agents').textContent(), /context 3/);
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.waitForFunction(({root,expected})=>document.querySelector(root).textContent.includes(expected), {root:c.root,expected:c.expected});
  }
}));

test('thread list, header and membership-history selections survive polling while new messages and drafts remain live', async () => fixture(async (page, data) => {
  data.threads = [conversation([], {events:[{id:1,at:1,kind:'thread.joined',agent:1,actor:'acom',details:{reason:'Initial join'}}]})];
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Keep draft');
  await page.locator('#thread-history summary').click();
  for (const selector of ['#thread-list strong','.thread-header h2','.thread-header > div.meta','#thread-events .event > div']) {
    const selected = await selectText(page, selector);
    await page.evaluate(() => refresh());
    assert.equal(await page.evaluate(() => getSelection().toString()), selected);
    assert.equal(await page.evaluate(() => window.selectedNode.isConnected), true);
  }
  const selectedTitle = await selectText(page, '.thread-header h2');
  data.threads[0].title = 'Updated conversation';
  data.threads[0].messages.push(incoming(1,'Live while title selected'));
  await page.evaluate(() => refresh());
  assert.equal(await page.evaluate(() => getSelection().toString()), selectedTitle);
  assert.match(await page.locator('#messages').textContent(), /Live while title selected/);
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Keep draft');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForFunction(() => document.querySelector('.thread-header h2').textContent === 'Updated conversation');
  const selectedRow = await selectText(page, '#thread-list strong');
  data.threads[0].title = 'Latest conversation';
  data.threads[0].messages.push(incoming(2,'Second live message'));
  await page.evaluate(() => refresh());
  assert.equal(await page.evaluate(() => getSelection().toString()), selectedRow);
  assert.match(await page.locator('#messages').textContent(), /Second live message/);
  assert.equal(await page.locator('.thread-header h2').textContent(), 'Latest conversation');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.waitForFunction(() => document.querySelector('#thread-list strong').textContent === 'Latest conversation');
}));

test('thread identifiers are visible and copyable for references in another conversation', async () => fixture(async (page, data) => {
  data.threads = [conversation([]),conversation([], {id:2,title:'Follow-up'})];
  await reloadPage(page); await page.context().grantPermissions(['clipboard-read','clipboard-write']);
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
  await reloadPage(page); await page.locator('[data-action=details]').click();
  await page.waitForFunction(() => document.querySelector('#agent-details').textContent.includes('conversation history'));
  assert.match(await page.locator('#agent-details').textContent(), /\/home\/example\/\.claude\/projects\/-work\/session.jsonl/);
  assert.match(await page.locator('#agent-details').textContent(), /\/home\/example\/\.acom\/logs\/1.jsonl/);
  await page.locator('#agent-dialog button[value=cancel]').click();
  await page.locator('[data-page=settings]').click();
  assert.match(await page.locator('[name=done_closes]').locator('..').locator('..').textContent(), /require explicit Reopen/);
}));

async function holdRequest(page, pattern, method = 'POST') {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const handler = async route => {
    if (route.request().method() !== method) return route.continue();
    entered(); await gate;
    await route.continue().catch(() => {}); // A bounded GET may already be aborted.
  };
  await page.route(pattern, handler);
  return { started, release, remove: () => page.unroute(pattern, handler) };
}

test('slow overview requests commit without overlapping polls discarding every response', async () => fixture(async (page, data) => {
  data.delays = {1:2400};
  await reloadPage(page);
  await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'live', null, {timeout:6000});
  assert.equal(await page.locator('#project-path').textContent(), '/projects/example');
  data.delays = {};
  await page.waitForFunction(() => refreshPending === 0);
}));

test('a stalled GET times out and polling recovers while pending read acknowledgements keep messages live', async () => fixture(async (page, data) => {
  const overview = await holdRequest(page, '**/overview*', 'GET');
  await page.evaluate(() => { window.pendingOverview = refresh(); });
  await overview.started;
  await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'connection error', null, {timeout:18000});
  overview.release(); await overview.remove();
  await page.evaluate(() => window.pendingOverview);
  await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'live');
  data.threads = [conversation([incoming(1)])];
  await page.evaluate(() => refresh());
  const read = await holdRequest(page, '**/threads/1/read');
  await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click(); await read.started;
  data.threads[0].messages.push(incoming(2, 'While read acknowledgement is pending'));
  await page.locator('[data-message="2"]').waitFor({timeout:5000});
  assert.equal(data.reads[1], undefined);
  read.release(); await read.remove();
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
}));

test('switching threads removes old controls immediately and closing the loading pane keeps drafts', async () => fixture(async (page, data) => {
  data.threads = [conversation([], {title:'First conversation'}), conversation([], {id:2,title:'Second conversation',members:[1]})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread-filter=all]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('First draft');
  const next = await holdRequest(page, /\/threads\/2\/messages(?:\?|$)/, 'GET');
  await page.locator('[data-thread="2"]').click(); await next.started;
  assert.match(await page.locator('#thread-main').textContent(), /Thread #2.*Loading conversation/s);
  for (const selector of ['#message-form','#thread-membership','#add-thread-members','#copy-thread']) assert.equal(await page.locator(selector).count(), 0);
  await page.locator('#close-thread').click(); next.release(); await next.remove();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#thread-main').textContent(), 'Select a thread');
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'First draft');
  await page.locator('[data-thread="2"]').click();
  await page.waitForFunction(() => document.querySelector('#thread-membership')?.textContent === 'Join thread');
  await page.locator('#thread-membership').click();
  await page.waitForFunction(() => document.querySelector('#thread-membership')?.textContent === 'Leave thread');
  assert.deepEqual(data.requests.find(r => r.url === '/threads/2/user').body, {joined:true});
}));

test('polling restores focus to updated controls and removes actions that no longer apply', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:1,name:'Worker',state:'working',status:'Starting',locks:[]}];
  await reloadPage(page); await page.locator('[data-action=details]').focus();
  data.agents[0].state = 'idle'; data.agents[0].status = 'Finished this turn';
  await page.waitForFunction(() => document.querySelector('#agents').textContent.includes('Finished this turn'));
  assert.equal(await page.locator('[data-action=details]').evaluate(el => document.activeElement === el), true);
  await page.locator('[data-action=pause]').focus();
  data.agents[0].state = 'paused';
  await page.evaluate(() => refresh());
  assert.equal(await page.locator('[data-action=pause]').count(), 0);
  assert.equal(await page.locator('[data-action=resume]').count(), 1);
  assert.equal(await page.locator('#agents').textContent().then(text => /paused/.test(text)), true);
}));

test('late thread creation keeps reopened drafts and cannot open another project conversation', async () => fixture(async (page, data) => {
  await page.locator('[data-page=threads]').click();
  const pending = await holdRequest(page, '**/threads');
  await page.locator('[data-open=thread-dialog]').click();
  await page.locator('#thread-form [name=title]').fill('Created in first');
  await page.locator('#thread-form button.primary').click(); await pending.started;
  await page.locator('[data-close=thread-dialog]').click();
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(() => document.querySelector('#project-path').textContent === '/projects/other');
  await page.locator('[data-open=thread-dialog]').click();
  await page.locator('#thread-form [name=title]').fill('New draft in second');
  pending.release(); await pending.remove();
  await page.waitForFunction(() => !document.querySelector('#thread-form button.primary').disabled);
  assert.equal(data.threads[0].project, 1);
  assert.equal(await page.locator('#thread-dialog').isVisible(), true);
  assert.equal(await page.locator('#thread-form [name=title]').inputValue(), 'New draft in second');
  assert.equal(await page.locator('#thread-main').textContent(), 'Select a thread');
  assert.equal(await page.locator('#project-path').textContent(), '/projects/other');
}));

test('late launch completions preserve newer drafts in the same or reopened dialog', async () => fixture(async (page, data) => {
  for (const reopen of [false,true]) {
    const pending = await holdRequest(page, '**/agents');
    await openLaunch(page);
    await page.locator('#launch-form [name=task]').fill('Submitted task');
    await page.locator('#launch-form button.primary').click(); await pending.started;
    if (reopen) { await page.locator('[data-close=launch-dialog]').click(); await openLaunch(page); }
    await page.locator('#launch-form [name=task]').fill('New unsent task');
    pending.release(); await pending.remove();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Agent launched');
    assert.equal(await page.locator('#launch-dialog').isVisible(), true);
    assert.equal(await page.locator('#launch-form [name=task]').inputValue(), 'New unsent task');
    await page.locator('[data-close=launch-dialog]').click();
  }
  assert.deepEqual(data.requests.filter(r=>r.url === '/agents').map(r=>r.body.task), ['Submitted task','Submitted task']);
}));

test('a stale launch failure cannot prompt or force a request from a reopened dialog', async () => fixture(async (page, data) => {
  data.hardLimit = true;
  const pending = await holdRequest(page, '**/agents');
  let confirmations = 0;
  page.on('dialog', dialog => { confirmations++; dialog.accept(); });
  await openLaunch(page); await page.locator('#launch-form [name=task]').fill('Original task');
  await page.locator('#launch-form button.primary').click(); await pending.started;
  await page.locator('[data-close=launch-dialog]').click(); await openLaunch(page);
  await page.locator('#launch-form [name=task]').fill('New task');
  pending.release(); await pending.remove();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('hard limit reached'));
  assert.equal(confirmations, 0);
  assert.equal(data.requests.filter(r => r.url === '/agents').length, 1);
  assert.equal(await page.locator('#launch-form [name=task]').inputValue(), 'New task');
  assert.equal(await page.locator('#launch-dialog').isVisible(), true);
}));

test('late project creation preserves reopened paths and the current project', async () => fixture(async (page, data) => {
  const pending = await holdRequest(page, '**/projects');
  await page.locator('[data-open=project-dialog]').click();
  await page.locator('#project-form [name=path]').fill('/projects/created');
  await page.locator('#project-form button.primary').click(); await pending.started;
  await page.locator('[data-close=project-dialog]').click();
  await page.locator('[data-open=project-dialog]').click();
  await page.locator('#project-form [name=path]').fill('/projects/newer-draft');
  pending.release(); await pending.remove();
  await page.waitForFunction(() => !document.querySelector('#project-form button.primary').disabled);
  assert.equal(data.projects.length, 3);
  assert.equal(await page.locator('#project-dialog').isVisible(), true);
  assert.equal(await page.locator('#project-form [name=path]').inputValue(), '/projects/newer-draft');
  assert.equal(await page.locator('#project-path').textContent(), '/projects/example');
}));

test('late folder creation does not clear new names or navigate away from a newer location', async () => fixture(async (page, data) => {
  await page.locator('[data-open=project-dialog]').click(); await page.locator('#browse-project').click();
  await page.waitForFunction(() => document.querySelector('#folder-path').textContent === '/home/example');
  const pending = await holdRequest(page, '**/folders');
  await page.locator('#folder-form [name=name]').fill('Created');
  await page.locator('#folder-form button[type=submit]').click(); await pending.started;
  await page.locator('[data-folder="/home/example/work"]').click();
  await page.waitForFunction(() => document.querySelector('#folder-path').textContent === '/home/example/work');
  await page.locator('#folder-form [name=name]').fill('New folder draft');
  pending.release(); await pending.remove();
  await page.waitForFunction(() => !document.querySelector('#folder-form button[type=submit]').disabled);
  assert.ok(data.folders['/home/example/Created']);
  assert.equal(await page.locator('#folder-path').textContent(), '/home/example/work');
  assert.equal(await page.locator('#folder-form [name=name]').inputValue(), 'New folder draft');
}));

test('late config and member saves preserve newer dialog input', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click(); await page.locator('#save-config-as').click();
  const config = await holdRequest(page, '**/configs');
  await page.locator('#config-form [name=name]').fill('Saved copy');
  await page.locator('#config-form button.primary').click(); await config.started;
  await page.locator('#config-form [name=name]').fill('Next copy draft');
  config.release(); await config.remove();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Settings saved');
  assert.equal(await page.locator('#config-dialog').isVisible(), true);
  assert.equal(await page.locator('#config-form [name=name]').inputValue(), 'Next copy draft');
  await page.locator('[data-close=config-dialog]').click();
  data.agents = [1,2].map(id => ({id,project:1,name:`Worker ${id}`,state:'idle'}));
  data.threads = [conversation([], {members:[0]})];
  await page.evaluate(() => refresh()); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click(); await page.locator('#add-thread-members').click();
  const members = await holdRequest(page, '**/threads/1/members');
  await page.locator('#add-member-picker [name=member][value="1"]').check();
  await page.locator('#members-form button.primary').click(); await members.started;
  await page.locator('#add-member-picker [name=member][value="1"]').uncheck();
  await page.locator('#add-member-picker [name=member][value="2"]').check();
  members.release(); await members.remove();
  await page.waitForFunction(() => !document.querySelector('#members-form button.primary').disabled);
  assert.equal(await page.locator('#members-dialog').isVisible(), true);
  assert.equal(await page.locator('#add-member-picker [name=member][value="2"]').isChecked(), true);
  assert.deepEqual(data.requests.find(r=>r.url === '/threads/1/members').body.members, ['1']);
}));

test('late removal keeps reopened selections and never removes members from a different thread', async () => fixture(async (page, data) => {
  data.threads=[conversation([]),conversation([],{id:2,title:'Second',members:[0,2]})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#remove-thread-members').click(); await page.locator('#remove-member-picker [name=member][value="1"]').check();
  const pending=await holdRequest(page,'**/threads/1/members/remove');
  await page.locator('#remove-members-form button.danger').click(); await pending.started;
  await page.locator('[data-close=remove-members-dialog]').click(); await page.locator('[data-thread="2"]').click();
  await page.locator('#remove-thread-members').click(); await page.locator('#remove-member-picker [name=member][value="2"]').check();
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>!document.querySelector('#remove-members-form button.danger').disabled);
  assert.equal(await page.locator('#remove-members-dialog').isVisible(),true);
  assert.equal(await page.locator('#remove-member-picker [name=member][value="2"]').isChecked(),true);
  assert.deepEqual(data.threads[0].members,[0]);
  assert.deepEqual(data.threads[1].members,[0,2]);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/members/remove')).length,1);
  await page.locator('[data-close=remove-members-dialog]').click();
  await page.locator('#remove-thread-members').click();
  await page.evaluate(()=>resetThread());
  assert.equal(await page.locator('#remove-members-dialog').isVisible(),false);
  assert.equal(await page.locator('#thread-main').textContent(),'Select a thread');
}));

test('late ownership transfers preserve edited or reopened owner drafts and never target another thread', async () => fixture(async (page, data) => {
  data.agents=[2,3].map(id=>({id,project:1,name:`Worker ${id}`,state:'idle'}));
  data.threads=[conversation([],{owner:0}),conversation([],{id:2,title:'Second',owner:0})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#change-thread-owner').click(); await page.locator('#thread-owner-form [name=owner]').fill('2');
  const first=await holdRequest(page,'**/threads/1/owner');
  await page.locator('#thread-owner-form button.primary').click(); await first.started;
  await page.locator('#thread-owner-form [name=owner]').fill('3');
  first.release(); await first.remove();
  await page.waitForFunction(()=>!document.querySelector('#thread-owner-form button.primary').disabled);
  assert.equal(data.threads[0].owner,2);
  assert.equal(await page.locator('#thread-owner-dialog').isVisible(),true);
  assert.equal(await page.locator('#thread-owner-form [name=owner]').inputValue(),'3');
  assert.match(await page.locator('#thread-owner-current').textContent(), /Current owner: #2 Worker 2/);
  const second=await holdRequest(page,'**/threads/1/owner');
  await page.locator('#thread-owner-form button.primary').click(); await second.started;
  await page.locator('[data-close=thread-owner-dialog]').click(); await page.locator('[data-thread="2"]').click();
  await page.locator('#change-thread-owner').click(); await page.locator('#thread-owner-form [name=owner]').fill('2');
  second.release(); await second.remove();
  await page.waitForFunction(()=>!document.querySelector('#thread-owner-form button.primary').disabled);
  assert.equal(data.threads[0].owner,3);
  assert.equal(data.threads[1].owner,0);
  assert.equal(await page.locator('#thread-owner-dialog').isVisible(),true);
  assert.equal(await page.locator('#thread-owner-form [name=owner]').inputValue(),'2');
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,2);
}));

test('project switching invalidates ownership dialogs and prevents stale owner form submissions', async () => fixture(async (page, data) => {
  data.agents=[{id:2,project:1,name:'Target',state:'idle'}]; data.threads=[conversation([])];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#change-thread-owner').click(); await page.locator('#thread-owner-form [name=owner]').fill('2');
  await page.locator('#project-select').selectOption('2');
  await page.waitForFunction(()=>document.querySelector('#project-path').textContent==='/projects/other');
  assert.equal(await page.locator('#thread-owner-dialog').isVisible(),false);
  await page.evaluate(()=>document.querySelector('#thread-owner-form').dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true})));
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,0);
  assert.equal(await page.locator('#thread-main').textContent(),'Select a thread');
}));

test('switching projects invalidates open add and removal dialogs before a stale form can submit', async () => fixture(async (page, data) => {
  data.agents=[{id:2,project:1,name:'Additional',state:'idle'}]; data.threads=[conversation([])];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  for(const [control,dialog,form] of [['#add-thread-members','#members-dialog','#members-form'],['#remove-thread-members','#remove-members-dialog','#remove-members-form']]) {
    await page.locator(control).click();
    await page.locator(`${form} [name=member]`).check();
    const before=data.requests.filter(r=>/\/members(?:\/remove)?$/.test(r.url)).length;
    await page.locator('#project-select').selectOption('2');
    await page.waitForFunction(()=>document.querySelector('#project-path').textContent==='/projects/other');
    assert.equal(await page.locator(dialog).isVisible(),false);
    await page.evaluate(form=>document.querySelector(form).dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true})),form);
    assert.equal(data.requests.filter(r=>/\/members(?:\/remove)?$/.test(r.url)).length,before);
    await page.locator('#project-select').selectOption('1');
    await page.locator('[data-thread="1"]').click();
  }
}));

test('mobile locks can scroll every control into view and dialogs and feedback have accessible names', async () => fixture(async (page, data) => {
  data.locks = [{name:'write-lock',project:1,about:'Editing important shared content',holder:1,holder_name:'Worker',acquired_at:1,expires_at:Date.now()/1000+600,queue:[2,3]}];
  await page.setViewportSize({width:390,height:844}); await reloadPage(page); await page.locator('[data-action=free-lock]').waitFor();
  assert.equal(await page.locator('#locks').evaluate(el => getComputedStyle(el).overflowX), 'auto');
  await page.locator('#locks').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  assert.equal(await page.locator('[data-action=free-lock]').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const names = {launch:'Launch agent',project:'Add project',thread:'New thread',folder:'Choose a project folder',members:'Add thread members','remove-members':'Remove thread members','thread-owner':'Change thread owner',usage:'Subscription usage',config:'Save as new config',agent:'Agent'};
  for (const [id,name] of Object.entries(names)) {
    await page.evaluate(id => openDialog(document.getElementById(id+'-dialog')), id);
    assert.equal(await page.getByRole('dialog', {name,exact:true}).count(), 1);
    await page.evaluate(id => document.getElementById(id+'-dialog').close(), id);
  }
  await openLaunch(page); await page.locator('#launch-model').selectOption('__custom__');
  await page.locator('#launch-custom-model').fill('invalid model'); await page.locator('#launch-form [name=task]').fill('Task');
  await page.locator('#launch-form button.primary').click();
  assert.match(await page.getByRole('dialog',{name:'Launch agent'}).ariaSnapshot(), /status: Enter a full model ID without spaces/);
  await page.locator('[data-close=launch-dialog]').click();
  await page.locator('#toast').waitFor({state:'visible'});
  assert.equal(await page.locator('#toast').isVisible(), true);
  assert.match(await page.locator('#toast').textContent(), /Enter a full model ID without spaces/);
  assert.equal(data.requests.length, 0);
}));

test('active views and filters and each limit input expose their context to assistive technology', async () => fixture(async page => {
  assert.equal(await page.locator('[data-page=overview]').getAttribute('aria-current'), 'page');
  for (const view of ['threads','settings','overview']) {
    await page.locator(`[data-page=${view}]`).click();
    assert.equal(await page.locator('[data-page][aria-current=page]').count(), 1);
    assert.equal(await page.locator(`[data-page=${view}]`).getAttribute('aria-current'), 'page');
  }
  await page.locator('[data-page=threads]').click();
  for (const [filter,name] of [['unread','Unread'],['all','All'],['agents','Agent-only'],['mine','Mine']]) {
    await page.locator(`[data-thread-filter=${filter}]`).click();
    assert.equal(await page.getByRole('button', {name,exact:true,pressed:true}).count(), 1);
    assert.equal(await page.locator('[data-thread-filter][aria-pressed=true]').count(), 1);
  }
  await page.locator('[data-page=settings]').click();
  for (const name of ['Active agents soft limit','Active agents hard limit','Claude weekly subscription % soft limit','Claude weekly subscription % hard limit','Context tokens soft limit','Context tokens hard limit']) {
    assert.equal(await page.getByRole('spinbutton', {name,exact:true}).count(), 1);
  }
}));

const manualPolling = async page => page.addInitScript(() => { window.setInterval = () => 0; });
const messageIds = page => page.locator('[data-message]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.message)));

test('initial unread paging drains a fixed high-water before acknowledging, and later arrivals remain unread', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.threads=[conversation(Array.from({length:9},(_,i)=>incoming(i+1)))]; data.reads[1]=3;
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click();
  const middle=await holdRequest(page,/\/threads\/1\/messages\?after=5(?:&|$)/,'GET');
  await page.locator('[data-thread="1"]').click(); await middle.started;
  assert.deepEqual(await messageIds(page),[4,5]);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length,0,'an incomplete catch-up is not acknowledged');
  data.threads[0].messages.push(incoming(10,'Arrived outside the pinned snapshot'));
  middle.release(); await middle.remove();
  await page.waitForFunction(()=>state.thread && !state.thread.loadingNew && !state.thread.resume);
  await page.waitForFunction(()=>state.thread.last_read===9);
  assert.deepEqual(await messageIds(page),[4,5,6,7,8,9]);
  assert.equal(data.reads[1],9); assert.match(await page.locator('#unread-total').textContent(),/1 unread/);
  await page.evaluate(()=>refresh());
  await page.waitForFunction(()=>state.thread.last_read===10);
  assert.deepEqual(await messageIds(page),[4,5,6,7,8,9,10]);
  assert.equal(data.reads[1],10);
}));

test('incremental paging deduplicates overlapping boundaries and resumes after a failed middle page', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.threads=[conversation([])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread && !state.thread.loadingNew);
  let failed=false;
  await page.route(/\/threads\/1\/messages\?after=/,async route=>{
    const after=Number(new URL(route.request().url()).searchParams.get('after'));
    if(after===2&&!failed) {failed=true;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary page failure'})});}
    const response=await route.fetch(),body=await response.json();
    if(after>0&&body.items.length)body.items.unshift(data.threads[0].messages.find(m=>m.id===after));
    await route.fulfill({response,json:body});
  });
  data.threads[0].messages.push(...Array.from({length:7},(_,i)=>incoming(i+1)));
  await page.evaluate(()=>refresh());
  assert.deepEqual(await messageIds(page),[1,2]);
  assert.equal(await page.evaluate(()=>state.thread.resume.after),2);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length,0);
  await page.evaluate(()=>refresh());
  await page.waitForFunction(()=>state.thread.last_read===7);
  assert.deepEqual(await messageIds(page),[1,2,3,4,5,6,7]);
  await page.evaluate(()=>refresh());
  assert.deepEqual(await messageIds(page),[1,2,3,4,5,6,7]);
  assert.equal(await page.locator('#thread-catchup').textContent(),'');
}));

test('loading older messages preserves the visible anchor, selection and draft without duplicates', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.threads=[conversation(Array.from({length:6},(_,i)=>incoming(i+1,`Message ${i+1}\n${'Long history line\n'.repeat(35)}`)))]; data.reads[1]=6;
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread && !state.thread.loadingNew);
  assert.deepEqual(await messageIds(page),[5,6]);
  await page.locator('#message-form textarea').fill('Keep this draft');
  await page.locator('#messages').evaluate(el=>{el.scrollTop=10;});
  const selected=await selectText(page,'[data-message="5"] .message-text');
  const top=await page.locator('[data-message="5"]').evaluate(el=>el.getBoundingClientRect().top);
  await page.evaluate(()=>olderMessages());
  assert.deepEqual(await messageIds(page),[3,4,5,6]);
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>document.querySelector('[data-message="5"] .message-text')===window.selectedNode),true);
  assert.ok(Math.abs(await page.locator('[data-message="5"]').evaluate(el=>el.getBoundingClientRect().top)-top)<2);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep this draft');
  await page.evaluate(()=>{getSelection().removeAllRanges();return olderMessages();});
  assert.deepEqual(await messageIds(page),[1,2,3,4,5,6]);
  assert.equal(await page.locator('#thread-older').isHidden(),true);
}));

test('an old incremental page cannot replace a newly selected conversation or its draft', async () => fixture(async (page,data) => {
  data.threads=[conversation([incoming(1)]),conversation([incoming(2)],{id:2,title:'Second'})]; data.reads={1:1,2:2};
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('First draft');
  const pending=await holdRequest(page,/\/threads\/1\/messages\?after=1(?:&|$)/,'GET');
  data.threads[0].messages.push(incoming(3)); await page.evaluate(()=>{window.pendingDelta=refresh();}); await pending.started;
  await page.locator('[data-thread="2"]').click(); await page.locator('#message-form[data-draft-thread="2"]').waitFor();
  await page.locator('#message-form textarea').fill('Second draft');
  pending.release(); await pending.remove(); await page.evaluate(()=>window.pendingDelta);
  assert.deepEqual(await messageIds(page),[2]); assert.equal(await page.evaluate(()=>state.thread.id),2);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Second draft');
  await page.locator('[data-thread="1"]').click(); await page.locator('#message-form[data-draft-thread="1"]').waitFor();
  assert.equal(await page.locator('#message-form textarea').inputValue(),'First draft');
}));

test('paged project, config and member selectors expose omitted choices and All means every agent', async () => fixture(async (page,data) => {
  data.pageLimit=2;
  data.projects=Array.from({length:6},(_,i)=>({id:i+1,name:`Project ${i+1}`,path:`/projects/${i+1}`,config:2}));
  data.configs.push(...[3,4,5,6].map(id=>({id,name:`Config ${id}`,settings:settings()})));
  data.agents=Array.from({length:6},(_,i)=>({id:i+1,project:1,name:`Agent ${i+1}`,state:i%2?'closed':'working'}));
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('#project-select').inputValue(),'1','the selected project stays reachable outside the first page');
  while(await page.locator('.project-banner [data-more=projects]').isVisible()) {await page.locator('.project-banner [data-more=projects]').click();await page.waitForFunction(()=>!state.pages.projects.pending);}
  assert.equal(await page.locator('#project-select option').count(),6);
  await page.locator('[data-page=settings]').click();
  while(await page.locator('#settings-form [data-more=configs]').isVisible()) {await page.locator('#settings-form [data-more=configs]').click();await page.waitForFunction(()=>!state.pages.configs.pending);}
  await page.locator('#config-select').selectOption('3'); await page.waitForFunction(()=>state.editor.config===3);
  assert.equal(await page.locator('[name=config_name]').inputValue(),'Config 3');
  await page.locator('[data-page=threads]').click(); await page.locator('[data-open=thread-dialog]').click();
  await page.locator('#thread-member-picker [data-member-pick=all]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#thread-member-picker [name=member]:checked').length===6);
  await page.locator('#thread-member-picker [data-member-pick=active]').click();
  assert.deepEqual(await page.locator('#thread-member-picker [name=member]:checked').evaluateAll(nodes=>nodes.map(n=>Number(n.value))),[1,3,5]);
}));

test('a mutable collection changing during Load more restarts a consistent window without stale or duplicate rows', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.agents=Array.from({length:6},(_,i)=>({id:i+1,project:1,name:`Agent ${i+1}`,state:'working'}));
  await manualPolling(page); await reloadPage(page);
  const pending=await holdRequest(page,url=>url.pathname==='/agents'&&url.searchParams.get('before')==='5','GET');
  await page.locator('#page-overview [data-more=agents]').click(); await pending.started;
  data.agents=data.agents.filter(a=>a.id!==5); data.agents.find(a=>a.id===2).name='Updated agent 2';
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>document.querySelectorAll('[data-agent]').length===5);
  assert.deepEqual(await page.locator('[data-agent]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.agent))),[6,4,3,2,1]);
  assert.match(await page.locator('[data-agent="2"]').textContent(),/Updated agent 2/);
  assert.equal(await page.locator('#agent-count').textContent(),'5 total');
}));

test('oversized UTF-8 message and config chunks stay lossless and incomplete text is not acknowledged', async () => fixture(async (page,data) => {
  const text='☃"\\\n😀'.repeat(5000);
  data.settings.prompts.launch=text;
  data.threads=[conversation([incoming(1,text)])];
  await manualPolling(page); await reloadPage(page);
  await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator('[name=prompt_launch]').inputValue(),text);
  await page.locator('[data-page=threads]').click();
  const pending=await holdRequest(page,url=>url.pathname==='/messages/1'&&Number(url.searchParams.get('offset'))>0,'GET');
  await page.locator('[data-thread="1"]').click(); await pending.started;
  assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length,0);
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>state.thread?.last_read===1);
  assert.equal(await page.locator('[data-message="1"] .message-text').textContent(),text);
  assert.equal(await page.locator('[data-message]').count(),1);
  assert.ok(data.getRequests.some(url=>url.startsWith('/configs/2?offset=')));
  assert.ok(data.getRequests.some(url=>url.startsWith('/messages/1?agent=0&offset=')));
}));

test('unchanged polls use only slim Overview and message deltas; activity updates incrementally and metadata stays cached', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.threads=[conversation([incoming(1)])]; data.reads[1]=1;
  data.activity=[{id:1,at:1,actor:'user',what:'Old event'}];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread && !state.thread.loadingNew);
  const catalogs=data.getRequests.filter(url=>url==='/catalog').length;
  let start=data.getRequests.length;
  await page.evaluate(()=>refresh()); await page.evaluate(()=>refresh());
  const paths=data.getRequests.slice(start).map(url=>new URL(url,'http://localhost').pathname);
  assert.deepEqual(paths,['/overview','/threads/1/messages','/overview','/threads/1/messages']);
  data.activity.push(...[2,3,4,5,6].map(id=>({id,at:id,actor:'acom',what:`Event ${id}`})));
  start=data.getRequests.length; await page.evaluate(()=>refresh());
  const activity=data.getRequests.slice(start).filter(url=>url.startsWith('/activity?'));
  assert.deepEqual(activity.map(url=>Number(new URL(url,'http://localhost').searchParams.get('after'))),[1,3,5]);
  assert.match(await page.locator('#activity').textContent(),/Event 6/);
  assert.equal(new Set(await page.evaluate(()=>state.activity.map(e=>e.id))).size,await page.evaluate(()=>state.activity.length));
  assert.equal(data.getRequests.filter(url=>url==='/catalog').length,catalogs);
  await openLaunch(page);
  await page.waitForFunction(()=>!document.querySelector('#launch-form button.primary').disabled);
  assert.ok(data.getRequests.at(-1).startsWith('/settings?project=1'));
}));

test('a large disconnected activity burst fetches only the retained latest window and keeps older history reachable', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.activity=[{id:1,at:1,actor:'acom',what:'Initial event'}];
  await manualPolling(page); await reloadPage(page);
  data.activity.push(...Array.from({length:1000},(_,i)=>({id:i+2,at:i+2,actor:'acom',what:`Event ${i+2}`})));
  const start=data.getRequests.length; await page.evaluate(()=>refresh());
  const requests=data.getRequests.slice(start).filter(url=>url.startsWith('/activity?'));
  assert.ok(requests.length<=26,`bounded latest-window requests, got ${requests.length}`);
  assert.deepEqual(await page.evaluate(()=>state.activity.map(e=>e.id)),Array.from({length:50},(_,i)=>1001-i));
  assert.equal(await page.locator('[data-more=activity]').isVisible(),true);
  await page.locator('[data-more=activity]').click(); await page.waitForFunction(()=>!state.pages.activity.pending);
  assert.deepEqual(await page.evaluate(()=>state.activity.slice(-2).map(e=>e.id)),[951,950]);
}));

test('selected configs outside the current page refresh external edits without clearing an unsaved editor', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.configs.push(...[3,4,5,6,7,8].map(id=>({id,name:`Config ${id}`,settings:settings()})));
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator('#config-select').inputValue(),'2');
  data.settings.max_lock_ttl_secs=1234; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[name=max_lock_ttl_secs]').inputValue(),'1234');
  await page.locator('[name=max_lock_ttl_secs]').fill('4321');
  data.settings.max_lock_ttl_secs=1222; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[name=max_lock_ttl_secs]').inputValue(),'4321');
  assert.equal(await page.evaluate(()=>state.settings.max_lock_ttl_secs),1222);
}));

test('changed record versions restart chunk hydration instead of stitching old and new settings', async () => fixture(async (page,data) => {
  const old='Old ☃ instruction\n'.repeat(2000),fresh='New 😀 instruction\n'.repeat(2000);
  data.settings.prompts.launch=old;
  let changed=false;
  await page.route(url=>url.pathname==='/configs/2'&&Number(url.searchParams.get('offset'))>0,async route=>{
    if(!changed) {changed=true;data.settings.prompts.launch=fresh;}
    await route.continue();
  });
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=settings]').click();
  assert.equal(changed,true);
  assert.equal(await page.locator('[name=prompt_launch]').inputValue(),fresh);
  assert.equal(await page.evaluate(()=>state.editor.settings.prompts.launch),fresh);
}));

test('folder paging reaches every entry and restarts when the listing changes during continuation', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.folders['/home/example'].entries=Array.from({length:6},(_,i)=>({name:`folder${i+1}`,path:`/home/example/folder${i+1}`,directory:true}));
  await manualPolling(page); await reloadPage(page); await page.locator('[data-open=project-dialog]').click(); await page.locator('#browse-project').click();
  await page.locator('#folder-list [data-folder]').first().waitFor();
  assert.equal(await page.locator('#folder-list [data-folder]').count(),2);
  const pending=await holdRequest(page,url=>url.pathname==='/folders'&&url.searchParams.has('after'),'GET');
  await page.locator('#folder-more').click(); await pending.started;
  data.folders['/home/example'].entries.push({name:'folder7',path:'/home/example/folder7',directory:true});
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>document.querySelector('#folder-error').textContent.includes('Reloaded its first page'));
  while(await page.locator('#folder-more').isVisible()) {await page.locator('#folder-more').click();await page.waitForFunction(()=>!document.querySelector('#folder-more').disabled);}
  assert.deepEqual(await page.locator('#folder-list [data-folder]').evaluateAll(nodes=>nodes.map(n=>n.dataset.folder)),Array.from({length:7},(_,i)=>`/home/example/folder${i+1}`));
}));

test('bounded log tails load older content, append deltas once and recover from rotation', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Worker',state:'working'}];
  data.agentLogs[1]=Array.from({length:300},(_,i)=>`Log line ${i}`);
  await manualPolling(page); await reloadPage(page); await page.locator('[data-action=details]').click();
  await page.waitForFunction(()=>document.querySelector('#agent-detail-status').textContent.startsWith('Live'));
  assert.ok((await page.locator('#agent-log').textContent()).startsWith('Log line 200'));
  await page.locator('#log-older').click(); await page.waitForFunction(()=>document.querySelector('#agent-log').textContent.startsWith('Log line 0'));
  data.agentLogs[1].push('New activity'); const start=data.getRequests.length;
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-log').textContent(),data.agentLogs[1].join('\n'));
  assert.ok(data.getRequests.slice(start).some(url=>url.startsWith('/agents/1/log?after=')));
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-log').textContent(),data.agentLogs[1].join('\n'));
  data.logVersions={1:'rotated'}; data.agentLogs[1]=['Replacement log'];
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-log').textContent(),'Replacement log');
  assert.equal(await page.locator('#log-older').isHidden(),true);
}));

test('truncated mutation results expose lossless receipts and receipt failures remain completed actions', async () => fixture(async (page,data) => {
  const warnings=Array.from({length:100},(_,i)=>`Warning ${i}: ${'Detailed reason '.repeat(30)}`);
  data.launchResult={id:1,result_truncated:true,counts:{warnings:100},warnings:warnings.slice(0,1),receipt_event:7};
  data.receipts={7:{id:7,details:{response:{id:1,warnings}}}};
  await manualPolling(page); await reloadPage(page); await openLaunch(page); await page.locator('#launch-form [name=task]').fill('Launch once');
  await page.locator('#launch-form button.primary').click(); await page.waitForFunction(()=>!document.querySelector('#launch-dialog').open);
  assert.match(await page.locator('#result-notice').textContent(),/Action completed.*warnings: 100/);
  await page.locator('#result-notice [data-record=receipts]').click();
  await page.waitForFunction(()=>document.querySelector('#record-content').textContent.includes('Warning 99:'));
  const receipt=JSON.parse(await page.locator('#record-content').textContent());
  assert.deepEqual(receipt.details.response.warnings,warnings);
  await page.locator('#record-dialog button').click();
  data.launchResult={id:2,result_truncated:true,counts:{warnings:100},receipt_error:'Action completed, receipt storage unavailable'};
  await openLaunch(page); await page.locator('#launch-form [name=task]').fill('Another explicit launch');
  await page.locator('#launch-form button.primary').click(); await page.waitForFunction(()=>!document.querySelector('#launch-dialog').open);
  assert.match(await page.locator('#result-notice').textContent(),/Action completed.*Inspect current state before retrying/);
  assert.equal(data.requests.filter(r=>r.url==='/agents').length,2,'no automatic mutation retry');
}));

test('malformed success responses retain the conversation and its cursor until a valid page arrives', async () => fixture(async (page,data) => {
  data.threads=[conversation([incoming(1)])]; data.reads[1]=1;
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread && !state.thread.loadingNew);
  await page.locator('#message-form textarea').fill('Keep draft through protocol failure');
  data.threads[0].messages.push(incoming(2));
  const matcher=/\/threads\/1\/messages\?after=/;
  for(const body of ['', '{', '[]', 'null', '"not an object"']) {
    await page.route(matcher,route=>route.fulfill({status:200,contentType:'application/json',body}));
    await page.evaluate(()=>refresh());
    assert.deepEqual(await messageIds(page),[1]);
    assert.equal(await page.evaluate(()=>state.thread.messages.at(-1).id),1);
    assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep draft through protocol failure');
    assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length,0);
    await page.unroute(matcher);
  }
  await page.evaluate(()=>refresh()); await page.waitForFunction(()=>state.thread.last_read===2);
  assert.deepEqual(await messageIds(page),[1,2]);
}));

test('a malformed mutation receipt does not claim success or automatically repeat a potentially completed action', async () => fixture(async (page,data) => {
  await manualPolling(page); await reloadPage(page); await openLaunch(page); await page.locator('#launch-form [name=task]').fill('Explicit launch');
  await page.route('**/agents',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    await route.fetch();
    await route.fulfill({status:200,contentType:'application/json',body:'{'});
  });
  await page.locator('#launch-form button.primary').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Inspect current state before retrying'));
  assert.equal(await page.locator('#launch-dialog').evaluate(dialog=>dialog.open),true);
  assert.equal(await page.locator('#launch-form [name=task]').inputValue(),'Explicit launch');
  assert.match(await page.locator('#toast').textContent(),/Invalid server response.*may have completed/);
  assert.equal(await page.locator('#result-notice').isHidden(),true);
  assert.equal(data.requests.filter(r=>r.url==='/agents').length,1);
}));

test('oversized thread summaries retain exact participation and unread filters without inventing missing member details', async () => fixture(async (page,data) => {
  const title='Long thread title ☃ '.repeat(1800);
  data.threads=[conversation([incoming(1)],{title})]; data.readFailure=true;
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click();
  for(const filter of ['mine','unread','all']) {
    await page.locator(`[data-thread-filter=${filter}]`).click();
    const row=page.locator('[data-thread="1"]');
    assert.equal(await row.count(),1);
    assert.match(await row.textContent(),/You’re a member.*1 messages.*Member list exceeds the preview budget/);
    assert.doesNotMatch(await row.textContent(),/Agent-only|no members/);
  }
  await page.locator('[data-thread-filter=agents]').click(); assert.equal(await page.locator('[data-thread="1"]').count(),0);
  await page.locator('[data-thread-filter=unread]').click(); await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread && !state.thread.loadingNew);
  assert.equal(await page.locator('.thread-header h2').textContent(),title);
  assert.deepEqual(await messageIds(page),[1]);
}));

test('chunked oversized outside-membership messages keep their context and do not become unread arrivals', async () => fixture(async (page,data) => {
  const text='Outside membership 😀 '.repeat(2000);
  data.threads=[conversation([incoming(1)])]; data.reads[1]=1;
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread && !state.thread.loadingNew);
  data.threads[0].messages.push({...incoming(2,text),outside_membership:true});
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-message="2"] .message-text').textContent(),text);
  assert.match(await page.locator('[data-message="2"] .message-head').textContent(),/Outside your membership/);
  assert.equal(await page.evaluate(()=>state.thread.unread),0);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length,0);
  assert.ok(data.getRequests.some(url=>url.startsWith('/messages/2?agent=0&offset=')));
}));

test('rejoining backfills earlier unread messages in order and a failed middle page cannot acknowledge unseen history', async () => fixture(async (page,data) => {
  data.pageLimit=2;
  data.threads=[conversation(Array.from({length:6},(_,i)=>incoming(i+1,`Message ${i+1}\n${'Long retained history\n'.repeat(25)}`)),{members:[1]})];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread-filter=all]').click(); await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread && !state.thread.loadingNew);
  assert.deepEqual(await messageIds(page),[5,6]);
  await page.locator('#message-form textarea').fill('Retain rejoin draft');
  await page.locator('#messages').evaluate(node=>{node.scrollTop=10;});
  const selected=await selectText(page,'[data-message="5"] .message-text');
  const top=await page.locator('[data-message="5"]').evaluate(node=>node.getBoundingClientRect().top-node.parentElement.getBoundingClientRect().top);
  const held=await holdRequest(page,/\/threads\/1\/messages\?after=2(?:&|$)/,'GET');
  let failed=false;
  await page.route(/\/threads\/1\/messages\?after=2(?:&|$)/,route=>{
    if(!failed) {failed=true;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Backfill temporarily unavailable'})});}
    return route.fallback();
  });
  await page.locator('#thread-membership').click();
  await page.waitForFunction(()=>state.thread?.resume?.after===2 && !state.thread.loadingNew);
  assert.deepEqual(await messageIds(page),[1,2,5,6]);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length,0);
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>document.querySelector('[data-message="5"] .message-text')===window.selectedNode),true);
  const afterTop=await page.locator('[data-message="5"]').evaluate(node=>node.getBoundingClientRect().top-node.parentElement.getBoundingClientRect().top);
  assert.ok(Math.abs(afterTop-top)<2,`retained anchor moved from ${top} to ${afterTop}`);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Retain rejoin draft');
  await page.evaluate(()=>{window.retryBackfill=refresh();}); await held.started;
  assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length,0);
  held.release(); await held.remove(); await page.evaluate(()=>window.retryBackfill);
  assert.deepEqual(await messageIds(page),[1,2,3,4,5,6]);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length,0,'the reader is still viewing the retained anchor, not the latest message');
  await page.evaluate(()=>{getSelection().removeAllRanges();const messages=document.querySelector('#messages');messages.scrollTop=messages.scrollHeight;return markThreadRead();});
  assert.equal(data.reads[1],6);
}));

test('Resume is a single agent action without reading or freeing other agents paged locks', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.agents=[{id:1,project:1,name:'Resume worker',state:'paused'}];
  const longName='Older active lock ☃ '.repeat(1300);
  data.locks=Array.from({length:6},(_,i)=>({id:i+1,project:1,name:i===0?longName:`lock${i+1}`,holder:2,about:'Another worker owns this lease',expires_at:Date.now()/1000+60}));
  await manualPolling(page); await reloadPage(page);
  assert.deepEqual(await page.evaluate(()=>state.locks.map(lock=>lock.id)),[6,5]);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/locks?')&&url.includes('before=')).length,0);
  await page.locator('[data-action=resume]').click();
  await page.waitForFunction(()=>state.agents[0]?.state==='working');
  assert.deepEqual(data.requests,[{url:'/agents/1/resume',method:'POST',body:{}}]);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/locks?')&&url.includes('before=')).length,0);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/locks/')).length,0,'Resume never hydrates unrelated oversized locks');
  assert.ok(data.locks.every(lock=>lock.holder===2));
  assert.equal(await page.locator('#pause-dialog,#resume-dialog').count(),0);
}));

test('Pause retains leases only while verified process cleanup is still stopping and blocks overlapping actions', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Worker',state:'working',locks:['held lease']}];
  data.locks=[{id:1,project:1,name:'held lease',holder:1,about:'Still being written',expires_at:Date.now()/1000+60}];
  data.pauseStopping=true;
  await manualPolling(page); await reloadPage(page);
  await page.locator('[data-action=pause]').click();
  await page.waitForFunction(()=>state.agents[0]?.stopping && !agentTransitions.size);
  assert.deepEqual(data.requests,[{url:'/agents/1/pause',method:'POST',body:{}}]);
  assert.equal(data.locks[0].holder,1,'leases are not freed while owned processes remain alive');
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Stopping.*Stopping processes before releasing locks/s);
  assert.equal(await page.locator('[data-action=resume]').isDisabled(),true);
  assert.equal(await page.locator('[data-action=close]').isDisabled(),true);
  assert.equal(await page.locator('[data-action=free-lock]').isDisabled(),true);
  assert.match(await page.locator('#locks').textContent(),/Releasing after stop/);
  await page.evaluate(()=>{document.querySelector('[data-action=resume]').click();document.querySelector('[data-action=close]').click();document.querySelector('[data-action=free-lock]').click();return refresh();});
  assert.equal(data.requests.length,1);
  await page.locator('[data-action=details]').click();
  await page.locator('#agent-details dt[data-key=stopping]').waitFor();
  assert.match(await page.locator('#agent-details dt[data-key=stopping] + dd').textContent(),/Locks are released only after cleanup finishes/);
  Object.assign(data.agents[0],{stopping:false,locks:[]});
  Object.assign(data.locks[0],{holder:null,expires_at:null});
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-details dt[data-key=stopping]').count(),0);
  await page.locator('#agent-dialog button[value=cancel]').click();
  assert.equal(await page.locator('[data-action=resume]').isEnabled(),true);
  assert.equal(await page.locator('[data-action=close]').isEnabled(),true);
  assert.doesNotMatch(await page.locator('[data-agent="1"]').textContent(),/Stopping/);
}));

test('explicit Free uses a plain lease and never sends obsolete paused-lock flags', async () => fixture(async (page,data) => {
  data.locks=[{id:1,project:1,name:'shared',holder:2,holder_name:'Active worker',acquired_at:1,expires_at:Date.now()/1000+60}];
  await manualPolling(page); await reloadPage(page);
  assert.doesNotMatch(await page.locator('#locks').textContent(),/frozen|no TTL/i);
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('[data-action=free-lock]').click();
  await page.waitForFunction(()=>state.locks[0]?.holder===null);
  assert.deepEqual(data.requests,[{url:'/locks/free',method:'POST',body:{project:1,name:'shared'}}]);
  await page.evaluate(()=>refresh());
  assert.equal(data.requests.length,1);
}));

test('stopping lock holders outside the agent page block Free even through selected stale rows and oversized previews', async () => fixture(async (page,data) => {
  data.pageLimit=1;
  data.agents=[{id:1,project:1,name:'Older holder',state:'paused',stopping:true},{id:2,project:1,name:'Newer worker',state:'working'}];
  data.locks=[{id:1,project:1,name:'protected',holder:1,expires_at:1}];
  await manualPolling(page); await reloadPage(page);
  let confirmations=0;
  page.on('dialog',dialog=>{confirmations++;return dialog.accept();});
  assert.deepEqual(await page.evaluate(()=>state.agents.map(agent=>agent.id)),[2]);
  assert.equal(await page.locator('[data-action=free-lock]').isDisabled(),true);
  assert.match(await page.locator('#locks').textContent(),/Releasing after stop/);
  data.agents[0].stopping=false; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-action=free-lock]').isEnabled(),true);
  await page.evaluate(()=>{
    const range=document.createRange(); range.selectNodeContents(document.querySelector('#locks code'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  data.agents[0].stopping=true; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-action=free-lock]').isEnabled(),true,'selected old rows remain intact');
  await page.evaluate(()=>document.querySelector('[data-action=free-lock]').click());
  assert.equal(confirmations,0,'stopping guards prevent even prompting from stale controls');
  assert.equal(data.requests.length,0,'the latest lock scalar blocks a stale enabled control');
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.equal(await page.locator('[data-action=free-lock]').isDisabled(),true);
  data.locks[0].about='Large lock purpose '.repeat(1500); await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>state.locks[0].truncated),true);
  assert.match(await page.locator('#locks').textContent(),/Lock #1 · Releasing after stop/);
  await page.locator('[data-record=locks]').click();
  await page.locator('[data-action=free-lock]').waitFor();
  assert.equal(await page.locator('[data-action=free-lock]').isDisabled(),true);
  assert.equal(data.requests.length,0);
}));

test('Free reports a holder that started stopping after confirmation without releasing or automatically retrying', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Holder',state:'working'}];
  data.locks=[{id:1,project:1,name:'racing lease',holder:1,expires_at:Date.now()/1000+60}];
  await manualPolling(page); await reloadPage(page);
  const held=await holdRequest(page,'**/locks/free');
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('[data-action=free-lock]').click(); await held.started;
  Object.assign(data.agents[0],{state:'paused',stopping:true});
  held.release(); await held.remove();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Lock holder is still stopping');
  assert.equal(data.locks[0].holder,1);
  assert.deepEqual(data.requests,[{url:'/locks/free',method:'POST',body:{project:1,name:'racing lease'}}]);
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-action=free-lock]').isDisabled(),true);
  assert.equal(data.requests.length,1);
}));

test('Pause is a single empty-payload action, preserves the current project after a delayed response and never retries errors', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'First worker',state:'working',locks:['first hold']},{id:2,project:2,name:'Other worker',state:'working',locks:['other hold']}];
  data.locks=[{id:1,project:1,name:'first hold',holder:1},{id:2,project:2,name:'other hold',holder:2}];
  await manualPolling(page); await reloadPage(page);
  const held=await holdRequest(page,'**/agents/1/pause');
  await page.locator('[data-action=pause]').click(); await held.started;
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-action=pause]').isDisabled(),true);
  await page.evaluate(()=>document.querySelector('[data-action=pause]').click());
  await page.locator('#project-select').selectOption('2');
  held.release(); await held.remove();
  await page.waitForFunction(()=>state.selectedProject===2&&refreshPending===0&&agentTransitions.size===0);
  assert.deepEqual(data.requests,[{url:'/agents/1/pause',method:'POST',body:{}}]);
  assert.deepEqual(data.locks.map(lock=>lock.holder),[null,2]);
  assert.equal(data.agents[1].state,'working');
  assert.equal(data.detailRequests.length,0,'Pause no longer fetches holds before a choice');
  data.agents[0].state='working'; data.pauseError='Stop cleanup unavailable';
  await page.locator('#project-select').selectOption('1'); await page.waitForFunction(()=>state.selectedProject===1&&refreshPending===0);
  await page.locator('[data-action=pause]').click(); await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Stop cleanup unavailable');
  await page.evaluate(()=>refresh());
  assert.equal(data.requests.filter(request=>request.url==='/agents/1/pause').length,2,'one explicit retry is not repeated automatically');
  assert.equal(data.agents[0].state,'working');
}));

test('Pause all confirms stop-and-release scope, can be cancelled and stays single-flight through polling', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Working',state:'working'},{id:2,project:2,name:'Idle elsewhere',state:'idle'},{id:3,project:1,name:'Already paused',state:'paused',pause_reason:'user'}];
  data.locks=[{id:1,project:1,name:'first',holder:1},{id:2,project:2,name:'second',holder:2}];
  await manualPolling(page); await reloadPage(page);
  const confirmations=[];
  page.on('dialog',dialog=>{confirmations.push(dialog.message());return confirmations.length===1?dialog.dismiss():dialog.accept();});
  await page.locator('#pause-all').click();
  assert.equal(data.requests.length,0);
  const held=await holdRequest(page,'**/pause-all');
  await page.locator('#pause-all').click(); await held.started;
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#pause-all').isDisabled(),true);
  await page.evaluate(()=>document.querySelector('#pause-all').click());
  held.release(); await held.remove();
  await page.waitForFunction(()=>!document.querySelector('#pause-all').disabled);
  assert.deepEqual(confirmations,Array(2).fill('Pause all agents in all projects, stop their processes, and release every held lock?'));
  assert.deepEqual(data.requests,[{url:'/pause-all',method:'POST',body:{}}]);
  assert.ok(data.locks.every(lock=>lock.holder===null));
  assert.deepEqual(data.agents.map(a=>a.pause_reason),['all','all','user']);
  await page.locator('[data-page=settings]').click();
  assert.match(await page.locator('#settings-form').textContent(),/Every pause stops the agent's processes, then releases its locks/);
  assert.doesNotMatch(await page.locator('body').textContent(),/frozen|freeze|keep locks/i);
}));

test('bounded stopping previews keep cleanup visible and Details available without restart actions', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Huge worker name '.repeat(2500),state:'paused',pause_reason:'user',stopping:true}];
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('[data-action=resume],[data-action=close]').count(),0);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Stopping.*before releasing locks/s);
  await page.locator('[data-action=details]').click();
  await page.locator('#agent-details dt[data-key=stopping]').waitFor();
  assert.equal(await page.locator('[data-action=resume]').isDisabled(),true);
  assert.equal(await page.locator('[data-action=close]').isDisabled(),true);
}));

test('explicit Details hydration restores the action controls of an oversized agent preview without replacing config drafts', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Large agent name ☃ '.repeat(1500),state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium',task:'Full task',locks:[]}];
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('[data-action=pause]').count(),0);
  await page.locator('[data-action=details]').click();
  await page.waitForFunction(()=>document.querySelector('#agent-detail-status').textContent.startsWith('Live'));
  assert.equal(await page.locator('[data-action=pause]').count(),1);
  const model=page.locator('#agent-config [name=agent_model]');
  await model.selectOption('gpt-6-luna');
  await page.evaluate(()=>refresh());
  assert.equal(await model.inputValue(),'gpt-6-luna');
  assert.equal(await page.locator('[data-action=close]').count(),1);
}));

test('oversized selector previews retain unique ID labels and hydrate only the chosen config or project', async () => fixture(async (page,data) => {
  const large='Long preview ☃ '.repeat(1800);
  const custom=settings(); custom.prompts.launch=large;
  data.configs.push({id:3,name:'Large config',settings:custom});
  data.projects.push({id:3,name:large,path:'/projects/large',config:2});
  data.agents=[{id:1,project:1,name:large,state:'working',harness:'codex',model:'gpt-6.1-sol'}];
  await manualPolling(page); await reloadPage(page);
  assert.match(await page.locator('#project-select option[value="3"]').textContent(),/^Project #3/);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/projects/3')||url.startsWith('/configs/3')).length,0);
  await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator('#config-select option[value="3"]').textContent(),'Config #3');
  await page.locator('#config-select').selectOption('3'); await page.waitForFunction(()=>state.editor.config===3);
  assert.equal(await page.locator('[name=config_name]').inputValue(),'Large config');
  assert.equal(await page.locator('[name=prompt_launch]').inputValue(),large);
  await page.locator('[data-page=threads]').click(); await page.locator('[data-open=thread-dialog]').click();
  assert.match(await page.locator('#thread-member-picker [data-member-row]').textContent(),/Agent #1.*working.*Details exceed the preview budget/);
  assert.doesNotMatch(await page.locator('#thread-member-picker').textContent(),/undefined/);
  await page.locator('#thread-dialog [data-close=thread-dialog]').click();
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#project-select').selectOption('3');
  await page.waitForFunction(()=>state.selectedProject===3&&refreshPending===0);
  assert.equal(await page.locator('#project-path').textContent(),'/projects/large');
  assert.ok(data.getRequests.some(url=>url.startsWith('/projects/3?offset=')||url.startsWith('/overview?project=3&offset=')));
}));

test('Overview exposes a pending replacement, preserves selected text and permanently links the committed successor', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Original worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high',replacement_request:{harness:'claude',model:'claude-sonnet-5-5',blocked:null}}];
  await manualPolling(page); await reloadPage(page);
  const source=page.locator('[data-agent="1"]');
  assert.match(await source.textContent(),/Replacement pending.*claude \/ claude-sonnet-5-5.*current turn exits/s);
  assert.equal(await source.locator('[data-action=pause]').textContent(),'Pause');
  assert.equal(await source.locator('[data-action=details][data-id="2"]').count(),0);
  const selected=await selectText(page,'[data-agent="1"] .meta');
  data.agents[0].replacement_request.blocked='Target limit <waiting> & retry later';
  await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>document.querySelector('[data-agent="1"] .meta')===window.selectedNode),true);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.waitForFunction(()=>document.querySelector('[data-agent="1"]').textContent.includes('Target limit <waiting> & retry later'));
  assert.equal(await source.locator('waiting').count(),0);
  Object.assign(data.agents[0],{state:'replaced',replacement_request:null,replacement:2});
  data.agents.push({id:2,project:1,name:'New owner',state:'done',harness:'claude',model:'claude-sonnet-5-5',effort:'high',replacement_start:{predecessor:1,blocked:'Hard target limit',attempted:0},wake_queued_at:1,wake_reason:'Ordinary wake reason'});
  await page.evaluate(()=>refresh());
  assert.doesNotMatch(await source.textContent(),/Replacement pending/);
  assert.equal(await source.locator('[data-action=details][data-id="2"]').textContent(),'Replacement agent #2');
  assert.equal(await source.locator('[data-action=pause],[data-action=resume],[data-action=reopen],[data-action=close]').count(),0);
  const target=page.locator('[data-agent="2"]');
  assert.match(await target.textContent(),/queued.*Replacement waiting.*Hard target limit/s);
  assert.doesNotMatch(await target.textContent(),/waiting for a slot|Ordinary wake reason/);
  await source.locator('[data-action=details][data-id="2"]').focus();
  data.agents[1].replacement_start.blocked='Target capacity still full'; await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-agent]')?.dataset.agent),'1','focus stays on the source successor link, not the successor card Details button');
  await source.locator('[data-action=details][data-id="2"]').click();
  await page.locator('#agent-details dt[data-key=replacement_start]').waitFor();
  assert.match(await page.locator('#agent-details').textContent(),/New owner.*replacement waiting.*Predecessor agent #1.*Target capacity still full/s);
  assert.equal(data.requests.length,0);
}));

test('pending first startup uses replacement-specific suspended actions and allows configuration but not continuation', async () => fixture(async (page,data) => {
  data.agents=[{id:2,project:1,name:'Waiting successor',state:'done',harness:'codex',model:'gpt-6.1-sol',effort:'medium',pause_reason:'limit',wake_queued_at:1,wake_reason:'Do not show normal wake',replacement_pending:false,replacement_start_pending:true,replacement_start:{predecessor:1,blocked:'Usage <hard> limit',attempted:0}}];
  await manualPolling(page); await reloadPage(page);
  const target=page.locator('[data-agent="2"]');
  assert.equal(await target.locator('[data-action=pause]').textContent(),'Pause replacement');
  assert.equal(await target.locator('[data-action=close]').textContent(),'Close replacement');
  assert.doesNotMatch(await target.textContent(),/Auto-resume is on|Do not show normal wake|waiting for a slot/);
  data.agents[0].state='paused'; await page.evaluate(()=>refresh());
  assert.match(await target.textContent(),/Replacement waiting.*Startup is paused.*Resume replacement to continue/s);
  assert.equal(await target.locator('[data-action=resume]').textContent(),'Resume replacement');
  assert.equal(await target.locator('[data-action=another-model]').count(),0);
  data.agents[0].state='closed'; await page.evaluate(()=>refresh());
  assert.match(await target.textContent(),/Startup is closed.*Reopen replacement to continue/s);
  assert.equal(await target.locator('[data-action=reopen]').textContent(),'Reopen replacement');
  await target.locator('[data-action=details][data-id="2"]').click();
  await page.locator('#agent-details dt[data-key=replacement_start]').waitFor();
  assert.equal(await page.locator('#agent-details dt[data-key=replacement_pending],#agent-details dt[data-key=replacement_start_pending]').count(),0);
  assert.equal(await page.locator('#agent-config-title').textContent(),'First-session configuration');
  assert.match(await page.locator('#agent-config-explainer').textContent(),/has not started.*paused or closed startup stays suspended.*Continuation is unavailable/s);
  assert.equal(await page.locator('#agent-config [name=agent_continue]').isDisabled(),true);
  await page.locator('#agent-config [name=agent_model]').selectOption('gpt-6-luna');
  data.agents[0].replacement_start.blocked='Changed capacity reason'; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-config [name=agent_model]').inputValue(),'gpt-6-luna');
  assert.equal(await page.locator('#save-agent-config').textContent(),'Apply to first session');
  await page.locator('#save-agent-config').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Model and effort saved');
  assert.equal(data.requests[0].body.model,'gpt-6-luna');
  assert.equal(Object.hasOwn(data.requests[0].body,'continuation'),false);
  Object.assign(data.agents[0],{state:'crashed',replacement_start:null,replacement_start_pending:false,problem:'First provider start failed',pause_reason:null});
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-details dt[data-key=replacement_start]').count(),0);
  assert.equal(await page.locator('#agent-config-title').textContent(),'Next-turn configuration');
  await page.locator('#agent-dialog button[value=cancel]').click();
  assert.doesNotMatch(await target.textContent(),/Replacement waiting/);
  assert.equal(await target.locator('[data-action=resume]').textContent(),'Retry same model');
  assert.equal(await target.locator('[data-action=another-model]').count(),1);
}));

test('bounded agent stubs retain replacement badges and links and Details hydrates the startup reason', async () => fixture(async (page,data) => {
  const large='Large preview name ☃ '.repeat(1500);
  data.agents=[
    {id:1,project:1,name:large,state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high',replacement_request:{harness:'claude',model:'claude-sonnet-5-5',blocked:'Pending target reason'}},
    {id:2,project:1,name:large,state:'done',harness:'claude',model:'claude-sonnet-5-5',effort:'high',replacement_start:{predecessor:3,blocked:'Exact <first start> reason',attempted:0}},
    {id:3,project:1,name:large,state:'replaced',harness:'codex',model:'gpt-6.1-sol',effort:'high',replacement:2},
  ];
  await manualPolling(page); await reloadPage(page);
  while(await page.locator('#page-overview [data-more=agents]').isVisible()) {await page.locator('#page-overview [data-more=agents]').click();await page.waitForFunction(()=>!state.pages.agents.pending);}
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Replacement pending.*See Details for the replacement target and reason/s);
  assert.match(await page.locator('[data-agent="2"]').textContent(),/Replacement waiting.*See Details for the startup reason/s);
  assert.doesNotMatch(await page.locator('#agents').textContent(),/undefined/);
  assert.equal(await page.locator('[data-agent="3"] [data-action=details][data-id="2"]').textContent(),'Replacement agent #2');
  assert.equal(data.getRequests.filter(url=>/^\/agents\/[123]/.test(url)).length,0,'stub display does not eagerly hydrate full agent records');
  await page.locator('[data-agent="2"] [data-action=details][data-id="2"]').click();
  await page.locator('#agent-details dt[data-key=replacement_start]').waitFor();
  assert.match(await page.locator('#agent-details').textContent(),/replacement waiting.*Exact <first start> reason/s);
  assert.equal(await page.locator('#agent-details first').count(),0);
  assert.equal(await page.locator('[data-agent="2"] [data-action=pause]').textContent(),'Pause replacement');
  assert.ok(data.getRequests.some(url=>url.startsWith('/agents/2?offset=')));
}));

test('a pending source replacement locks configuration without discarding drafts and cancellation restores editing', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Original worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'},{id:2,project:1,name:'Other worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-agent="1"] [data-action=details][data-id="1"]').click();
  await page.locator('#save-agent-config').waitFor();
  const model=page.locator('#agent-config [name=agent_model]');
  await model.selectOption('gpt-6-luna');
  await page.locator('#agent-config [name=agent_continue]').check();
  await page.locator('#agent-config [name=agent_continuation]').fill('Keep this unapplied draft');
  data.agents[0].replacement_request={harness:'claude',model:'claude-sonnet-5-5',blocked:null};
  await page.evaluate(()=>refresh());
  assert.equal(await model.inputValue(),'gpt-6-luna');
  assert.equal(await model.isDisabled(),true);
  assert.equal(await page.locator('#save-agent-config').isDisabled(),true);
  assert.equal(await page.locator('#agent-continuation-toggle').isHidden(),true);
  assert.equal(await page.locator('#agent-config [name=agent_continuation]').inputValue(),'Keep this unapplied draft');
  assert.match(await page.locator('#agent-config-explainer').textContent(),/read-only while a replacement is queued.*draft is kept/s);
  await page.evaluate(()=>document.querySelector('#save-agent-config').click());
  assert.equal(data.requests.length,0);
  data.agents[0].replacement_request=null;
  await page.evaluate(()=>refresh());
  assert.equal(await model.inputValue(),'gpt-6-luna');
  assert.equal(await model.isEnabled(),true);
  assert.equal(await page.locator('#save-agent-config').isEnabled(),true);
  assert.equal(await page.locator('#agent-config [name=agent_continue]').isChecked(),true);
  assert.equal(await page.locator('#agent-config [name=agent_continuation]').inputValue(),'Keep this unapplied draft');
  assert.equal(await page.locator('#agent-config [name=agent_continuation]').isEnabled(),true);
  assert.equal(await page.locator('#agent-continuation-toggle').isVisible(),true);
  assert.equal(data.requests.length,0);
  data.agents[0].replacement_request={harness:'claude',model:'claude-sonnet-5-5',blocked:null}; await page.evaluate(()=>refresh());
  await page.locator('#agent-dialog button[value=cancel]').click();
  await page.locator('[data-agent="2"] [data-action=details][data-id="2"]').click(); await page.locator('#save-agent-config').waitFor();
  assert.equal(await page.locator('#agent-config [name=agent_model]').isEnabled(),true);
  await page.locator('#agent-dialog button[value=cancel]').click();
  await page.locator('[data-agent="1"] [data-action=details][data-id="1"]').click(); await page.locator('#agent-details dt[data-key=replacement_request]').waitFor();
  assert.equal(await model.isDisabled(),true);
  data.agents[0].replacement_request=null; await page.evaluate(()=>refresh());
  assert.equal(await model.isEnabled(),true,'reopened editor owns a fresh lock snapshot');
  assert.equal(data.requests.length,0);
}));

test('Resume restart-paused uses an exact all-project count and leaves manual and limit pauses unchanged', async () => fixture(async (page,data) => {
  data.pageLimit=1;
  data.agents=[
    {id:1,project:1,name:'Manual pause',state:'paused',pause_reason:'user'},
    {id:2,project:1,name:'Usage pause',state:'paused',pause_reason:'limit'},
    {id:3,project:2,name:'Restart one',state:'paused',pause_reason:'restart'},
    {id:4,project:2,name:'Restart two',state:'paused',pause_reason:'restart'},
    {id:5,project:1,name:'Already crashed',state:'crashed',pause_reason:'restart'},
    {id:6,project:1,name:'Already done',state:'done',pause_reason:'restart'},
  ];
  await manualPolling(page); await reloadPage(page);
  const button=page.locator('#resume-restart');
  assert.equal(await button.textContent(),'Resume restart-paused (2 · all projects)');
  assert.equal(await button.isEnabled(),true);
  assert.equal(await page.locator('[data-agent]').count(),1,'selected-project previews remain bounded');
  assert.equal(await page.locator('[data-agent="3"],[data-agent="4"]').count(),0,'no restart-paused preview is needed for the global action');
  await button.click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Resumed 2 restart-paused agents across all projects.');
  assert.deepEqual(data.requests,[{url:'/resume-restart',method:'POST',body:{}}]);
  assert.deepEqual(data.agents.map(a=>[a.id,a.state,a.pause_reason]),[[1,'paused','user'],[2,'paused','limit'],[3,'working',null],[4,'working',null],[5,'crashed','restart'],[6,'done','restart']]);
  assert.equal(await button.textContent(),'Resume restart-paused (0 · all projects)');
  assert.equal(await button.isDisabled(),true);
  assert.equal(await page.locator('#project-select').inputValue(),'1','global resume does not change the selected project');
  assert.equal(await page.locator('#resume-all').textContent(),'Resume all');
}));

test('restart-paused counts refresh across projects without disturbing selected text and disable an empty action', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Selected manual pause',state:'paused',pause_reason:'user'},{id:2,project:2,name:'Other project restart',state:'paused',pause_reason:'restart'}];
  await manualPolling(page); await reloadPage(page);
  const selected=await selectText(page,'[data-agent="1"] .agent-name span');
  data.agents[1].pause_reason='limit'; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#resume-restart').textContent(),'Resume restart-paused (0 · all projects)');
  assert.equal(await page.locator('#resume-restart').isDisabled(),true);
  await page.evaluate(()=>document.querySelector('#resume-restart').click());
  assert.equal(data.requests.length,0);
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>window.selectedNode===document.querySelector('[data-agent="1"] .agent-name span')),true);
  data.agents[1].pause_reason='restart'; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#resume-restart').isEnabled(),true);
  assert.equal(await page.locator('#restart-paused-count').textContent(),'(1 · all projects)');
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.locator('[data-agent="1"] [data-action=details]').click();
  await page.locator('#agent-details dt[data-key=pause_reason]').waitFor();
  assert.equal(await page.locator('#agent-details dt[data-key=pause_reason] + dd').textContent(),'user');
  await page.locator('#agent-dialog button[value=cancel]').click();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'the global count and scope fit the mobile header');
}));

test('restart-paused resume stays disabled during polling and reports request errors without retrying', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Restart pause',state:'paused',pause_reason:'restart'}];
  data.resumeRestartError='Cannot resume restart-paused agents';
  await manualPolling(page); await reloadPage(page);
  const pending=await holdRequest(page,'**/resume-restart');
  await page.locator('#resume-restart').click(); await pending.started;
  assert.equal(await page.locator('#resume-restart').isDisabled(),true);
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#resume-restart').isDisabled(),true);
  await page.evaluate(()=>document.querySelector('#resume-restart').click());
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Cannot resume restart-paused agents');
  assert.equal(await page.locator('#toast').evaluate(el=>el.classList.contains('error')),true);
  assert.equal(await page.locator('#resume-restart').isEnabled(),true);
  await page.evaluate(()=>refresh());
  assert.equal(data.requests.filter(r=>r.url==='/resume-restart').length,1,'failure and subsequent polling never repeat the mutation');
  assert.deepEqual([data.agents[0].state,data.agents[0].pause_reason],['paused','restart']);
}));

test('restart-paused resume exposes partial failures and warnings while retaining unsuccessful agents', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:1,name:'Restart success',state:'paused',pause_reason:'restart'},{id:2,project:2,name:'Restart blocked',state:'paused',pause_reason:'restart'},{id:3,project:1,name:'Manual pause',state:'paused',pause_reason:'user'}];
  data.resumeRestartWarnings=['Agent 1 is waiting for an active slot'];
  data.resumeRestartFailures={2:'Agent 2: requested model is disabled'};
  await manualPolling(page); await reloadPage(page);
  await page.locator('#resume-restart').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Agent 2: requested model is disabled'));
  assert.equal(await page.locator('#toast').textContent(),'Resumed 1 restart-paused agents across all projects.\nAgent 1 is waiting for an active slot\nAgent 2: requested model is disabled');
  assert.equal(await page.locator('#toast').evaluate(el=>el.classList.contains('error')),true);
  assert.deepEqual(data.agents.map(a=>[a.state,a.pause_reason]),[['working',null],['paused','restart'],['paused','user']]);
  assert.equal(await page.locator('#restart-paused-count').textContent(),'(1 · all projects)');
  assert.equal(await page.locator('#resume-restart').isEnabled(),true);
  assert.equal(data.requests.filter(r=>r.url==='/resume-restart').length,1);
}));

test('truncated restart-paused results report full failure counts even when the error sample is empty', async () => fixture(async (page,data) => {
  data.agents=[1,2,3].map(id=>({id,project:1,name:`Restart ${id}`,state:'paused',pause_reason:'restart'}));
  const error='Agent 3: disabled model '.repeat(100);
  data.resumeRestartFailures={3:error};
  data.resumeRestartResult={result_truncated:true,counts:{ids:2,errors:1,warnings:0},ids:[1],errors:[],warnings:[],receipt_event:11};
  data.receipts={11:{details:{response:{ids:[1,2],errors:[error],warnings:[]}}}};
  await manualPolling(page); await reloadPage(page);
  await page.locator('#resume-restart').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('2 resumed, 1 failed'));
  assert.equal(await page.locator('#toast').textContent(),'Restart-paused agents across all projects: 2 resumed, 1 failed. See the completed-action result below.');
  assert.equal(await page.locator('#toast').evaluate(el=>el.classList.contains('error')),true);
  assert.match(await page.locator('#result-notice').textContent(),/ids: 2.*errors: 1.*Result details/);
  await page.locator('#result-notice [data-record=receipts]').click();
  await page.waitForFunction(()=>document.querySelector('#record-content').textContent.includes('Agent 3: disabled model'));
  assert.deepEqual(JSON.parse(await page.locator('#record-content').textContent()).details.response.errors,[error]);
  await page.locator('#record-dialog').getByRole('button',{name:'Close'}).click();
  await page.evaluate(()=>refresh());
  assert.equal(data.requests.filter(r=>r.url==='/resume-restart').length,1,'reading the receipt and polling do not repeat a partially completed action');
  assert.deepEqual(data.agents.map(a=>a.state),['working','working','paused']);
}));
