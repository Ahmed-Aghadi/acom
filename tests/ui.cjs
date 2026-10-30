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
const markdownAsset = '/assets/markdown-it-15.0.3.min.js';
const projectId = id => `10000000-0000-4000-8000-${String(id).padStart(12,'0')}`;
const configId = id => Number(id)===1 ? 'default' : `20000000-0000-4000-8000-${String(id).padStart(12,'0')}`;
const tokenFieldReport=(tokens,awaiting_update=false,at=1720000000)=>({last_known:tokens==null?null:{tokens,at},observed_at:tokens==null?null:at,state_at:at,awaiting_update});

test('chat Markdown uses the reviewed local parser artifact with matching script integrity', () => {
  const bytes=fs.readFileSync(path.join(__dirname,'../src/vendor/markdown-it-15.0.3.min.js'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'391f2aa638e75e6c7859d0a5c5650ef0956722a45998f17e05b83bc655778e1e');
  const html=fs.readFileSync(path.join(__dirname,'../src/ui.html'),'utf8');
  const script=html.match(/<script\b[^>]*\bsrc=["']\/assets\/markdown-it-15\.0\.3\.min\.js["'][^>]*>/);
  assert.ok(script,'the parser is loaded from the same server, not a CDN');
  const integrity=script[0].match(/\bintegrity=["']([^"']+)["']/);
  assert.equal(integrity?.[1],`sha384-${createHash('sha384').update(bytes).digest('base64')}`,'browser integrity verifies the exact vendored bytes');
});

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
    prompts: { launch:'Launch guidance', wake:'Wake guidance', resume:'Resume guidance' },
  };
}
const reloadPage = async page => {
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'live');
};

// Test-server query fixture only; the page obtains the AST and editable clauses from the server.
function agentQueryFixture(source) {
  const fields=['group','provider','model','effort','state','pause_reason','id','name','launched_by','task','status','failure_kind']; let i=0;
  const quote=value=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"',fail=message=>{throw new Error(message);};
  const isSpace=char=>/[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(char);
  const space=()=>{while(i<source.length&&isSpace(source[i]))i++;};
  const operator=word=>source.startsWith(word,i)&&(i+word.length===source.length||isSpace(source[i+word.length])||/[()]/.test(source[i+word.length]));
  const value=(field=false)=>{
    if(source[i]==='"') {
      i++;let text='';
      while(i<source.length) {
        const char=source[i++];if(char==='"')return text;
        if(char==='\\') {const next=source[i++];if(!['\\','"'].includes(next))fail('Invalid escape');text+=next;} else text+=char;
      }
      fail('Unclosed quote');
    }
    const start=i;while(i<source.length&&!isSpace(source[i])&&!/[:()"\\]/.test(source[i])&&(!field||source[i]!==','))i++;
    if(start===i)fail('Missing or malformed value');return source.slice(start,i);
  };
  const combine=(op,children)=>children.length===1?children[0]:{op,children:children.flatMap(child=>child.op===op?child.children:[child])};
  const primary=()=>{
    space();
    if(source[i]==='(') {i++;const expression=or();space();if(source[i++]!==')')fail('Missing closing parenthesis');return expression;}
    if(i===source.length||source[i]===')'||operator('AND')||operator('OR'))fail('Expected condition');
    const quoted=source[i]==='"',first=value();let field=null,values=[first];
    if(!quoted&&source[i]===':') {
      field=first;i++;if(!fields.includes(field))fail(`Unknown search field: ${field}`);
      values=[value(true)];while(source[i]===','){i++;values.push(value(true));}
      if(field!=='group'&&values.includes(''))fail(`Empty ${field} value`);
      const valid={provider:['claude','codex'],state:['working','idle','paused','crashed','done','closed','replaced'],pause_reason:['manual','limit','restart'],failure_kind:['unknown','transport','authentication','model_unavailable','provider_rejected','model_switched','startup','process_exit']}[field];
      if(valid&&values.some(value=>!valid.includes(value)))fail(`Unknown ${field} value`);
      if(['id','launched_by'].includes(field))values=values.map(value=>{
        if(field==='launched_by'&&value==='user')return '0';
        if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<(field==='id'?1:0))fail(`Invalid ${field} value`);
        return String(Number(value));
      });
      values=[...new Set(values)].sort();
    } else if(first==='')fail('Empty text term');
    if(i<source.length&&!isSpace(source[i])&&!/[()]/.test(source[i]))fail('Expected space between clauses');
    return {op:'clause',clause:{field,values,text:field?`${field}:${values.map(quote).join(',')}`:quote(first)}};
  };
  const not=()=>{space();if(operator('NOT')){i+=3;return {op:'not',child:not()};}return primary();};
  const and=()=>{
    const children=[not()];
    while(true) {space();if(i===source.length||source[i]===')'||operator('OR'))break;if(operator('AND'))i+=3;children.push(not());}
    return combine('and',children);
  };
  const or=()=>{const children=[and()];while(true){space();if(!operator('OR'))break;i+=2;children.push(and());}return combine('or',children);};
  const render=(node,parent=0)=>{
    const precedence={or:1,and:2,not:3,clause:4}[node.op];
    const text=node.op==='clause'?node.clause.text:node.op==='not'?`NOT ${render(node.child,precedence)}`:node.children.map(child=>render(child,precedence)).join(node.op==='and'?' AND ':' OR ');
    return precedence<parent?`(${text})`:text;
  };
  try {
    space();if(i===source.length)return {text:'',clauses:[],expression:null};
    const expression=or();space();if(i!==source.length)fail('Unexpected closing parenthesis');
    const children=expression.op==='and'?expression.children:[expression];
    let clauses=children.every(child=>child.op==='clause')?children.map(child=>child.clause):null;
    if(clauses&&new Set(clauses.filter(clause=>clause.field).map(clause=>clause.field)).size!==clauses.filter(clause=>clause.field).length)clauses=null;
    if(clauses)clauses.sort((a,b)=>(a.field==null?fields.length:fields.indexOf(a.field))-(b.field==null?fields.length:fields.indexOf(b.field)));
    return {text:clauses?clauses.map(clause=>clause.text).join(' '):render(expression),clauses,expression};
  } catch(error) {return {status:400,error:error.message};}
}

function agentQueryMatches(expression,agent) {
  if(!expression)return true;
  if(expression.op==='and')return expression.children.every(child=>agentQueryMatches(child,agent));
  if(expression.op==='or')return expression.children.some(child=>agentQueryMatches(child,agent));
  if(expression.op==='not')return !agentQueryMatches(expression.child,agent);
  const clause=expression.clause;
  if(clause.field==null)return [agent.name,agent.id,agent.harness,agent.model,agent.group,agent.status,agent.task].some(value=>String(value??'').toLowerCase().includes(clause.values[0].toLowerCase()));
  if(clause.field==='pause_reason')return agent.state==='paused'&&clause.values.includes(['user','all'].includes(agent.pause_reason)?'manual':agent.pause_reason);
  if(clause.field==='failure_kind')return agent.state==='crashed'&&clause.values.includes(agent.failure_kind||'unknown');
  if(['task','status'].includes(clause.field))return clause.values.some(value=>String(agent[clause.field]??'').toLowerCase().includes(value.toLowerCase()));
  if(clause.field==='launched_by')return clause.values.some(value=>Number(value==='user'?0:value)===agent.launched_by);
  return clause.values.includes(String(clause.field==='provider'?agent.harness:clause.field==='group'?agent.group||'':agent[clause.field]));
}

async function fixture(run) {
  const data = { settings: settings(), globalSettings:{usage_poll_secs:120,metrics_sample_secs:5}, agents: [], threads: [], subscriptions: [], reads: {}, agentLogs: {}, detailRequests: [], getRequests: [], projects: [{ id:projectId(1), name: 'example', path: '/projects/example', config:configId(2) }, { id:projectId(2), name: 'other', path: '/projects/other', config:configId(2) }], requests: [], hardLimit: false };
  data.configs = [{ id:configId(1), name: 'Default', settings: settings() }, { id:configId(2), name: 'Mine', settings: data.settings }];
  let nextProject=3,nextConfig=3;
  data.folders = { '/home/example': { path:'/home/example', parent:'/home', home:'/home/example', entries:[{name:'work',path:'/home/example/work',directory:true},{name:'note.txt',path:'/home/example/note.txt',directory:false}] }, '/home/example/work':{path:'/home/example/work',parent:'/home/example',home:'/home/example',entries:[]} };
  const configs = () => data.configs.map(c => ({ ...c, projects: data.projects.filter(p => p.config === c.id).map(p => p.id) }));
  const effective = p => p?.config == null && p ? p.custom : data.configs.find(c => c.id === (p?.config ?? configId(1))).settings;
  const readOf=t=>data.projectReads?.[`${t.project}:${t.id}`]??(data.threads.filter(thread=>thread.id===t.id).length===1?data.reads[t.id]||0:0);
  const unread = t => t.members.includes(0) ? t.messages.filter(m => m.sender !== 0 && !m.outside_membership && m.id > readOf(t)).length : 0;
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16);
  const agentCategory = (agent, category) => category==='active' ? ['working','idle'].includes(agent.state) : category==='attention' ? ['paused','crashed'].includes(agent.state)||!!(agent.stopping||agent.wake_queued_at||agent.replacement_start||agent.replacement_start_pending) : category==='finished' ? ['done','closed','replaced'].includes(agent.state) : category==='all' ? true : agent.state===category;
  const agentCounts = agents => Object.fromEntries(['all','active','attention','finished','working','idle','paused','crashed','done','closed','replaced'].map(category=>[category,agents.filter(agent=>agentCategory(agent,category)).length]));
  const globalEligible = () => ({pause_eligible:data.agents.filter(agent=>['working','idle','done'].includes(agent.state)).length,resume_eligible:data.agents.filter(agent=>agent.state==='paused').length});
  const bulkResponse=(eligible,successful,warnings=[],failures=[])=>{
    const projects=[...new Set(eligible.map(agent=>agent.project))];
    const results=projects.map((project,index)=>({project,ids:successful.filter(agent=>agent.project===project).map(agent=>agent.id),warnings:index===0?warnings:[],errors:failures.filter(item=>item.agent.project===project).map(item=>item.error)}));
    return {results,errors:[],counts:{ids:successful.length,warnings:warnings.length,errors:failures.length}};
  };
  const projectRows = () => data.projects.map(p => ({...p, agents:data.agents.filter(a => a.project === p.id).length, active:data.agents.filter(a => a.project === p.id && ['working','idle'].includes(a.state)).length, unread:data.threads.filter(t => t.project === p.id).reduce((n,t) => n + unread(t),0)}));
  const collection = (key, project) => {
    if (key === 'projects') return projectRows();
    if (key === 'configs') return configs();
    if (key === 'threads') return data.threads.filter(t => t.project === project).map(t => ({...t,owner:t.owner ?? t.created_by ?? 0,user_member:t.members.includes(0),last_at:t.messages.length?Math.max(...t.messages.map(message=>message.at)):null,last_message_id:Math.max(0,...t.messages.map(message=>message.id)),messages:t.messages.length,unread:unread(t)}));
    if (key === 'agents') return data.agents.filter(a => a.project === project).map(({task,problem,...a})=>({...a,stopping:!!a.stopping,is_waiting:!!a.waiting,replacement:a.replacement ?? (a.state==='replaced' ? a.retry?.replacement : null),replacement_pending:!!a.replacement_request,replacement_start_pending:!!a.replacement_start,task_preview:task?.slice(0,400),problem_preview:problem,has_problem:!!problem,model_unavailable:/model.*(not supported|not available|not found)|not supported.*account/i.test(problem || '')}));
    if (key === 'locks') return (data.locks || []).filter(lock=>lock.project == null || lock.project === project).map((lock,i)=>({id:i+1,...lock,holder_stopping:!!(lock.holder && (lock.holder_stopping || data.agents.find(agent=>agent.id===lock.holder)?.stopping))}));
    return (data[key] || []).filter(row => row.project == null || row.project === project).map((row,i) => ({id:i+1,...row}));
  };
  const revision = (key, project) => hash([key,['projects','configs'].includes(key)?null:project,collection(key,project),key==='agents'?data.agents.filter(agent=>agent.project===project):null]);
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
        if (!items.length) items.push({id:row.id,truncated:true,...Object.fromEntries(['project','thread','sender','at','kind','state','stopping','is_waiting','has_diagnostics','holder_stopping','user_member','unread','messages','private','joinable','owner','created_by','replacement','replacement_pending','replacement_start_pending','agent','mode','deadline','total_tokens','token_usage_state','token_usage_fields'].filter(k => row[k] != null).map(k => [k,row[k]]))});
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
  function sortedThreads(rows,params,revision) {
    const sort=params.get('sort')||'latest_message';revision=hash([revision,sort]);
    if(params.has('revision')&&params.get('revision')!==revision)return {status:409,error:'collection changed; restart paging without a cursor'};
    if(params.get('since')===revision)return {unchanged:true,revision};
    rows.sort((a,b)=>sort==='oldest'?(a.created_at??a.id)-(b.created_at??b.id)||a.id-b.id:sort==='newest'?(b.created_at??b.id)-(a.created_at??a.id)||b.id-a.id:sort==='title'?Buffer.compare(Buffer.from(String(a.title).toLowerCase()),Buffer.from(String(b.title).toLowerCase()))||a.id-b.id:(b.last_at!=null)-(a.last_at!=null)||(b.last_at??0)-(a.last_at??0)||b.last_message_id-a.last_message_id||b.id-a.id);
    let offset=0;
    if(params.has('cursor')) {
      const cursor=JSON.parse(Buffer.from(params.get('cursor'),'base64url').toString());
      if(cursor.revision!==revision||cursor.sort!==sort)return {status:409,error:'collection changed; restart paging without a cursor'};
      offset=rows.findIndex(row=>row.id===cursor.last)+1;
    }
    const limit=Math.min(Number(params.get('limit')||50),data.pageLimit||200),budget=Number(params.get('max_bytes')||16000);
    const candidates=rows.slice(offset),envelope=items=>({items,revision,total:rows.length,has_more:items.length<candidates.length,next_cursor:items.length?Buffer.from(JSON.stringify({sort,revision,last:items.at(-1).id})).toString('base64url'):null});
    const items=[];
    for(const row of candidates.slice(0,limit)) {
      items.push(row);
      if(Buffer.byteLength(JSON.stringify(envelope(items)))>budget) {
        items.pop();
        if(!items.length)items.push({id:row.id,truncated:true,project:row.project,user_member:row.user_member,unread:row.unread,messages:row.messages,last_at:row.last_at,owner:row.owner,private:row.private,joinable:row.joinable});
        break;
      }
    }
    return envelope(items);
  }
  function registryPage(rows,params,revision) {
    if(params.has('revision')&&params.get('revision')!==revision)return {status:409,error:'collection changed; restart paging without a cursor'};
    if(params.get('since')===revision)return {unchanged:true,revision};
    rows=[...rows].reverse();let offset=0;
    if(params.has('cursor')) {const cursor=JSON.parse(Buffer.from(params.get('cursor'),'base64url').toString());if(cursor.revision!==revision)return {status:409,error:'collection changed; restart paging without a cursor'};offset=rows.findIndex(row=>row.id===cursor.last)+1;}
    const candidates=rows.slice(offset),limit=Math.min(Number(params.get('limit')||50),data.pageLimit||200),budget=Number(params.get('max_bytes')||16000),items=[];
    const envelope=items=>({items,revision,total:rows.length,has_more:items.length<candidates.length,next_cursor:items.length?Buffer.from(JSON.stringify({revision,last:items.at(-1).id})).toString('base64url'):null});
    for(const row of candidates.slice(0,limit)) {items.push(row);if(Buffer.byteLength(JSON.stringify(envelope(items)))>budget){items.pop();if(!items.length)items.push({id:row.id,truncated:true});break;}}
    return envelope(items);
  }
  const releaseLocks = (id,project) => {
    const agent=data.agents.find(a=>a.id===id&&(!project||a.project===project)); if(agent)agent.locks=[];
    for(const lock of data.locks || [])if(lock.holder===id&&(!project||lock.project==null||lock.project===project))Object.assign(lock,{holder:null,holder_name:null,acquired_at:null,expires_at:null});
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const wireUrl=req.url,url = new URL(req.url,'http://localhost'), wireQuery=url.search;
    let pathname=url.pathname;
    const scope=/^\/p\/([^/]+)(\/.*)$/.exec(pathname),scopeProject=scope&&decodeURIComponent(scope[1]);
    if(scope) {pathname=scope[2];url.pathname=pathname;url.searchParams.set('project',scopeProject);req.url=pathname+(req.method==='GET'?url.search:wireQuery);}
    const params=url.searchParams;
    (data.wireRequests ||= []).push({url:wireUrl,method:req.method,body});
    if(req.method==='GET') data.getRequests.push(req.url);
    if (req.method !== 'GET'&&!/^\/threads\/\d+\/draft$/.test(pathname)) data.requests.push({ url: req.url, method: req.method, body });
    res.setHeader('Content-Type', 'application/json');
    const send = value => {if(value?.status && value?.error)res.statusCode=value.status;res.end(JSON.stringify(value));};
    if(scope&&!data.projects.some(project=>project.id===scopeProject))return send({status:404,error:'Unknown project'});
    if(!scope&&/^\/(agents|threads|messages|locks|activity|history|subscriptions|agent-config)(\/|$)/.test(pathname))return send({status:400,error:'Project context required'});
    const agentFor=id=>data.agents.find(agent=>agent.id===id&&agent.project===scopeProject);
    const threadFor=id=>data.threads.find(thread=>thread.id===id&&thread.project===scopeProject);
    if(/^\/threads\/\d+\/draft$/.test(pathname)) {
      const id=Number(pathname.split('/')[2]),key=`${scopeProject}:${id}`;
      if(!threadFor(id))return send({status:404,error:'No such thread'});
      const saved=(data.serverDrafts||={})[key]||{thread:id,text:'',version:'empty',updated_at:null};
      (data.draftRequests||=[]).push({url:wireUrl,method:req.method,body});
      if(data.draftError)return send({status:503,error:data.draftError});
      if(req.method==='GET')return send(bounded(saved,params));
      if(req.method==='PUT') {
        if(body.version!==saved.version)return send({status:409,error:'Saved draft changed; reload before saving'});
        if(typeof body.text!=='string'||Buffer.byteLength(body.text)>1048576)return send({status:400,error:'Draft text exceeds limit'});
        const version=`draft-${data.draftSequence=(data.draftSequence||0)+1}`;
        data.serverDrafts[key]={thread:id,text:body.text,version,updated_at:Math.floor(Date.now()/1000)};
        return send({saved:true,thread:id,version});
      }
    }
    if(/^\/agents\/\d+\/permissions$/.test(pathname)) {
      const id=Number(pathname.split('/')[2]),key=`${scopeProject}:${id}`;
      if(!agentFor(id))return send({status:404,error:'No such agent'});
      const grants=(data.permissionGrants||={})[key]||[],version=hash([key,grants]);
      if(req.method==='GET') {
        if(data.permissionsReadError)return send({status:503,error:data.permissionsReadError});
        return send(bounded({agent:id,grants,version},params));
      }
      if(req.method==='PUT') {
        if(data.permissionsWriteError)return send({status:503,error:data.permissionsWriteError});
        if(body.version!==version||agentFor(id).state==='replaced')return send({status:409,error:'Permissions changed; reload before saving'});
        data.permissionGrants[key]=body.grants;
        return send({agent:id,grants:body.grants,version:hash([key,body.grants])});
      }
    }
    if (new URL(req.url, 'http://localhost').pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(fs.readFileSync(path.join(__dirname, '../src/ui.html')));
    }
    if (req.method === 'GET' && pathname === markdownAsset) {
      const asset = path.join(__dirname, '../src/vendor/markdown-it-15.0.3.min.js');
      if (!fs.existsSync(asset)) return send({status:404,error:'Markdown asset is unavailable'});
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.end(fs.readFileSync(asset));
    }
    if(req.method==='GET'&&['/assets/charts.js','/assets/project-data.js'].includes(pathname)) {
      res.setHeader('Content-Type','text/javascript; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');
      return res.end(fs.readFileSync(path.join(__dirname,'../src',path.basename(pathname))));
    }
    if(req.method==='GET'&&(pathname==='/metrics'||pathname==='/metrics/projects'||pathname==='/metrics/series')) {
      if(pathname==='/metrics/series')return send({items:[{id:1,series:{entity:'account:claude:five_hour',metric:'usage_pct',kind:'gauge'},first_at:1,last_at:2}],next:null,status:{available:true}});
      const project=scopeProject||params.get('projects')?.split(',')[0],entity=params.get('entity')||(project?'agent:1':'account:claude:five_hour'),metric=params.get('metric')||'total_tokens',at=Math.floor(Date.now()/1000),counter=metric!=='usage_pct';
      if(!scopeProject&&pathname==='/metrics'&&entity.startsWith('agent:'))return send({status:400,error:'Agent metrics require a project context'});
      const point={observed_at:at,value_observed_at:at,value:{kind:counter?'counter':'gauge',value:counter?'9007199254740993':42},quality:'final'};
      return send({items:[{...(project?{project}:{}),id:1,series:{entity,metric,kind:counter?'counter':'gauge'},origin:{id:'30000000-0000-4000-8000-000000000001',source_instance:'40000000-0000-4000-8000-000000000001',imported_at:null},envelope:{first:point,last:point,minimum:point,maximum:point,observations:1,qualities:['final'],has_gap:false,has_correction:false,checkpoint:false,resolution_secs:60,sampled_at:at},crosses_range:false}],summaries:[],next:null,status:{available:true},range:{from:Number(params.get('from')),to:Number(params.get('to'))}});
    }
    if (req.url.startsWith('/overview')) {
      const id = params.get('project');
      const project = data.projects.find(p => p.id === id) || data.projects[0] || null;
      if (data.delays?.[id]) await new Promise(resolve => setTimeout(resolve, data.delays[id]));
      const revisions = Object.fromEntries(['projects','configs','agents','threads','locks','activity'].map(key => [key,revision(key,project?.id)]));
      revisions.settings=hash([data.projects,configs()]);
      revisions.global_settings=hash(data.globalSettings);
      const restartPaused=data.agents.filter(a=>a.state==='paused' && a.pause_reason==='restart').length;
      const projectAgents=data.agents.filter(a=>a.project===project?.id);
      const projectActions={pause_eligible:projectAgents.filter(a=>['working','idle','done'].includes(a.state)).length,resume_eligible:projectAgents.filter(a=>a.state==='paused').length,restart_paused:projectAgents.filter(a=>a.state==='paused'&&a.pause_reason==='restart').length};
      const rev=hash([revisions,data.usage,data.checks,restartPaused,globalEligible(),projectActions,data.unknownGlobalCounts,data.unknownProjectCounts]);
      if(params.get('since')===rev) return send({unchanged:true,revision:rev});
      return send(bounded({revision:rev,revisions,unread_total:projectRows().reduce((n,p)=>n+p.unread,0),...(data.unknownGlobalCounts?{}:{restart_paused:restartPaused,...globalEligible()}),...(data.unknownProjectCounts?{}:{project_actions:projectActions}),agent_counts:agentCounts(projectAgents), limits:{usage:data.usage || [],checks:data.checks || [],limits:effective(project).limits},project:projectRows().find(p=>p.id===project?.id) || null,url:`http://127.0.0.1:${server.address().port}`},params));
    }
    if(req.method==='GET' && pathname==='/catalog') return send(bounded(catalog,params));
    if(pathname==='/global-settings') {
      if(data.globalSettingsError)return send({status:503,error:data.globalSettingsError});
      if(req.method==='PUT')data.globalSettings=body.settings;
      return send(data.globalSettings);
    }
    if(req.method==='GET' && pathname==='/storage') {
      const project=params.has('project')?params.get('project'):null;
      const report=structuredClone(data.storageReports?.[project] || {home:'/home/example/.acom',project,started_at:1720000000,completed_at:1720000001,complete:true,limited:false,entries:8,skipped:0,bytes:{project:project===null?null:0,project_core:project===null?null:0,project_logs:project===null?null:0,project_metrics:project===null?null:0,project_native:project===null?null:0,all_project_logs:4096,database:8192,metrics:0,native:0,trash:0,other:4096,total:16384}});
      if(data.storageDelay)await new Promise(resolve=>setTimeout(resolve,data.storageDelay));
      if(data.storageError)return send({status:503,error:data.storageError});
      return send(report);
    }
    if(req.method==='GET' && pathname==='/agent-query') {
      const result=agentQueryFixture(params.get('search')||'');
      return send(result.error?result:bounded(result,params));
    }
    if(req.method==='GET' && pathname==='/settings') {
      const id=params.get('project'),project=data.projects.find(p=>p.id===id);
      if(data.delays?.[id])await new Promise(resolve=>setTimeout(resolve,data.delays[id]));
      return send(bounded(effective(project),params));
    }
    if(req.method==='GET' && /^\/(projects|configs|agents|threads|locks|activity)$/.test(pathname)) {
      const key=pathname.slice(1),project=params.get('project') || data.projects[0]?.id;
      if(key==='agents') {
        const category=params.get('category')||'all', search=params.get('search')||'',state=params.get('state'),reason=params.get('pause_reason'),parsed=agentQueryFixture(search);
        if(parsed.error)return send(parsed);
        const matched=data.agents.filter(agent=>agent.project===project&&(!state||agent.state===state)&&(!reason||(agent.state==='paused'&&(reason==='manual'?['user','all'].includes(agent.pause_reason):agent.pause_reason===reason)))&&agentQueryMatches(parsed.expression,agent));
        const ids=new Set(matched.filter(agent=>agentCategory(agent,category)).map(agent=>agent.id));
        const result=paged(collection(key,project).filter(agent=>ids.has(agent.id)),params,hash([revision(key,project),category,search,state,reason]));
        return send(result.error||result.unchanged ? result : {...result,counts:agentCounts(matched),project_total:data.agents.filter(agent=>agent.project===project).length});
      }
      if(key==='threads') {
        const search=(params.get('search')||'').toLowerCase(),id=params.has('id')?Number(params.get('id')):null;
        const members=(params.get('members')||params.get('agent')||'').split(',').filter(Boolean).map(Number),memberMatch=params.get('member_match')||'all',category=params.get('category')||'all';
        const rows=collection(key,project).filter(thread=>(!search||String(thread.title||'').toLowerCase().includes(search))&&(id===null||thread.id===id)&&(!members.length||(memberMatch==='any'?members.some(member=>thread.members.includes(member)):members.every(member=>thread.members.includes(member))))&&(category==='all'||category==='mine'&&thread.user_member||category==='unread'&&thread.unread>0||category==='agents'&&!thread.user_member));
        return send(sortedThreads(rows,params,hash([revision(key,project),search,id,members,memberMatch,category])));
      }
      if(['projects','configs'].includes(key))return send(registryPage(collection(key,project),params,revision(key,project)));
      return send(paged(collection(key,project),params,revision(key,project),key!=='activity'));
    }
    if(req.method==='GET' && pathname==='/history') {
      const selected=(data.history || []).filter(event=>(!params.has('agent')||event.agent===Number(params.get('agent')))&&(!params.has('kind')||event.kind===params.get('kind'))&&(!params.has('before')||event.id<Number(params.get('before')))&&(!params.has('after')||event.id>Number(params.get('after')))).sort((a,b)=>params.has('after')?a.id-b.id:b.id-a.id);
      if(data.historyFailure)return send({status:503,error:'History offline'});
      const events=selected.slice(0,Number(params.get('limit')||30));
      return send({events,has_more:events.length<selected.length,next_before:params.has('after')?null:events.at(-1)?.id??null,next_after:params.has('after')?events.at(-1)?.id??null:null});
    }
    if(req.method==='GET' && pathname==='/subscriptions') {
      if(data.subscriptionFailure)return send({status:503,error:data.subscriptionFailure});
      const rows=data.subscriptions.filter(item=>item.agent===Number(params.get('agent'))&&(!item.project||item.project===scopeProject));
      return send(paged(rows,params,hash(rows)));
    }
    if(req.method==='GET' && /^\/subscriptions\/\d+$/.test(pathname))return send(bounded(data.subscriptions.find(item=>item.id===Number(pathname.split('/')[2])&&(!item.project||item.project===scopeProject)),params));
    if(req.method==='POST' && /^\/subscriptions\/\d+\/cancel$/.test(pathname)) {
      if(data.cancelSubscriptionDelay)await new Promise(resolve=>setTimeout(resolve,data.cancelSubscriptionDelay));
      if(data.cancelSubscriptionError)return send({status:503,error:data.cancelSubscriptionError});
      const item=data.subscriptions.find(item=>item.id===Number(pathname.split('/')[2])&&(!item.project||item.project===scopeProject));
      Object.assign(item,{state:'canceled',completed_at:Math.floor(Date.now()/1000),completion:{kind:'notice',summary:'Canceled by user'}});
      return send({id:item.id,state:item.state});
    }
    if(req.method==='GET' && /^\/(projects|configs|locks|activity)\/[^/]+$/.test(pathname)) {
      const [key,id]=pathname.slice(1).split('/'),project=params.get('project') || data.projects[0]?.id;
      return send(bounded(collection(key,project).find(row=>row.id===(['projects','configs'].includes(key)?id:Number(id))),params));
    }
    if(req.method==='GET' && (scopeProject?/^\/receipts\/\d+$/:/^\/global-receipts\/\d+$/).test(pathname))return send(bounded(data.receipts[Number(pathname.split('/')[2])],params));
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
    if(req.method==='POST'&&/^\/projects\/[^/]+\/export$/.test(pathname))return send({exported:true,archive:body.destination,files:1,warnings:[],notes:[]});
    if (req.url === '/projects') {
      while(data.projects.some(project=>project.id===projectId(nextProject)))nextProject++;
      const p = { id:projectId(nextProject++), path: body.path, name: body.path.split('/').at(-1), config:configId(1) };
      data.projects.push(p);
      return send({ id: p.id });
    }
    if (/^\/projects\/[^/]+\/remove$/.test(req.url)) {
      data.projects = data.projects.filter(p => p.id !== req.url.split('/')[2]);
      return send({});
    }
    if (req.url === '/configs') {
      if (req.method === 'GET') return send(configs());
      if (data.configs.some(c => c.name === body.name)) { res.statusCode = 409; return send({ error: 'Config name already exists' }); }
      while(data.configs.some(config=>config.id===configId(nextConfig)))nextConfig++;
      const id = configId(nextConfig++);
      data.configs.push({ id, ...body }); return send({ id });
    }
    if (/^\/configs\/[^/]+(\/remove)?$/.test(req.url)) {
      if (data.writeDelay) await new Promise(resolve => setTimeout(resolve, data.writeDelay));
      const id = req.url.split('/')[2];
      if (id === configId(1)) { res.statusCode = 403; return send({error:'Default is read-only'}); }
      if (req.url.endsWith('/remove')) data.configs = data.configs.filter(c => c.id !== id);
      else {
        Object.assign(data.configs.find(c => c.id === id), body);
        if (id === configId(2)) data.settings = body.settings;
      }
      return send({});
    }
    if (/^\/projects\/[^/]+\/config$/.test(req.url)) {
      const p = data.projects.find(p => p.id === req.url.split('/')[2]);
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
      const agent = agentFor(body.id);
      if (body.model != null) agent.model = body.model;
      if (body.effort != null) agent.effort = body.effort;
      if (typeof body.continuation === 'string') agent.continuation = {text:body.continuation,blocked:null};
      return send({});
    }
    if (/^\/agents\/\d+\/resume$/.test(req.url)) {
      const agent=agentFor(Number(req.url.split('/')[2]));
      if(agent.stopping)return send({status:409,error:'Agent is still stopping'});
      Object.assign(agent, {state:'working',pause_reason:null,problem:null});
      return send({warnings:[]});
    }
    if (/^\/agents\/\d+\/(close|reopen)$/.test(req.url)) {
      const agent=agentFor(Number(req.url.split('/')[2]));
      if(data.agentTransitionError)return send({status:503,error:data.agentTransitionError});
      Object.assign(agent,{state:req.url.endsWith('/close')?'closed':'idle',pause_reason:null,problem:null});
      return send({});
    }
    if (req.url === '/resume-all') {
      if(data.resumeAllError)return send({status:503,error:data.resumeAllError});
      const eligible=data.agents.filter(a=>a.state==='paused'&&(body.project==null||a.project===body.project));
      for(const agent of eligible)Object.assign(agent,{state:'working',pause_reason:null});
      return send(data.resumeAllResult||bulkResponse(eligible,eligible));
    }
    if (req.url === '/resume-restart') {
      if(data.resumeRestartError)return send({status:503,error:data.resumeRestartError});
      const eligible=data.agents.filter(a=>a.state==='paused' && a.pause_reason==='restart'&&(body.project==null||a.project===body.project));
      const successful=eligible.filter(a=>!data.resumeRestartFailures?.[a.id]);
      for(const agent of successful)Object.assign(agent,{state:'working',pause_reason:null});
      return send(data.resumeRestartResult || bulkResponse(eligible,successful,data.resumeRestartWarnings||[],eligible.filter(agent=>data.resumeRestartFailures?.[agent.id]).map(agent=>({agent,error:data.resumeRestartFailures[agent.id]}))));
    }
    if (/^\/agents\/\d+\/pause$/.test(req.url)) {
      if(Object.hasOwn(body,'locks'))return send({status:400,error:'Pause always releases locks; lock options are unsupported'});
      if(data.pauseError)return send({status:503,error:data.pauseError});
      const id=Number(req.url.split('/')[2]);
      Object.assign(agentFor(id), {state:'paused',pause_reason:'user',stopping:!!data.pauseStopping});
      if(!data.pauseStopping)releaseLocks(id,scopeProject);
      return send({});
    }
    if(req.url==='/pause-all') {
      if(data.pauseAllError)return send({status:503,error:data.pauseAllError});
      const eligible=data.agents.filter(a=>['working','idle','done'].includes(a.state)&&(body.project==null||a.project===body.project));
      for(const agent of eligible) {
        Object.assign(agent,{state:'paused',pause_reason:body.project==null?'all':'user',stopping:!!data.pauseStopping});
        if(!data.pauseStopping)releaseLocks(agent.id,agent.project);
      }
      return send(data.pauseAllResult||bulkResponse(eligible,eligible));
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
        const text=(data.projectLogs?.[`${scopeProject}:${id}`]??data.agentLogs[id]??[]).join('\n'), raw=Buffer.from(text), total=raw.length, version=data.logVersions?.[id] || `log:${scopeProject}:${id}`,rev=hash([version,text]);
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
      } else {
        const agent={...agentFor(id)};
        agent.subscriptions ||= {active:data.subscriptions.filter(item=>item.agent===id&&item.state==='active'&&(!item.project||item.project===scopeProject)).length,pending:data.subscriptionPending?.[id] || 0};
        if(agent.waiting) {agent.waiting={...agent.waiting};delete agent.waiting.remaining_secs;}
        value=bounded(agent,params);
      }
      if (data.detailDelay) await new Promise(resolve => setTimeout(resolve, data.detailDelay));
      if (data.detailFailure) { res.statusCode = 503; return send({ error: 'Offline' }); }
      return send(value);
    }
    if (req.url === '/threads') {
      const t = { id:Math.max(0,...data.threads.filter(thread=>thread.project===scopeProject).map(thread=>thread.id))+1, created_by:0, owner:0, ...body, private:!!body.private, joinable:body.joinable !== false && !body.private, members:[...(body.include_user === false ? [] : [0]),...(body.members || [])], messages: [] };
      data.threads.push(t);
      return send({ id: t.id });
    }
    if (req.url.startsWith('/threads/')) {
      const t=threadFor(Number(pathname.split('/')[2]));
      if(!t)return send({status:404,error:'No such thread'});
      if(req.method==='GET') {
        const metadata={...t,owner:t.owner ?? t.created_by ?? 0,messages:undefined,last_read:readOf(t),unread:unread(t),latest_message:Math.max(0,...t.messages.map(m=>m.id)),first_unread:unread(t)>0?t.messages.find(m=>m.sender!==0&&!m.outside_membership&&m.id>readOf(t)).id:null};
        if(pathname.endsWith('/metadata'))return send(bounded(metadata,params));
        if(pathname.endsWith('/messages/context')) {
          const messages=[...t.messages].sort((a,b)=>a.id-b.id),target=Number(params.get('message')),index=messages.findIndex(message=>message.id===target);
          if(index<0)return send({status:404,error:'No such message in this thread'});
          const limit=Math.min(Number(params.get('limit')||50),data.pageLimit||200),start=Math.min(Math.max(0,index-Math.floor((limit-1)/2)),Math.max(0,messages.length-limit));
          let items=messages.slice(start,start+limit);
          const envelope=items=>({items,target,total:messages.length,through:messages.at(-1)?.id||0,revision:hash([t.messages,readOf(t)]),oldest:items[0]?.id??null,newest:items.at(-1)?.id??null,has_older:messages.some(message=>message.id<items[0]?.id),has_newer:messages.some(message=>message.id>items.at(-1)?.id)});
          while(Buffer.byteLength(JSON.stringify(envelope(items)))>Number(params.get('max_bytes')||16000)) {
            if(items.length===1) {items=[{id:target,thread:t.id,sender:items[0].sender,at:items[0].at,truncated:true}];break;}
            if(items[0].id===target||items.at(-1).id-target>target-items[0].id)items.pop();else items.shift();
          }
          return send(envelope(items));
        }
        const p=new URLSearchParams(params),first=t.messages.find(m=>m.sender!==0 && !m.outside_membership && m.id>readOf(t)),catchup=!p.has('before')&&!p.has('after')&&unread(t)>0;
        if(catchup)p.set('after',first.id-1);
        const messages=paged(t.messages,p,hash([t.messages,readOf(t)]),false);
        if(pathname.endsWith('/messages'))return send({...messages,catchup});
        return send(bounded({...metadata,messages,catchup},params));
      }
      if(req.url.endsWith('/read')) {
        if(data.readDelay) await new Promise(resolve => setTimeout(resolve, data.readDelay));
        if(data.readFailure) {res.statusCode=503;return send({error:'Offline'});}
        const value=Math.max(readOf(t),body.message);(data.projectReads ||= {})[`${t.project}:${t.id}`]=value;data.reads[t.id]=value;
        return send({last_read:value,unread:unread(t)});
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
      return send({...t,last_read:readOf(t),unread:unread(t)});
    }
    if (req.url === '/messages') {
      if (data.messageDelay) await new Promise(resolve => setTimeout(resolve, data.messageDelay));
      if (data.messageFailure) { res.statusCode = data.messageFailureStatus || 503; return send({error:'Message send failed'}); }
      const t = threadFor(body.thread);
      t.members=[...new Set([0,...t.members])];
      const id = Math.max(0,...data.threads.filter(thread=>thread.project===scopeProject).flatMap(thread=>thread.messages.map(message=>message.id))) + 1;
      t.messages.push({ id, sender: 0, at: Date.now() / 1000, text: body.text });
      return send({id});
    }
    if(req.method==='GET' && pathname==='/messages/search') {
      const text=(params.get('text')||'').toLowerCase(),id=params.has('id')?Number(params.get('id')):null;
      const threads=(params.get('threads')||params.get('thread')||'').split(',').filter(Boolean).map(Number),sender=params.has('sender')?Number(params.get('sender')):null;
      const rows=data.threads.filter(thread=>thread.project===scopeProject&&(!threads.length||threads.includes(thread.id))).flatMap(thread=>thread.messages.filter(message=>(id===null||message.id===id)&&(!text||String(message.text).toLowerCase().includes(text))&&(sender===null||message.sender===sender)&&(!params.has('from')||message.at>=Number(params.get('from')))&&(!params.has('to')||message.at<=Number(params.get('to')))).map(message=>({id:message.id,thread:thread.id,title:thread.title,sender:message.sender,at:message.at,snippet:String(message.text).slice(0,320),outside_membership:!!message.outside_membership,...(message.mark?{mark:message.mark}:{})})));
      return send(paged(rows,params,hash([rows,params.get('text'),id,threads,sender,params.get('from'),params.get('to')]),false));
    }
    if(req.method==='GET' && /^\/messages\/\d+$/.test(pathname)) {
      const thread=data.threads.find(thread=>thread.project===scopeProject&&thread.messages.some(message=>message.id===Number(pathname.split('/')[2])));
      if(!thread||params.has('thread')&&thread.id!==Number(params.get('thread')))return send({status:404,error:'No such message in this thread'});
      return send(bounded({...thread.messages.find(message=>message.id===Number(pathname.split('/')[2])),thread:thread.id},params));
    }
    res.statusCode = 404; send({ error: 'not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) });
    const page = await browser.newPage();
    await page.addInitScript(`window.projectId=${projectId.toString()};window.configId=${configId.toString()};`);
    page.on('dialog', dialog => { if (page.listenerCount('dialog') === 1) dialog.accept(); });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelector('#live-text').textContent === 'live');
    await run(page, data);
    assert.deepEqual(errors, [], 'no uncaught page errors');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
const openLaunch = page => page.locator('[data-open="launch-dialog"]').click();
const openSidebar = async page => { if(await page.locator('#sidebar-toggle').getAttribute('aria-expanded')==='false')await page.locator('#sidebar-toggle').click(); };
const openGlobalActions = async page => { await openSidebar(page); if (!await page.locator('#system-menu').evaluate(menu=>menu.open)) await page.locator('#system-menu > summary').click(); };
const openThreadDetails = async page => {
  await page.locator('#thread-details').waitFor({state:'attached'});
  if (!await page.locator('#thread-details').evaluate(details=>details.open)) await page.locator('#thread-details > summary').click();
};
const saveSettings = async page => {
  await page.locator('[form="settings-form"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Settings saved');
};

test('global server settings are independent of Default, project selection and project configuration saves',async()=>fixture(async(page,data)=>{
  data.projects[0].config=configId(1);
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=settings]').click();
  await page.waitForFunction(()=>serverSettings.value);
  const usage=page.locator('#server-settings-form [name=usage_poll_secs]'),sampling=page.locator('#server-settings-form [name=metrics_sample_secs]'),save=page.locator('[form=server-settings-form]');
  assert.equal(await page.locator('[form=settings-form]').isDisabled(),true);
  assert.equal(await save.isDisabled(),true);
  await usage.fill('45');await sampling.fill('3');
  await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
  assert.equal(await usage.inputValue(),'45','global drafts survive project switches');
  assert.equal(await sampling.inputValue(),'3');
  await save.click();await page.waitForFunction(()=>!serverSettings.saving&&!serverSettings.dirty);
  assert.deepEqual(data.globalSettings,{usage_poll_secs:45,metrics_sample_secs:3});
  assert.deepEqual(data.requests,[{url:'/global-settings',method:'PUT',body:{settings:{usage_poll_secs:45,metrics_sample_secs:3}}}]);
  assert.equal(Object.hasOwn(data.settings,'usage_poll_secs'),false);
  assert.equal(await save.isDisabled(),true);
  await usage.fill('60');await usage.fill('45');assert.equal(await save.isDisabled(),true,'reverting a draft disables Save');
  await reloadPage(page);await page.locator('[data-page=settings]').click();await page.waitForFunction(()=>serverSettings.value);
  assert.equal(await usage.inputValue(),'45');
}));

test('global settings detect external edits without replacing a draft or accepting a stale overwrite',async()=>fixture(async(page,data)=>{
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=settings]').click();await page.waitForFunction(()=>serverSettings.value);
  await page.locator('#server-settings-form [name=usage_poll_secs]').fill('60');
  data.globalSettings.usage_poll_secs=90;await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#server-settings-form [name=usage_poll_secs]').inputValue(),'60');
  assert.match(await page.locator('#server-settings-status').textContent(),/changed elsewhere/);
  assert.equal(await page.locator('[form=server-settings-form]').isDisabled(),true);
  await page.locator('#server-settings-form').evaluate(form=>form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})));
  assert.equal(data.requests.length,0);
  await page.locator('#server-settings-reset').click();
  await page.waitForFunction(()=>!serverSettings.loading&&!serverSettings.conflict);
  assert.equal(await page.locator('#server-settings-form [name=usage_poll_secs]').inputValue(),'90');
}));

test('global settings writes remain single-flight, preserve failed drafts and enforce numeric form bounds',async()=>fixture(async(page,data)=>{
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=settings]').click();await page.waitForFunction(()=>serverSettings.value);
  const usage=page.locator('#server-settings-form [name=usage_poll_secs]'),sampling=page.locator('#server-settings-form [name=metrics_sample_secs]'),save=page.locator('[form=server-settings-form]');
  await usage.fill('0');await save.click();assert.equal(data.requests.length,0);
  await usage.fill('45');await sampling.fill('0');await save.click();assert.equal(data.requests.length,0);
  await sampling.fill('2');
  const held=await holdRequest(page,'**/global-settings','PUT');
  await save.click();await held.started;
  await page.evaluate(()=>refresh());
  assert.equal(await save.isDisabled(),true);assert.equal(await usage.isDisabled(),true);
  await page.locator('#server-settings-form').evaluate(form=>form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})));
  data.globalSettingsError='Settings store unavailable';held.release();await held.remove();
  await page.waitForFunction(()=>!serverSettings.saving);
  assert.equal(await usage.inputValue(),'45');assert.equal(await sampling.inputValue(),'2');
  assert.equal(await page.evaluate(()=>serverSettings.dirty),true);
  assert.match(await page.locator('#server-settings-status').textContent(),/unavailable/);
  await page.evaluate(()=>refresh());assert.equal(data.requests.filter(request=>request.url==='/global-settings').length,1,'failed writes are never retried automatically');
}));

test('identical local agent IDs never share in-flight lifecycle controls or retarget delayed requests across projects',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'First project worker',state:'working'},{id:1,project:projectId(2),name:'Second project worker',state:'idle'}];
  await manualPolling(page);await reloadPage(page);
  const held=await holdRequest(page,url=>url.pathname==='/agents/1/pause'&&url.searchParams.get('project')===projectId(1));
  await page.locator('[data-action=pause]').click();await held.started;
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
  assert.equal(await page.locator('[data-action=pause]').isEnabled(),true,'another project’s same ID is not locked by the first action');
  await page.locator('[data-action=pause]').click();await page.waitForFunction(()=>state.agentBrowser[0]?.state==='paused');
  assert.equal(data.agents[0].state,'working');assert.equal(data.agents[1].state,'paused');
  held.release();await held.remove();await page.waitForFunction(()=>agentTransitions.size===0);
  assert.deepEqual(data.agents.map(agent=>agent.state),['paused','paused']);
  const paths=data.wireRequests.filter(request=>request.url.endsWith('/agents/1/pause')).map(request=>request.url).sort();
  assert.deepEqual(paths,[`/p/${projectId(1)}/agents/1/pause`,`/p/${projectId(2)}/agents/1/pause`]);
}));

test('identical local thread and message IDs retain separate drafts, read acknowledgements and send destinations',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([incoming(1,'First project message')]),conversation([incoming(1,'Second project message')],{project:projectId(2)})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();
  const held=await holdRequest(page,url=>url.pathname==='/threads/1/read'&&url.searchParams.get('project')===projectId(1));
  await page.locator('[data-thread="1"]').click();await held.started;
  await page.locator('#message-form textarea').fill('First project draft');
  await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread?.project===projectId(2)&&state.thread.last_read===1);
  assert.match(await page.locator('#messages').textContent(),/Second project message/);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'');
  assert.equal(data.projectReads[`${projectId(2)}:1`],1);
  assert.equal(data.projectReads[`${projectId(1)}:1`],undefined,'a blocked receipt in another project does not share read state');
  await page.locator('#message-form textarea').fill('Reply in second project');await page.locator('#message-form button').click();
  await page.waitForFunction(()=>!pendingSends.size);
  assert.equal(data.threads[0].messages.length,1);assert.equal(data.threads[1].messages.at(-1).text,'Reply in second project');
  held.release();await held.remove();await page.waitForFunction(()=>reading.size===0);
  assert.equal(await page.evaluate(()=>state.thread.project),projectId(2));
  await page.locator('#project-select').selectOption(projectId(1));await page.waitForFunction(()=>state.selectedProject===projectId(1)&&refreshPending===0);
  await page.locator('[data-thread="1"]').click();await page.locator('#message-form textarea').waitFor();
  assert.equal(await page.locator('#message-form textarea').inputValue(),'First project draft');
}));

test('server-backed drafts survive browser cache removal and flush the original thread when it closes',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([])];const key=`${projectId(1)}:1`;
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>draftEntry(state.selectedProject,1).loaded);
  await page.locator('#message-form textarea').fill('Persistent server draft');await page.locator('#close-thread').click();
  await page.waitForFunction(()=>[...drafts.values()].every(entry=>!entry.dirty&&!entry.pending));
  assert.equal(data.serverDrafts[key].text,'Persistent server draft');
  await page.evaluate(()=>localStorage.clear());await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>document.querySelector('#message-form textarea')?.value==='Persistent server draft');
  assert.match(await page.locator('#draft-status').textContent(),/saved to server/);
  assert.equal(data.draftRequests.filter(request=>request.method==='PUT').length,1,'opening and reading a saved draft do not write it again');
}));

test('draft CAS conflicts retain both choices and require an explicit resolution before another save',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([])];const key=`${projectId(1)}:1`;
  data.serverDrafts={[key]:{thread:1,text:'Original saved draft',version:'original',updated_at:1}};
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>document.querySelector('#message-form textarea')?.value==='Original saved draft');
  data.serverDrafts[key]={thread:1,text:'Draft changed in another browser',version:'external',updated_at:2};
  await page.locator('#message-form textarea').fill('Keep my local edits');
  await page.waitForFunction(()=>draftEntry(state.selectedProject,1).conflict&&!draftEntry(state.selectedProject,1).pending);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep my local edits');assert.equal(data.serverDrafts[key].text,'Draft changed in another browser');
  const writes=data.draftRequests.filter(request=>request.method==='PUT').length;await page.waitForTimeout(650);await page.evaluate(()=>refresh());
  assert.equal(data.draftRequests.filter(request=>request.method==='PUT').length,writes,'a conflict is never automatically retried');
  await page.locator('[data-draft-use-saved]').click();assert.equal(await page.locator('#message-form textarea').inputValue(),'Draft changed in another browser');
  data.serverDrafts[key]={thread:1,text:'Another saved edit',version:'external-again',updated_at:3};
  await page.locator('#message-form textarea').fill('Explicitly keep this version');await page.waitForFunction(()=>draftEntry(state.selectedProject,1).conflict&&!draftEntry(state.selectedProject,1).pending);
  await page.locator('[data-draft-keep]').click();await page.waitForFunction(()=>!draftEntry(state.selectedProject,1).dirty&&!draftEntry(state.selectedProject,1).pending);
  assert.equal(data.serverDrafts[key].text,'Explicitly keep this version');
}));

test('a delayed saved-draft read cannot replace newer typing or an acknowledged newer draft write',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([])];const key=`${projectId(1)}:1`;
  data.serverDrafts={[key]:{thread:1,text:'Original draft',version:'original',updated_at:1}};
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();await page.waitForFunction(()=>draftEntry(state.selectedProject,1).loaded);
  let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
  const matcher=new RegExp(`/p/${projectId(1)}/threads/1/draft(?:\\?|$)`);
  const handler=async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch();started();await gate;await route.fulfill({response});};
  await page.route(matcher,handler);
  try {
    await page.evaluate(()=>{window.oldDraftRead=loadServerDraft(draftEntry(state.selectedProject,1),true);});await ready;
    await page.locator('#message-form textarea').fill('Newer acknowledged draft');await page.waitForFunction(()=>!draftEntry(state.selectedProject,1).dirty&&!draftEntry(state.selectedProject,1).pending);
    release();await page.evaluate(()=>window.oldDraftRead);
    assert.equal(await page.locator('#message-form textarea').inputValue(),'Newer acknowledged draft');
    assert.equal(data.serverDrafts[key].text,'Newer acknowledged draft');
    assert.equal(await page.evaluate(()=>draftEntry(state.selectedProject,1).version),data.serverDrafts[key].version);
  } finally {release();await page.unroute(matcher,handler);}
}));

test('a delayed failed draft read cannot overwrite the status of a newer acknowledged save',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([])];await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();await page.waitForFunction(()=>draftEntry(state.selectedProject,1).loaded);
  let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve),matcher=new RegExp(`/p/${projectId(1)}/threads/1/draft(?:\\?|$)`);
  const handler=async route=>{if(route.request().method()!=='GET')return route.continue();started();await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Stale read failed'})});};
  await page.route(matcher,handler);
  try {
    await page.evaluate(()=>{window.oldDraftRead=loadServerDraft(draftEntry(state.selectedProject,1),true);});await ready;
    await page.locator('#message-form textarea').fill('Acknowledged current draft');await page.waitForFunction(()=>!draftEntry(state.selectedProject,1).dirty&&!draftEntry(state.selectedProject,1).pending);
    release();await page.evaluate(()=>window.oldDraftRead);
    assert.equal(await page.evaluate(()=>draftEntry(state.selectedProject,1).error),null,'an old read failure cannot undo a newer successful save status');
    assert.equal(await page.locator('#draft-status').textContent(),'Draft saved to server');
  } finally {release();await page.unroute(matcher,handler);}
}));

test('draft sync failure keeps the browser copy, avoids write retry loops and recovers by explicit retry',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([])];const key=`${projectId(1)}:1`;
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();await page.waitForFunction(()=>draftEntry(state.selectedProject,1).loaded);
  data.draftError='Draft storage unavailable';await page.locator('#message-form textarea').fill('Keep through failed synchronization');
  await page.waitForFunction(()=>draftEntry(state.selectedProject,1).blocked&&!draftEntry(state.selectedProject,1).pending);
  const writes=data.draftRequests.filter(request=>request.method==='PUT').length;await page.waitForTimeout(800);await page.evaluate(()=>refresh());
  assert.equal(data.draftRequests.filter(request=>request.method==='PUT').length,writes);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep through failed synchronization');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem(draftKey(state.selectedProject,1))).text),'Keep through failed synchronization');
  data.draftError=null;await page.locator('[data-draft-retry]').click();await page.waitForFunction(()=>!draftEntry(state.selectedProject,1).dirty&&!draftEntry(state.selectedProject,1).pending);
  assert.equal(data.serverDrafts[key].text,'Keep through failed synchronization');
}));

test('in-flight draft writes stay project-scoped and successful sends clear only the matching submitted draft',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([]),conversation([],{project:projectId(2)})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();await page.waitForFunction(()=>draftEntry(state.selectedProject,1).loaded);
  const held=await holdRequest(page,url=>url.pathname==='/threads/1/draft'&&url.searchParams.get('project')===projectId(1),'PUT');
  try {
    await page.locator('#message-form textarea').fill('First project draft');await page.locator('#close-thread').click();await held.started;
    await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
    await page.locator('[data-thread="1"]').click();await page.waitForFunction(()=>draftEntry(state.selectedProject,1).loaded);
    await page.locator('#message-form textarea').fill('Second project draft');await page.waitForFunction(()=>!draftEntry(state.selectedProject,1).dirty&&!draftEntry(state.selectedProject,1).pending);
    held.release();await held.remove();await page.waitForFunction(()=>!draftEntry(projectId(1),1).dirty&&!draftEntry(projectId(1),1).pending);
    assert.equal(await page.locator('#message-form textarea').inputValue(),'Second project draft');
    assert.equal(data.serverDrafts[`${projectId(1)}:1`].text,'First project draft');assert.equal(data.serverDrafts[`${projectId(2)}:1`].text,'Second project draft');
    await page.locator('#message-form > button.primary').click();await page.waitForFunction(()=>!pendingSends.size&&!draftEntry(state.selectedProject,1).dirty&&!draftEntry(state.selectedProject,1).pending);
    assert.equal(data.serverDrafts[`${projectId(2)}:1`].text,'');assert.notEqual(data.serverDrafts[`${projectId(2)}:1`].version,'empty');
    assert.equal(data.serverDrafts[`${projectId(1)}:1`].text,'First project draft');
  } finally {held.release();await held.remove();}
}));

test('late details and log responses cannot overwrite another project’s same local agent ID',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'First worker',state:'idle'},{id:1,project:projectId(2),name:'Second worker',state:'idle'}];
  data.projectLogs={[`${projectId(1)}:1`]:['First project output'],[`${projectId(2)}:1`]:['Second project output']};
  await manualPolling(page);await reloadPage(page);
  const held=await holdRequest(page,url=>url.pathname==='/agents/1'&&url.searchParams.get('project')===projectId(1),'GET');
  try {
    await page.locator('[data-action=details]').click();await held.started;
    await page.locator('#agent-dialog .dialog-close').click();
    await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
    await page.locator('[data-action=details]').click();await page.waitForFunction(()=>document.querySelector('#agent-title').textContent==='Second worker · #1');
    held.release();await held.remove();await page.waitForTimeout(100);
    assert.equal(await page.locator('#agent-title').textContent(),'Second worker · #1');
    assert.equal(await page.locator('#agent-log').textContent(),'Second project output');
    assert.ok((await page.locator('#agent-details').textContent()).includes(projectId(2)));
  } finally {held.release();await held.remove();}
}));

test('subscription cancellations use the original project without locking the same local subscription elsewhere',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'First worker',state:'idle'},{id:1,project:projectId(2),name:'Second worker',state:'idle'}];
  data.subscriptions=[1,2].map(project=>({id:1,project:projectId(project),agent:1,mode:'persistent',state:'active',created_at:100,watch:{agents:'all',states:['crashed']}}));
  await manualPolling(page);await reloadPage(page);
  await page.locator('[data-action=details]').click();await page.locator('#agent-subscriptions summary').click();await page.locator('[data-cancel-subscription="1"]').waitFor();
  const held=await holdRequest(page,url=>url.pathname==='/subscriptions/1/cancel'&&url.searchParams.get('project')===projectId(1));
  try {
    await page.locator('[data-cancel-subscription="1"]').click();await held.started;
    await page.locator('#agent-dialog .dialog-close').click();await page.locator('#project-select').selectOption(projectId(2));
    await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
    await page.locator('[data-action=details]').click();await page.locator('#agent-subscriptions summary').click();await page.locator('[data-cancel-subscription="1"]').waitFor();
    assert.equal(await page.locator('[data-cancel-subscription="1"]').isEnabled(),true);
    await page.locator('[data-cancel-subscription="1"]').click();await page.waitForFunction(()=>document.querySelector('[data-subscription="1"]').textContent.includes('canceled'));
    assert.deepEqual(data.subscriptions.map(item=>item.state),['active','canceled']);
    held.release();await held.remove();await page.waitForFunction(()=>cancelingSubscriptions.size===0);
    assert.equal(await page.locator('#agent-title').textContent(),'Second worker · #1');
    assert.deepEqual(data.subscriptions.map(item=>item.state),['canceled','canceled']);
    assert.deepEqual(data.wireRequests.filter(request=>request.url.endsWith('/subscriptions/1/cancel')).map(request=>request.url).sort(),[`/p/${projectId(1)}/subscriptions/1/cancel`,`/p/${projectId(2)}/subscriptions/1/cancel`]);
  } finally {held.release();await held.remove();}
}));

test('delegated controls are opt-in, validate eligible states and save or revoke only on explicit submission',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Coordinator',state:'idle'},...['working','paused'].map((state,index)=>({id:index+2,project:projectId(1),name:`Worker ${index+2}`,state}))];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-id="1"][data-action=details]').click();
  assert.equal(data.getRequests.filter(url=>url.includes('/permissions')).length,0);
  await page.locator('#agent-permissions > summary').click();await page.waitForFunction(()=>permissionEntry().loaded&&!permissionEntry().loading);
  assert.equal(await page.locator('[data-permission-rule]').count(),0);
  assert.equal(await page.locator('#permission-save').isDisabled(),true);
  await page.locator('#permission-add').click();
  assert.equal(await page.locator('#permission-action-0').inputValue(),'');
  assert.equal(await page.locator('#permission-scope-0').inputValue(),'');
  await page.locator('#permission-action-0').selectOption('pause');await page.locator('#permission-scope-0').selectOption('selected');
  assert.deepEqual(await page.locator('[data-permission-state]').evaluateAll(nodes=>nodes.map(node=>node.dataset.permissionState)),['working','idle','done']);
  await page.locator('#permission-state-0-idle').check();
  for(const targets of ['', '0', '-1','1','2, invalid']) {await page.locator('#permission-targets-0').fill(targets);assert.equal(await page.locator('#permission-save').isDisabled(),true,targets);}
  await page.locator('#permission-targets-0').fill('2, 3');assert.equal(await page.locator('#permission-save').isEnabled(),true);
  await page.locator('#permission-targets-0').press('Enter');assert.equal(await page.locator('#agent-dialog').isVisible(),true,'Enter in an editor input cannot submit the dialog’s Close form');
  await page.locator('.permission-rule details > summary').click();await page.locator('[data-permission-search]').fill('Worker 3');
  assert.equal(await page.locator('[data-permission-candidate]:visible').count(),1);
  assert.equal(await page.locator('[data-permission-target="1"]').count(),0,'self cannot be selected');
  assert.equal(data.requests.length,0,'editing permissions never autosaves');
  await page.locator('#permission-save').click();await page.waitForFunction(()=>!permissionEntry().saving&&!permissionDirty(permissionEntry()));
  assert.deepEqual(data.permissionGrants[`${projectId(1)}:1`],[{action:'pause',scope:'selected',states:['idle'],agents:[2,3]}]);
  assert.equal(data.requests[0].method,'PUT');assert.equal(typeof data.requests[0].body.version,'string');
  await page.locator('#permission-revoke').click();assert.equal(data.requests.length,1);assert.equal(data.permissionGrants[`${projectId(1)}:1`].length,1);
  await page.locator('#permission-save').click();await page.waitForFunction(()=>!permissionEntry().saving&&!permissionDirty(permissionEntry()));
  assert.deepEqual(data.permissionGrants[`${projectId(1)}:1`],[]);
}));

test('permission drafts preserve focus across polling and selection, then reject stale writes without restoring revoked rights',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Coordinator',state:'idle'},{id:2,project:projectId(1),name:'Worker',state:'idle'}];
  const key=`${projectId(1)}:1`;
  data.permissionGrants={[key]:[{action:'pause',scope:'project',states:['idle']}]};
  await manualPolling(page);await reloadPage(page);await page.locator('[data-id="1"][data-action=details]').click();await page.locator('#agent-permissions > summary').click();
  await page.waitForFunction(()=>permissionEntry().loaded&&!permissionEntry().loading);
  await page.locator('#permission-state-0-working').check();await page.locator('#permission-action-0').focus();
  const input=await page.locator('#permission-action-0').elementHandle();await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#permission-action-0').evaluate((node,old)=>node===old&&document.activeElement===node,input),true);
  await page.locator('#agent-dialog .dialog-close').click();await page.locator('[data-id="2"][data-action=details]').click();await page.locator('#agent-dialog .dialog-close').click();
  await page.locator('[data-id="1"][data-action=details]').click();await page.locator('#agent-permissions > summary').click();
  assert.equal(await page.locator('#permission-state-0-working').isChecked(),true);
  await page.waitForFunction(()=>!permissionEntry().loading);
  data.permissionGrants[key]=[];
  await page.locator('#permission-save').click();await page.waitForFunction(()=>permissionEntry().conflict&&!permissionEntry().saving);
  assert.equal(await page.locator('#permission-state-0-working').isChecked(),true,'a rejected save retains its draft');
  assert.deepEqual(data.permissionGrants[key],[],'a stale version cannot restore permissions');
  assert.equal(await page.locator('#permission-save').isDisabled(),true);await page.evaluate(()=>refresh());
  assert.equal(data.requests.length,1,'polling does not retry a rejected write');
  await page.locator('#permission-reset').click();await page.waitForFunction(()=>permissionEntry().loaded&&!permissionEntry().loading);
  assert.equal(await page.locator('[data-permission-rule]').count(),0);
  assert.equal(await page.locator('#permission-save').isDisabled(),true);
}));

test('permission saves retain the original project and agent while another project edits the same local ID',async()=>fixture(async(page,data)=>{
  data.agents=[1,2].map(project=>({id:1,project:projectId(project),name:`Coordinator ${project}`,state:'idle'}));
  await manualPolling(page);await reloadPage(page);await page.locator('[data-action=details]').click();await page.locator('#agent-permissions > summary').click();await page.waitForFunction(()=>permissionEntry().loaded&&!permissionEntry().loading);
  await page.locator('#permission-add').click();await page.locator('#permission-action-0').selectOption('resume');await page.locator('#permission-scope-0').selectOption('launched');await page.locator('#permission-state-0-paused').check();
  const held=await holdRequest(page,url=>url.pathname==='/agents/1/permissions'&&url.searchParams.get('project')===projectId(1),'PUT');
  try {
    await page.locator('#permission-save').click();await held.started;
    await page.locator('#permission-save').dispatchEvent('click');
    await page.locator('#agent-dialog .dialog-close').click();await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
    await page.locator('[data-action=details]').click();await page.locator('#agent-permissions > summary').click();await page.waitForFunction(()=>permissionEntry().loaded&&!permissionEntry().loading);
    await page.locator('#permission-add').click();await page.locator('#permission-action-0').selectOption('close');await page.locator('#permission-scope-0').selectOption('project');await page.locator('#permission-state-0-idle').check();
    held.release();await held.remove();await page.waitForFunction(()=>!permissionDrafts.get(localKey(1,projectId(1))).saving);
    assert.equal(await page.locator('#permission-action-0').inputValue(),'close');
    assert.equal(await page.locator('#permission-save').isEnabled(),true);
    assert.deepEqual(data.permissionGrants[`${projectId(1)}:1`],[{action:'resume',scope:'launched',states:['paused']}]);
    assert.equal(data.permissionGrants[`${projectId(2)}:1`],undefined);
    assert.equal(data.requests.filter(request=>request.method==='PUT').length,1);
  } finally {held.release();await held.remove();}
}));

test('selected stale permission rows cannot remove a different current rule after an external edit',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Coordinator',state:'idle'}];const key=`${projectId(1)}:1`;
  data.permissionGrants={[key]:[{action:'pause',scope:'project',states:['idle']}]};
  await manualPolling(page);await reloadPage(page);await page.locator('[data-action=details]').click();await page.locator('#agent-permissions > summary').click();await page.waitForFunction(()=>permissionEntry().loaded&&!permissionEntry().loading);
  await selectText(page,'[data-permission-rule="0"] legend');
  data.permissionGrants[key]=[{action:'resume',scope:'launched',states:['paused']}];await page.evaluate(()=>refresh());
  await page.locator('[data-permission-remove="0"]').dispatchEvent('click');
  assert.equal(await page.evaluate(()=>permissionEntry().rules[0]?.action),'resume');
  assert.equal(await page.evaluate(()=>permissionDirty(permissionEntry())),false);assert.equal(data.requests.length,0);
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.equal(await page.locator('#permission-action-0').inputValue(),'resume');
}));

test('replaced agents have read-only delegated controls and failed permission writes are never retried',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Coordinator',state:'idle'}];
  data.permissionGrants={[`${projectId(1)}:1`]:[{action:'pause',scope:'project',states:['idle']}]};
  await manualPolling(page);await reloadPage(page);await page.locator('[data-action=details]').click();await page.locator('#agent-permissions > summary').click();await page.waitForFunction(()=>permissionEntry().loaded&&!permissionEntry().loading);
  await page.locator('#permission-state-0-working').check();data.permissionsWriteError='Permission storage unavailable';
  await page.locator('#permission-save').click();await page.waitForFunction(()=>!!permissionEntry().error&&!permissionEntry().saving);
  await page.evaluate(()=>refresh());assert.equal(data.requests.length,1);assert.equal(await page.locator('#permission-state-0-working').isChecked(),true);
  data.agents[0].state='replaced';await page.evaluate(()=>refresh());
  for(const selector of ['#permission-add','#permission-revoke','#permission-save','#permission-action-0'])assert.equal(await page.locator(selector).isDisabled(),true,selector);
  assert.match(await page.locator('#permission-status').textContent(),/Replaced agents/);
}));

test('history panels load only on demand and keep project, agent and account request scopes distinct',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'History worker',state:'idle'}];
  await manualPolling(page);await reloadPage(page);
  assert.equal(data.wireRequests.filter(request=>/^\/(?:p\/[^/]+\/)?metrics(?:\?|\/)/.test(request.url)).length,0);
  const overview=page.locator('#overview-history-host');
  await overview.locator(':scope > details > summary').click();await overview.getByRole('status').filter({hasText:'stored envelopes loaded'}).waitFor();
  const projectRequest=data.wireRequests.find(request=>request.url.startsWith('/metrics/projects?'));
  assert.equal(new URL(projectRequest.url,'http://test').searchParams.get('projects'),projectId(1));
  assert.equal(new URL(projectRequest.url,'http://test').searchParams.get('scope'),'recorded_here');
  await overview.getByLabel('Source',{exact:true}).selectOption('account');await overview.getByRole('status').filter({hasText:'stored envelopes loaded'}).waitFor();
  assert.ok(data.wireRequests.some(request=>request.url.startsWith('/metrics/series?')));
  assert.ok(data.wireRequests.some(request=>request.url.startsWith('/metrics?')&&new URL(request.url,'http://test').searchParams.get('entity')==='account:claude:five_hour'));
  await page.locator('[data-action=details]').click();const agent=page.locator('#agent-history-host');
  await agent.locator(':scope > details > summary').click();await agent.getByRole('status').filter({hasText:'stored envelopes loaded'}).waitFor();
  assert.ok(data.wireRequests.some(request=>request.url.startsWith(`/p/${projectId(1)}/metrics?`)&&new URL(request.url,'http://test').searchParams.get('entity')==='agent:1'));
  assert.equal(data.wireRequests.some(request=>request.url.startsWith(`/p/${projectId(1)}/metrics/projects`)),false,'global project aggregation is not implicitly retargeted');
  assert.equal(data.requests.length,0,'reading charts does not modify saved data');
}));

test('project archive controls stay manual, preserve per-project drafts and use explicit global paths',async()=>fixture(async(page,data)=>{
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=settings]').click();
  const panel=page.locator('#project-data-host');await panel.getByText('Project archives and captured files',{exact:true}).click();
  assert.equal(data.requests.length,0,'opening Settings and archive controls performs no archive work');
  await panel.getByLabel('Archive destination',{exact:true}).fill('/archives/example.tar');
  await page.evaluate(()=>{const node=document.querySelector('#project-data-host details > p'),range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);});
  const selected=await page.evaluate(()=>getSelection().toString());await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected,'polling keeps selected project identity text');
  assert.equal(await panel.getByLabel('Archive destination',{exact:true}).inputValue(),'/archives/example.tar');
  await page.evaluate(()=>getSelection().removeAllRanges());await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
  assert.equal(await panel.getByLabel('Archive destination',{exact:true}).inputValue(),'');
  await panel.getByLabel('Archive destination',{exact:true}).fill('/archives/other.tar');
  await page.locator('#project-select').selectOption(projectId(1));await page.waitForFunction(()=>state.selectedProject===projectId(1)&&refreshPending===0);
  assert.equal(await panel.getByLabel('Archive destination',{exact:true}).inputValue(),'/archives/example.tar');
  await panel.getByRole('button',{name:'Export snapshot',exact:true}).click();await panel.getByRole('status').filter({hasText:'Snapshot exported'}).waitFor();
  assert.deepEqual(data.requests,[{url:`/projects/${projectId(1)}/export`,method:'POST',body:{destination:'/archives/example.tar',logs:false,native:false}}]);
  assert.equal(data.wireRequests.some(request=>request.url.includes(`/p/${projectId(1)}/projects/`)),false);
  assert.equal(data.getRequests.some(url=>url.startsWith('/storage')),false,'archive controls never trigger a disk scan');
}));

test('project export waits for accepted local draft saves and refuses unresolved draft conflicts',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([])];await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();await page.waitForFunction(()=>draftEntry(state.selectedProject,1).loaded);
  const held=await holdRequest(page,url=>url.pathname==='/threads/1/draft','PUT');
  try {
    await page.locator('#message-form textarea').fill('Include this accepted draft');await held.started;
    await page.locator('[data-page=settings]').click();const panel=page.locator('#project-data-host');await panel.getByText('Project archives and captured files',{exact:true}).click();await panel.getByLabel('Archive destination',{exact:true}).fill('/archives/with-draft.tar');
    await panel.getByRole('button',{name:'Export snapshot',exact:true}).click();await panel.getByRole('status').filter({hasText:'Exporting snapshot'}).waitFor();
    assert.equal(data.requests.length,0,'the archive request cannot race a pending local save');
    held.release();await held.remove();await panel.getByRole('status').filter({hasText:'Snapshot exported'}).waitFor();
    assert.equal(data.serverDrafts[`${projectId(1)}:1`].text,'Include this accepted draft');assert.equal(data.requests.length,1);
    data.serverDrafts[`${projectId(1)}:1`]={thread:1,text:'Another saved draft',version:'another-version',updated_at:2};
    await page.locator('[data-page=threads]').click();await page.locator('#message-form textarea').fill('Do not overwrite the conflict');await page.waitForFunction(()=>draftEntry(state.selectedProject,1).conflict&&!draftEntry(state.selectedProject,1).pending);
    await page.locator('[data-page=settings]').click();await panel.getByRole('button',{name:'Export snapshot',exact:true}).click();await panel.getByRole('status').filter({hasText:'Resolve its sync status before exporting'}).waitFor();
    assert.equal(data.requests.length,1,'a conflict is never overwritten or exported as if synchronized');
    assert.equal(data.serverDrafts[`${projectId(1)}:1`].text,'Another saved draft');
  } finally {held.release();await held.remove();}
}));

test('disk usage is calculated only on demand and stays independent of project settings', async () => fixture(async (page,data) => {
  data.projects[0].config=configId(1);
  await manualPolling(page); await reloadPage(page);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/storage')).length,0);
  await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator('#storage-report').isHidden(),true);
  assert.match(await page.locator('#storage-status').textContent(),/not calculated|calculate|not measured/i);
  assert.equal(await page.locator('#storage-calculate').isEnabled(),true,'Default remains measurable');
  assert.equal(await page.locator('[form=settings-form]').isDisabled(),true);
  assert.equal(await page.locator('#storage-calculate').evaluate(node=>node.closest('form')),null);
  const configs=JSON.stringify(data.configs);
  for(let i=0;i<3;i++)await page.evaluate(()=>refresh());
  await page.locator('[data-page=overview]').click();await page.locator('[data-page=settings]').click();
  assert.equal(data.getRequests.filter(url=>url.startsWith('/storage')).length,0,'polls and opening Settings do not scan');
  await page.locator('#storage-calculate').click();
  await page.waitForFunction(()=>!document.querySelector('#storage-report').hidden);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/storage')).length,1);
  assert.equal(data.getRequests.find(url=>url.startsWith('/storage')),`/storage?project=${projectId(1)}`);
  assert.match(await page.locator('#storage-project').textContent(),/^0\s*(?:B|bytes)$/);
  assert.match(await page.locator('#storage-total').textContent(),/16.*KiB/);
  assert.match(await page.locator('#storage-scanned').textContent(),/\d/);
  assert.match(await page.locator('#storage-panel').textContent(),/chang|snapshot|scan/i);
  assert.match(await page.locator('#storage-panel').textContent(),/native|Claude.*Codex/i);
  for(let i=0;i<3;i++)await page.evaluate(()=>refresh());
  assert.equal(data.getRequests.filter(url=>url.startsWith('/storage')).length,1);
  assert.equal(await page.locator('[form=settings-form]').isDisabled(),true);
  assert.equal(JSON.stringify(data.configs),configs);assert.equal(data.requests.length,0);
  await reloadPage(page);await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator('#storage-report').isHidden(),true,'reload does not present a stale persisted measurement');
  assert.equal(data.getRequests.filter(url=>url.startsWith('/storage')).length,1,'reload never scans automatically');
}));

test('disk usage remains single-flight and rejects stale results after project A to B to A', async () => fixture(async (page,data) => {
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=settings]').click();
  const held=await holdRequest(page,'**/storage*','GET');
  try {
    await page.locator('#storage-calculate').click();await held.started;
    assert.equal(await page.locator('#storage-calculate').isDisabled(),true);
    assert.equal(await page.locator('#storage-panel').getAttribute('aria-busy'),'true');
    await page.locator('#storage-calculate').dispatchEvent('click');await page.evaluate(()=>refresh());
    await page.locator('#project-select').selectOption(projectId(2));
    await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
    assert.match(await page.locator('#storage-scope').textContent(),new RegExp(`Project #${projectId(2)}.*other`));
    assert.equal(await page.locator('#storage-report').isHidden(),true);
    assert.match(await page.locator('#storage-status').textContent(),/previous selection/i);
    await page.locator('#storage-calculate').dispatchEvent('click');
    await page.locator('#project-select').selectOption(projectId(1));
    await page.waitForFunction(()=>state.selectedProject===projectId(1)&&refreshPending===0);
    held.release();await held.remove();
    await page.waitForFunction(()=>!document.querySelector('#storage-calculate').disabled);
    assert.equal(data.getRequests.filter(url=>url.startsWith('/storage')).length,1);
    assert.equal(await page.locator('#storage-report').isHidden(),true,'an earlier calculation is stale even when its project becomes selected again');
    assert.match(await page.locator('#storage-status').textContent(),/not calculated/i);
    await page.locator('#storage-calculate').click();
    await page.waitForFunction(()=>!document.querySelector('#storage-report').hidden);
    assert.equal(data.getRequests.filter(url=>url.startsWith('/storage')).length,2);
  } finally {held.release();await held.remove();}
}));

test('disk usage invalidates asynchronous project selection before its first render', async () => fixture(async page => {
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=settings]').click();
  const scan=await holdRequest(page,'**/storage*','GET'),overview=await holdRequest(page,new RegExp(`/overview\\?project=${projectId(3)}(?:&|$)`),'GET');
  try {
    await page.locator('#storage-calculate').click();await scan.started;
    await page.locator('[data-open=project-dialog]').click();
    await page.locator('#project-form [name=path]').fill('/projects/third');
    await page.locator('#project-form button.primary').click();await overview.started;
    assert.equal(await page.evaluate(()=>state.selectedProject),projectId(3),'selection changes before the new overview renders');
    await page.locator('[data-close=project-dialog]:not(.dialog-close)').click();
    // Exercise the selection handler even while the DOM still displays its prior value.
    await page.locator('#project-select').selectOption(projectId(1));
    await page.waitForFunction(()=>state.selectedProject===projectId(1));
    scan.release();await scan.remove();
    await page.waitForFunction(()=>!document.querySelector('#storage-calculate').disabled);
    assert.equal(await page.locator('#storage-report').isHidden(),true,'an intervening unrendered selection also invalidates the earlier calculation');
    assert.match(await page.locator('#storage-status').textContent(),/not calculated/i);
  } finally {scan.release();overview.release();await scan.remove();await overview.remove();}
}));

test('disk usage labels partial lower bounds, escapes paths and preserves selected values through polling', async () => fixture(async (page,data) => {
  const home='/home/<img src=x onerror="window.storageInjection=true">/.acom';
  data.storageReports={[projectId(1)]:{home,project:projectId(1),started_at:1720000000,completed_at:1720000001,complete:false,limited:true,entries:50,skipped:3,bytes:{project:0,project_core:0,project_logs:0,project_metrics:0,project_native:0,all_project_logs:4096,database:8192,metrics:0,native:0,trash:0,other:4096,total:16384}}};
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=settings]').click();
  await page.locator('#storage-calculate').click();await page.waitForFunction(()=>!document.querySelector('#storage-report').hidden);
  assert.match(await page.locator('#storage-status').textContent(),/Partial.*scan limit reached.*lower bounds.*3.*skipped/i);
  for(const selector of ['project','all-projects','database','other','total'])assert.match(await page.locator(`#storage-${selector}`).textContent(),/^At least /);
  assert.equal(await page.locator('#storage-home').textContent(),home);
  assert.equal(await page.locator('#storage-home img').count(),0);assert.equal(await page.evaluate(()=>window.storageInjection),undefined);
  const selected=await selectText(page,'#storage-home');
  for(let i=0;i<3;i++)await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>window.selectedNode.isConnected),true);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/storage')).length,1);
  assert.equal(await page.getByRole('status',{name:'Disk usage calculation',exact:true}).count(),1);
}));

test('disk usage errors retain only the current scope result and invalid values never become zero', async () => fixture(async (page,data) => {
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=settings]').click();
  await page.locator('#storage-calculate').click();await page.waitForFunction(()=>!document.querySelector('#storage-report').hidden);
  const total=await page.locator('#storage-total').textContent(),scanned=await page.locator('#storage-scanned').textContent();
  data.storageError='Scan unavailable <script>window.storageInjection=true</script>';
  await page.locator('#storage-calculate').click();await page.waitForFunction(()=>document.querySelector('#storage-status').textContent.includes('Calculation failed'));
  assert.match(await page.locator('#storage-status').textContent(),/Previous result retained/);
  assert.equal(await page.locator('#storage-total').textContent(),total);assert.equal(await page.locator('#storage-scanned').textContent(),scanned);
  assert.equal(await page.locator('#storage-status script').count(),0);assert.equal(await page.evaluate(()=>window.storageInjection),undefined);
  await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
  assert.equal(await page.locator('#storage-report').isHidden(),true);assert.match(await page.locator('#storage-status').textContent(),/not calculated/i);
  await page.locator('#storage-calculate').click();await page.waitForFunction(()=>document.querySelector('#storage-status').textContent.includes('Calculation failed'));
  assert.equal(await page.locator('#storage-report').isHidden(),true,'another project never inherits the prior result');
  data.storageError=null;
  for(const invalid of [null,-1,'0']) {
    data.storageReports={[projectId(2)]:{home:'/tmp/acom',project:projectId(2),started_at:1720000000,completed_at:1720000001,complete:true,limited:false,entries:0,skipped:0,bytes:{project:0,project_core:0,project_logs:invalid,project_metrics:0,project_native:0,all_project_logs:4096,database:8192,metrics:0,native:0,trash:0,other:4096,total:16384}}};
    await page.locator('#storage-calculate').click();
    await page.waitForFunction(()=>!document.querySelector('#storage-calculate').disabled);
    assert.match(await page.locator('#storage-status').textContent(),/Invalid disk usage response/);
    assert.equal(await page.locator('#storage-report').isHidden(),true);
  }
}));

test('disk usage supports all-project totals without requiring a selected project', async () => fixture(async (page,data) => {
  data.projects=[];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=settings]').click();
  assert.equal(data.getRequests.filter(url=>url.startsWith('/storage')).length,0);
  await page.locator('#storage-calculate').click();await page.waitForFunction(()=>!document.querySelector('#storage-report').hidden);
  assert.equal(data.getRequests.find(url=>url.startsWith('/storage')),'/storage');
  assert.match(await page.locator('#storage-scope').textContent(),/all projects.*no project selected/i);
  assert.equal(await page.locator('#storage-project').isHidden(),true);
  assert.match(await page.locator('#storage-all-projects').textContent(),/4.*KiB/);
  assert.match(await page.locator('#storage-total').textContent(),/16.*KiB/);
}));

for (const viewport of [{width:1280,height:900,header:95,messages:400},{width:390,height:844,header:120,messages:350},{width:320,height:568,header:120,messages:250}]) {
  test(`compact thread header leaves reading space with many members at ${viewport.width}px`, async () => fixture(async (page,data) => {
    data.agents=Array.from({length:36},(_,i)=>({id:i+1,project:projectId(1),name:`Reviewer ${i+1} with a descriptive name`,state:'idle'}));
    const title='A long discussion title about reviewing the complete project and coordinating detailed follow-up work '.repeat(3);
    data.threads=[conversation([incoming(1,'A useful message remains easy to read.')],{title,members:[0,...data.agents.map(agent=>agent.id)],private:true,joinable:false,owner:1})];
    await manualPolling(page); await page.setViewportSize({width:viewport.width,height:viewport.height}); await reloadPage(page);
    await openSidebar(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
    await page.locator('#message-form textarea').waitFor();
    const height=await page.locator('.thread-header').evaluate(node=>node.getBoundingClientRect().height);
    assert.ok(height<=viewport.header,`collapsed header is ${height}px rather than at most ${viewport.header}px`);
    const readingHeight=await page.locator('#messages').evaluate(node=>node.clientHeight);
    assert.ok(readingHeight>=viewport.messages,`timeline is ${readingHeight}px rather than at least ${viewport.messages}px`);
    assert.equal(await page.locator('.thread-header h2').textContent(),title,'the full title remains available even when visually truncated');
    assert.equal(await page.locator('#thread-details').evaluate(details=>details.open),false);
    assert.match(await page.locator('#thread-summary').textContent(),/Thread #1.*Private.*37 members.*You’re a member/);
    assert.equal(await page.locator('#thread-metadata').isHidden(),true);
    assert.equal(await page.locator('#close-thread').isVisible(),true);
    assert.equal(await page.locator('#thread-unread').evaluate(node=>node.closest('#thread-details')===null),true,'unread navigation remains outside collapsed administration');
    assert.equal(await page.locator('#thread-read-error').evaluate(node=>node.closest('#thread-details')===null),true,'read failures are not concealed in details');
    if(viewport.width<600)assert.equal(await page.locator('#back-to-threads').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const disclosure=page.locator('#thread-details > summary');
    await disclosure.focus(); await disclosure.press('Enter');
    assert.equal(await page.locator('#thread-details').evaluate(details=>details.open),true,'native disclosure is keyboard operable');
    assert.equal(await page.locator('.thread-header h2').textContent(),title,'expanded details keep the complete title in its original heading');
    assert.equal(await page.locator('.thread-header h2').evaluate(node=>getComputedStyle(node).whiteSpace),'normal','the original title expands in place');
    if(viewport.width<600)assert.equal(await page.locator('#back-to-threads').evaluate(node=>{
      const button=node.getBoundingClientRect(),header=node.closest('.thread-header').getBoundingClientRect();
      return button.top>=header.top&&button.bottom<=header.bottom;
    }),true,'expanded long titles keep Back within the visible header');
    assert.match(await page.locator('#thread-metadata').textContent(),/Owner: #1 Reviewer 1.*Members:.*Reviewer 36/);
    for(const id of ['copy-thread','thread-membership','add-thread-members','remove-thread-members','change-thread-owner'])assert.equal(await page.locator(`#${id}`).isVisible(),true,`${id} stays accessible in details`);
    assert.ok(await page.locator('#messages').evaluate(node=>node.clientHeight>=160),'expanded details still leave the timeline usable');
    assert.equal(await page.locator('#message-form button').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight),true,'expanded details keep the send button within the viewport');
    await disclosure.press('Space');
    assert.equal(await page.locator('#thread-details').evaluate(details=>details.open),false);
    assert.equal(data.requests.filter(request=>request.method!=='GET'&&!request.url.endsWith('/read')).length,0);
  }));
}

test('expanded thread details add controls and metadata without repeating the visible title or summary', async () => fixture(async (page,data) => {
  const title='One compact conversation';
  data.agents=[{id:1,project:projectId(1),name:'Reviewer',state:'idle'}];
  data.threads=[conversation([],{title,owner:1,watch:['working','idle'],events:[{id:1,at:1,kind:'thread.joined',agent:1,actor:'acom',details:{reason:'Review started'}}]})];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const summary=await page.locator('#thread-summary').textContent();
  await openThreadDetails(page);
  const details=await page.locator('#thread-details .thread-details-content').textContent();
  assert.doesNotMatch(details,/One compact conversation|Thread #1|Public|You’re a member/,'details do not repeat the visible title, ID, access or participation');
  assert.match(details,/Owner: #1 Reviewer.*Members:.*Reviewer.*Live filters: working, idle/);
  for(const id of ['copy-thread','thread-membership','remove-thread-members','change-thread-owner','thread-history'])assert.equal(await page.locator(`#${id}`).isVisible(),true,`${id} remains available`);
  assert.equal(await page.locator('#thread-summary').textContent(),summary);
  assert.equal(await page.locator('.thread-header h2').count(),1);
  assert.equal(await page.locator('#thread-full-title').count(),0);
  await page.locator('#thread-history > summary').click();
  assert.match(await page.locator('#thread-events').textContent(),/Review started/);
}));

test('thread details preserve disclosure, selected metadata, draft and scroll across polling without leaking to another thread', async () => fixture(async (page,data) => {
  const messages=Array.from({length:30},(_,i)=>incoming(i+1,`Reply ${i+1}. ${'Detailed project update. '.repeat(8)}`));
  data.threads=[conversation(messages,{owner:0,watch:['working','idle','group:review'],events:[{id:1,at:1,kind:'thread.joined',agent:1,actor:'acom',details:{reason:'working matched'}}]}),conversation([],{id:2,title:'Other conversation'})];
  await manualPolling(page); await page.setViewportSize({width:1280,height:900}); await reloadPage(page);
  await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await openThreadDetails(page); await page.locator('#thread-history > summary').click();
  assert.match(await page.locator('#thread-watch').textContent(),/Live filters: working, idle, group:review/);
  assert.match(await page.locator('#thread-events').textContent(),/working matched/);
  await page.locator('#message-form textarea').fill('Retain this detailed conversation draft');
  await page.locator('#messages').evaluate(node=>{node.scrollTop=160;});
  const selected=await selectText(page,'#thread-metadata');
  const scroll=await page.locator('#messages').evaluate(node=>node.scrollTop);
  data.threads[0].owner=2;data.threads[0].messages.push(incoming(31,'Arrived while reading details'));
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#thread-details').evaluate(details=>details.open),true);
  assert.equal(await page.locator('#thread-history').evaluate(details=>details.open),true);
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>window.selectedNode.isConnected),true);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Retain this detailed conversation draft');
  assert.equal(await page.locator('#messages').evaluate(node=>node.scrollTop),scroll);
  assert.equal(await page.locator('[data-message="31"] .message-text').textContent(),'Arrived while reading details');
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.waitForFunction(()=>document.querySelector('#thread-metadata').textContent.includes('Owner: #2'));
  await page.locator('[data-thread="2"]').click();
  await page.waitForFunction(()=>state.thread?.id===2);
  assert.equal(await page.locator('#thread-details').evaluate(details=>details.open),false,'another conversation starts with compact details');
  assert.equal((await page.locator('#thread-summary').textContent()).includes('Thread #2'),true);
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread?.id===1);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Retain this detailed conversation draft');
  assert.equal(await page.locator('#thread-details').evaluate(details=>details.open),false,'reopening does not inherit another pane’s disclosure state');
}));

test('thread disclosure resizing keeps latest readers at the bottom and does not move selected earlier messages', async () => fixture(async (page,data) => {
  data.agents=Array.from({length:12},(_,i)=>({id:i+1,project:projectId(1),name:`Reviewer ${i+1} with a descriptive name`,state:'idle'}));
  data.threads=[conversation(Array.from({length:30},(_,i)=>incoming(i+1,`Reply ${i+1}. ${'Detailed project update. '.repeat(8)}`)),{
    members:[0,...data.agents.map(agent=>agent.id)],
    events:Array.from({length:8},(_,i)=>({id:i+1,at:i+1,kind:'thread.joined',agent:i+1,actor:'acom',details:{reason:'Review group matched'}})),
  })];
  await manualPolling(page); await page.setViewportSize({width:1280,height:900}); await reloadPage(page);
  await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>{const messages=document.querySelector('#messages');return messages&&messages._followLatest&&messages.scrollHeight-messages.scrollTop-messages.clientHeight<2;});
  for(const selector of ['#thread-details','#thread-history','#thread-history','#thread-details']) {
    await page.locator(`${selector} > summary`).click();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const position=await page.locator('#messages').evaluate(node=>({gap:node.scrollHeight-node.scrollTop-node.clientHeight,following:node._followLatest}));
    assert.ok(position.gap<2,`${selector} left the latest reader ${position.gap}px above the bottom`);
    assert.equal(position.following,true,`${selector} preserves follow-latest mode`);
  }
  await page.locator('#messages').evaluate(node=>{node.scrollTop=160;});
  const selected=await selectText(page,'[data-message="2"] .message-text');
  const scroll=await page.locator('#messages').evaluate(node=>node.scrollTop);
  for(const selector of ['#thread-details','#thread-history','#thread-details']) {
    await page.locator(`${selector} > summary`).focus(); await page.locator(`${selector} > summary`).press('Enter');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#messages').evaluate(node=>node.scrollTop),scroll,`${selector} keeps the earlier reading position`);
    assert.equal(await page.evaluate(()=>getSelection().toString()),selected,`${selector} preserves selected message text`);
  }
}));

test('empty dialogs cancel without validation or writes; Task is still required', async () => fixture(async (page, data) => {
  assert.equal(await page.locator('#project-path').textContent(), '/projects/example');
  assert.equal(await page.title(), 'example · acom');
  await openLaunch(page);
  assert.match(await page.locator('#launch-project').textContent(), /\/projects\/example/);
  await page.locator('#launch-form button.primary').click();
  assert.equal(await page.locator('#launch-dialog').isVisible(), true);
  await page.locator('[data-close="launch-dialog"]:not(.dialog-close)').click();
  assert.equal(await page.locator('#launch-dialog').isVisible(), false);
  await page.locator('[data-page="threads"]').click();
  await page.locator('[data-open="thread-dialog"]').click();
  await page.locator('[data-close="thread-dialog"]:not(.dialog-close)').click();
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
  data.threads.push({ id: 1, project:projectId(1), title: 'First project', members: [], messages: [] });
  await reloadPage(page);
  await page.locator('[data-page="threads"]').click();
  await page.locator('[data-thread-filter=all]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form').waitFor();
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForFunction(() => document.querySelector('#project-path').textContent === '/projects/other');
  assert.equal(new URL(page.url()).searchParams.get('project'), projectId(2));
  assert.equal(await page.locator('#thread-list [data-thread]').count(), 0);
  assert.equal(await page.locator('#message-form').count(), 0);
  await openLaunch(page);
  assert.equal(await page.locator('#launch-project-select').inputValue(), projectId(2));
  await page.locator('#launch-project-select').selectOption(projectId(1));
  assert.match(await page.locator('#launch-project').textContent(), /\/projects\/example/);
  await page.locator('#launch-form [name=task]').fill('Different project');
  await page.locator('#launch-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#launch-dialog').open);
  assert.equal(data.requests.at(-1).body.project, projectId(1));
  await reloadPage(page);
  await page.waitForFunction(() => document.querySelector('#project-select').value === projectId(2));
  assert.equal(await page.locator('#project-path').textContent(), '/projects/other');
}));

test('empty project list prompts for a folder; add and remove never delete files', async () => fixture(async (page, data) => {
  data.projects = [];
  await reloadPage(page);
  await page.waitForFunction(() => document.querySelector('#project-select').disabled);
  await openLaunch(page);
  assert.equal(await page.locator('#project-dialog').isVisible(), true);
  await page.locator('[data-close="project-dialog"]:not(.dialog-close)').click();
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
  assert.equal(data.requests.at(-1).url, `/projects/${projectId(3)}/remove`);
}));

test('a delayed project removal preserves another project selection and unsaved settings', async () => fixture(async (page, data) => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  await page.route(`**/projects/${projectId(1)}/remove`, async route => { started(); await gate; await route.continue(); });
  try {
    await page.locator('#remove-project').click();
    await pending;
    await page.locator('#project-select').selectOption(projectId(2));
    await page.locator('[data-page=settings]').click();
    await page.locator('[name=max_lock_ttl_secs]').fill('777');
    const response = page.waitForResponse(response => response.url().endsWith(`/projects/${projectId(1)}/remove`));
    release();
    await response;
    await page.waitForFunction(() => !state.projects.some(project => project.id === projectId(1)) && refreshPending === 0);
    assert.equal(await page.locator('#project-select').inputValue(), projectId(2));
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').inputValue(), '777');
    assert.equal(await page.locator('#settings-save-state').textContent(), 'Unsaved changes');
    assert.deepEqual(data.requests.map(request => request.url), [`/projects/${projectId(1)}/remove`]);
  } finally { release(); }
}));

test('project removal remains single-flight through polling and unlocks after failure', async () => fixture(async (page, data) => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  let attempts = 0;
  await page.route(`**/projects/${projectId(1)}/remove`, async route => {
    attempts++; started(); await gate;
    await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Project changed; try again after inspecting it'})});
  });
  try {
    await page.locator('#remove-project').click();
    await pending;
    await page.evaluate(() => refresh());
    assert.equal(await page.locator('#remove-project').isDisabled(), true);
    await page.locator('#remove-project').evaluate(button => button.click());
    assert.equal(attempts, 1);
    release();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Project changed'));
    assert.equal(await page.locator('#remove-project').isEnabled(), true);
    assert.equal(await page.locator('#project-select').inputValue(), projectId(1));
    assert.equal(data.projects.length, 2);
  } finally { release(); }
}));

test('shared-lock and thread-message counts use singular only for one item', async () => fixture(async (page, data) => {
  await manualPolling(page); await reloadPage(page);
  for (const count of [0,1,2]) {
    data.locks = Array.from({length:count}, (_, index) => ({project:projectId(1),name:`lock-${index}`,holder:null}));
    data.threads = [conversation(Array.from({length:count}, (_, index) => ({id:index+1,sender:0,at:1700000000,text:'Sample'})))];
    await page.evaluate(() => refresh());
    assert.equal(await page.locator('#workspace-stats .stat').last().locator('.stat-note').textContent(), `${count} shared lock${count === 1 ? '' : 's'}`);
    assert.ok((await page.locator('[data-thread="1"] [data-part=summary]').textContent()).includes(`· ${count} message${count === 1 ? '' : 's'} ·`));
  }
  assert.equal(data.requests.length, 0);
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
  data.delays = { [projectId(1)]: 350 };
  await page.locator('#project-select').selectOption(projectId(2));
  await page.locator('#project-select').selectOption(projectId(1));
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#project-path').textContent(), '/projects/other');
  assert.equal(await page.locator('#project-select').inputValue(), projectId(2));
}));

test('late project record hydration cannot overwrite the committed overview after switching projects',async()=>fixture(async(page,data)=>{
  await manualPolling(page);await reloadPage(page);
  const held=await holdRequest(page,url=>url.pathname===`/projects/${projectId(1)}`,'GET');
  await page.route('**/overview*',async route=>{
    const url=new URL(route.request().url());
    if(url.searchParams.get('project')!==projectId(1))return route.continue();
    const response=await route.fetch(),body=await response.json();
    if(body.project)body.project={id:projectId(1),truncated:true};
    await route.fulfill({response,json:body});
  });
  try {
    await page.evaluate(()=>{state.overviewRevision=null;window.oldOverview=refresh();});await held.started;
    await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&state.project?.id===projectId(2));
    held.release();await held.remove();await page.evaluate(()=>window.oldOverview);
    assert.equal(await page.evaluate(()=>state.project.id),projectId(2));
    assert.equal(await page.locator('#project-path').textContent(),'/projects/other');
  } finally {held.release();await held.remove();}
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
    { id: 1, name: 'Replaced agent', project:projectId(1), state: 'replaced', problem: 'Prior stream failure <example>', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
    { id: 2, name: 'Limit agent', project:projectId(1), state: 'paused', pause_reason: 'limit', problem: 'Usage limit reached' },
    { id: 3, name: 'Crash agent', project:projectId(1), state: 'crashed', problem: 'Stream disconnected' },
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
  await openSidebar(page);
  assert.ok(await page.locator('#project-select').evaluate(node=>node.clientWidth>=140));
  assert.ok(await page.locator('.project-actions button').first().evaluate(node=>node.clientWidth>=60));
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-harness=codex]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await openLaunch(page);
  assert.ok(await page.evaluate(() => document.querySelector('#launch-dialog').scrollWidth <= document.querySelector('#launch-dialog').clientWidth));
}));

test('shared edits name affected projects; Custom starts from Default and stays isolated', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  assert.ok((await page.locator('#config-scope').textContent()).includes(`example (#${projectId(1)}), other (#${projectId(2)})`));
  await page.locator('[data-limit=active] [name=hard]').fill('10');
  await saveSettings(page);
  assert.equal(data.settings.limits.active.hard, 10);
  await page.locator('#project-select').selectOption(projectId(2));
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
  await page.locator('#project-select').selectOption(projectId(1));
  await page.waitForFunction(() => document.querySelector('#config-select')?.value === configId(2));
  assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '10');
  assert.doesNotMatch(await page.locator('#config-scope').textContent(), /other/);
}));

test('named configs can be saved, reused, renamed and removed only when unused', async () => fixture(async (page, data) => {
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-limit=active] [name=hard]').fill('12');
  await page.locator('#save-config-as').click();
  await page.locator('#config-form button.primary').click();
  assert.equal(await page.locator('#config-dialog').isVisible(), true);
  await page.locator('[data-close=config-dialog]:not(.dialog-close)').click();
  assert.equal(data.requests.length, 0);
  assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '12');
  await page.locator('#save-config-as').click();
  await page.locator('#config-form [name=name]').fill('Large jobs');
  await page.locator('#config-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#config-dialog').open);
  assert.equal(data.projects[0].config, configId(3));
  assert.equal(data.configs[2].settings.limits.active.hard, 12);
  assert.equal(data.settings.limits.active.hard, 8);
  assert.equal(await page.locator('#remove-config').isDisabled(), true);
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForFunction(() => document.querySelector('#config-select')?.value === configId(2));
  await page.locator('#config-select').selectOption(configId(3));
  await saveSettings(page);
  assert.deepEqual(data.projects.map(p => p.config), [configId(3),configId(3)]);
  await page.locator('[name=config_name]').fill('Bigger jobs');
  await saveSettings(page);
  assert.equal(data.configs[2].name, 'Bigger jobs');
  for (const project of [projectId(1),projectId(2)]) {
    await page.locator('#project-select').selectOption(project);
    await page.waitForFunction(() => !!document.querySelector('#config-select'));
    await page.locator('#config-select').selectOption(configId(1));
    await saveSettings(page);
  }
  await page.locator('#config-select').selectOption(configId(3));
  assert.equal(await page.locator('#remove-config').isEnabled(), true);
  page.once('dialog', d => d.accept()); await page.locator('#remove-config').click();
  await page.waitForFunction(() => !document.querySelector(`#config-select option[value="${configId(3)}"]`));
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
  assert.equal(data.projects[0].config, configId(2));
}));

test('project/config switches ask before discarding drafts, and cancelled switches keep them', async () => fixture(async page => {
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-limit=active] [name=hard]').fill('9');
  for (const selector of ['#project-select', '#config-select']) {
    page.once('dialog', d => d.dismiss());
    await page.locator(selector).selectOption(selector === '#project-select' ? projectId(2) : 'custom');
    assert.equal(await page.locator(selector).inputValue(), selector === '#project-select' ? projectId(1) : configId(2));
    assert.equal(await page.locator('[data-limit=active] [name=hard]').inputValue(), '9');
  }
  page.once('dialog', d => d.accept());
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForFunction(() => document.querySelector('[data-limit=active] [name=hard]')?.value === '8');
}));

test('config selection alone survives polling and switches without discard confirmations', async () => fixture(async (page, data) => {
  let dialogs = 0;
  page.on('dialog', dialog => { dialogs++; dialog.dismiss(); });
  await page.locator('[data-page=settings]').click();
  for (const config of [1,2,1,2,1].map(configId)) {
    await page.locator('#config-select').selectOption(config);
    await page.evaluate(() => refresh());
    assert.equal(await page.locator('#config-select').inputValue(), config);
    assert.equal(await page.evaluate(() => state.editor.dirty), false);
  }
  assert.equal(dialogs, 0);
  assert.equal(data.requests.length, 0, 'selection requires explicit Save to apply');
  assert.equal(await page.locator('[form=settings-form]').isEnabled(), true);
  await saveSettings(page);
  assert.equal(data.projects[0].config, configId(1));
  assert.deepEqual(data.requests, [{url:`/projects/${projectId(1)}/config`,method:'PUT',body:{config:configId(1)}}]);
  assert.equal(await page.locator('[form=settings-form]').isDisabled(), true);
  await page.locator('#config-select').selectOption(configId(2));
  await page.locator('#config-select').selectOption(configId(1));
  assert.equal(dialogs, 0);
  assert.equal(await page.locator('[form=settings-form]').isDisabled(), true);
}));

test('loading a configuration locks dependent editing and survives polling without saving the previous shared config', async () => fixture(async (page, data) => {
  await manualPolling(page);
  const next=settings(); next.prompts.launch='x'.repeat(20000); next.max_lock_ttl_secs=1234;
  data.configs.push({id:configId(3),name:'Large config',settings:next});
  await reloadPage(page); await page.locator('[data-page=settings]').click();
  const pending=await holdRequest(page,`**/configs/${configId(3)}*`,'GET');
  try {
    await page.locator('#config-select').selectOption(configId(3)); await pending.started;
    assert.match(await page.locator('#settings-save-state').textContent(),/loading.*config/i);
    for(const selector of ['[name=max_lock_ttl_secs]','[name=config_name]','#save-config-as','#remove-config','[form=settings-form]'])assert.equal(await page.locator(selector).isDisabled(),true,selector);
    assert.equal(await page.locator('#config-select').isEnabled(),true);
    assert.equal(await page.locator('#project-select').isEnabled(),true);
    const input=await page.locator('[name=max_lock_ttl_secs]').elementHandle();
    data.projects[0].name='Updated project'; await page.evaluate(()=>refresh());
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').evaluate((node,previous)=>node===previous,input),true,'polling preserves the loading editor DOM');
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').isDisabled(),true);
    assert.equal(await page.evaluate(()=>state.editor.dirty),false,'loading is not an edit');
    await page.locator('#save-config-as').dispatchEvent('click');
    await page.locator('#remove-config').dispatchEvent('click');
    await page.locator('#settings-form').dispatchEvent('submit');
    await page.locator('#config-form').dispatchEvent('submit');
    assert.equal(await page.locator('#config-dialog').isVisible(),false);
    assert.deepEqual(data.requests,[],'forced events cannot mutate the previous config');
    pending.release(); await pending.remove();
    await page.waitForFunction(()=>state.editor.config===configId(3));
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').inputValue(),'1234');
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').isEnabled(),true);
    await page.locator('[name=max_lock_ttl_secs]').fill('777'); await saveSettings(page);
    assert.equal(data.configs.find(config=>config.id===configId(2)).settings.max_lock_ttl_secs,900);
    assert.equal(data.configs.find(config=>config.id===configId(3)).settings.max_lock_ttl_secs,777);
    assert.equal(data.projects[0].config,configId(3));
  } finally {pending.release();await pending.remove();}
}));

test('a forced submit during configuration loading never writes the previously selected shared config', async () => fixture(async (page, data) => {
  await manualPolling(page);
  const next=settings();next.prompts.launch='x'.repeat(20000);
  data.configs.push({id:configId(3),name:'Large config',settings:next});
  await reloadPage(page);await page.locator('[data-page=settings]').click();
  const pending=await holdRequest(page,`**/configs/${configId(3)}*`,'GET');
  try {
    await page.locator('#config-select').selectOption(configId(3));await pending.started;
    await page.locator('[name=max_lock_ttl_secs]').evaluate(input=>{input.value='777';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.locator('#settings-form').dispatchEvent('submit');
    await page.waitForTimeout(100);
    assert.deepEqual(data.requests,[]);
    assert.equal(data.configs.find(config=>config.id===configId(2)).settings.max_lock_ttl_secs,900);
    assert.equal(await page.locator('[form=settings-form]').isDisabled(),true);
    pending.release();await pending.remove();await page.waitForFunction(()=>state.editor.config===configId(3));
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').inputValue(),'900');
  } finally {pending.release();await pending.remove();}
}));

test('late configuration failures cannot reset or unlock a newer pending selection', async () => fixture(async (page, data) => {
  await manualPolling(page);
  for(const id of [3,4]) {const next=settings();next.prompts.launch='x'.repeat(20000);next.max_lock_ttl_secs=id*100;data.configs.push({id:configId(id),name:`Large ${id}`,settings:next});}
  await reloadPage(page);await page.locator('[data-page=settings]').click();
  while(await page.locator('#settings-form [data-more=configs]').isVisible()) {await page.locator('#settings-form [data-more=configs]').click();await page.waitForFunction(()=>!state.pages.configs.pending);}
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const reject=async route=>{started();await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Old config unavailable'})});};
  await page.route(`**/configs/${configId(3)}*`,reject);
  const newer=await holdRequest(page,`**/configs/${configId(4)}*`,'GET');
  try {
    await page.locator('#config-select').selectOption(configId(3));await entered;
    await page.locator('#config-select').selectOption(configId(4));await newer.started;
    release();await page.waitForTimeout(100);
    assert.equal(await page.locator('#config-select').inputValue(),configId(4));
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').isDisabled(),true);
    assert.match(await page.locator('#settings-save-state').textContent(),/loading.*config/i);
    assert.doesNotMatch(await page.locator('#toast').textContent(),/Old config unavailable/);
    newer.release();await newer.remove();await page.waitForFunction(()=>state.editor.config===configId(4));
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').inputValue(),'400');
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').isEnabled(),true);
    assert.deepEqual(data.requests,[]);
  } finally {release();newer.release();await newer.remove();await page.unroute(`**/configs/${configId(3)}*`,reject);}
}));

test('a failed configuration load restores the previous unsaved draft and selection', async () => fixture(async (page,data)=>{
  await manualPolling(page);
  const next=settings();next.prompts.launch='x'.repeat(20000);data.configs.push({id:configId(3),name:'Large config',settings:next});
  await reloadPage(page);await page.locator('[data-page=settings]').click();
  await page.locator('[name=max_lock_ttl_secs]').fill('777');
  const reject=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Config unavailable'})});
  await page.route(`**/configs/${configId(3)}*`,reject);
  await page.locator('#config-select').selectOption(configId(3));
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Config unavailable'));
  assert.equal(await page.locator('#config-select').inputValue(),configId(2));
  assert.equal(await page.locator('[name=max_lock_ttl_secs]').inputValue(),'777');
  assert.equal(await page.locator('[name=max_lock_ttl_secs]').isEnabled(),true);
  assert.equal(await page.evaluate(()=>state.editor.dirty),true);
  assert.equal(await page.locator('[form=settings-form]').isEnabled(),true);
  assert.deepEqual(data.requests,[]);await page.unroute(`**/configs/${configId(3)}*`,reject);
}));

test('rapid configuration A to B to A selections accept only the latest load, even before the editor changes', async () => fixture(async (page,data)=>{
  await manualPolling(page);
  for(const id of [3,4]) {const next=settings();next.prompts.launch='x'.repeat(20000);next.max_lock_ttl_secs=id*100;data.configs.push({id:configId(id),name:`Large ${id}`,settings:next});}
  await reloadPage(page);await page.locator('[data-page=settings]').click();
  while(await page.locator('#settings-form [data-more=configs]').isVisible()) {await page.locator('#settings-form [data-more=configs]').click();await page.waitForFunction(()=>!state.pages.configs.pending);}
  const requests=[];
  const hold=async route=>{
    if(new URL(route.request().url()).searchParams.has('offset'))return route.continue();
    let release;const gate=new Promise(resolve=>{release=resolve;});requests.push({id:new URL(route.request().url()).pathname.split('/').at(-1),release});
    await gate;await route.continue().catch(()=>{});
  };
  const matcher=new RegExp(`/configs/(${configId(3)}|${configId(4)})(?:\\?|$)`);
  await page.route(matcher,hold);
  try {
    for(const [index,id] of [3,4,3].entries()) {await page.locator('#config-select').selectOption(configId(id));for(let attempt=0;attempt<100&&requests.length<=index;attempt++)await page.waitForTimeout(20);assert.equal(requests.length,index+1);}
    for(const index of [0,1]) {
      requests[index].release();await page.waitForTimeout(100);
      assert.equal(await page.locator('#config-select').inputValue(),configId(3));
      assert.equal(await page.evaluate(()=>state.editor.config),configId(2));
      assert.equal(await page.locator('[name=max_lock_ttl_secs]').isDisabled(),true);
      assert.equal(await page.evaluate(()=>state.configs.find(config=>config.id===configId(3)).settings),undefined,'stale hydration does not replace the cache');
    }
    requests[2].release();await page.waitForFunction(()=>state.editor.config===configId(3));
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').inputValue(),'300');
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').isEnabled(),true);
    assert.deepEqual(data.requests,[]);
  } finally {requests.forEach(request=>request.release());await page.unroute(matcher,hold);}
}));

test('configuration load failures from an earlier project selection leave the current draft untouched after switching away and back', async () => fixture(async (page,data)=>{
  await manualPolling(page);
  const next=settings();next.prompts.launch='x'.repeat(20000);data.configs.push({id:configId(3),name:'Large config',settings:next});
  await reloadPage(page);await page.locator('[data-page=settings]').click();
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const reject=async route=>{started();await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Obsolete config failure'})});};
  await page.route(`**/configs/${configId(3)}*`,reject);
  try {
    await page.locator('#config-select').selectOption(configId(3));await entered;
    for(const project of [projectId(2),projectId(1)]) {await page.locator('#project-select').selectOption(project);await page.waitForFunction(id=>state.selectedProject===id&&refreshPending===0&&!!state.editor,project);}
    await page.locator('[name=max_lock_ttl_secs]').fill('777');
    release();await page.waitForTimeout(100);
    assert.equal(await page.locator('#config-select').inputValue(),configId(2));
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').inputValue(),'777');
    assert.equal(await page.locator('[name=max_lock_ttl_secs]').isEnabled(),true);
    assert.equal(await page.evaluate(()=>state.editor.dirty),true);
    assert.equal(await page.locator('[form=settings-form]').isEnabled(),true);
    assert.doesNotMatch(await page.locator('#toast').textContent(),/Obsolete config failure/);
    assert.deepEqual(data.requests,[]);
  } finally {release();await page.unroute(`**/configs/${configId(3)}*`,reject);}
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
  await page.locator('#config-select').selectOption(configId(1));
  assert.equal(await save.isEnabled(), true);
  assert.equal(await page.locator('#config-applied').textContent(), 'Applied configuration: Mine');
  await page.locator('#config-select').selectOption(configId(2));
  assert.equal(await save.isDisabled(), true);
  await page.locator('#add-retry-rule').click();
  assert.equal(await save.isEnabled(), true);
  await page.locator('[data-remove-retry]').click();
  assert.equal(await save.isDisabled(), true);
  await page.locator('#config-select').selectOption('custom');
  assert.equal(await save.isEnabled(), true, 'Custom is a real binding change even with matching settings');
  await page.locator('#config-select').selectOption(configId(2));
  assert.equal(await save.isDisabled(), true);
  assert.deepEqual(data.requests, []);
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForFunction(() => document.querySelector('#config-select')?.value === configId(2));
  assert.equal(await save.isDisabled(), true);
}));

test('Default is read-only, copied settings are editable, and busy restoration preserves read-only controls', async () => fixture(async (page, data) => {
  data.settings.limits.active.hard = 9;
  data.writeDelay = 250;
  const originalDefault = structuredClone(data.configs[0].settings);
  await reloadPage(page); await page.locator('[data-page=settings]').click();
  await page.locator('#config-select').selectOption(configId(1));
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
  assert.equal(data.projects[0].config, configId(3));
  assert.equal(await page.locator('[data-limit=active] [name=hard]').isEnabled(), true);
  await page.locator('[data-limit=active] [name=hard]').fill('12'); await saveSettings(page);
  assert.equal(data.configs[2].settings.limits.active.hard, 12);
  assert.deepEqual(data.configs[0].settings, originalDefault);
  assert.equal(data.settings.limits.active.hard, 9, 'Mine persists independently of Default and copies');
  assert.equal(data.requests.some(request => request.url === `/configs/${configId(1)}`), false);
}));

test('launch loads the target project defaults and ignores stale target responses', async () => fixture(async (page, data) => {
  const custom = settings(); custom.harnesses.claude.enabled = false;
  custom.harnesses.codex.model = 'gpt-6-luna'; custom.harnesses.codex.effort = 'low';
  data.projects[1].config = null; data.projects[1].custom = custom;
  await openLaunch(page);
  await page.locator('#launch-project-select').selectOption(projectId(2));
  await page.waitForFunction(() => document.querySelector('#launch-model').value === 'gpt-6-luna');
  assert.equal(await page.locator('#launch-harness').inputValue(), 'codex');
  assert.equal(await page.locator('#launch-harness option[value=claude]').count(), 0);
  assert.equal(await page.locator('#launch-effort').inputValue(), 'low');
  data.delays = { [projectId(1)]: 350 };
  await page.locator('#launch-project-select').selectOption(projectId(1));
  await page.locator('#launch-project-select').selectOption(projectId(2));
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#launch-model').inputValue(), 'gpt-6-luna');
  await page.locator('#launch-form [name=task]').fill('Scoped defaults');
  await page.locator('#launch-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#launch-dialog').open);
  assert.equal(data.requests.at(-1).body.model, 'gpt-6-luna');
  assert.equal(data.requests.at(-1).body.effort, 'low');
  assert.equal(data.requests.at(-1).body.project, projectId(2));
}));

test('without projects Default is read-only while Mine and copied configs remain editable', async () => fixture(async (page, data) => {
  data.projects = []; await reloadPage(page);
  await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator('[data-limit=active] [name=hard]').isDisabled(), true);
  assert.equal(await page.locator('[form=settings-form]').isDisabled(), true);
  await page.locator('#config-select').selectOption(configId(2));
  await page.locator('[data-limit=active] [name=hard]').fill('9');
  await saveSettings(page);
  assert.equal(data.settings.limits.active.hard, 9);
  await page.locator('#save-config-as').click();
  await page.locator('#config-form [name=name]').fill('Unused');
  await page.locator('#config-form button.primary').click();
  await page.waitForFunction(() => !document.querySelector('#config-dialog').open);
  assert.equal(await page.locator('#config-select').inputValue(), configId(3));
  assert.equal(data.projects.length, 0);
  assert.equal(data.requests.some(r => r.url.startsWith('/projects')), false);
}));

test('a project with no enabled harness cannot launch', async () => fixture(async (page, data) => {
  const custom = settings();
  for (const h of Object.values(custom.harnesses)) h.enabled = false;
  data.projects[1].config = null; data.projects[1].custom = custom;
  await openLaunch(page);
  await page.locator('#launch-project-select').selectOption(projectId(2));
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('No harnesses are enabled'));
  assert.equal(await page.locator('#launch-form button.primary').isDisabled(), true);
  await page.locator('[data-close=launch-dialog]:not(.dialog-close)').click();
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
  assert.equal(data.projects[0].config, configId(2));
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
  data.agents=[{id:1,project:projectId(1),name:'Reviewer',state:'working',harness:'codex',model:'gpt-6-luna'}, {id:2,project:projectId(1),name:'Writer',state:'paused',harness:'claude',model:'claude-sonnet-5-5'}];
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
  data.agents=[{id:1,project:projectId(1),name:'One',state:'idle'},{id:2,project:projectId(1),name:'Two',state:'paused'}];
  data.threads=[{id:1,project:projectId(1),title:'Mine',members:[0,1],messages:[]},{id:2,project:projectId(1),title:'Agents talking',members:[1],messages:[]}];
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('[data-thread]').count(),1);
  await page.locator('[data-thread-filter=all]').click();
  assert.equal(await page.locator('[data-thread]').count(),2);
  await page.locator('[data-thread="2"]').click();
  await openThreadDetails(page); await page.locator('#thread-membership').waitFor();
  assert.equal(await page.locator('#thread-membership').textContent(),'Join thread');
  await openThreadDetails(page); await page.locator('#thread-membership').click();
  await page.waitForFunction(()=>document.querySelector('#thread-membership').textContent==='Leave thread');
  assert.ok(data.threads[1].members.includes(0));
  await openThreadDetails(page); await page.locator('#add-thread-members').click();
  assert.equal(await page.locator('#add-member-picker [name=member]').count(),1);
  await page.locator('#add-member-picker [name=member]').check();
  await page.locator('#members-form button.primary').click();
  await page.waitForFunction(()=>!document.querySelector('#members-dialog').open);
  assert.ok(data.threads[1].members.includes('2'));
  await openThreadDetails(page); await page.locator('#thread-membership').click();
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
    await openThreadDetails(page);
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
  assert.deepEqual(data.requests.find(r => r.url === '/threads').body, {project:projectId(1),title:'Chosen members',members:[],include_user:true,private:false,joinable:true});
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
    assert.ok((await page.locator('#thread-summary').textContent()).includes(label));
    assert.ok((await page.locator(`[data-thread="${index+1}"] [data-part=summary]`).textContent()).includes(label));
    assert.equal(await page.locator('#thread-access').inputValue(), 'open', 'successful creation resets access for the next thread');
  }
  assert.equal(data.threads.at(-1).members.includes(0), false, 'not including the user does not hide the administrative thread view');
}));

test('no-self-join access switches live membership to fixed without discarding its filter selections', async () => fixture(async (page, data) => {
  data.agents=[{id:1,project:projectId(1),name:'Reviewer',state:'working'}];
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
  data.pageLimit=1; data.agents=[1,2,3].map(id=>({id,project:projectId(1),name:`Worker ${id}`,state:'idle'}));
  data.threads=[conversation([incoming(1,'Existing conversation')],{members:[0,1,3],private:true,joinable:false})]; data.reads[1]=1;
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await openThreadDetails(page); await page.locator('#remove-thread-members').click();
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
  await openThreadDetails(page); await page.locator('#thread-history summary').click();
  assert.match(await page.locator('#thread-events').textContent(), /agent 1 left · by user.*Removed by user/);
  await openThreadDetails(page); await page.locator('#remove-thread-members').click();
  assert.deepEqual(await page.locator('#remove-member-picker [name=member]').evaluateAll(nodes=>nodes.map(n=>Number(n.value))),[3]);
}));

test('live member removals explain durable exclusions and offer explicit restoration by ID', async () => fixture(async (page, data) => {
  data.threads=[conversation([],{watch:['working','idle'],excluded_members:[]})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await openThreadDetails(page); await page.locator('#remove-thread-members').click();
  assert.match(await page.locator('#remove-members-help').textContent(),/stay excluded.*until explicitly added/);
  await page.locator('#remove-member-picker [name=member][value="1"]').check(); await page.locator('#remove-members-form button.danger').click();
  await page.waitForFunction(()=>!document.querySelector('#remove-members-dialog').open);
  assert.deepEqual(data.threads[0].excluded_members,[1]);
  assert.equal(await page.locator('#remove-thread-members').isDisabled(),true);
  assert.equal(await page.locator('#add-thread-members').textContent(),'Restore members');
  await openThreadDetails(page); await page.locator('#add-thread-members').click();
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
  await openThreadDetails(page); await page.locator('#remove-thread-members').click();
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
  data.pageLimit=1; data.agents=[1,2,3].map(id=>({id,project:projectId(1),name:`Worker ${id}`,state:'idle'}));
  data.threads=[conversation([],{created_by:0,owner:0,private:true,joinable:false})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('#thread-metadata').textContent(), /Owner: you/);
  await openThreadDetails(page); await page.locator('#change-thread-owner').click();
  assert.equal(await page.getByRole('dialog',{name:'Change thread owner',exact:true}).count(),1);
  assert.match(await page.locator('#thread-owner-form').textContent(),/Ownership changes do not add or remove members/);
  assert.deepEqual(await page.locator('#thread-owner-options option').evaluateAll(nodes=>nodes.map(node=>Number(node.value))),[3]);
  await page.locator('#thread-owner-form [name=owner]').fill('2'); await page.locator('#thread-owner-form button.primary').click();
  await page.waitForFunction(()=>!document.querySelector('#thread-owner-dialog').open);
  assert.deepEqual(data.requests.find(r=>r.url==='/threads/1/owner').body,{owner:2});
  assert.equal(data.threads[0].owner,2);
  assert.equal(data.threads[0].created_by,0);
  assert.deepEqual(data.threads[0].members,[0,1]);
  assert.match(await page.locator('#thread-metadata').textContent(),/Owner: #2/);
  await openThreadDetails(page); await page.locator('#thread-history summary').click();
  assert.match(await page.locator('#thread-events').textContent(),/Owner changed: user → agent 2 · by user/);
  assert.equal(data.requests.filter(r=>/\/members(?:\/remove)?$/.test(r.url)).length,0);
}));

test('owner selection loads suggestions without clearing explicit IDs and rejects user or foreign-agent targets', async () => fixture(async (page, data) => {
  data.pageLimit=1; data.agents=[1,2,3].map(id=>({id,project:projectId(1),name:`Worker ${id}`,state:['closed','paused','crashed'][id-1]}));
  data.agents.push({id:4,project:projectId(2),name:'Other project agent',state:'idle'});
  data.agents.push({id:5,project:projectId(1),name:'Replaced agent',state:'replaced'});
  data.threads=[conversation([],{created_by:1})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('#thread-metadata').textContent(),/Owner: #1/);
  await openThreadDetails(page); await page.locator('#change-thread-owner').click();
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
  data.agents=[{id:2,project:projectId(1),name:'Target',state:'idle'}]; data.threads=[conversation([])]; data.ownerFailure=true;
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await openThreadDetails(page); await page.locator('#change-thread-owner').click(); await page.locator('#thread-owner-form [name=owner]').fill('2');
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
  data.agents=[{id:1,project:projectId(1),name:'<img src=x onerror="window.ownerUnsafe=true">',state:'idle'}];
  data.threads=[conversation([],{owner:1,events:[{id:1,at:1,kind:'thread.owner-changed',agent:1,actor:'<script>bad()</script>',details:{from:0,to:1,reason:'<b>new owner</b>'}}]})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('#thread-metadata').textContent(),/Owner: #1 <img/);
  assert.equal(await page.locator('.thread-header img').count(),0);
  await openThreadDetails(page); await page.locator('#thread-history summary').click();
  assert.match(await page.locator('#thread-events').textContent(),/Owner changed: user → agent 1.*<script>bad\(\)<\/script>.*<b>new owner<\/b>/);
  assert.equal(await page.locator('#thread-events script, #thread-events b').count(),0);
  const selected=await selectText(page,'#thread-metadata');
  data.threads[0].owner=2; await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.waitForFunction(()=>document.querySelector('#thread-metadata').textContent.includes('Owner: #2'));
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
  assert.match(await page.locator('#thread-metadata').textContent(),/Owner: unavailable/);
  assert.doesNotMatch(await page.locator('#thread-metadata').textContent(),/Owner: #1|Owner: you/);
  await openThreadDetails(page); await page.locator('#change-thread-owner').click();
  assert.equal(await page.locator('#thread-owner-current').textContent(),'Current owner: unavailable');
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,0);
}));

test('live threads expose escaped membership history and mark outside-membership messages without counting them unread', async () => fixture(async (page, data) => {
  data.threads = [conversation([{...incoming(1,'Before you joined'),outside_membership:true},incoming(2,`Current reply\n${'Retained conversation context.\n'.repeat(30)}`)], {
    watch:['working','idle','group:review'],events_more:true,
    events:[{id:1,at:1,kind:'thread.joined',agent:1,actor:'user',details:{reason:'group <review> matched'}}],
  })];
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.locator('[data-thread="1"]').click();
  await openThreadDetails(page); await page.locator('#thread-history').waitFor();
  assert.equal(await page.locator('#add-thread-members').isHidden(), true);
  assert.equal(await page.locator('#thread-membership').textContent(), 'Leave thread');
  await page.locator('#thread-older').click();
  assert.equal(await page.locator('[data-message="1"] .pill').textContent(), 'Outside your membership');
  assert.equal(await page.locator('[data-message="2"] .pill').count(), 0);
  assert.match(await page.locator('#unread-total').textContent(), /1 unread/);
  await openThreadDetails(page); await page.locator('#thread-history summary').click();
  assert.match(await page.locator('#thread-events').textContent(), /agent 1 joined.*group <review> matched/);
  assert.match(await page.locator('#thread-events').textContent(), /Earlier thread events are not shown/);
  assert.equal(await page.locator('#thread-events review').count(), 0);
  data.threads[0].events.push({id:2,at:2,kind:'thread.left',agent:1,actor:'system',details:{reason:'state changed'}});
  data.threads[0].members = [0];
  await page.evaluate(() => refresh());
  assert.match(await page.locator('#thread-events').textContent(), /agent 1 left.*state changed/);
  assert.equal(await page.locator('#thread-history').evaluate(el=>el.open), true, 'polling preserves the opened history');
  await page.locator('#messages').evaluate(node=>{node.scrollTop=0;});
  await page.evaluate(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); });
  assert.equal(await page.locator('#thread-unread').isVisible(),true,'earlier history does not acknowledge the unread reply');
  await page.locator('#thread-unread').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  assert.equal(data.reads[1], 2);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/read')).length, 1);
  await openThreadDetails(page); await page.locator('#thread-membership').click();
  await page.waitForFunction(() => document.querySelector('#thread-membership').textContent === 'Join thread');
  assert.equal(await page.locator('#add-thread-members').isHidden(), true);
}));

test('prompt guidance is literal and recovery settings persist independently of server settings',async()=>fixture(async(page,data)=> {
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-prompt-editor] summary').click();
  const text='Keep {task}, {updates}, $HOME and <tag> literal.';
  await page.locator('[name=prompt_resume]').fill(text);
  await page.locator('[name=auto_resume]').uncheck();
  await saveSettings(page); await reloadPage(page); await page.locator('[data-page=settings]').click();
  await page.locator('[data-prompt-editor] summary').click();
  assert.equal(await page.locator('[name=prompt_resume]').inputValue(),text);
  assert.equal(data.settings.prompts.resume,text);
  assert.equal(await page.locator('[name=usage_poll_secs]').inputValue(),'120');
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
  data.agents=[{id:1,project:projectId(1),state:'crashed',harness:'codex',model:'gpt-6.1-sol',problem:'Model not supported with this account'}];
  await reloadPage(page); await openLaunch(page); await page.locator('#launch-harness').selectOption('codex');
  assert.equal(await page.locator('#launch-model').inputValue(),'gpt-6.1-sol');
  assert.match(await page.locator('#launch-model-warning').textContent(),/previous launch rejected/);
  await page.locator('#launch-model').selectOption('gpt-6-luna');
  assert.equal(await page.locator('#launch-model-warning').isHidden(),true);
  assert.equal(data.requests.length,0);
}));

test('model errors offer an explicit alternative launch while retaining the original agent',async()=>fixture(async(page,data)=> {
  data.agents=[{id:1,project:projectId(1),name:'Unavailable',state:'crashed',harness:'codex',model:'gpt-6.1-sol',task:'Original task',problem:'Model not supported with this account'}];
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
    {id:1,project:projectId(1),name:'Failed turn',state:'crashed',harness:'codex',model:'gpt-6.1-sol',effort:'high',task:'Continue the original task',problem:'Stream failed: cyber-risk error'},
    {id:2,project:projectId(1),name:'Quota pause',state:'paused',pause_reason:'limit',harness:'codex',model:'gpt-6.1-sol',effort:'high'},
    {id:3,project:projectId(1),name:'Manual pause',state:'paused',pause_reason:'user',harness:'claude',model:'claude-opus-5-5',effort:'medium'},
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
  await page.locator('[data-close=launch-dialog]:not(.dialog-close)').click();
  await crash.locator('[data-action=resume]').click();
  await page.waitForFunction(() => document.querySelector('[data-agent="1"] .pill').textContent === 'working');
  assert.deepEqual(data.requests.at(-1), {url:'/agents/1/resume',method:'POST',body:{}});
  assert.equal(data.agents[0].model, 'gpt-6.1-sol');
}));

test('cancelling member selection preserves a draft only within its project',async()=>fixture(async(page,data)=> {
  data.agents=[{id:1,project:projectId(1),name:'First',state:'working'},{id:2,project:projectId(2),name:'Second',state:'idle'}];
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-open=thread-dialog]').click();
  await page.locator('[name=member][value="1"]').check();
  await page.locator('[name=include_user]').uncheck();
  await page.locator('[data-close=thread-dialog]:not(.dialog-close)').click();
  await page.locator('[data-open=thread-dialog]').click();
  assert.equal(await page.locator('[name=member][value="1"]').isChecked(),true);
  assert.equal(await page.locator('[name=include_user]').isChecked(),false);
  await page.locator('[data-close=thread-dialog]:not(.dialog-close)').click();
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForFunction(()=>document.querySelector('#project-path').textContent==='/projects/other');
  await page.locator('[data-open=thread-dialog]').click();
  assert.equal(await page.locator('[name=member][value="2"]').isChecked(),false);
  assert.equal(await page.locator('[name=include_user]').isChecked(),true);
}));

const incoming = (id, text = `Message ${id}`) => ({ id, sender: 1, text, at: 1 });
const conversation = (messages, extra = {}) => ({ id: 1, project:projectId(1), title: 'Review', members: [0, 1], messages, ...extra });

const submitMessageSearch = async (page,{query,mode='text',scope,sender,from,to,threads}={}) => {
  const form=page.locator('#message-search-form');
  await form.locator('[name=mode]').selectOption(mode);
  if(scope)await form.locator('[name=scope]').selectOption(scope);
  await form.locator('[name=query]').fill(query);
  for(const [name,value] of Object.entries({sender,from,to,threads}))if(value!==undefined) {
    const input=form.locator(`[name=${name}]`);
    if(!await input.isVisible())await input.evaluate(input=>{let parent=input.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}});
    await input.fill(value);
  }
  const response=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/messages/search'));
  await form.evaluate(form=>form.requestSubmit());
  await response;
};

test('message search covers complete project history, distinguishes literal numbers from IDs and never acknowledges previews',async()=>fixture(async(page,data)=>{
  data.pageLimit=2;
  data.threads=[
    conversation([incoming(1,'First matching needle'),incoming(2,'Text containing 83'),incoming(3,'Unrelated latest text')],{id:1,title:'Older conversation'}),
    conversation([incoming(83,'Exact ID target without numeric text'),incoming(84,'Second matching needle')],{id:2,title:'Private conversation',private:true,joinable:false,members:[2]}),
    conversation([incoming(85,'Other project matching needle')],{project:projectId(2)}),
  ];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('#open-message-search').click();
  await submitMessageSearch(page,{query:'needle'});
  await page.locator('[data-message-result="84"]').waitFor();await page.locator('[data-message-result="1"]').waitFor();
  assert.equal(await page.locator('#message-search-results [data-message-result]').count(),2);
  assert.match(await page.locator('#message-search-results').textContent(),/Private conversation.*Older conversation/s);
  assert.equal(await page.locator('#message-search-results [data-message-result="85"]').count(),0,'the other project is excluded');
  assert.deepEqual(data.reads,{});assert.equal(data.requests.length,0,'previews do not join threads, read messages or change marks');
  await submitMessageSearch(page,{query:'83'});await page.locator('[data-message-result="2"]').waitFor();
  assert.equal(await page.locator('[data-message-result="83"]').count(),0,'numeric text is not implicit ID lookup');
  await submitMessageSearch(page,{query:'83',mode:'id'});await page.locator('[data-message-result="83"]').waitFor();
  assert.equal(await page.locator('#message-search-results [data-message-result]').count(),1);
  assert.deepEqual(data.reads,{});assert.equal(data.requests.length,0);
}));

test('message search within a thread preserves the open conversation and its unsent draft until a result is opened',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([]),conversation([incoming(2,'Find matching text')],{id:2,title:'Other thread'})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Retain my unsent draft');await page.locator('#thread-message-search').click();
  assert.equal(await page.locator('#message-search-form [name=scope]').inputValue(),'thread');
  await submitMessageSearch(page,{query:'matching'});
  await page.waitForFunction(()=>/no .*match|0 .*result/i.test(document.querySelector('#message-search-status').textContent+' '+document.querySelector('#message-search-results').textContent));
  assert.equal(await page.evaluate(()=>state.selectedThread),1);
  await submitMessageSearch(page,{query:'matching',scope:'all'});await page.locator('[data-message-result="2"]').waitFor();
  assert.equal(await page.evaluate(()=>state.selectedThread),1,'showing other-thread previews does not switch conversations');
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Retain my unsent draft');
  await page.locator('[data-close-search]').first().click();
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Retain my unsent draft');
  assert.equal(data.requests.length,0);
}));

test('an exact message ID absent from the current thread offers an explicit project-wide lookup without switching threads',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([]),conversation([incoming(83,'Message in the other thread')],{id:2,title:'Other thread'})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Keep this draft');await page.locator('#thread-message-search').click();
  await submitMessageSearch(page,{query:'83',mode:'id'});await page.locator('#message-search-all').waitFor();
  assert.equal(await page.evaluate(()=>state.selectedThread),1);assert.equal(await page.locator('#message-search-results [data-message-result]').count(),0);
  await page.locator('#message-search-all').click();await page.locator('[data-message-result="83"]').waitFor();
  assert.equal(await page.locator('#message-search-form [name=scope]').inputValue(),'all');
  assert.equal(await page.evaluate(()=>state.selectedThread),1,'broadening an ID lookup is not opening the other thread');
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep this draft');assert.equal(data.requests.length,0);
  await page.locator('[data-message-result="83"]').click();await page.locator('#messages [data-message="83"].message-target').waitFor();
  assert.equal(await page.evaluate(()=>state.selectedThread),2);assert.equal(data.reads[2],undefined,'opening historical context still does not acknowledge messages');
}));

test('reopening message search with a different scope clears results and cursors rather than relabeling old matches',async()=>fixture(async(page,data)=>{
  data.pageLimit=2;data.threads=[conversation([]),conversation([incoming(1,'Needle'),incoming(2,'Needle'),incoming(3,'Needle')],{id:2})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();
  await page.locator('#open-message-search').click();await submitMessageSearch(page,{query:'Needle'});await page.locator('[data-message-result="3"]').waitFor();
  assert.equal(await page.locator('#message-search-more').isVisible(),true);
  await page.locator('[data-close-search]').click();await page.locator('#thread-message-search').click();
  assert.equal(await page.locator('#message-search-form [name=scope]').inputValue(),'thread');
  assert.equal(await page.locator('#message-search-results [data-message-result]').count(),0,'global matches are not presented as within-thread matches');
  assert.equal(await page.locator('#message-search-more').isVisible(),false);assert.equal(await page.locator('#message-search-previous').isVisible(),false);
  assert.equal(data.requests.length,0);
}));

test('repeating an identical message search after clearing or reopening renders its matches instead of an empty cached panel',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([incoming(1,'Matching needle')])];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('#open-message-search').click();
  await submitMessageSearch(page,{query:'needle'});await page.locator('[data-message-result="1"]').waitFor();
  await submitMessageSearch(page,{query:'needle'});await page.waitForFunction(()=>!messageSearch.pending);
  assert.equal(await page.locator('[data-message-result="1"]').count(),1,'clearing an input does not leave an obsolete cached HTML equality');
  await page.locator('[data-close-search]').click();await page.locator('#open-message-search').click();
  await submitMessageSearch(page,{query:'needle'});await page.waitForFunction(()=>!messageSearch.pending);
  assert.equal(await page.locator('[data-message-result="1"]').count(),1,'reopening the dialog can render the exact same successful result again');
  assert.equal(data.requests.length,0);
}));

test('case-insensitive search highlighting preserves original Unicode text before and inside each match',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([incoming(1,'İstanbul foo and FOO after dotted İ'),incoming(2,'ΟΣ')])];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('#open-message-search').click();
  await submitMessageSearch(page,{query:'foo'});await page.locator('[data-message-result="1"]').waitFor();
  assert.deepEqual(await page.locator('[data-message-result="1"] mark').allTextContents(),['foo','FOO']);
  assert.equal(await page.locator('[data-message-result="1"] .message-search-snippet').textContent(),'İstanbul foo and FOO after dotted İ');
  await submitMessageSearch(page,{query:'ΟΣ'});await page.locator('[data-message-result="2"]').waitFor();
  assert.deepEqual(await page.locator('[data-message-result="2"] mark').allTextContents(),['ΟΣ'],'context-sensitive lowercase keeps the original Greek final sigma match');
  assert.equal(data.requests.length,0);
}));

test('message search filters sender, dates and selected threads and renders untrusted snippets as text',async()=>fixture(async(page,data)=>{
  const at=Math.floor(new Date('2026-01-02T12:00:00').getTime()/1000);
  data.threads=[
    conversation([{...incoming(1,'Needle <img src=x onerror=alert(1)>'),at,sender:2},{...incoming(2,'Needle wrong sender'),at,sender:1},{...incoming(3,'Needle outside date'),at:at-86400,sender:2}],{id:1,title:'<img src=x onerror=alert(1)> title'}),
    conversation([{...incoming(4,'Needle outside thread'),at,sender:2}],{id:2}),
  ];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('#open-message-search').click();
  await submitMessageSearch(page,{query:'needle',sender:'2',from:'2026-01-02T00:00',to:'2026-01-02T23:59',threads:'1'});
  await page.locator('[data-message-result="1"]').waitFor();
  assert.equal(await page.locator('#message-search-results [data-message-result]').count(),1);
  assert.equal(await page.locator('#message-search-results img').count(),0);
  assert.match(await page.locator('#message-search-results').textContent(),/<img src=x onerror=alert\(1\)>/);
  const query=new URL(data.getRequests.filter(url=>url.startsWith('/messages/search?')).at(-1),'http://test').searchParams;
  assert.equal(query.get('sender'),'2');assert.equal(query.get('threads'),'1');
  assert.equal(Number(query.get('from')),Math.floor(new Date('2026-01-02T00:00').getTime()/1000));
  assert.equal(Number(query.get('to')),Math.floor(new Date('2026-01-02T23:59').getTime()/1000));
  assert.match(await page.locator('#message-search-form details > summary').textContent(),/4 set/);
  await page.locator('#message-search-clear-filters').click();
  for(const name of ['sender','from','to','threads'])assert.equal(await page.locator(`#message-search-form [name=${name}]`).inputValue(),'');
  assert.equal(await page.locator('#message-search-form [name=query]').inputValue(),'needle');
  assert.equal(await page.locator('#message-search-results [data-message-result]').count(),0,'clearing filters invalidates previous results rather than relabeling them');
  await submitMessageSearch(page,{query:'needle'});await page.waitForFunction(()=>document.querySelectorAll('#message-search-results [data-message-result]').length===4);
  assert.doesNotMatch(await page.locator('#message-search-form details > summary').textContent(),/set/);
  assert.equal(data.requests.length,0);
}));

test('message search pages without duplicate results or admitting messages beyond its captured boundary',async()=>fixture(async(page,data)=>{
  data.pageLimit=2;data.threads=[conversation(Array.from({length:7},(_,index)=>incoming(index+1,'Matching needle')))];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('#open-message-search').click();
  await submitMessageSearch(page,{query:'needle'});await page.locator('[data-message-result="7"]').waitFor();
  assert.deepEqual(await page.locator('#message-search-results [data-message-result]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.messageResult))),[7,6]);
  data.threads[0].messages.push(incoming(8,'New matching needle'));
  await page.locator('#message-search-more').click();await page.locator('[data-message-result="5"]').waitFor();
  assert.deepEqual(await page.locator('#message-search-results [data-message-result]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.messageResult))),[5,4]);
  assert.equal(await page.locator('[data-message-result="8"]').count(),0);
  await page.locator('#message-search-previous').click();await page.locator('[data-message-result="7"]').waitFor();
  assert.deepEqual(await page.locator('#message-search-results [data-message-result]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.messageResult))),[7,6]);
  assert.equal(data.requests.length,0);
}));

test('stale message search responses cannot overwrite a newer query or another project',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([incoming(1,'First needle'),incoming(2,'Second needle')]),conversation([incoming(1,'Other project needle')],{project:projectId(2)})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('#open-message-search').click();
  const held=await holdRequest(page,url=>url.pathname==='/messages/search'&&url.searchParams.get('text')==='First','GET');
  await page.locator('#message-search-form [name=query]').fill('First');await page.locator('#message-search-form').evaluate(form=>form.requestSubmit());await held.started;
  await page.locator('#message-search-form [name=query]').fill('Second');await page.locator('#message-search-form').evaluate(form=>form.requestSubmit());
  await page.locator('[data-message-result="2"]').waitFor();held.release();await held.remove();
  assert.equal(await page.locator('[data-message-result="1"]').count(),0);assert.equal(await page.locator('#message-search-form [name=query]').inputValue(),'Second');
  const another=await holdRequest(page,url=>url.pathname==='/messages/search'&&url.searchParams.get('text')==='needle','GET');
  await page.locator('#message-search-form [name=query]').fill('needle');await page.locator('#message-search-form').evaluate(form=>form.requestSubmit());await another.started;
  await page.evaluate(project=>{document.querySelector('#project-select').value=project;document.querySelector('#project-select').dispatchEvent(new Event('change',{bubbles:true}));},projectId(2));
  await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);another.release();await another.remove();
  assert.equal(await page.locator('[data-message-result="2"]').count(),0,'the old project results cannot survive switching scope');
  assert.equal(data.requests.length,0);
}));

test('opening a search result loads exact surrounding history without gaps, duplicates or false read-through',async()=>fixture(async(page,data)=>{
  data.pageLimit=5;data.threads=[conversation(Array.from({length:25},(_,index)=>incoming(index+1)))];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('#open-message-search').click();
  await submitMessageSearch(page,{query:'13',mode:'id'});await page.locator('[data-message-result="13"]').click();
  await page.locator('#messages [data-message="13"].message-target').waitFor();
  const ids=()=>page.locator('#messages [data-message]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.message)));
  assert.deepEqual(await ids(),[11,12,13,14,15]);assert.equal(data.reads[1],undefined);
  await page.locator('#thread-older').click();await page.locator('#messages [data-message="6"]').waitFor();
  assert.deepEqual(await ids(),Array.from({length:10},(_,index)=>index+6));
  await page.locator('#thread-newer').click();await page.locator('#messages [data-message="20"]').waitFor();
  assert.deepEqual(await ids(),Array.from({length:15},(_,index)=>index+6));
  await page.locator('#thread-newer').click();await page.locator('#messages [data-message="25"]').waitFor();
  assert.deepEqual(await ids(),Array.from({length:20},(_,index)=>index+6));
  assert.equal(data.reads[1],undefined,'reaching latest still does not acknowledge omitted unread history');
  data.threads[0].messages.push(incoming(26,'New live arrival'));await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#messages [data-message="26"]').count(),0,'polling does not graft a live gap onto a historical window');
  assert.equal(data.requests.filter(request=>request.url.endsWith('/read')).length,0);
  await page.locator('#thread-live').click();await page.locator('#messages [data-message="26"]').waitFor();
  await page.waitForFunction(()=>state.thread?.last_read===26);
  assert.deepEqual(await ids(),Array.from({length:26},(_,index)=>index+1));
  assert.equal(data.reads[1],26);
}));

test('an oversized exact search target hydrates losslessly before copying without acknowledging the historical window',async()=>fixture(async(page,data)=>{
  const text='Long Unicode history 🙂 é\n'.repeat(4500);
  data.threads=[conversation([incoming(1),incoming(2,text),incoming(3)])];
  await manualPolling(page);await reloadPage(page);await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('[data-page=threads]').click();await page.locator('#open-message-search').click();await submitMessageSearch(page,{query:'2',mode:'id'});
  await page.locator('[data-message-result="2"]').click();await page.locator('#messages [data-message="2"].message-target').waitFor();
  assert.equal(await page.locator('[data-message="2"] .message-text').textContent(),text);
  await page.locator('[data-copy-message="2"]').click();await page.waitForFunction(text=>navigator.clipboard.readText().then(value=>value===text),text);
  assert.ok(data.getRequests.some(url=>url.startsWith('/messages/2?')&&new URL(url,'http://test').searchParams.has('offset')));
  assert.equal(data.requests.filter(request=>request.url.endsWith('/read')).length,0);
}));

test('persisted message IDs, copy references and deep links remain distinct from raw message copying and local send IDs',async()=>fixture(async(page,data)=>{
  const source='**Original markdown**\nExact trailing spaces.  ';
  data.threads=[conversation([incoming(1,source)])];data.reads[1]=1;
  await manualPolling(page);await reloadPage(page);await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('[data-message="1"] [data-message-id]').textContent(),/#1/);
  await page.locator('[data-copy-message="1"]').click();
  await page.waitForFunction(text=>navigator.clipboard.readText().then(value=>value===text),source);
  await page.locator('[data-copy-message-reference="1"]').click();
  await page.waitForFunction(()=>navigator.clipboard.readText().then(value=>/thread #1/i.test(value)&&/message #1/i.test(value)));
  await page.locator('[data-copy-message-link="1"]').click();
  await page.waitForFunction(()=>navigator.clipboard.readText().then(value=>/^https?:/.test(value)));
  const link=await page.evaluate(()=>navigator.clipboard.readText());const url=new URL(link);
  assert.equal(url.searchParams.get('project'),projectId(1));assert.equal(url.searchParams.get('thread'),'1');assert.equal(url.searchParams.get('message'),'1');
  const held=await holdRequest(page,'**/messages');await page.locator('#message-form textarea').fill('Pending reply');await page.locator('#message-form button').click();await held.started;
  const pending=page.locator('[data-pending-message]');await pending.waitFor();
  assert.equal(await pending.locator('[data-message-id],[data-copy-message-reference],[data-copy-message-link]').count(),0,'local attempt IDs are never exposed as persisted references');
  held.release();await held.remove();await page.locator('[data-message="2"] [data-message-id]').waitFor();
  await page.goto(link);await page.waitForFunction(()=>state.selectedThread===1&&document.querySelector('#messages [data-message="1"].message-target'));
  assert.equal(await page.locator('#page-threads').evaluate(node=>node.classList.contains('active')),true);
  assert.match(await page.locator('#messages [data-message="1"] .message-text').textContent(),/Original markdown\nExact trailing spaces\./);
}));

test('thread title, exact ID and all-or-any member filters apply to the entire collection before paging',async()=>fixture(async(page,data)=>{
  data.pageLimit=2;data.agents=[1,2,3].map(id=>({id,project:projectId(1),name:`Reviewer ${id}`,state:'idle'}));
  data.threads=[conversation([],{id:1,title:'Old needle',members:[0,1,2]}),conversation([],{id:2,title:'Recent 17 title',members:[0,1]}),conversation([],{id:3,title:'Another recent',members:[0,2]}),conversation([],{id:17,title:'Exact thread',members:[0,3]})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();
  await page.locator('#thread-search').fill('needle');await page.locator('#thread-list [data-thread="1"]').waitFor();
  assert.equal(await page.locator('#thread-list [data-thread]').count(),1);assert.equal(await page.locator('#thread-count').textContent(),'1');
  await page.locator('#thread-search').fill('17');await page.locator('#thread-list [data-thread="2"]').waitFor();
  assert.equal(await page.locator('#thread-list [data-thread="17"]').count(),0,'title text remains a literal title search');
  await page.locator('#thread-search-filters > summary').click();await page.locator('#thread-search-id').fill('17');
  await page.locator('#thread-list [data-thread="17"]').waitFor();assert.equal(await page.locator('#thread-search').inputValue(),'');
  assert.match(await page.locator('#thread-search-filters > summary').textContent(),/1 active/);
  await page.locator('#thread-search-id').fill('');await page.locator('#thread-member-filter').fill('1,2');
  await page.locator('#thread-list [data-thread="1"]').waitFor();assert.equal(await page.locator('#thread-count').textContent(),'1');
  await page.locator('#thread-member-match').selectOption('any');await page.waitForFunction(()=>document.querySelector('#thread-count').textContent==='3');
  assert.equal(await page.locator('#thread-list [data-thread="17"]').count(),0);
  const query=new URL(data.getRequests.filter(url=>url.startsWith('/threads?')).at(-1),'http://test').searchParams;
  assert.equal(query.get('members'),'1,2');assert.equal(query.get('member_match'),'any');
  assert.equal(data.requests.length,0);
}));

test('agent details page current thread memberships and View all opens an exact server member filter',async()=>fixture(async(page,data)=>{
  data.pageLimit=2;data.agents=[{id:1,project:projectId(1),name:'Reviewer',state:'idle'}];
  data.threads=[conversation([],{id:1,title:'One'}),conversation([],{id:2,title:'Two'}),conversation([],{id:3,title:'Three'}),conversation([],{id:4,title:'Former membership',members:[0,2]})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-action=details]').click();
  await page.locator('#agent-threads > summary').click();await page.locator('#agent-threads-items [data-agent-thread]').first().waitFor();
  assert.equal(await page.locator('#agent-threads-items [data-agent-thread]').count(),2);
  assert.match(await page.locator('#agent-threads > summary').textContent(),/3/);
  await page.locator('#agent-threads-more').click();await page.waitForFunction(()=>document.querySelectorAll('#agent-threads-items [data-agent-thread]').length===3);
  assert.doesNotMatch(await page.locator('#agent-threads-items').textContent(),/Former membership/);
  await page.locator('#agent-threads-view-all').click();await page.waitForFunction(()=>document.querySelector('#page-threads').classList.contains('active')&&document.querySelector('#thread-count').textContent==='3');
  assert.equal(await page.locator('#agent-dialog').evaluate(dialog=>dialog.open),false);
  assert.equal(await page.locator('#thread-member-filter').inputValue(),'1');
  assert.equal(await page.locator('[data-thread-filter=all]').getAttribute('aria-pressed'),'true');
  const query=new URL(data.getRequests.filter(url=>url.startsWith('/threads?')).at(-1),'http://test').searchParams;
  assert.equal(query.get('members'),'1');assert.equal(query.get('category'),'all');
  assert.equal(data.requests.length,0);
}));

test('reopening agent details can render unchanged thread memberships after the previous panel was cleared',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Reviewer',state:'idle'}];data.threads=[conversation([])];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-action=details]').click();await page.locator('#agent-threads > summary').click();await page.locator('#agent-threads-items [data-agent-thread="1"]').waitFor();
  await page.locator('#agent-dialog .dialog-close').click();await page.locator('[data-action=details]').click();await page.locator('#agent-threads > summary').click();
  await page.waitForFunction(()=>agentThreads&&!agentThreads.pending);
  assert.equal(await page.locator('#agent-threads-items [data-agent-thread="1"]').count(),1);
  assert.match(await page.locator('#agent-threads > summary').textContent(),/1/);assert.equal(data.requests.length,0);
}));

test('a delayed agent membership page is revalidated after the project thread revision changes',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Reviewer',state:'idle'}];
  data.threads=[conversation([],{id:1,title:'Original membership'}),conversation([],{id:2,title:'New membership',members:[0,2]})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-action=details]').click();
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const matcher=url=>url.pathname.endsWith('/threads')&&url.searchParams.get('members')==='1';
  const handler=async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response}).catch(()=>{});};
  await page.route(matcher,handler);await page.locator('#agent-threads > summary').click();await started;
  data.threads[1].members.push(1);await page.evaluate(()=>refresh());
  release();await page.locator('#agent-threads-items [data-agent-thread="1"]').waitFor();await page.unroute(matcher,handler);
  await page.evaluate(()=>refresh());await page.locator('#agent-threads-items [data-agent-thread="2"]').waitFor();
  assert.equal(await page.locator('#agent-threads-items [data-agent-thread]').count(),2);
  assert.match(await page.locator('#agent-threads > summary').textContent(),/2/);
  assert.equal(data.requests.length,0);
}));

for(const change of ['project','filter'])test(`a failed read-triggered unread-list refresh cannot overwrite a newer ${change} scope`,async()=>fixture(async(page,data)=>{
  data.threads=[conversation([incoming(1)]),conversation([],{project:projectId(2),title:'Other project'})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread-filter=unread]').click();await page.locator('[data-thread="1"]').waitFor();
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const matcher=url=>url.pathname===`/p/${projectId(1)}/threads`&&url.searchParams.get('category')==='unread';
  const handler=async route=>{entered();await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Old unread scope offline'})}).catch(()=>{});};
  await page.route(matcher,handler);await page.locator('[data-thread="1"]').click();await started;
  await page.evaluate(()=>{window.oldUnreadReload=state.pages.threads.pending;});
  if(change==='project') {await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);}
  else {await page.locator('[data-thread-filter=all]').click();await page.waitForFunction(()=>state.pages.threads?.scope===collectionPath('threads')&&!state.pages.threads.pending);}
  release();await page.evaluate(()=>window.oldUnreadReload?.catch(()=>{}));await page.unroute(matcher,handler);
  assert.doesNotMatch(await page.locator('#thread-sort-status').textContent(),/Old unread scope offline/);
  assert.equal(await page.evaluate(()=>state.threadFilterError||null),null,'an old failed reload does not label current results invalid');
}));

test('changing member filters rejects stale pages and retains an open thread draft and text selection',async()=>fixture(async(page,data)=>{
  data.agents=[1,2].map(id=>({id,project:projectId(1),name:`Reviewer ${id}`,state:'idle'}));
  data.threads=[conversation([incoming(1,'Retain selected message text')],{id:1,members:[0,1]}),conversation([],{id:2,members:[0,2]})];data.reads[1]=1;
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Keep my draft');
  await page.locator('#thread-search-filters > summary').click();
  const held=await holdRequest(page,url=>url.pathname==='/threads'&&url.searchParams.get('members')==='1','GET');
  await page.locator('#thread-member-filter').fill('1');await held.started;
  const next=await holdRequest(page,url=>url.pathname==='/threads'&&url.searchParams.get('members')==='2','GET');
  await page.locator('#thread-member-filter').fill('2');await next.started;
  const selection=await selectText(page,'[data-message="1"] .message-text');next.release();await next.remove();
  await page.locator('#thread-list [data-thread="2"]').waitFor();await page.waitForFunction(()=>document.querySelectorAll('#thread-list [data-thread]').length===1);held.release();await held.remove();
  assert.equal(await page.locator('#thread-list [data-thread="1"]').count(),0);
  assert.equal(await page.evaluate(()=>state.selectedThread),1);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep my draft');
  assert.equal(await page.evaluate(()=>getSelection().toString()),selection);
  await page.locator('#thread-filter-member-search').fill('Reviewer 1');
  await page.locator('#thread-filter-members-picker [data-thread-member="1"]').waitFor();
  await page.locator('#thread-filter-members-picker [data-thread-member="1"]').check();
  await page.waitForFunction(()=>document.querySelector('#thread-member-filter').value==='1,2');
  assert.equal(data.requests.length,0);
}));

test('visual member selections clear with the CSV filter and never carry a checked user into another project',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([],{members:[0]}),conversation([],{project:projectId(2),members:[0]})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('#thread-search-filters > summary').click();
  await page.waitForFunction(()=>threadMemberPage&&!threadMemberPage.pending);
  const user=page.locator('#thread-filter-members-picker [data-thread-member="0"]');
  await user.check();assert.equal(await page.locator('#thread-member-filter').inputValue(),'0');
  await page.locator('#thread-member-filter').fill('');await page.waitForFunction(()=>!document.querySelector('#thread-filter-members-picker [data-thread-member="0"]').checked);
  assert.equal(await user.isChecked(),false);
  await user.check();assert.equal(await page.locator('#thread-member-filter').inputValue(),'0');
  await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
  assert.equal(await page.locator('#thread-member-filter').inputValue(),'');assert.equal(await user.isChecked(),false);
  assert.equal(data.requests.length,0);
}));

for(const width of [1600,390,320])test(`thread and message search remain usable at ${width}px with bounded controls and rich results`,async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Reviewer with a long readable name',state:'idle'}];
  data.threads=[conversation([incoming(1,'Search needle with aVeryLongUnbrokenToken'.repeat(10))],{title:'Review with a long readable conversation title'})];data.reads[1]=1;
  await manualPolling(page);await page.setViewportSize({width,height:900});await reloadPage(page);await openSidebar(page);await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('#thread-search-filters').evaluate(details=>details.open),false,'advanced member controls start collapsed');
  await page.locator('#thread-search-filters > summary').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#open-message-search').click();await submitMessageSearch(page,{query:'needle'});await page.locator('[data-message-result="1"]').waitFor();
  const bounds=await page.locator('#message-search-dialog').evaluate(dialog=>({width:dialog.getBoundingClientRect().width,height:dialog.getBoundingClientRect().height,overflow:dialog.scrollWidth>dialog.clientWidth,viewportWidth:innerWidth,viewportHeight:innerHeight}));
  assert.ok(bounds.width<=bounds.viewportWidth&&bounds.height<=bounds.viewportHeight);assert.equal(bounds.overflow,false,'long snippets wrap inside the dialog');
  assert.ok(await page.locator('#message-search-results').getAttribute('aria-label'));
  assert.equal(data.requests.length,0);
  if(process.env.ACOM_UI_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.ACOM_UI_SCREENSHOT_DIR,{recursive:true});
    await page.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,`message-search-${width}.png`)});
  }
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#message-search-dialog').open);
  await page.locator('#thread-search-filters > summary').click();await page.locator('[data-thread="1"]').click();await page.locator('[data-message="1"]').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'persisted message reference controls fit the conversation');
  if(process.env.ACOM_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,`message-reference-${width}.png`)});
  if(width===320) {
    await page.emulateMedia({colorScheme:'dark'});await page.locator('#thread-message-search').click();await submitMessageSearch(page,{query:'needle'});await page.waitForFunction(()=>!messageSearch.pending);
    assert.equal(await page.locator('[data-message-result="1"]').count(),1,'reopening search in dark mode still renders unchanged matches');
    assert.equal(await page.locator('#message-search-results mark').count()>0,true);
    assert.equal(await page.locator('#message-search-dialog').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth),true);
    if(process.env.ACOM_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,'message-search-dark-320.png')});
  }
}));

test('unread badges span projects, exclude own and agent-only messages, and persist across reloads', async () => fixture(async (page, data) => {
  data.threads = [
    conversation([incoming(1), { ...incoming(2), sender: 0 }]),
    conversation([incoming(3)], { id: 2, project:projectId(2) }),
    conversation([incoming(4)], { id: 3, members: [1] }),
  ];
  await reloadPage(page);
  await page.waitForFunction(() => document.querySelector('#unread-total').textContent === '2 unread');
  await page.setViewportSize({width:375,height:800});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.match(await page.title(), /^\(2\)/);
  assert.match(await page.locator(`#project-select option[value="${projectId(2)}"]`).textContent(), /1 unread/);
  await openSidebar(page);
  await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread-filter=unread]').click();
  assert.equal(await page.locator('.thread-row').count(), 1);
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').textContent === '1 unread');
  assert.equal(data.reads[1], 2);
  assert.equal(await page.locator('.thread-row').count(), 0);
  await reloadPage(page);
  await openSidebar(page);
  await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('.thread-row').count(), 0);
  assert.equal(data.reads[2], undefined);
  await openSidebar(page);
  await page.locator('#project-select').selectOption(projectId(2));
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
  assert.equal(await page.locator('#thread-main .empty strong').textContent(), 'Select a thread');
  assert.equal(await page.locator('.thread-row.active').count(), 0);
  assert.deepEqual(data.threads[0].members, [0, 1]);
  assert.equal(data.reads[1], 1, 'closing does not undo an acknowledged read');
  const readsBefore = data.requests.filter(r => r.url.endsWith('/read')).length;
  data.threads[0].messages.push(incoming(2, 'After closing'));
  // Normal polling updates badges, but must not reopen or acknowledge the thread.
  await page.waitForFunction(() => document.querySelector('#unread-total').textContent === '1 unread');
  await page.waitForTimeout(2100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await page.locator('#thread-main .empty strong').textContent(), 'Select a thread');
  assert.equal(data.reads[1], 1);
  assert.equal(data.requests.filter(r => r.url.endsWith('/read')).length, readsBefore);
  assert.equal(data.requests.filter(r => r.url.endsWith('/user')).length, 0, 'Close is not Leave');
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').hidden);
  assert.equal(data.reads[1], 2);
  assert.equal(await page.locator('[data-message="2"] .message-text').textContent(), 'After closing');
}));

test('X dismissal preserves separate thread and project drafts across switching and reload without confirmation', async () => fixture(async (page, data) => {
  data.threads = [conversation([]), conversation([], {id:2,title:'Other thread'}), conversation([], {id:3,project:projectId(2),title:'Other project'})];
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
  assert.equal(await page.locator('#thread-main .empty strong').textContent(), 'Select a thread');
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Keep my draft');
  await page.locator('#project-select').selectOption(projectId(2));
  await page.locator('[data-thread="3"]').click();
  await page.locator('#message-form textarea').fill('Other project draft');
  await reloadPage(page); await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('#thread-main .empty strong').textContent(), 'Select a thread');
  await page.locator('[data-thread="3"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'Other project draft');
  await page.locator('#project-select').selectOption(projectId(1));
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
  const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/messages'));
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
  const secondResponse = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/messages'));
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
  assert.match(await page.locator('#toast').textContent(), /browser storage is unavailable/i);
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
  const pending = page.waitForRequest(r => new URL(r.url()).pathname.endsWith('/threads/1/messages'));
  await page.evaluate(() => { window.pendingThread = refreshThread(); });
  await pending;
  await page.locator('#close-thread').click();
  release();
  await page.evaluate(async () => { await window.pendingThread; });
  await page.unroute(threadPattern);
  await page.evaluate(() => refresh());
  assert.equal(await page.locator('#thread-main .empty strong').textContent(), 'Select a thread');
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
  await page.locator('[data-close=thread-dialog]:not(.dialog-close)').click();
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

test('agent tokens distinguish unreported counts from measured zero in Overview and Details', async () => fixture(async (page,data) => {
  data.agents=[
    {id:1,project:projectId(1),name:'Starting worker',state:'working',token_usage_state:'unknown',total_tokens:null,fresh_in:null,cache_write:null,cache_read:null,output:null,token_usage_updated_at:null},
    {id:2,project:projectId(1),name:'Zero usage',state:'idle',token_usage_state:'final',total_tokens:0,fresh_in:0,cache_write:0,cache_read:0,output:0,token_usage_updated_at:1720000000},
  ];
  await manualPolling(page); await reloadPage(page);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Total tokens: —.*Not reported/);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/context —/,'an absent context count is not measured zero');
  assert.match(await page.locator('[data-agent="2"]').textContent(),/Total tokens: 0.*Finalised/);
  await page.locator('[data-agent="1"] [data-action=details]').click();
  await page.locator('#agent-field-total_tokens').waitFor();
  assert.equal(await page.locator('dt[data-key="total_tokens"]').textContent(),'Total tokens');
  assert.equal(await page.locator('#agent-field-token_usage').textContent(),'Not reported');
  for(const key of ['total_tokens','fresh_in','cache_write','cache_read','output'])assert.equal(await page.locator(`#agent-field-${key}`).textContent(),'—',`${key} remains unavailable`);
  assert.equal(await page.locator('dt[data-key="token_usage_state"], dt[data-key="token_usage_updated_at"]').count(),0,'raw reporting metadata is not duplicated');
  await page.locator('#agent-dialog button[value=cancel]').click();
  await page.locator('[data-agent="2"] [data-action=details]').click();
  await page.locator('#agent-field-total_tokens').waitFor();
  assert.equal(await page.locator('#agent-field-token_usage').textContent(),'Finalised');
  for(const key of ['total_tokens','fresh_in','cache_write','cache_read','output'])assert.equal(await page.locator(`#agent-field-${key}`).textContent(),'0',`${key} can be an explicitly reported zero`);
}));

test('live token counts reconcile to reported totals and retain partial status without resetting selections', async () => fixture(async (page,data) => {
  const task='Review the synthetic example without replacing this selected task.';
  data.agents=[{id:1,project:projectId(1),name:'Worker',state:'working',task,token_usage_state:'provisional',total_tokens:null,fresh_in:1000,cache_write:2000,cache_read:3000,output:null,token_usage_updated_at:1720000000}];
  await manualPolling(page); await reloadPage(page);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Total tokens: —.*In progress \(provisional\)/,'known input alone does not invent a total');
  await page.locator('[data-agent="1"] [data-action=details]').click();
  await page.locator('#agent-field-fresh_in').waitFor();
  assert.equal(await page.locator('#agent-field-fresh_in').textContent(),'1,000');
  assert.equal(await page.locator('#agent-field-output').textContent(),'—');
  const selected=await selectText(page,'#agent-field-task');
  Object.assign(data.agents[0],{output:4,total_tokens:6004}); await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'6,004');
  assert.equal(await page.locator('#agent-field-output').textContent(),'4');
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>document.querySelector('#agent-field-task')===window.selectedNode),true);
  Object.assign(data.agents[0],{state:'idle',token_usage_state:'final',fresh_in:800,cache_write:1800,cache_read:2800,total_tokens:5404}); await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'5,404','an authoritative total replaces the provisional value rather than accumulating it');
  assert.equal(await page.locator('#agent-field-token_usage').textContent(),'Finalised');
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Total tokens: 5,404.*Finalised/);
  Object.assign(data.agents[0],{state:'crashed',token_usage_state:'partial',fresh_in:900,total_tokens:5504}); await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'5,504');
  assert.equal(await page.locator('#agent-field-token_usage').textContent(),'Partial (incomplete)');
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Total tokens: 5,504.*Partial \(incomplete\)/);
  assert.equal(await page.evaluate(()=>getSelection().toString()),task);
  assert.equal(await page.locator('dt[data-key="fresh_in"]').textContent(),'Fresh input');
  assert.equal(await page.locator('dt[data-key="cache_write"]').textContent(),'Cache writes');
  assert.equal(await page.locator('dt[data-key="cache_read"]').textContent(),'Cache reads');
}));

test('absent token metadata never invents a total from an incomplete breakdown', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Incomplete worker',state:'paused',fresh_in:7,cache_write:0,output:3}];
  await manualPolling(page); await reloadPage(page);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Total tokens: —.*Not reported/);
  await page.locator('[data-agent="1"] [data-action=details]').click(); await page.locator('#agent-field-total_tokens').waitFor();
  assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'—');
  assert.equal(await page.locator('#agent-field-fresh_in').textContent(),'7');
  assert.equal(await page.locator('#agent-field-cache_write').textContent(),'0');
  assert.equal(await page.locator('#agent-field-cache_read').textContent(),'—');
}));

test('per-field token evidence preserves zero and partial snapshots without inventing missing counts',async()=>fixture(async(page,data)=>{
  const evidence={total_tokens:tokenFieldReport(35,true),fresh_in:tokenFieldReport(0,true),cache_write:tokenFieldReport(0),cache_read:tokenFieldReport(null,true),output:tokenFieldReport(3,true)};
  data.agents=[{id:1,project:projectId(1),name:'Partial token worker',state:'working',task:'Synthetic task',token_usage_state:'partial',total_tokens:null,fresh_in:null,cache_write:0,cache_read:null,output:3,token_usage_last_total:{tokens:999,at:1720000000},token_usage_fields:evidence}];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-action=details]').click();await page.locator('#agent-field-fresh_in').waitFor();
  assert.equal(await page.locator('#agent-field-token_usage').textContent(),'Partial (incomplete)');
  for(const [key,value]of Object.entries({total_tokens:'35',fresh_in:'0',cache_write:'0',cache_read:'—',output:'3'}))assert.equal(await page.locator(`#agent-field-${key}`).textContent(),value,key);
  assert.equal(await page.locator('#agent-field-fresh_in .last-known.refreshing').textContent(),'0');
  assert.match(await page.locator('#agent-field-fresh_in .token-value').getAttribute('aria-label'),/Last known fresh input.*Awaiting update/);
  assert.equal(await page.locator('#agent-field-output .refreshing:not(.last-known)').textContent(),'3','an observed current count can be awaiting a later update without being incomplete');
  assert.equal(await page.locator('#agent-field-cache_read .refreshing').count(),0,'a missing observation is not fabricated as a loading zero');
  assert.equal(await page.locator('#agent-field-cache_write .refreshing').count(),0,'freshness follows this field rather than the agent state');
  assert.doesNotMatch(await page.locator('#agent-field-total_tokens').textContent(),/999/,'obsolete aggregate metadata cannot override per-field evidence');
  data.agents[0].state='idle';for(const field of Object.values(evidence))field.awaiting_update=false;
  Object.assign(data.agents[0],{fresh_in:5,output:null});evidence.fresh_in=tokenFieldReport(5,false,1720000010);evidence.output=tokenFieldReport(7,false,1720000010);
  await page.evaluate(()=>refresh());assert.equal(await page.locator('#agent-field-fresh_in').textContent(),'5');assert.equal(await page.locator('#agent-field-output .last-known').textContent(),'7');assert.equal(await page.locator('#agent-details .refreshing').count(),0);
}));

test('last known token totals remain visible while a newer report is incomplete', async () => fixture(async (page,data) => {
  const task='Keep this synthetic task selected while token reports update.';
  data.agents=[{id:1,project:projectId(1),name:'Worker',state:'idle',task,token_usage_state:'final',total_tokens:1000,fresh_in:900,cache_write:0,cache_read:0,output:100,token_usage_fields:{total_tokens:tokenFieldReport(1000)}}];
  await manualPolling(page); await reloadPage(page);
  await page.locator('[data-agent="1"] [data-action=details]').click();
  await page.locator('#agent-field-total_tokens').waitFor();
  const selected=await selectText(page,'#agent-field-task');
  Object.assign(data.agents[0],{state:'working',token_usage_state:'provisional',total_tokens:null,fresh_in:1100,output:null,token_usage_fields:{total_tokens:tokenFieldReport(1000,true)}});
  await page.evaluate(()=>refresh());
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Total tokens: 1,000/,'a missing current total does not erase the latest observed total');
  assert.equal(await page.locator('[data-agent="1"] .token-value.refreshing').textContent(),'1,000');
  assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'1,000');
  assert.match(await page.locator('#agent-field-total_tokens .token-value').getAttribute('aria-label'),/Last known.*Awaiting update/);
  assert.equal(await page.locator('#agent-field-output').textContent(),'—','a field without an observed snapshot remains unavailable');
  assert.equal(await page.locator('#agent-field-fresh_in').textContent(),'1,100');
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>document.querySelector('#agent-field-task')===window.selectedNode),true);
  await reloadPage(page);
  assert.equal(await page.locator('[data-agent="1"] .token-value.refreshing').textContent(),'1,000','the snapshot comes from the API, not an ephemeral page cache');
  await page.locator('[data-agent="1"] [data-action=details]').click();
  await page.locator('#agent-field-total_tokens').waitFor();
  await selectText(page,'#agent-field-task');
  Object.assign(data.agents[0],{total_tokens:1204,output:104,token_usage_fields:{total_tokens:tokenFieldReport(1204,true,1720000010)}});
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'1,204');
  assert.doesNotMatch(await page.locator('[data-agent="1"]').textContent(),/Last known|Awaiting update/,'a live numeric report replaces the fallback');
  Object.assign(data.agents[0],{state:'idle',token_usage_state:'final',total_tokens:900,fresh_in:800,output:100,token_usage_fields:{total_tokens:tokenFieldReport(900,false,1720000020)}});
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'900','a lower authoritative total is not clamped to an earlier provisional snapshot');
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Total tokens: 900.*Finalised/);
  assert.equal(await page.evaluate(()=>getSelection().toString()),task);
}));

test('last known zero totals survive compact previews without implying paused agents are loading', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Large synthetic worker '.repeat(1500),state:'working',task:'Synthetic task',token_usage_state:'partial',total_tokens:null,fresh_in:50,cache_write:null,cache_read:null,output:null,token_usage_fields:{total_tokens:tokenFieldReport(0,true)}}];
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('[data-agent="1"] .token-value.refreshing').textContent(),'0','the bounded preview retains an explicitly observed zero snapshot');
  assert.equal(data.detailRequests.length,0,'showing the snapshot does not hydrate the full record');
  await page.locator('[data-agent="1"] [data-action=details]').click();
  await page.locator('#agent-field-total_tokens').waitFor();
  assert.equal(await page.locator('#agent-field-total_tokens .token-value.refreshing').textContent(),'0');
  assert.equal(await page.locator('#agent-field-token_usage').textContent(),'Partial (incomplete)','last known is not a claim of complete accounting');
  for(const key of ['cache_write','cache_read','output'])assert.equal(await page.locator(`#agent-field-${key}`).textContent(),'—',`${key} is not fabricated from the snapshot`);
  Object.assign(data.agents[0],{total_tokens:10,token_usage_fields:{total_tokens:tokenFieldReport(30,false,1720000010)}});
  for(const state of ['paused','crashed','idle']) {
    data.agents[0].state=state; await page.evaluate(()=>refresh());
    assert.equal(await page.locator('[data-agent="1"] .token-value.last-known').textContent(),'30','a folded partial count does not erase a more recent observed total');
    assert.equal(await page.locator('[data-agent="1"] .token-value.refreshing').count(),0,`${state} is not shown as actively awaiting a report`);
    assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'30');
    assert.equal(await page.locator('#agent-field-total_tokens .refreshing').count(),0);
  }
  Object.assign(data.agents[0],{state:'working',total_tokens:0,token_usage_fields:{total_tokens:tokenFieldReport(0,true,1720000020)}}); await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'0','an actual zero takes precedence over a fallback snapshot');
  assert.doesNotMatch(await page.locator('[data-agent="1"]').textContent(),/Last known|Awaiting update/);
}));

for(const width of [375,320])test(`last known token totals and their update cue stay visible at ${width}px`, async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Worker',state:'working',task:'Synthetic task',token_usage_state:'provisional',total_tokens:null,token_usage_fields:{total_tokens:tokenFieldReport(1000,true)}}];
  await manualPolling(page); await page.setViewportSize({width,height:812}); await reloadPage(page);
  const row=page.locator('[data-agent="1"]'); await row.scrollIntoViewIfNeeded();
  const geometry=await row.evaluate(row=>{
    const meta=[...row.querySelectorAll('.meta')].find(el=>el.textContent.startsWith('Total tokens:'));
    const note=meta.querySelector('.token-value'),number=document.createRange(); number.selectNodeContents(note);
    const rect=el=>{const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
    return {meta:rect(meta),number:rect(number),note:rect(note),text:meta.textContent,title:note.title,pageWidth:document.documentElement.scrollWidth};
  });
  assert.match(geometry.text,/Total tokens: 1,000/);
  assert.match(geometry.title,/Last known total at/,'the observed timestamp is available without widening the card');
  for(const key of ['number','note']) {
    assert.ok(geometry[key].left>=geometry.meta.left-1&&geometry[key].right<=geometry.meta.right+1,`${key} is not horizontally clipped`);
    assert.ok(geometry[key].top>=geometry.meta.top-1&&geometry[key].bottom<=geometry.meta.bottom+1,`${key} is not vertically clipped`);
  }
  assert.ok(geometry.pageWidth<=width,'the total and cue do not widen the page');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await row.locator('.token-value').evaluate(node=>getComputedStyle(node).animationName),'none','reduced-motion users retain a static freshness cue');
}));

test('open details update status and logs, preserve history scroll and recover from errors', async () => fixture(async (page, data) => {
  data.agents = [{ id: 1, project:projectId(1), name: 'Worker', state: 'working', status: 'Starting', locks: [], lost_locks: [] }];
  data.agentLogs[1] = Array.from({ length: 80 }, (_, i) => `Line ${i}`);
  await reloadPage(page); await page.locator('[data-action=details]').click();
  await page.waitForFunction(() => document.querySelector('#agent-detail-status').textContent.startsWith('Live'));
  assert.equal(await page.locator('#agent-log').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 20), true);
  await page.locator('#agent-log').evaluate(el => { el.scrollTop = 35; });
  data.delays = {[projectId(1)]:3000}; // Details must not wait for a slow overview response.
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
  data.agents = [1, 2].map(id => ({ id, project:projectId(1), name: `Worker ${id}`, state: 'working' }));
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

test('Claude windows display and save independent canonical thresholds', async () => fixture(async (page, data) => {
  data.settings.limits.usage.claude_five_hour = {soft:50,hard:90};
  data.settings.limits.usage.claude_seven_day = {soft:60,hard:90};
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

test('maximum lock TTL is required, positive and persists', async () => fixture(async (page, data) => {
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
  assert.match(await form.locator('label:has([name=allow_agent_model_change])').textContent(),/including cross-provider replacement/);
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

test('Fable weekly usage has an independent meter and threshold', async () => fixture(async (page, data) => {
  data.settings.limits.usage.claude_seven_day = {soft:50,hard:90};
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
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'ultra'}];
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
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',harness:'codex',model:'gpt-6-luna',effort:'max',running_configuration:{model:'gpt-6.1-sol',effort:'ultra'}}];
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
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
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
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
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
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
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
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
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
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'crashed',harness:'claude',model:'claude-opus-5-5',effort:'medium',retry:{source:'claude-opus-5-5',handled:0,replacement:null,blocked:null,same_model_attempts:1,effort:'medium',eligible_at:Date.now()/1000+120}}];
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
    {id:1,project:projectId(1),name:'Predecessor',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high',replacement_request:{harness:'claude',model:'claude-sonnet-5-5',blocked:null}},
    {id:2,project:projectId(1),name:'Old recovery target',state:'closed',harness:'claude',model:'claude-haiku-5-5',effort:'medium'},
    {id:3,project:projectId(1),name:'Successor',state:'working',harness:'claude',model:'claude-sonnet-5-5',effort:'high'},
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
    {id:1,project:projectId(1),name:'Predecessor',state:'replaced',harness:'codex',model:'gpt-6.1-sol',effort:'high',conversation_history:'/history/old.jsonl',output_log:'/logs/old.jsonl',retry:{source:'gpt-6.1-sol',handled:1,replacement:2,blocked:null,same_model_attempts:0,effort:'high'}},
    {id:2,project:projectId(1),name:'Replacement',state:'working',harness:'claude',model:'claude-sonnet-5-5',effort:'high'},
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
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high',task,fresh_in:1}];
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
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',task:'Review "quotes" & escapes',status:'Starting'}];
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
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForFunction(() => document.querySelector('#project-path').textContent === '/projects/other');
  assert.equal(await page.locator('#project-select').inputValue(), projectId(2), 'explicit navigation does not retain stale selected-project content');
}));

test('selected agent, lock and activity regions defer only their changes and flush the latest value on deselection', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',status:'Initial status'}];
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
  await openThreadDetails(page); await page.locator('#thread-history summary').click();
  for (const selector of ['#thread-list strong','.thread-header h2','#thread-metadata','#thread-events .event > div']) {
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

test('workspace expands with the viewport and sidebar collapse preserves conversation state', async () => fixture(async (page,data) => {
  data.threads=[conversation([incoming(1,'Select this reply without losing the draft.')])];
  await manualPolling(page); await page.setViewportSize({width:1280,height:900}); await reloadPage(page);
  assert.ok(await page.locator('.top').evaluate(node=>node.getBoundingClientRect().height<=60));
  await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Keep this draft');
  const selected=await selectText(page,'[data-message="1"] .message-text');
  const width=await page.locator('#main-content').evaluate(node=>node.clientWidth);
  await page.locator('#sidebar-toggle').click();
  assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#workspace-sidebar').evaluate(node=>node.inert),true);
  assert.ok(await page.locator('#main-content').evaluate((node,width)=>node.clientWidth>=width+200,width));
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep this draft');
  await page.evaluate(()=>getSelection().removeAllRanges());
  await reloadPage(page);
  assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
  await page.locator('#sidebar-toggle').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'true');
  await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep this draft');
  await page.setViewportSize({width:2400,height:1600});
  assert.ok(await page.locator('#main-content').evaluate(node=>node.getBoundingClientRect().width>2000),'wide and zoomed-out workspaces use available width');
  assert.ok(await page.locator('.thread-layout').evaluate(node=>node.getBoundingClientRect().height>1300),'tall workspaces are not capped at the old height');
  assert.ok(await page.locator('.thread-layout').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
}));

test('mobile sidebar defaults closed and navigation gives the conversation the viewport', async () => fixture(async (page,data) => {
  data.threads=[conversation([])];
  await manualPolling(page); await page.setViewportSize({width:320,height:568}); await reloadPage(page);
  assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#workspace-sidebar').isVisible(),false);
  await openSidebar(page);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
  await page.locator('[data-thread="1"]').click();
  assert.ok(await page.locator('#message-form button').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight));
  assert.ok(await page.locator('#messages').evaluate(node=>node.clientHeight>=100));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
}));

test('copy controls preserve exact project paths and agent detail values across polling', async () => fixture(async (page, data) => {
  const task = 'Review "quoted" paths & <tags>\nKeep this second line.';
  data.projects[0].path = '/projects/example with "quotes" & spaces';
  data.agents = [{id:1,project:projectId(1),name:'Reviewer',state:'paused',pause_reason:'limit',task,status:'Waiting for usage',history_path:'/sessions/a "review".jsonl'}];
  await reloadPage(page); await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  assert.equal(await page.locator('[data-copy-target="project-path"]').count(),1);
  await page.locator('[data-copy-target="project-path"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Project path copied');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),data.projects[0].path);
  await page.locator('[data-agent="1"] [data-action="details"]').click();
  await page.locator('#agent-details dt[data-key="task"]').waitFor();
  await page.locator('[data-copy-target="agent-field-task"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Task copied');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),task);
  assert.equal(await page.locator('#agent-details dt[data-key="task"] + dd').textContent(),task);
  const selected = await selectText(page,'#agent-field-task');
  await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>document.querySelector('#agent-field-task')===window.selectedNode),true);
  await page.evaluate(()=>getSelection().removeAllRanges());
  data.agents[0].status='Ready after recovery';
  await page.evaluate(()=>refresh());
  await page.locator('[data-copy-target="agent-field-status"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Status copied');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'Ready after recovery');
  await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new Error('Permission denied');};});
  await page.locator('[data-copy-target="agent-field-task"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Select the text and copy it manually'));
  assert.equal(await page.locator('#agent-field-task').textContent(),task);
  assert.equal(data.requests.length,0,'copying never mutates server state');
}));

test('agent previews label descriptive status separately from launch tasks and lifecycle state', async () => fixture(async (page,data) => {
  data.agents=[
    {id:1,project:projectId(1),name:'Status reporter',state:'paused',pause_reason:'limit',task:'Original review assignment',status:'Phase 4 complete. Idle until review.'},
    {id:2,project:projectId(1),name:'Task fallback',state:'paused',pause_reason:'limit',task:'Original second assignment',status:null},
  ];
  await reloadPage(page);
  assert.equal(await page.locator('[data-agent="1"] .agent-task').textContent(),'Status: Phase 4 complete. Idle until review.');
  assert.equal(await page.locator('[data-agent="1"] .agent-task').getAttribute('title'),'Status: Phase 4 complete. Idle until review.');
  assert.equal(await page.locator('[data-agent="2"] .agent-task').textContent(),'Task: Original second assignment');
  for(const id of [1,2]) assert.match(await page.locator(`[data-agent="${id}"] .pill.paused`).textContent(),/paused.*limit/);
}));

test('thread identifiers are visible and copyable for references in another conversation', async () => fixture(async (page, data) => {
  data.threads = [conversation([]),conversation([], {id:2,title:'Follow-up'})];
  await reloadPage(page); await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('[data-page=threads]').click();
  assert.match(await page.locator('[data-thread="1"] [data-part=summary]').textContent(), /Thread #1/);
  await page.locator('[data-thread="1"]').click();
  assert.match(await page.locator('#thread-summary').textContent(), /Thread #1/);
  await openThreadDetails(page); await page.locator('#copy-thread').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Copied thread #1');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'thread #1');
  await page.locator('[data-thread="2"]').click();
  await page.locator('#message-form textarea').fill('See thread #1');
  await page.locator('#message-form button').click();
  await page.locator('.message-text').waitFor();
  assert.equal(data.threads[1].messages[0].text, 'See thread #1');
}));

test('agent details expose native history and output paths; closed behavior is explained', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'closed',harness:'claude',conversation_history:'/home/example/.claude/projects/-work/session.jsonl',output_log:'/home/example/.acom/logs/1.jsonl'}];
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
  const matcher=typeof pattern==='function' ? url=>{
    const normalized=new URL(url),scope=/^\/p\/([^/]+)(\/.*)$/.exec(normalized.pathname);
    if(scope){normalized.pathname=scope[2];normalized.searchParams.set('project',decodeURIComponent(scope[1]));}
    return pattern(normalized);
  } : pattern;
  await page.route(matcher, handler);
  return { started, release, remove: () => page.unroute(matcher, handler) };
}

test('slow overview requests commit without overlapping polls discarding every response', async () => fixture(async (page, data) => {
  data.delays = {[projectId(1)]:2400};
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
  assert.equal(await page.locator('#thread-main .empty strong').textContent(), 'Select a thread');
  await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(), 'First draft');
  await page.locator('[data-thread="2"]').click();
  await page.waitForFunction(() => document.querySelector('#thread-membership')?.textContent === 'Join thread');
  await openThreadDetails(page); await page.locator('#thread-membership').click();
  await page.waitForFunction(() => document.querySelector('#thread-membership')?.textContent === 'Leave thread');
  assert.deepEqual(data.requests.find(r => r.url === '/threads/2/user').body, {joined:true});
}));

test('polling restores focus to updated controls and removes actions that no longer apply', async () => fixture(async (page, data) => {
  data.agents = [{id:1,project:projectId(1),name:'Worker',state:'working',status:'Starting',locks:[]}];
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
  await page.locator('[data-close=thread-dialog]:not(.dialog-close)').click();
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForFunction(() => document.querySelector('#project-path').textContent === '/projects/other');
  await page.locator('[data-open=thread-dialog]').click();
  await page.locator('#thread-form [name=title]').fill('New draft in second');
  pending.release(); await pending.remove();
  await page.waitForFunction(() => !document.querySelector('#thread-form button.primary').disabled);
  assert.equal(data.threads[0].project, projectId(1));
  assert.equal(await page.locator('#thread-dialog').isVisible(), true);
  assert.equal(await page.locator('#thread-form [name=title]').inputValue(), 'New draft in second');
  assert.equal(await page.locator('#thread-main .empty strong').textContent(), 'Select a thread');
  assert.equal(await page.locator('#project-path').textContent(), '/projects/other');
}));

test('late launch completions preserve newer drafts in the same or reopened dialog', async () => fixture(async (page, data) => {
  for (const reopen of [false,true]) {
    const pending = await holdRequest(page, '**/agents');
    await openLaunch(page);
    await page.locator('#launch-form [name=task]').fill('Submitted task');
    await page.locator('#launch-form button.primary').click(); await pending.started;
    if (reopen) { await page.locator('[data-close=launch-dialog]:not(.dialog-close)').click(); await openLaunch(page); }
    await page.locator('#launch-form [name=task]').fill('New unsent task');
    pending.release(); await pending.remove();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Agent launched');
    assert.equal(await page.locator('#launch-dialog').isVisible(), true);
    assert.equal(await page.locator('#launch-form [name=task]').inputValue(), 'New unsent task');
    await page.locator('[data-close=launch-dialog]:not(.dialog-close)').click();
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
  await page.locator('[data-close=launch-dialog]:not(.dialog-close)').click(); await openLaunch(page);
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
  await page.locator('[data-close=project-dialog]:not(.dialog-close)').click();
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
  await page.locator('[data-close=config-dialog]:not(.dialog-close)').click();
  data.agents = [1,2].map(id => ({id,project:projectId(1),name:`Worker ${id}`,state:'idle'}));
  data.threads = [conversation([], {members:[0]})];
  await page.evaluate(() => refresh()); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click(); await openThreadDetails(page); await page.locator('#add-thread-members').click();
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
  await openThreadDetails(page); await page.locator('#remove-thread-members').click(); await page.locator('#remove-member-picker [name=member][value="1"]').check();
  const pending=await holdRequest(page,'**/threads/1/members/remove');
  await page.locator('#remove-members-form button.danger').click(); await pending.started;
  await page.locator('[data-close=remove-members-dialog]:not(.dialog-close)').click(); await page.locator('[data-thread="2"]').click();
  await openThreadDetails(page); await page.locator('#remove-thread-members').click(); await page.locator('#remove-member-picker [name=member][value="2"]').check();
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>!document.querySelector('#remove-members-form button.danger').disabled);
  assert.equal(await page.locator('#remove-members-dialog').isVisible(),true);
  assert.equal(await page.locator('#remove-member-picker [name=member][value="2"]').isChecked(),true);
  assert.deepEqual(data.threads[0].members,[0]);
  assert.deepEqual(data.threads[1].members,[0,2]);
  assert.equal(data.requests.filter(r=>r.url.endsWith('/members/remove')).length,1);
  await page.locator('[data-close=remove-members-dialog]:not(.dialog-close)').click();
  await openThreadDetails(page); await page.locator('#remove-thread-members').click();
  await page.evaluate(()=>resetThread());
  assert.equal(await page.locator('#remove-members-dialog').isVisible(),false);
  assert.equal(await page.locator('#thread-main .empty strong').textContent(),'Select a thread');
}));

test('late ownership transfers preserve edited or reopened owner drafts and never target another thread', async () => fixture(async (page, data) => {
  data.agents=[2,3].map(id=>({id,project:projectId(1),name:`Worker ${id}`,state:'idle'}));
  data.threads=[conversation([],{owner:0}),conversation([],{id:2,title:'Second',owner:0})];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await openThreadDetails(page); await page.locator('#change-thread-owner').click(); await page.locator('#thread-owner-form [name=owner]').fill('2');
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
  await page.locator('[data-close=thread-owner-dialog]:not(.dialog-close)').click(); await page.locator('[data-thread="2"]').click();
  await openThreadDetails(page); await page.locator('#change-thread-owner').click(); await page.locator('#thread-owner-form [name=owner]').fill('2');
  second.release(); await second.remove();
  await page.waitForFunction(()=>!document.querySelector('#thread-owner-form button.primary').disabled);
  assert.equal(data.threads[0].owner,3);
  assert.equal(data.threads[1].owner,0);
  assert.equal(await page.locator('#thread-owner-dialog').isVisible(),true);
  assert.equal(await page.locator('#thread-owner-form [name=owner]').inputValue(),'2');
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,2);
}));

test('project switching invalidates ownership dialogs and prevents stale owner form submissions', async () => fixture(async (page, data) => {
  data.agents=[{id:2,project:projectId(1),name:'Target',state:'idle'}]; data.threads=[conversation([])];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await openThreadDetails(page); await page.locator('#change-thread-owner').click(); await page.locator('#thread-owner-form [name=owner]').fill('2');
  await page.locator('#project-select').selectOption(projectId(2));
  await page.waitForFunction(()=>document.querySelector('#project-path').textContent==='/projects/other');
  assert.equal(await page.locator('#thread-owner-dialog').isVisible(),false);
  await page.evaluate(()=>document.querySelector('#thread-owner-form').dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true})));
  assert.equal(data.requests.filter(r=>r.url.endsWith('/owner')).length,0);
  assert.equal(await page.locator('#thread-main .empty strong').textContent(),'Select a thread');
}));

test('switching projects invalidates open add and removal dialogs before a stale form can submit', async () => fixture(async (page, data) => {
  data.agents=[{id:2,project:projectId(1),name:'Additional',state:'idle'}]; data.threads=[conversation([])];
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  for(const [control,dialog,form] of [['#add-thread-members','#members-dialog','#members-form'],['#remove-thread-members','#remove-members-dialog','#remove-members-form']]) {
    await openThreadDetails(page);
    await page.locator(control).click();
    await page.locator(`${form} [name=member]`).check();
    const before=data.requests.filter(r=>/\/members(?:\/remove)?$/.test(r.url)).length;
    await page.locator('#project-select').selectOption(projectId(2));
    await page.waitForFunction(()=>document.querySelector('#project-path').textContent==='/projects/other');
    assert.equal(await page.locator(dialog).isVisible(),false);
    await page.evaluate(form=>document.querySelector(form).dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true})),form);
    assert.equal(data.requests.filter(r=>/\/members(?:\/remove)?$/.test(r.url)).length,before);
    await page.locator('#project-select').selectOption(projectId(1));
    await page.locator('[data-thread="1"]').click();
  }
}));

test('mobile locks can scroll every control into view and dialogs and feedback have accessible names', async () => fixture(async (page, data) => {
  data.locks = [{name:'write-lock',project:projectId(1),about:'Editing important shared content',holder:1,holder_name:'Worker',acquired_at:1,expires_at:Date.now()/1000+600,queue:[2,3]}];
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
  await page.locator('[data-close=launch-dialog]:not(.dialog-close)').click();
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
  data.projects=Array.from({length:6},(_,i)=>({id:projectId(i+1),name:`Project ${i+1}`,path:`/projects/${i+1}`,config:configId(2)}));
  data.configs.push(...[3,4,5,6].map(id=>({id:configId(id),name:`Config ${id}`,settings:settings()})));
  data.agents=Array.from({length:6},(_,i)=>({id:i+1,project:projectId(1),name:`Agent ${i+1}`,state:i%2?'closed':'working'}));
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('#project-select').inputValue(),projectId(1),'the selected project stays reachable outside the first page');
  while(await page.locator('.project-banner [data-more=projects]').isVisible()) {await page.locator('.project-banner [data-more=projects]').click();await page.waitForFunction(()=>!state.pages.projects.pending);}
  assert.equal(await page.locator('#project-select option').count(),6);
  await page.locator('[data-page=settings]').click();
  while(await page.locator('#settings-form [data-more=configs]').isVisible()) {await page.locator('#settings-form [data-more=configs]').click();await page.waitForFunction(()=>!state.pages.configs.pending);}
  await page.locator('#config-select').selectOption(configId(3)); await page.waitForFunction(()=>state.editor.config===configId(3));
  assert.equal(await page.locator('[name=config_name]').inputValue(),'Config 3');
  await page.locator('[data-page=threads]').click(); await page.locator('[data-open=thread-dialog]').click();
  await page.locator('#thread-member-picker [data-member-pick=all]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#thread-member-picker [name=member]:checked').length===6);
  await page.locator('#thread-member-picker [data-member-pick=active]').click();
  assert.deepEqual(await page.locator('#thread-member-picker [name=member]:checked').evaluateAll(nodes=>nodes.map(n=>Number(n.value))),[1,3,5]);
}));

test('a mutable collection changing during Load more restarts a consistent window without stale or duplicate rows', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.agents=Array.from({length:6},(_,i)=>({id:i+1,project:projectId(1),name:`Agent ${i+1}`,state:'working'}));
  await manualPolling(page); await reloadPage(page);
  const pending=await holdRequest(page,url=>url.pathname==='/agents'&&url.searchParams.get('before')==='5','GET');
  await page.locator('#page-overview [data-more=agentBrowser]').click(); await pending.started;
  data.agents=data.agents.filter(a=>a.id!==5); data.agents.find(a=>a.id===2).name='Updated agent 2';
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>document.querySelectorAll('[data-agent]').length===5);
  assert.deepEqual(await page.locator('[data-agent]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.agent))),[6,4,3,2,1]);
  assert.match(await page.locator('[data-agent="2"]').textContent(),/Updated agent 2/);
  assert.equal(await page.locator('#agent-count').textContent(),'Showing 5 of 5 matches · 5 total');
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
  assert.ok(data.getRequests.some(url=>url.startsWith(`/configs/${configId(2)}?offset=`)));
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
  assert.ok(data.getRequests.at(-1).startsWith(`/settings?project=${projectId(1)}`));
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
  data.pageLimit=2; data.configs.push(...[3,4,5,6,7,8].map(id=>({id:configId(id),name:`Config ${id}`,settings:settings()})));
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator('#config-select').inputValue(),configId(2));
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
  await page.route(url=>url.pathname===`/configs/${configId(2)}`&&Number(url.searchParams.get('offset'))>0,async route=>{
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
  data.agents=[{id:1,project:projectId(1),name:'Worker',state:'working'}];
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
  data.launchResult={id:1,result_truncated:true,counts:{warnings:100},warnings:warnings.slice(0,1),receipt_path:`/p/${projectId(1)}/receipts/7`};
  data.receipts={7:{id:7,details:{response:{id:1,warnings}}}};
  await manualPolling(page); await reloadPage(page); await openLaunch(page); await page.locator('#launch-form [name=task]').fill('Launch once');
  await page.locator('#launch-form button.primary').click(); await page.waitForFunction(()=>!document.querySelector('#launch-dialog').open);
  assert.match(await page.locator('#result-notice').textContent(),/Action completed.*warnings: 100/);
  await page.locator('#result-notice [data-record-path]').click();
  await page.waitForFunction(()=>document.querySelector('#record-content').textContent.includes('Warning 99:'));
  const receipt=JSON.parse(await page.locator('#record-content').textContent());
  assert.deepEqual(receipt.details.response.warnings,warnings);
  await page.locator('#record-dialog .dialog-actions button').click();
  data.launchResult={id:2,result_truncated:true,counts:{warnings:100},receipt_error:'Action completed, receipt storage unavailable'};
  await openLaunch(page); await page.locator('#launch-form [name=task]').fill('Another explicit launch');
  await page.locator('#launch-form button.primary').click(); await page.waitForFunction(()=>!document.querySelector('#launch-dialog').open);
  assert.match(await page.locator('#result-notice').textContent(),/Action completed.*Inspect current state before retrying/);
  assert.equal(data.requests.filter(r=>r.url==='/agents').length,2,'no automatic mutation retry');
  assert.ok(data.wireRequests.some(request=>request.url.startsWith(`/p/${projectId(1)}/receipts/7`)),'scoped receipts follow their exact supplied path');
}));

test('completed-action receipts retain their exact original scope and reject nonlocal or malformed paths',async()=>fixture(async(page,data)=>{
  await manualPolling(page);await reloadPage(page);
  const path=`/p/${projectId(1)}/receipts/7`;
  data.receipts={7:{details:{response:{note:'Original project result'}}}};
  data.launchResult={id:1,result_truncated:true,counts:{warnings:1},receipt_path:path};
  const held=await holdRequest(page,url=>url.pathname==='/agents'&&url.searchParams.get('project')===projectId(1));
  try {
    await page.evaluate(()=>{window.pendingReceipt=api('/agents',{method:'POST',body:JSON.stringify({task:'Synthetic action'})});});
    await held.started;
    await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
    held.release();await held.remove();await page.evaluate(()=>window.pendingReceipt);
    assert.equal(await page.locator('#result-notice [data-record-path]').getAttribute('data-record-path'),path);
    await page.locator('#result-notice [data-record-path]').click();await page.locator('#record-content').filter({hasText:'Original project result'}).waitFor();
    await page.locator('#record-dialog .dialog-close').click();
    assert.ok(data.wireRequests.some(request=>request.url.startsWith(path)));
    assert.equal(data.wireRequests.some(request=>request.url.startsWith(`/p/${projectId(2)}/receipts/7`)),false);
  } finally {held.release();await held.remove();}
  for(const receipt_path of ['https://example.invalid/receipts/7','//example.invalid/receipts/7','/receipts/7','/receipts/7?redirect=1','/p/invalid/not-receipts/7',null]) {
    const handler=route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({result_truncated:true,counts:{warnings:1},receipt_event:7,receipt_path})});
    await page.route('**/usage/check',handler);
    await page.evaluate(()=>api('/usage/check',{method:'POST',body:'{}'}));
    assert.equal(await page.locator('#result-notice [data-record-path]').count(),0);
    assert.match(await page.locator('#result-notice').textContent(),/Action completed.*Inspect current state before retrying/);
    await page.unroute('**/usage/check',handler);
  }
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
    assert.match(await row.textContent(),/You’re a member.*1 message ·.*Member list exceeds the preview budget/);
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
  assert.equal(await page.locator('[data-message="2"] .message-text').textContent(),text.trimEnd(),'Markdown normalizes presentation whitespace, not the stored source');
  assert.equal(await page.evaluate(()=>state.thread.messages.find(message=>message.id===2).text),text);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']); await page.locator('[data-copy-message="2"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Message copied');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),text,'copy retains even the trailing source whitespace');
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
  await openThreadDetails(page);
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
  await openThreadDetails(page); await page.locator('#thread-membership').click();
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
  data.pageLimit=2; data.agents=[{id:1,project:projectId(1),name:'Resume worker',state:'paused'}];
  const longName='Older active lock ☃ '.repeat(1300);
  data.locks=Array.from({length:6},(_,i)=>({id:i+1,project:projectId(1),name:i===0?longName:`lock${i+1}`,holder:2,about:'Another worker owns this lease',expires_at:Date.now()/1000+60}));
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
  data.agents=[{id:1,project:projectId(1),name:'Worker',state:'working',locks:['held lease']}];
  data.locks=[{id:1,project:projectId(1),name:'held lease',holder:1,about:'Still being written',expires_at:Date.now()/1000+60}];
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
  data.locks=[{id:1,project:projectId(1),name:'shared',holder:2,holder_name:'Active worker',acquired_at:1,expires_at:Date.now()/1000+60}];
  await manualPolling(page); await reloadPage(page);
  assert.doesNotMatch(await page.locator('#locks').textContent(),/frozen|no TTL/i);
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('[data-action=free-lock]').click();
  await page.waitForFunction(()=>state.locks[0]?.holder===null);
  assert.deepEqual(data.requests,[{url:'/locks/free',method:'POST',body:{project:projectId(1),name:'shared'}}]);
  await page.evaluate(()=>refresh());
  assert.equal(data.requests.length,1);
}));

test('stopping lock holders outside the agent page block Free even through selected stale rows and oversized previews', async () => fixture(async (page,data) => {
  data.pageLimit=1;
  data.agents=[{id:1,project:projectId(1),name:'Older holder',state:'paused',stopping:true},{id:2,project:projectId(1),name:'Newer worker',state:'working'}];
  data.locks=[{id:1,project:projectId(1),name:'protected',holder:1,expires_at:1}];
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
  data.agents=[{id:1,project:projectId(1),name:'Holder',state:'working'}];
  data.locks=[{id:1,project:projectId(1),name:'racing lease',holder:1,expires_at:Date.now()/1000+60}];
  await manualPolling(page); await reloadPage(page);
  const held=await holdRequest(page,'**/locks/free');
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('[data-action=free-lock]').click(); await held.started;
  Object.assign(data.agents[0],{state:'paused',stopping:true});
  held.release(); await held.remove();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Lock holder is still stopping');
  assert.equal(data.locks[0].holder,1);
  assert.deepEqual(data.requests,[{url:'/locks/free',method:'POST',body:{project:projectId(1),name:'racing lease'}}]);
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-action=free-lock]').isDisabled(),true);
  assert.equal(data.requests.length,1);
}));

test('Pause is a single empty-payload action, preserves the current project after a delayed response and never retries errors', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'First worker',state:'working',locks:['first hold']},{id:2,project:projectId(2),name:'Other worker',state:'working',locks:['other hold']}];
  data.locks=[{id:1,project:projectId(1),name:'first hold',holder:1},{id:2,project:projectId(2),name:'other hold',holder:2}];
  await manualPolling(page); await reloadPage(page);
  const held=await holdRequest(page,'**/agents/1/pause');
  await page.locator('[data-action=pause]').click(); await held.started;
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-action=pause]').isDisabled(),true);
  await page.evaluate(()=>document.querySelector('[data-action=pause]').click());
  await page.locator('#project-select').selectOption(projectId(2));
  held.release(); await held.remove();
  await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0&&agentTransitions.size===0);
  assert.deepEqual(data.requests,[{url:'/agents/1/pause',method:'POST',body:{}}]);
  assert.deepEqual(data.locks.map(lock=>lock.holder),[null,2]);
  assert.equal(data.agents[1].state,'working');
  assert.equal(data.detailRequests.length,0,'Pause no longer fetches holds before a choice');
  data.agents[0].state='working'; data.pauseError='Stop cleanup unavailable';
  await page.locator('#project-select').selectOption(projectId(1)); await page.waitForFunction(()=>state.selectedProject===projectId(1)&&refreshPending===0);
  await page.locator('[data-action=pause]').click(); await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Stop cleanup unavailable');
  await page.evaluate(()=>refresh());
  assert.equal(data.requests.filter(request=>request.url==='/agents/1/pause').length,2,'one explicit retry is not repeated automatically');
  assert.equal(data.agents[0].state,'working');
}));

test('Pause all confirms stop-and-release scope, can be cancelled and stays single-flight through polling', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Working',state:'working'},{id:2,project:projectId(2),name:'Idle elsewhere',state:'idle'},{id:3,project:projectId(1),name:'Already paused',state:'paused',pause_reason:'user'}];
  data.locks=[{id:1,project:projectId(1),name:'first',holder:1},{id:2,project:projectId(2),name:'second',holder:2}];
  await manualPolling(page); await reloadPage(page);
  await openGlobalActions(page);
  const confirmations=[];
  page.on('dialog',dialog=>{confirmations.push(dialog.message());return confirmations.length===1?dialog.dismiss():dialog.accept();});
  await page.locator('#pause-all').click();
  assert.equal(data.requests.length,0);
  const held=await holdRequest(page,'**/pause-all');
  await page.locator('#pause-all').click(); await held.started;
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#pause-all').isDisabled(),true);
  for(const id of ['pause-project','resume-project','resume-project-restart','resume-all','resume-restart']) {
    assert.equal(await page.locator(`#${id}`).isDisabled(),true);
    await page.locator(`#${id}`).dispatchEvent('click');
  }
  await page.evaluate(()=>document.querySelector('#pause-all').click());
  held.release(); await held.remove();
  await page.waitForFunction(()=>!bulkAction);
  assert.equal(await page.locator('#pause-all').isDisabled(),true);
  assert.deepEqual(confirmations,Array(2).fill('Pause 2 eligible agents across all projects? This stops their processes and releases their locks.'));
  assert.deepEqual(data.requests,[{url:'/pause-all',method:'POST',body:{}}]);
  assert.ok(data.locks.every(lock=>lock.holder===null));
  assert.deepEqual(data.agents.map(a=>a.pause_reason),['all','all','user']);
  await page.locator('[data-page=settings]').click();
  assert.match(await page.locator('#settings-form').textContent(),/Every pause stops the agent's processes, then releases its locks/);
  assert.doesNotMatch(await page.locator('body').textContent(),/frozen|freeze|keep locks/i);
}));

test('bounded stopping previews keep cleanup visible and Details available without restart actions', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Huge worker name '.repeat(2500),state:'paused',pause_reason:'user',stopping:true}];
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('[data-action=resume],[data-action=close]').count(),0);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Stopping.*before releasing locks/s);
  await page.locator('[data-action=details]').click();
  await page.locator('#agent-details dt[data-key=stopping]').waitFor();
  assert.equal(await page.locator('[data-action=resume]').isDisabled(),true);
  assert.equal(await page.locator('[data-action=close]').isDisabled(),true);
}));

test('explicit Details hydration restores the action controls of an oversized agent preview without replacing config drafts', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Large agent name ☃ '.repeat(1500),state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium',task:'Full task',locks:[],token_usage_state:'partial',total_tokens:123,fresh_in:100,cache_write:0,cache_read:20,output:3}];
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('[data-action=pause]').count(),0);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Total tokens: 123.*Partial \(incomplete\)/,'a bounded stub uses its explicit total and completeness status');
  assert.equal(data.detailRequests.length,0,'the token preview does not eagerly hydrate the record');
  await page.locator('[data-action=details]').click();
  await page.waitForFunction(()=>document.querySelector('#agent-detail-status').textContent.startsWith('Live'));
  assert.equal(await page.locator('[data-action=pause]').count(),1);
  assert.equal(await page.locator('#agent-field-total_tokens').textContent(),'123','chunked Details retain the reported total');
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Total tokens: 123.*Partial \(incomplete\)/);
  const model=page.locator('#agent-config [name=agent_model]');
  await model.selectOption('gpt-6-luna');
  await page.evaluate(()=>refresh());
  assert.equal(await model.inputValue(),'gpt-6-luna');
  assert.equal(await page.locator('[data-action=close]').count(),1);
}));

test('oversized selector previews retain unique ID labels and hydrate only the chosen config or project', async () => fixture(async (page,data) => {
  const large='Long preview ☃ '.repeat(1800);
  const custom=settings(); custom.prompts.launch=large;
  data.configs.push({id:configId(3),name:'Large config',settings:custom});
  data.projects.push({id:projectId(3),name:large,path:'/projects/large',config:configId(2)});
  data.agents=[{id:1,project:projectId(1),name:large,state:'working',harness:'codex',model:'gpt-6.1-sol'}];
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator(`#project-select option[value="${projectId(3)}"]`).textContent(),`Project #${projectId(3)}`);
  assert.equal(data.getRequests.filter(url=>url.startsWith(`/projects/${projectId(3)}`)||url.startsWith(`/configs/${configId(3)}`)).length,0);
  await page.locator('[data-page=settings]').click();
  assert.equal(await page.locator(`#config-select option[value="${configId(3)}"]`).textContent(),`Config #${configId(3)}`);
  await page.locator('#config-select').selectOption(configId(3)); await page.waitForFunction(()=>state.editor.config===configId(3));
  assert.equal(await page.locator('[name=config_name]').inputValue(),'Large config');
  assert.equal(await page.locator('[name=prompt_launch]').inputValue(),large);
  await page.locator('[data-page=threads]').click(); await page.locator('[data-open=thread-dialog]').click();
  assert.match(await page.locator('#thread-member-picker [data-member-row]').textContent(),/Agent #1.*working.*Details exceed the preview budget/);
  assert.doesNotMatch(await page.locator('#thread-member-picker').textContent(),/undefined/);
  await page.locator('#thread-dialog [data-close=thread-dialog]:not(.dialog-close)').click();
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#project-select').selectOption(projectId(3));
  await page.waitForFunction(()=>state.selectedProject===projectId(3)&&refreshPending===0);
  assert.equal(await page.locator('#project-path').textContent(),'/projects/large');
  assert.ok(data.getRequests.some(url=>url.startsWith(`/projects/${projectId(3)}?offset=`)||url.startsWith(`/overview?project=${projectId(3)}&offset=`)));
}));

test('Overview exposes a pending replacement, preserves selected text and permanently links the committed successor', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Original worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high',replacement_request:{harness:'claude',model:'claude-sonnet-5-5',blocked:null}}];
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
  data.agents.push({id:2,project:projectId(1),name:'New owner',state:'done',harness:'claude',model:'claude-sonnet-5-5',effort:'high',replacement_start:{predecessor:1,blocked:'Hard target limit',attempted:0},wake_queued_at:1,wake_reason:'Ordinary wake reason'});
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
  data.agents=[{id:2,project:projectId(1),name:'Waiting successor',state:'done',harness:'codex',model:'gpt-6.1-sol',effort:'medium',pause_reason:'limit',wake_queued_at:1,wake_reason:'Do not show normal wake',replacement_pending:false,replacement_start_pending:true,replacement_start:{predecessor:1,blocked:'Usage <hard> limit',attempted:0}}];
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
  await page.waitForFunction(()=>!refreshPending&&agentLoading===null&&document.querySelector('#agent-config').dataset.saving!=='true');
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
    {id:1,project:projectId(1),name:large,state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high',replacement_request:{harness:'claude',model:'claude-sonnet-5-5',blocked:'Pending target reason'}},
    {id:2,project:projectId(1),name:large,state:'done',harness:'claude',model:'claude-sonnet-5-5',effort:'high',replacement_start:{predecessor:3,blocked:'Exact <first start> reason',attempted:0}},
    {id:3,project:projectId(1),name:large,state:'replaced',harness:'codex',model:'gpt-6.1-sol',effort:'high',replacement:2},
  ];
  await manualPolling(page); await reloadPage(page);
  while(await page.locator('#page-overview [data-more=agentBrowser]').isVisible()) {await page.locator('#page-overview [data-more=agentBrowser]').click();await page.waitForFunction(()=>!state.pages.agentBrowser.pending);}
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
  data.agents=[{id:1,project:projectId(1),name:'Original worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'},{id:2,project:projectId(1),name:'Other worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
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
    {id:1,project:projectId(1),name:'Manual pause',state:'paused',pause_reason:'user'},
    {id:2,project:projectId(1),name:'Usage pause',state:'paused',pause_reason:'limit'},
    {id:3,project:projectId(2),name:'Restart one',state:'paused',pause_reason:'restart'},
    {id:4,project:projectId(2),name:'Restart two',state:'paused',pause_reason:'restart'},
    {id:5,project:projectId(1),name:'Already crashed',state:'crashed',pause_reason:'restart'},
    {id:6,project:projectId(1),name:'Already done',state:'done',pause_reason:'restart'},
  ];
  await manualPolling(page); await reloadPage(page);
  await openGlobalActions(page);
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
  assert.equal(await page.locator('#project-select').inputValue(),projectId(1),'global resume does not change the selected project');
  assert.equal(await page.locator('#resume-all').textContent(),'Resume all (2 · all projects)');
}));

test('restart-paused counts refresh across projects without disturbing selected text and disable an empty action', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Selected manual pause',state:'paused',pause_reason:'user'},{id:2,project:projectId(2),name:'Other project restart',state:'paused',pause_reason:'restart'}];
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
  data.agents=[{id:1,project:projectId(1),name:'Restart pause',state:'paused',pause_reason:'restart'}];
  data.resumeRestartError='Cannot resume restart-paused agents';
  await manualPolling(page); await reloadPage(page);
  await openGlobalActions(page);
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
  data.agents=[{id:1,project:projectId(1),name:'Restart success',state:'paused',pause_reason:'restart'},{id:2,project:projectId(2),name:'Restart blocked',state:'paused',pause_reason:'restart'},{id:3,project:projectId(1),name:'Manual pause',state:'paused',pause_reason:'user'}];
  data.resumeRestartWarnings=['Agent 1 is waiting for an active slot'];
  data.resumeRestartFailures={2:'Agent 2: requested model is disabled'};
  await manualPolling(page); await reloadPage(page);
  await openGlobalActions(page);
  await page.locator('#resume-restart').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Agent 2: requested model is disabled'));
  assert.equal(await page.locator('#toast').textContent(),`Resumed 1 restart-paused agents across all projects. 1 error.\nProject “example” (#${projectId(1)}): Agent 1 is waiting for an active slot\nProject “other” (#${projectId(2)}): Agent 2: requested model is disabled`);
  assert.equal(await page.locator('#toast').evaluate(el=>el.classList.contains('error')),true);
  assert.deepEqual(data.agents.map(a=>[a.state,a.pause_reason]),[['working',null],['paused','restart'],['paused','user']]);
  assert.equal(await page.locator('#restart-paused-count').textContent(),'(1 · all projects)');
  assert.equal(await page.locator('#resume-restart').isEnabled(),true);
  assert.equal(data.requests.filter(r=>r.url==='/resume-restart').length,1);
}));

test('truncated restart-paused results report full failure counts even when the error sample is empty', async () => fixture(async (page,data) => {
  data.agents=[1,2,3].map(id=>({id,project:projectId(1),name:`Restart ${id}`,state:'paused',pause_reason:'restart'}));
  const error='Agent 3: disabled model '.repeat(100);
  data.resumeRestartFailures={3:error};
  data.resumeRestartResult={result_truncated:true,counts:{ids:2,errors:1,warnings:0},ids:[1],errors:[],warnings:[],receipt_path:'/global-receipts/11'};
  data.receipts={11:{details:{response:{ids:[1,2],errors:[error],warnings:[]}}}};
  await manualPolling(page); await reloadPage(page);
  await openGlobalActions(page);
  await page.locator('#resume-restart').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('2 resumed, 1 error'));
  assert.equal(await page.locator('#toast').textContent(),'Restart-paused agents across all projects: 2 resumed, 1 error. See the completed-action result below.');
  assert.equal(await page.locator('#toast').evaluate(el=>el.classList.contains('error')),true);
  assert.match(await page.locator('#result-notice').textContent(),/ids: 2.*errors: 1.*Result details/);
  await page.locator('#result-notice [data-record-path]').click();
  await page.waitForFunction(()=>document.querySelector('#record-content').textContent.includes('Agent 3: disabled model'));
  assert.deepEqual(JSON.parse(await page.locator('#record-content').textContent()).details.response.errors,[error]);
  assert.ok(data.wireRequests.some(request=>request.url.startsWith('/global-receipts/11')),'global receipts are never inferred from the selected project');
  await page.locator('#record-dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.evaluate(()=>refresh());
  assert.equal(data.requests.filter(r=>r.url==='/resume-restart').length,1,'reading the receipt and polling do not repeat a partially completed action');
  assert.deepEqual(data.agents.map(a=>a.state),['working','working','paused']);
}));

test('every bulk action reports project-qualified nested issues and top-level project failures truthfully',async()=>fixture(async(page,data)=>{
  await manualPolling(page);await reloadPage(page);
  for(const [button,resultKey,initial]of [['pause-all','pauseAllResult','idle'],['resume-all','resumeAllResult','paused'],['resume-restart','resumeRestartResult','paused']]) {
    data.agents=[{id:1,project:projectId(1),name:'Worker',state:initial,pause_reason:'restart'}];
    data[resultKey]={results:[{project:projectId(1),ids:[1],warnings:['Waiting for a slot'],errors:['One agent could not start']}],errors:[{project:projectId(2),status:503,error:'Project unavailable'}],counts:{ids:1,warnings:1,errors:2}};
    await page.evaluate(()=>refresh());await openGlobalActions(page);const before=data.requests.length;
    await page.locator(`#${button}`).click();await page.waitForFunction(()=>!bulkAction&&refreshPending===0);
    const text=await page.locator('#toast').textContent();
    assert.match(text,/1 .*agents across all projects\. 2 errors\./);
    assert.ok(text.includes(`Project “example” (#${projectId(1)}): Waiting for a slot`));
    assert.ok(text.includes(`Project “example” (#${projectId(1)}): One agent could not start`));
    assert.ok(text.includes(`Project “other” (#${projectId(2)}): Project unavailable`));
    assert.doesNotMatch(text,/\[object Object\]/);assert.equal(await page.locator('#toast').evaluate(node=>node.classList.contains('error')),true);
    await page.evaluate(()=>refresh());assert.equal(data.requests.length,before+1,'partial outcomes are not retried');
  }
}));

test('workspace agent search combines with accessible state filters and preserves the query through polling', async () => fixture(async (page,data) => {
  data.agents=[
    {id:1,project:projectId(1),name:'Alpha review',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'high'},
    {id:2,project:projectId(1),name:'Beta review',state:'paused',harness:'codex',model:'gpt-6.1-sol',effort:'high',pause_reason:'user'},
    {id:3,project:projectId(1),name:'Review complete',state:'done',harness:'claude',model:'claude-sonnet-5-5',effort:'medium'},
    {id:4,project:projectId(1),name:'Available worker',state:'idle',harness:'codex',model:'gpt-6.1-sol',effort:'medium'},
    {id:5,project:projectId(1),name:'Broken worker',state:'crashed',harness:'claude',model:'claude-sonnet-5-5',effort:'medium'},
    {id:6,project:projectId(1),name:'Waiting replacement',state:'done',harness:'codex',model:'gpt-6.1-sol',effort:'medium',replacement_start:{predecessor:3,blocked:'Capacity is full',attempted:0}},
    {id:7,project:projectId(1),name:'Stopping worker',state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium',stopping:true},
    {id:8,project:projectId(1),name:'Closed worker',state:'closed',harness:'codex',model:'gpt-6.1-sol',effort:'medium'},
    {id:9,project:projectId(1),name:'Replaced worker',state:'replaced',harness:'codex',model:'gpt-6.1-sol',effort:'medium',replacement:6},
  ];
  await manualPolling(page); await reloadPage(page);
  const ids=()=>page.locator('#agents [data-agent]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.agent)).sort((a,b)=>a-b));
  const expectIds=async expected=>{
    await page.waitForFunction(()=>!agentSearchTimer&&state.pages.agentBrowser?.scope===collectionPath('agentBrowser')&&!!state.pages.agentBrowser.revision&&!state.pages.agentBrowser.pending);
    assert.deepEqual(await ids(),expected);
  };
  await expectIds([1,2,3,4,5,6,7,8,9]);
  for(const [filter,expected] of [['active',[1,4,7]],['attention',[2,5,6,7]],['finished',[3,6,8,9]],['all',[1,2,3,4,5,6,7,8,9]]]) {
    await page.locator(`[data-agent-filter=${filter}]`).click();
    await expectIds(expected);
    assert.equal(await page.locator('[data-agent-filter][aria-pressed=true]').count(),1);
    assert.equal(await page.locator(`[data-agent-filter=${filter}]`).getAttribute('aria-pressed'),'true');
  }
  const search=page.locator('#agent-search');
  assert.ok(await search.getAttribute('aria-label') || await search.evaluate(el=>el.labels?.length));
  await search.fill('"Alpha review 1"');
  await expectIds([]);
  await search.fill('"Alpha review"');
  await expectIds([1]);
  await search.fill('REVIEW');
  await expectIds([1,2,3]);
  await page.locator('[data-agent-filter=active]').click();
  await expectIds([1]);
  await search.fill('Beta');
  await expectIds([]);
  assert.match(await page.locator('#agents').textContent(),/no .*match/i);
  await page.evaluate(()=>refresh());
  assert.equal(await search.inputValue(),'Beta');
  assert.equal(await page.locator('[data-agent-filter=active]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-agent-filter=attention]').click();
  await expectIds([2]);
  await search.fill('');
  await page.locator('[data-agent-filter=all]').click();
  await expectIds([1,2,3,4,5,6,7,8,9]);
  assert.equal(data.requests.length,0,'search and filters never change agent state');
}));

test('server facets and search include off-page agents and full tasks while pickers keep their unfiltered scope', async () => fixture(async (page,data) => {
  data.pageLimit=1;
  data.agents=Array.from({length:30},(_,i)=>({id:i+1,project:projectId(1),name:`Worker ${i+1}`,state:'closed'}));
  for(const [id,state] of [[1,'working'],[2,'idle'],[3,'paused'],[4,'crashed'],[5,'done'],[6,'replaced'],[8,'working'],[9,'idle'],[10,'done']])data.agents[id-1].state=state;
  data.agents[0].task='Earlier task content. '.repeat(30)+'Deep NeedLe%_ result';
  data.agents[7].stopping=true; data.agents[8].wake_queued_at=1;
  data.agents[9].replacement_start={predecessor:5,attempted:0};
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('#agents [data-agent]').count(),1);
  assert.equal(await page.locator('#agent-count').textContent(),'Showing 1 of 30 matches · 30 total');
  for(const [key,count] of [['all',30],['active',4],['attention',5],['finished',24]])assert.equal(await page.locator(`[data-agent-count=${key}]`).textContent(),String(count));
  assert.equal(await page.locator('.stat.attention .stat-value').textContent(),'5');
  await page.locator('[data-agent-filter=attention]').click();
  await page.waitForFunction(()=>state.pages.agentBrowser?.counts?.attention===5&&!state.pages.agentBrowser.pending&&state.agentBrowser[0]?.id===10);
  assert.equal(await page.locator('#agents [data-agent]').count(),1,'a category change loads only its first bounded page');
  await page.locator('#agent-search').fill('needle%_');
  await page.waitForFunction(()=>!agentSearchTimer&&state.pages.agentBrowser?.counts?.all===1&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('#agent-count').textContent(),'Showing 0 of 0 matches · 30 total');
  assert.equal(await page.locator('[data-agent-count=active]').textContent(),'1');
  assert.equal(await page.locator('[data-agent-count=attention]').textContent(),'0');
  await page.locator('[data-agent-filter=active]').click(); await page.locator('#agents [data-agent="1"]').waitFor();
  assert.doesNotMatch(await page.locator('#agents').textContent(),/needle%_/i,'the server searched beyond the displayed task preview');
  assert.deepEqual(await page.evaluate(()=>state.agents.map(agent=>agent.id)),[30]);
  assert.equal(await page.locator('.stat.attention .stat-value').textContent(),'5','project summary is not narrowed by browser search');
  await page.locator('[data-page=threads]').click(); await page.locator('[data-open=thread-dialog]').click();
  assert.deepEqual(await page.locator('#thread-member-picker [name=member]').evaluateAll(nodes=>nodes.map(node=>Number(node.value))),[30]);
  assert.equal(data.requests.length,0);
}));

test('debounced searches discard old pages after query and project switches without fetching every agent', async () => fixture(async (page,data) => {
  data.pageLimit=1; data.agents=[{id:1,project:projectId(1),name:'Old target',state:'idle'},{id:2,project:projectId(1),name:'New target',state:'idle'},{id:3,project:projectId(2),name:'New elsewhere',state:'idle'}];
  await manualPolling(page); await reloadPage(page);
  const pending=await holdRequest(page,url=>url.pathname==='/agents'&&url.searchParams.get('search')==='old','GET');
  await page.locator('#agent-search').fill('o'); await page.locator('#agent-search').fill('ol'); await page.locator('#agent-search').fill('old'); await pending.started;
  await page.locator('#agent-search').fill('new');
  await page.waitForFunction(()=>!agentSearchTimer&&state.agentBrowser[0]?.id===2&&!state.pages.agentBrowser.pending);
  await page.locator('#project-select').selectOption(projectId(2)); await page.locator('#agents [data-agent="3"]').waitFor();
  pending.release(); await pending.remove(); await page.waitForTimeout(100);
  assert.deepEqual(await page.locator('#agents [data-agent]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.agent))),[3]);
  assert.equal(await page.locator('#agent-search').inputValue(),'new');
  const searches=data.getRequests.filter(url=>url.startsWith('/agents?')).map(url=>new URL(url,'http://test').searchParams.get('search'));
  assert.equal(searches.filter(value=>value==='old').length,1);
  assert.equal(searches.filter(value=>value==='o'||value==='ol').length,0);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/agents?')&&url.includes('before=')).length,0);
  assert.equal(data.requests.length,0);
}));

test('server-classified oversized agents stay in filtered results and expose waiting without eager detail hydration', async () => fixture(async (page,data) => {
  const now=Math.floor(Date.now()/1000);
  data.agents=[{id:1,project:projectId(1),name:'Large queued '.repeat(1800),state:'idle',wake_queued_at:1},{id:2,project:projectId(1),name:'Large waiting '.repeat(1800),state:'working',waiting:{started_at:now,expires_at:now+30,remaining_secs:30,agents:'all',states:['idle'],status_text:true}}];
  await manualPolling(page); await reloadPage(page);
  assert.match(await page.locator('#agents [data-agent="2"]').textContent(),/Waiting for notifications.*See Details/);
  assert.equal(data.detailRequests.length,0);
  await page.locator('[data-agent-filter=attention]').click(); await page.locator('#agents [data-agent="1"]').waitFor();
  assert.equal(await page.locator('#agents [data-agent]').count(),1);
  assert.equal(await page.locator('[data-agent-count=attention]').textContent(),'1');
  assert.equal(data.detailRequests.length,0,'the server classification does not require searchable preview fields');
  await page.locator('[data-agent-filter=active]').click(); await page.locator('#agents [data-agent="2"]').waitFor();
  await page.locator('#agents [data-agent="2"] [data-action=details]').click();
  await page.waitForFunction(()=>document.querySelector('#agent-details dd [data-wait-agent="2"]'));
  assert.match(await page.locator('#agent-details').textContent(),/Waiting for notifications.*\d+s left.*all project agents.*states: idle.*status changes/);
}));

test('notification waits retain working state and use a monotonic selection-safe countdown', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Watching',state:'working',waiting:{started_at:100,expires_at:200,remaining_secs:5,agents:[2],states:['idle','crashed'],status_text:true,usage:{provider:'claude',window:'five_hour',condition:'below',percent:80}}},{id:2,project:projectId(1),name:'Watched',state:'closed'}];
  await manualPolling(page); await reloadPage(page);
  const wait=page.locator('#agents [data-agent="1"] .agent-wait');
  assert.match(await wait.textContent(),/5s left.*agents #2.*states: idle, crashed.*status changes/);
  assert.match(await wait.textContent(),/claude \/ five_hour: below 80%/);
  assert.equal(await page.locator('#agents [data-agent="1"] .agent-name .pill').textContent(),'working');
  await page.evaluate(()=>{window.waitRow=document.querySelector('#agents [data-agent="1"]');const original=Date.now;Date.now=()=>original()+86400000;});
  await page.waitForTimeout(1100);
  await page.evaluate(()=>updateWaitTimers());
  assert.match(await wait.textContent(),/[34]s left/);
  const selected=await selectText(page,'#agents [data-agent="1"] .agent-wait');
  await page.waitForTimeout(1100); await page.evaluate(()=>updateWaitTimers());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  await page.evaluate(()=>getSelection().removeAllRanges());
  data.agents[0].waiting.remaining_secs=2; await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>window.waitRow===document.querySelector('#agents [data-agent="1"]')),true,'countdown updates do not rebuild the agent row');
  await page.locator('#agents [data-agent="1"] [data-action=details]').click();
  await page.waitForFunction(()=>document.querySelector('#agent-details dd [data-wait-agent="1"]'));
  assert.match(await page.locator('#agent-details').textContent(),/claude \/ five_hour: below 80%/);
  assert.equal(data.agents[0].state,'working');
  data.agents[0].waiting=null; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agents [data-agent="1"] .agent-wait').count(),0);
  assert.equal(await page.locator('#agent-details dd [data-wait-agent="1"]').count(),0);
}));

test('slow chunked waiting details stay version-stable and calibrate their timeout from HTTP Date rather than the browser clock', async () => fixture(async (page,data) => {
  const now=Math.floor(Date.now()/1000);
  data.agents=[{id:1,project:projectId(1),name:'Oversized waiting agent '.repeat(2000),state:'working',harness:'codex',model:'gpt-6.1-sol',effort:'medium',waiting:{started_at:now,expires_at:now+30,remaining_secs:30,agents:'all',states:['idle'],status_text:true}}];
  await manualPolling(page); await page.addInitScript(()=>{const original=Date.now;Date.now=()=>original()+864000000;}); await reloadPage(page);
  assert.equal(await page.evaluate(()=>waitingClocks.has(localKey(1))),false,'the bounded list preview carries only is_waiting');
  const pending=await holdRequest(page,url=>url.pathname==='/agents/1'&&url.searchParams.get('offset')==='0','GET');
  await page.locator('[data-action=details]').click(); await pending.started;
  data.agents[0].waiting.remaining_secs=28; await page.waitForTimeout(1100);
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>document.querySelector('#agent-details dd [data-wait-agent="1"]'));
  const text=await page.locator('#agent-details dd [data-wait-agent="1"]').textContent(), remaining=Number.parseInt(text,10);
  assert.ok(remaining>10&&remaining<=30,`server-calibrated timeout, got ${text}`);
  assert.equal(await page.evaluate(()=>waitingClocks.get(localKey(1)).waiting.remaining_secs),undefined,'chunkable details contain only stable absolute fields');
  assert.equal(data.detailRequests.filter(url=>new URL(url,'http://test').pathname==='/agents/1'&&!new URL(url,'http://test').searchParams.has('offset')).length,1,'there was no version-change restart');
  assert.ok(data.detailRequests.some(url=>url.startsWith('/agents/1?offset=')));
  assert.equal(data.requests.length,0);
}));

test('typed log timestamps render locally while raw bytes, multiline chunks and selections remain intact', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Logged',state:'idle'}];
  data.agentLogs[1]=Array.from({length:30},(_,i)=>`[2026-10-15T12:34:${String(i).padStart(2,'0')}Z] [${i%2?'tool':'message'}] Entry ${i} ${'☃ text '.repeat(130)}\nContinuation ${i}`);
  await manualPolling(page); await reloadPage(page); await page.locator('[data-action=details]').click(); await page.locator('#agent-log').filter({hasText:'Entry 29'}).waitFor();
  while(await page.locator('#log-older').isVisible()) {await page.locator('#log-older').click();await page.waitForFunction(()=>!logLoading&&!document.querySelector('#log-older').disabled);}
  const raw=data.agentLogs[1].join('\n');
  assert.equal(await page.evaluate(()=>agentLog.text),raw);
  assert.equal(await page.evaluate(()=>agentLog.end),Buffer.byteLength(raw));
  const expected=await page.evaluate(raw=>raw.replace(/^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\] /gm,(_,iso)=>`[${new Date(iso).toLocaleString()}] `),raw);
  assert.equal(await page.locator('#agent-log').textContent(),expected);
  assert.match(await page.locator('#agent-log').textContent(),/\[tool\] Entry 29.*\nContinuation 29/);
  const selected=await selectText(page,'#agent-log');
  data.agentLogs[1].push('[2026-10-15T12:35:00Z] [error] Later failure'); await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.locator('#agent-log').textContent(),expected);
  await page.evaluate(()=>getSelection().removeAllRanges()); await page.evaluate(()=>refresh());
  assert.match(await page.locator('#agent-log').textContent(),/\[error\] Later failure$/);
  assert.equal((await page.locator('#agent-log').textContent()).split('Entry 0 ').length-1,1);
}));

test('current-project bulk counts ignore search and paging, reset on project switches, and disable unknown or zero totals', async () => fixture(async (page,data) => {
  data.pageLimit=1;
  data.agents=[{id:1,project:projectId(1),state:'working'},{id:2,project:projectId(1),state:'done'},{id:3,project:projectId(1),state:'paused',pause_reason:'restart'},{id:4,project:projectId(1),state:'paused',pause_reason:'user'},{id:5,project:projectId(2),state:'idle'},{id:6,project:projectId(2),state:'paused',pause_reason:'limit'}];
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('#system-menu').evaluate(menu=>menu.open),false,'global controls start collapsed');
  assert.equal(await page.locator('#pause-all').isVisible(),false);
  assert.equal(await page.locator('#pause-project').isVisible(),true);
  const counts=async()=>Promise.all(['pause-project-count','resume-project-count','restart-project-count'].map(id=>page.locator(`#${id}`).textContent()));
  assert.deepEqual(await counts(),['(2)','(2)','(1)']);
  await page.locator('#agent-search').fill('no matching agents');
  await page.waitForFunction(()=>!agentSearchTimer&&!state.pages.agentBrowser?.pending);
  assert.deepEqual(await counts(),['(2)','(2)','(1)'],'bulk eligibility is not the loaded or searched agent count');
  const pending=await holdRequest(page,`**/overview?project=${projectId(2)}*`,'GET');
  await page.locator('#project-select').selectOption(projectId(2)); await pending.started;
  for(const id of ['pause-project','resume-project','resume-project-restart'])assert.equal(await page.locator(`#${id}`).isDisabled(),true);
  assert.deepEqual(await counts(),['(checking)','(checking)','(checking)']);
  await page.locator('#pause-project').dispatchEvent('click');
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
  assert.deepEqual(await counts(),['(1)','(1)','(0)']);
  assert.equal(await page.locator('#resume-project-restart').isDisabled(),true);
  assert.equal(await page.locator('#pause-project').getAttribute('title'),`Project “other” (#${projectId(2)}) only`);
  data.unknownProjectCounts=true; await page.evaluate(()=>refresh());
  assert.deepEqual(await counts(),['(checking)','(checking)','(checking)']);
  for(const id of ['pause-project','resume-project','resume-project-restart']) {assert.equal(await page.locator(`#${id}`).isDisabled(),true);await page.locator(`#${id}`).dispatchEvent('click');}
  data.unknownProjectCounts=false; data.agents.filter(a=>a.project===projectId(2)).forEach(a=>a.state='closed'); await page.evaluate(()=>refresh());
  assert.deepEqual(await counts(),['(0)','(0)','(0)']);
  assert.equal(await page.locator('#pause-project').isDisabled(),true);
  assert.equal(await page.locator('#resume-project').isDisabled(),true);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#system-menu').evaluate(menu=>menu.open),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await openGlobalActions(page); await page.locator('#system-menu > summary').focus(); await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#system-menu').evaluate(menu=>menu.open),true,'polling preserves menu state');
  assert.equal(await page.locator('#system-menu > summary').evaluate(summary=>document.activeElement===summary),true,'polling preserves menu focus');
  data.projects=[]; data.agents=[]; await page.evaluate(()=>refresh());
  assert.deepEqual(await counts(),['(0)','(0)','(0)']);
  for(const id of ['pause-project','resume-project','resume-project-restart'])assert.equal(await page.locator(`#${id}`).isDisabled(),true);
  assert.equal(await page.locator('#pause-project').getAttribute('title'),'Select a project');
  assert.equal(data.requests.length,0);
}));

test('current-project Pause, Resume and restart-only Resume confirm their project and never affect other projects', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'working'},{id:2,project:projectId(2),state:'idle'},{id:3,project:projectId(1),state:'done'},{id:4,project:projectId(1),state:'paused',pause_reason:'restart'},{id:5,project:projectId(1),state:'paused',pause_reason:'user'},{id:6,project:projectId(2),state:'paused',pause_reason:'restart'}];
  data.locks=[{id:1,project:projectId(1),name:'mine',holder:1},{id:2,project:projectId(2),name:'elsewhere',holder:2}];
  await manualPolling(page); await reloadPage(page);
  const confirmations=[];
  page.on('dialog',dialog=>{confirmations.push(dialog.message());return confirmations.length===1?dialog.dismiss():dialog.accept();});
  await page.locator('#pause-project').click();
  assert.equal(data.requests.length,0,'canceling a project confirmation is read-only');
  await page.locator('#pause-project').click();
  await page.waitForFunction(()=>!bulkAction&&state.projectActions.pause_eligible===0);
  assert.deepEqual(data.agents.map(a=>a.state),['paused','idle','paused','paused','paused','paused']);
  assert.deepEqual(data.agents.map(a=>a.pause_reason),['user',undefined,'user','restart','user','restart']);
  assert.deepEqual(data.locks.map(l=>l.holder),[null,2]);
  await page.locator('#resume-project-restart').click();
  await page.waitForFunction(()=>!bulkAction&&state.projectActions.restart_paused===0);
  assert.deepEqual(data.agents.map(a=>a.state),['paused','idle','paused','working','paused','paused']);
  assert.equal(await page.locator('#toast').textContent(),`Resumed 1 restart-paused agents in project “example” (#${projectId(1)}).`);
  await page.locator('#resume-project').click();
  await page.waitForFunction(()=>!bulkAction&&state.projectActions.resume_eligible===0);
  assert.deepEqual(data.agents.map(a=>a.state),['working','idle','working','working','working','paused']);
  assert.deepEqual(data.requests,[{url:'/pause-all',method:'POST',body:{project:projectId(1)}},{url:'/resume-restart',method:'POST',body:{project:projectId(1)}},{url:'/resume-all',method:'POST',body:{project:projectId(1)}}]);
  assert.deepEqual(confirmations,[...Array(2).fill(`Pause 2 eligible agents in project “example” (#${projectId(1)})? This stops their processes and releases their locks.`),`Resume 1 restart-paused agent in project “example” (#${projectId(1)})? This may start work and consume provider quota.`,`Resume 3 paused agents in project “example” (#${projectId(1)})? This may start work and consume provider quota.`]);
}));

test('project bulk actions capture their scope across project switches and lock both scopes until completion', async () => fixture(async (page,data) => {
  await manualPolling(page); await reloadPage(page);
  page.on('dialog',dialog=>dialog.accept());
  for(const [button,endpoint,initial] of [['pause-project','pause-all','idle'],['resume-project','resume-all','paused'],['resume-project-restart','resume-restart','paused']]) {
    data.agents=[{id:1,project:projectId(1),state:initial,pause_reason:'restart'},{id:2,project:projectId(2),state:initial,pause_reason:'restart'}];
    await page.locator('#project-select').selectOption(projectId(1)); await page.waitForFunction(()=>state.selectedProject===projectId(1)&&refreshPending===0); await page.evaluate(()=>refresh());
    const pending=await holdRequest(page,`**/${endpoint}`);
    await page.locator(`#${button}`).click(); await pending.started;
    await page.locator('#project-select').selectOption(projectId(2)); await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
    await openGlobalActions(page);
    for(const id of ['pause-project','resume-project','resume-project-restart','pause-all','resume-all','resume-restart']) {
      assert.equal(await page.locator(`#${id}`).isDisabled(),true);
      await page.locator(`#${id}`).dispatchEvent('click');
    }
    pending.release(); await pending.remove();
    await page.waitForFunction(()=>!bulkAction&&refreshPending===0);
    assert.equal(await page.locator('#project-select').inputValue(),projectId(2));
    assert.equal(data.agents[0].state,initial==='idle'?'paused':'working');
    assert.equal(data.agents[1].state,initial);
    assert.deepEqual(data.requests.at(-1),{url:`/${endpoint}`,method:'POST',body:{project:projectId(1)}});
    assert.ok((await page.locator('#toast').textContent()).includes(`in project “example” (#${projectId(1)})`));
  }
  assert.equal(data.requests.length,3,'cross-scope clicks never issue another mutation');
}));

test('failed project bulk requests unlock both scopes without retrying or changing agents', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'paused',pause_reason:'restart'},{id:2,project:projectId(2),state:'paused',pause_reason:'restart'}];
  data.resumeRestartError='Scoped resume unavailable';
  await manualPolling(page); await reloadPage(page); await openGlobalActions(page);
  page.on('dialog',dialog=>dialog.accept());
  await page.locator('#resume-project-restart').click();
  await page.waitForFunction(()=>!bulkAction&&document.querySelector('#toast').textContent==='Scoped resume unavailable');
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#resume-project-restart').isEnabled(),true);
  assert.equal(await page.locator('#resume-restart').isEnabled(),true);
  assert.deepEqual(data.requests,[{url:'/resume-restart',method:'POST',body:{project:projectId(1)}}]);
  assert.ok(data.agents.every(a=>a.state==='paused'));
}));

test('all-project Pause and Resume counts remain exact across pages and project switches and disable zero or unknown totals', async () => fixture(async (page,data) => {
  data.pageLimit=1; data.agents=[{id:1,project:projectId(1),state:'working'},{id:2,project:projectId(2),state:'idle'},{id:3,project:projectId(2),state:'done'},{id:4,project:projectId(1),state:'paused',pause_reason:'limit'},{id:5,project:projectId(2),state:'paused',pause_reason:'restart'},{id:6,project:projectId(2),state:'crashed'},{id:7,project:projectId(1),state:'closed'},{id:8,project:projectId(1),state:'replaced'}];
  await manualPolling(page); await reloadPage(page);
  assert.equal(await page.locator('#pause-all-count').textContent(),'(3 · all projects)');
  assert.equal(await page.locator('#resume-all-count').textContent(),'(2 · all projects)');
  assert.equal(await page.locator('#restart-paused-count').textContent(),'(1 · all projects)');
  await page.locator('#project-select').selectOption(projectId(2)); await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
  assert.equal(await page.locator('#pause-all-count').textContent(),'(3 · all projects)');
  assert.equal(await page.locator('#resume-all-count').textContent(),'(2 · all projects)');
  data.unknownGlobalCounts=true; await page.evaluate(()=>refresh());
  for(const action of ['pause','resume']) {assert.equal(await page.locator(`#${action}-all`).isDisabled(),true);assert.equal(await page.locator(`#${action}-all-count`).textContent(),'(checking · all projects)');}
  assert.equal(await page.locator('#resume-restart').isDisabled(),true);
  assert.equal(await page.locator('#restart-paused-count').textContent(),'(checking · all projects)');
  await page.locator('#pause-all').dispatchEvent('click'); await page.locator('#resume-all').dispatchEvent('click');
  data.unknownGlobalCounts=false; for(const agent of data.agents)agent.state='closed'; await page.evaluate(()=>refresh());
  for(const action of ['pause','resume']) {assert.equal(await page.locator(`#${action}-all`).isDisabled(),true);assert.equal(await page.locator(`#${action}-all-count`).textContent(),'(0 · all projects)');}
  assert.equal(data.requests.length,0);
}));

test('lifecycle history is on-demand, bounded, deduplicated and keeps state timestamps and selected text', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Lifecycle',state:'idle'}];
  const change=id=>({id,agent:1,at:100+id,kind:'agent.state',details:{from:'working',to:'paused'}});
  data.history=Array.from({length:35},(_,i)=>change(i+1));
  await manualPolling(page); await reloadPage(page); await page.locator('[data-action=details]').click(); await page.locator('#agent-log').waitFor();
  assert.equal(data.getRequests.filter(url=>url.startsWith('/history?')).length,0);
  await page.locator('#agent-lifecycle summary').click();
  await page.waitForFunction(()=>agentLifecycle?.events.length===30&&!lifecycleLoading);
  assert.match(await page.locator('#agent-lifecycle-items').textContent(),/#35 · working → paused/);
  assert.equal(await page.locator('#agent-lifecycle-items time').first().textContent(),await page.evaluate(()=>new Date(135000).toLocaleString()));
  await page.locator('#lifecycle-older').click(); await page.waitForFunction(()=>agentLifecycle?.events.length===35&&!lifecycleLoading);
  assert.equal(await page.locator('#lifecycle-older').isHidden(),true);
  const selected=await selectText(page,'#agent-lifecycle-items .event > div');
  data.history.push(change(36)); await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.waitForFunction(()=>document.querySelector('#agent-lifecycle-items').textContent.includes('#36 ·'));
  assert.equal(await page.locator('#agent-lifecycle-items .event').count(),35);
  assert.equal(new Set(await page.evaluate(()=>agentLifecycle.events.map(event=>event.id))).size,35);
  await page.locator('#lifecycle-older').click(); await page.waitForFunction(()=>agentLifecycle?.events.length===36&&!lifecycleLoading);
  assert.deepEqual(await page.evaluate(()=>agentLifecycle.events.map(event=>event.id)),Array.from({length:36},(_,i)=>36-i));
  assert.ok(data.getRequests.filter(url=>url.startsWith('/history?')).every(url=>{const q=new URL(url,'http://test').searchParams;return q.get('agent')==='1'&&q.get('kind')==='agent.state'&&q.get('limit')==='30'&&q.get('max_bytes')==='16000';}));
}));

test('lifecycle history restarts a large burst without gaps, recovers from failure and ignores a closed agent pane', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Lifecycle',state:'idle'}];
  const change=id=>({id,agent:1,at:id,kind:'agent.state',details:{from:'idle',to:'working'}});
  data.history=[];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-action=details]').click(); await page.locator('#agent-log').waitFor();
  await page.locator('#agent-lifecycle summary').click(); await page.waitForFunction(()=>agentLifecycle&&!lifecycleLoading);
  data.history=Array.from({length:40},(_,i)=>change(i+1)); await page.evaluate(()=>refresh());
  assert.deepEqual(await page.evaluate(()=>agentLifecycle.events.map(event=>event.id)),Array.from({length:30},(_,i)=>40-i));
  data.history.push(...Array.from({length:40},(_,i)=>change(i+41))); await page.evaluate(()=>refresh());
  assert.deepEqual(await page.evaluate(()=>agentLifecycle.events.map(event=>event.id)),Array.from({length:30},(_,i)=>80-i));
  data.historyFailure=true; await page.evaluate(()=>refresh());
  assert.match(await page.locator('#agent-lifecycle-error').textContent(),/History offline/);
  assert.equal(await page.locator('#agent-lifecycle-items .event').count(),30);
  data.historyFailure=false; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-lifecycle-error').isHidden(),true);
  const pending=await holdRequest(page,url=>url.pathname==='/history'&&url.searchParams.has('before'),'GET');
  await page.locator('#lifecycle-older').click(); await pending.started;
  await page.locator('#agent-dialog .dialog-actions button').click(); pending.release(); await pending.remove(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#agent-dialog').isVisible(),false);
  assert.equal(await page.locator('#agent-lifecycle-items .event').count(),30,'a late page cannot update a closed pane');
}));

test('event subscriptions are on-demand, bounded and show deferred-wait IDs, conditions and completion reasons', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.agents=[{id:1,project:projectId(1),name:'Coordinator',state:'idle'}];
  data.subscriptionPending={1:2};
  data.subscriptions=[
    {id:1,agent:1,mode:'persistent',state:'active',created_at:100,watch:{agents:[2,3],states:['crashed','done'],status_text:true}},
    {id:2,agent:1,mode:'once',state:'active',created_at:101,deadline:200,watch:{}},
    {id:3,agent:1,mode:'once',state:'resolved',created_at:102,deadline:201,completed_at:120,completion:{kind:'message',summary:'a private notification'},watch:{}},
    {id:4,agent:1,mode:'persistent',state:'active',created_at:103,watch:{usage:{provider:'claude',window:'five_hour <test>',condition:'above',percent:80}}},
  ];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-action=details]').click();
  await page.waitForFunction(()=>document.querySelector('#agent-subscription-count').textContent.includes('3 active'));
  assert.match(await page.locator('#agent-subscription-count').textContent(),/3 active · 2 pending events/);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/subscriptions')).length,0);
  await page.locator('#agent-subscriptions summary').click(); await page.waitForFunction(()=>agentSubscriptions?.items.length===2&&!subscriptionsLoading);
  assert.match(await page.locator('#agent-subscription-items').textContent(),/Subscription #4.*claude \/ five_hour <test>: above 80%.*Deferred wait #3.*Resolved early by a private notification; timeout canceled/s);
  assert.equal(await page.locator('#agent-subscription-items test').count(),0);
  await page.locator('#subscriptions-more').click(); await page.waitForFunction(()=>agentSubscriptions?.items.length===4&&!subscriptionsLoading);
  assert.match(await page.locator('[data-subscription="1"]').textContent(),/agents #2, #3 · states: crashed, done · status text/);
  assert.match(await page.locator('[data-subscription="2"]').textContent(),/Deferred wait #2.*Own notifications.*Deadline:/s);
  assert.equal(await page.locator('[data-subscription="2"] time').textContent(),await page.evaluate(()=>new Date(101000).toLocaleString()));
  assert.equal(await page.locator('[data-subscription="3"] [data-cancel-subscription]').count(),0);
  assert.equal(await page.locator('#subscriptions-more').isHidden(),true);
  data.subscriptions[3].watch.usage={provider:'claude',window:'five_hour',condition:'reset-due'}; await page.evaluate(()=>refresh());
  assert.match(await page.locator('[data-subscription="4"]').textContent(),/estimated reset due \(unconfirmed\)/);
  data.subscriptions[3].watch.usage={provider:'claude',window:'five_hour',condition:'below',percent:80}; await page.evaluate(()=>refresh());
  assert.match(await page.locator('[data-subscription="4"]').textContent(),/below 80%/);
  assert.ok(data.getRequests.filter(url=>url.startsWith('/subscriptions?')).every(url=>{const q=new URL(url,'http://test').searchParams;return q.get('agent')==='1'&&q.get('limit')==='30'&&q.get('max_bytes')==='16000';}));
  assert.equal(data.requests.length,0);
}));

test('canceling subscriptions prevents duplicate requests, updates counts and preserves lifecycle and failed actions', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Coordinator',state:'idle'}];
  data.subscriptions=[{id:1,agent:1,mode:'once',state:'active',created_at:100,deadline:200,watch:{}}];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-action=details]').click();
  await page.locator('#agent-subscriptions summary').click(); await page.locator('[data-cancel-subscription="1"]').waitFor();
  await page.locator('[data-cancel-subscription="1"]').focus();
  data.subscriptions[0].watch={agents:[2],states:['crashed']}; await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.cancelSubscription),'1','polling preserves keyboard focus on a subscription action');
  data.cancelSubscriptionDelay=300;
  await page.locator('[data-cancel-subscription="1"]').click();
  await page.locator('[data-cancel-subscription="1"]').dispatchEvent('click');
  await page.waitForFunction(()=>document.querySelector('[data-subscription="1"]').textContent.includes('canceled'));
  await page.waitForFunction(()=>document.querySelector('#agent-subscription-count').textContent.includes('0 active')&&!agentLoading);
  assert.equal(data.requests.length,1); assert.deepEqual(data.requests[0],{url:'/subscriptions/1/cancel',method:'POST',body:{agent:0}});
  assert.match(await page.locator('#agent-subscription-count').textContent(),/0 active/);
  assert.equal(data.agents[0].state,'idle');
  assert.equal(await page.locator('[data-cancel-subscription="1"]').count(),0);
  data.subscriptions.push({id:2,agent:1,mode:'persistent',state:'active',created_at:101,watch:{agents:'all',states:['crashed']}});
  await page.evaluate(()=>refresh());
  data.cancelSubscriptionError='Cancel <failed>';
  await page.locator('[data-cancel-subscription="2"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-cancel-subscription="2"]').disabled);
  assert.equal(await page.locator('#toast').textContent(),'Cancel <failed>');
  assert.equal(data.subscriptions[1].state,'active'); assert.equal(data.agents[0].state,'idle');
  assert.equal(data.requests.filter(request=>!request.url.startsWith('/subscriptions/')).length,0);
}));

test('subscription paging restarts changed snapshots without gaps and polling preserves selected conditions', async () => fixture(async (page,data) => {
  data.pageLimit=2; data.agents=[{id:1,project:projectId(1),name:'Coordinator',state:'idle'}];
  const row=id=>({id,agent:1,mode:'persistent',state:'active',created_at:id,watch:{agents:[id+10],states:['done']}});
  data.subscriptions=Array.from({length:5},(_,i)=>row(i+1));
  await manualPolling(page); await reloadPage(page); await page.locator('[data-action=details]').click();
  await page.locator('#agent-subscriptions summary').click(); await page.waitForFunction(()=>agentSubscriptions?.items.length===2&&!subscriptionsLoading);
  data.subscriptions.push(row(6),row(7)); data.subscriptions[3].state='resolved';
  await page.locator('#subscriptions-more').click(); await page.waitForFunction(()=>agentSubscriptions?.items.length===7&&!subscriptionsLoading);
  assert.deepEqual(await page.locator('[data-subscription]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.subscription))),[7,6,5,4,3,2,1]);
  assert.equal(new Set(await page.evaluate(()=>agentSubscriptions.items.map(item=>item.id))).size,7);
  const selected=await selectText(page,'[data-subscription="7"] > div');
  data.subscriptions[6].state='canceled'; await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.waitForFunction(()=>document.querySelector('[data-subscription="7"]').textContent.includes('canceled'));
  assert.equal(await page.locator('[data-subscription]').count(),7);
  assert.equal(data.requests.length,0);
}));

test('subscription failures retain the last view, oversized watches load explicitly and closed panes ignore late pages', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Coordinator',state:'idle'}];
  data.subscriptions=[{id:1,agent:1,mode:'persistent',state:'active',created_at:100,watch:{usage:{provider:'claude',window:'large '.repeat(5000),condition:'below',percent:80}}}];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-action=details]').click();
  await page.locator('#agent-subscriptions summary').click(); await page.waitForFunction(()=>agentSubscriptions?.items.length===1&&!subscriptionsLoading);
  assert.equal(await page.locator('[data-subscription="1"] [data-record=subscriptions]').count(),1);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/subscriptions/1')).length,0,'an oversized watch is not eagerly hydrated');
  await page.locator('[data-subscription="1"] [data-record=subscriptions]').click();
  await page.waitForFunction(()=>document.querySelector('#record-content').textContent.includes('large large'));
  assert.equal(await page.locator('#record-title').textContent(),'subscriptions #1');
  await page.locator('#record-dialog .dialog-actions button').click();
  data.subscriptionFailure='Subscriptions offline'; await page.evaluate(()=>refresh());
  assert.match(await page.locator('#agent-subscriptions-error').textContent(),/Subscriptions offline/);
  assert.equal(await page.locator('[data-subscription]').count(),1);
  data.subscriptionFailure=null; await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-subscriptions-error').isHidden(),true);
  const pending=await holdRequest(page,url=>url.pathname==='/subscriptions','GET');
  await page.evaluate(()=>{window.pendingSubscriptions=loadAgentSubscriptions(selectedAgent,agentRequest);}); await pending.started;
  await page.locator('#agent-dialog .dialog-actions button').click(); data.subscriptions=[];
  pending.release(); await pending.remove(); await page.evaluate(()=>window.pendingSubscriptions);
  assert.equal(await page.locator('#agent-dialog').isVisible(),false);
  assert.equal(await page.locator('[data-subscription]').count(),1,'late responses do not redraw a closed pane');
  assert.equal(data.requests.length,0);
}));

test('coordination warnings remain advisory, escaped and visible in compact cards and on-demand bounded history', async () => fixture(async (page,data) => {
  const warning=id=>({id,agent:1,at:100+id,kind:'coordination.suspected-loop',details:{summary:'Repeated A → B → A <wake> pattern',agents:[1,2],subscriptions:[3,4],events:[5,6]}});
  data.agents=[{id:1,project:projectId(1),name:'Coordinator '.repeat(1500),state:'idle',has_diagnostics:true,diagnostics:{suspected_loop:true,items:[warning(35)]}}];
  data.history=Array.from({length:35},(_,i)=>warning(i+1));
  await manualPolling(page); await reloadPage(page);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Coordination warning/);
  assert.equal(data.detailRequests.length,0);
  await page.locator('[data-action=details]').click(); await page.locator('#agent-coordination-warning').waitFor();
  assert.match(await page.locator('#agent-coordination-warning').textContent(),/Advisory only; no automatic intervention.*Repeated A → B → A <wake> pattern/s);
  assert.equal(await page.locator('#agent-coordination-warning wake').count(),0);
  assert.equal(await page.locator('#agent-title').textContent(),`${data.agents[0].name} · #1`,'a bounded dialog heading preserves the complete agent name');
  assert.equal(await page.locator('#agent-title').getAttribute('tabindex'),'0');
  assert.equal(await page.locator('#agent-title').evaluate(node=>{
    const dialog=node.closest('dialog').getBoundingClientRect(), header=node.closest('.dialog-header').getBoundingClientRect();
    return header.height<dialog.height/2&&node.scrollHeight>node.clientHeight;
  }),true,'very long dialog headings scroll locally instead of covering the remaining controls');
  await page.locator('#agent-title').focus(); await page.keyboard.press('PageDown');
  await page.waitForFunction(()=>document.querySelector('#agent-title').scrollTop>0);
  assert.equal(await page.locator('#agent-dialog .dialog-close').evaluate(node=>{
    const box=node.getBoundingClientRect();return node.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2));
  }),true,'the close control remains reachable beside a long heading');
  assert.equal(data.getRequests.filter(url=>url.startsWith('/history?')).length,0);
  await page.locator('#agent-diagnostics summary').click(); await page.waitForFunction(()=>agentDiagnostics?.events.length===30&&!diagnosticsLoading);
  assert.match(await page.locator('#agent-diagnostics-items').textContent(),/#35.*agents: #1, #2.*subscriptions: #3, #4.*events: #5, #6/s);
  const selected=await selectText(page,'#agent-diagnostics-items .event > div');
  data.history.push(warning(36)); await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.waitForFunction(()=>document.querySelector('#agent-diagnostics-items').textContent.includes('#36 ·'));
  await page.locator('#diagnostics-older').click(); await page.waitForFunction(()=>agentDiagnostics?.events.length===36&&!diagnosticsLoading);
  assert.equal(await page.locator('#diagnostics-older').isHidden(),true);
  assert.equal(await page.locator('#agent-diagnostics-items wake').count(),0);
  assert.equal(data.agents[0].state,'idle'); assert.equal(data.requests.length,0);
  assert.ok(data.getRequests.filter(url=>url.startsWith('/history?')).every(url=>{const q=new URL(url,'http://test').searchParams;return q.get('kind')==='coordination.suspected-loop'&&q.get('limit')==='30'&&q.get('max_bytes')==='16000';}));
}));

test('thread ordering is server-paged, stable across ties and never limited to the currently loaded IDs',async()=>fixture(async(page,data)=>{
  data.pageLimit=2;
  data.threads=[
    conversation([incoming(1)],{id:1,title:'Gamma',created_at:1}),
    conversation([{...incoming(2),at:300}],{id:2,title:'Beta',created_at:2}),
    conversation([{...incoming(3),at:300}],{id:3,title:'Alpha',created_at:3}),
    conversation([],{id:4,title:'Delta',created_at:4}),
    conversation([{...incoming(4),at:400}],{id:5,title:'Epsilon',created_at:5}),
  ];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('#thread-sort').inputValue(),'latest_message');
  assert.deepEqual(await page.evaluate(()=>state.threads.map(thread=>thread.id)),[5,3]);
  await page.locator('[data-more=threads]').click();await page.waitForFunction(()=>state.threads.length===4);
  await page.locator('[data-more=threads]').click();await page.waitForFunction(()=>state.threads.length===5);
  assert.deepEqual(await page.evaluate(()=>state.threads.map(thread=>thread.id)),[5,3,2,1,4]);
  assert.equal(new Set(await page.evaluate(()=>state.threads.map(thread=>thread.id))).size,5);
  assert.ok(data.getRequests.filter(url=>url.startsWith('/threads?')).some(url=>new URL(url,'http://test').searchParams.has('cursor')));
  assert.ok(data.getRequests.filter(url=>url.startsWith('/threads?')).every(url=>{const query=new URL(url,'http://test').searchParams;return !query.has('before')&&!query.has('through');}));
  for(const [sort,expected] of [['newest',[5,4]],['oldest',[1,2]],['title',[3,2]]]) {
    await page.locator('#thread-sort').selectOption(sort);
    await page.waitForFunction(expected=>state.pages.threads?.scope===collectionPath('threads')&&state.threads.map(thread=>thread.id).join(',')===expected.join(','),expected);
  }
  await reloadPage(page);assert.equal(await page.locator('#thread-sort').inputValue(),'title','the browser retains its chosen order');
}));

test('changing thread sort preserves an open conversation, its selection, draft and scroll, and rejects stale sort responses',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([incoming(1,'Retained long message. '.repeat(200))],{id:1,title:'Zeta',created_at:1}),conversation([],{id:2,title:'Alpha',created_at:2})];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();await page.locator('[data-thread="1"]').click();
  await page.locator('[data-message="1"]').waitFor();await page.locator('#message-form textarea').fill('Retain this draft');
  await page.locator('#messages').evaluate(node=>node.scrollTop=100);
  const selected=await selectText(page,'[data-message="1"] .message-text'),scroll=await page.locator('#messages').evaluate(node=>node.scrollTop);
  const held=await holdRequest(page,url=>url.pathname==='/threads'&&url.searchParams.get('sort')==='oldest','GET');
  await page.locator('#thread-sort').selectOption('oldest');await held.started;
  await page.locator('#thread-sort').selectOption('title');
  await page.waitForFunction(()=>state.pages.threads?.scope===collectionPath('threads')&&state.threads[0]?.id===2);
  held.release();await held.remove();await page.waitForFunction(()=>!state.pages.threads.pending);
  assert.equal(await page.locator('#thread-sort').inputValue(),'title');
  assert.deepEqual(await page.evaluate(()=>state.threads.map(thread=>thread.id)),[2,1]);
  assert.equal(await page.evaluate(()=>state.selectedThread),1);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Retain this draft');
  assert.equal(await page.locator('#messages').evaluate(node=>node.scrollTop),scroll);
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
}));

test('live thread reordering preserves retained row nodes, selected metadata and a scrolled list anchor',async()=>fixture(async(page,data)=>{
  data.threads=Array.from({length:20},(_,index)=>conversation([incoming(index+1)],{id:index+1,title:`Conversation ${index+1}`}));
  await manualPolling(page);await reloadPage(page);await page.locator('[data-page=threads]').click();
  const row=page.locator('[data-thread="10"]');await row.scrollIntoViewIfNeeded();
  const selected=await selectText(page,'[data-thread="10"] strong'),top=await row.evaluate(node=>node.getBoundingClientRect().top);
  await page.evaluate(()=>window.retainedThread=document.querySelector('[data-thread="10"]'));
  data.threads[0].messages.push({...incoming(21),at:500});await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>state.threads[0].id),1,'a new message moves an older thread to the top');
  assert.equal(await page.evaluate(()=>document.querySelector('[data-thread="10"]')===window.retainedThread),true);
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.ok(Math.abs(await row.evaluate(node=>node.getBoundingClientRect().top)-top)<2,'live ordering does not move the reader’s anchor');
}));

test('workspace thread search scopes participation filters without discarding an open conversation draft', async () => fixture(async (page,data) => {
  data.threads=[
    conversation([],{id:1,title:'Design review'}),
    conversation([],{id:2,title:'Review between agents',members:[1,2]}),
    conversation([],{id:3,title:'Release plan'}),
  ];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Keep the design notes');
  const search=page.locator('#thread-search');
  assert.ok(await search.getAttribute('aria-label') || await search.evaluate(el=>el.labels?.length));
  await search.fill('REVIEW');
  await page.waitForFunction(()=>document.querySelectorAll('#thread-list [data-thread]').length===1);
  assert.equal(await page.locator('#thread-list [data-thread]').count(),1);
  await page.locator('[data-thread-filter=all]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#thread-list [data-thread]').length===2);
  assert.equal(await page.locator('#thread-list [data-thread]').count(),2);
  await page.locator('[data-thread-filter=agents]').click();
  await page.locator('#thread-list [data-thread="2"]').waitFor();
  assert.equal(await page.locator('#thread-list [data-thread="2"]').count(),1);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep the design notes');
  await search.fill('nothing matches this query');
  await page.waitForFunction(()=>document.querySelectorAll('#thread-list [data-thread]').length===0);
  assert.equal(await page.locator('#thread-list [data-thread]').count(),0);
  assert.match(await page.locator('#thread-list').textContent(),/no .*match/i);
  await page.evaluate(()=>refresh());
  assert.equal(await search.inputValue(),'nothing matches this query');
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep the design notes');
  await search.fill('');
  await page.locator('[data-thread-filter=mine]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#thread-list [data-thread]').length===2);
  assert.equal(await page.locator('#thread-list [data-thread]').count(),2);
  assert.equal(data.requests.length,0,'browsing empty conversations does not write to the API');
}));

test('workspace theme follows the system until changed and persists the explicit choice across reloads', async () => fixture(async page => {
  const background=()=>page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor);
  await manualPolling(page); await page.emulateMedia({colorScheme:'dark'}); await reloadPage(page);
  const dark=await background();
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(dark=>getComputedStyle(document.body).backgroundColor!==dark,dark);
  const light=await background();
  await page.locator('#theme-toggle').click();
  assert.equal(await background(),dark);
  assert.equal(await page.evaluate(()=>localStorage.getItem('acom:theme')),'dark');
  await reloadPage(page);
  assert.equal(await background(),dark);
  await page.emulateMedia({colorScheme:'dark'}); await page.emulateMedia({colorScheme:'light'});
  assert.equal(await background(),dark,'a saved preference takes priority over later system changes');
  await page.locator('#theme-toggle').click();
  assert.equal(await background(),light);
  assert.equal(await page.evaluate(()=>localStorage.getItem('acom:theme')),'light');
  await page.emulateMedia({colorScheme:'dark'}); await reloadPage(page);
  assert.equal(await background(),light);
}));

test('workspace theme stays usable when browser storage is unavailable', async () => fixture(async (page,data) => {
  await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage blocked');}}));
  await page.emulateMedia({colorScheme:'light'}); await reloadPage(page);
  const before=await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor);
  await page.locator('#theme-toggle').click();
  assert.notEqual(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),before);
  await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('#page-threads').isVisible(),true);
  assert.equal(data.requests.length,0);
}));

test('workspace mobile Back preserves the selected conversation and draft without reading hidden arrivals', async () => fixture(async (page,data) => {
  const history=Array.from({length:30},(_,i)=>incoming(i+1,`Earlier reply ${i+1}. ${'A useful update from the project team. '.repeat(3)}`));
  data.threads=[conversation(history),conversation([],{id:2,title:'Other discussion'})];
  await manualPolling(page); await page.setViewportSize({width:390,height:844}); await reloadPage(page);
  await openSidebar(page);
  await page.locator('[data-page=threads]').click();
  assert.equal(await page.locator('.thread-list').isVisible(),true);
  await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>{
    const button=document.querySelector('#message-form button');
    return button && button.getBoundingClientRect().top>=0 && button.getBoundingClientRect().bottom<=innerHeight;
  });
  assert.ok(await page.locator('#messages').evaluate(el=>el.clientHeight>=100),'the mobile conversation leaves useful reading space above the composer');
  await page.waitForFunction(()=>document.querySelector('#thread-unread').hidden);
  assert.equal(data.reads[1],30);
  await page.locator('#message-form textarea').fill('Keep this mobile draft');
  assert.equal(await page.locator('.thread-list').isHidden(),true);
  assert.equal(await page.locator('.thread-layout').evaluate(el=>el.classList.contains('conversation-open')),true);
  await page.locator('#back-to-threads').click();
  assert.equal(await page.locator('.thread-list').isVisible(),true);
  assert.equal(await page.locator('#thread-main').isHidden(),true);
  assert.equal(await page.evaluate(()=>state.selectedThread),1);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep this mobile draft');
  data.threads[0].messages.push({id:31,sender:1,at:Date.now()/1000,text:'Arrived while browsing threads'});
  await page.evaluate(()=>refresh());
  assert.equal(data.reads[1],30,'a hidden conversation does not acknowledge unseen messages');
  assert.match(await page.locator('[data-thread="1"]').textContent(),/1 unread/);
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').waitFor();
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep this mobile draft');
  await page.waitForFunction(()=>document.querySelector('[data-message="31"] .message-text')?.textContent==='Arrived while browsing threads');
  await page.waitForFunction(()=>!document.querySelector('#thread-unread') || document.querySelector('#thread-unread').hidden);
  assert.equal(data.reads[1],31);
  await page.locator('#messages').evaluate(el=>{el.scrollTop=0;});
  const historyScroll=await page.locator('#messages').evaluate(el=>el.scrollTop);
  await page.locator('#back-to-threads').click();
  data.threads[0].messages.push(incoming(32,'Arrived while reading earlier history'));
  await page.evaluate(()=>refresh());
  await page.locator('[data-thread="1"]').click();
  await page.locator('[data-message="32"]').waitFor();
  assert.equal(await page.locator('#messages').evaluate(el=>el.scrollTop),historyScroll,'Back and reopen preserve a reader’s earlier history position');
  assert.equal(await page.locator('#thread-unread').isVisible(),true);
  assert.equal(data.reads[1],31,'returning to earlier history does not acknowledge a reply at the bottom');
  await page.locator('#thread-unread').click();
  await page.waitForFunction(()=>document.querySelector('#thread-unread').hidden);
  assert.equal(data.reads[1],32);
  await page.setViewportSize({width:1280,height:900});
  assert.equal(await page.locator('.thread-list').isVisible(),true);
  assert.equal(await page.locator('#thread-main').isVisible(),true);
  assert.equal(await page.locator('#message-form button').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight),true,'the composer stays in view after changing to a desktop viewport');
  await page.waitForFunction(()=>{
    const messages=document.querySelector('#messages');
    return messages.scrollHeight-messages.scrollTop-messages.clientHeight<36;
  });
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep this mobile draft');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(data.requests.filter(r=>r.url==='/messages').length,0);
}));

test('workspace composer keeps Enter as a newline and submits validated messages with Ctrl or Command Enter', async () => fixture(async (page,data) => {
  data.threads=[conversation([])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  const composer=page.locator('#message-form textarea');
  await composer.fill('First line');
  await composer.press('End'); await composer.press('Enter'); await composer.press('A');
  assert.equal(await composer.inputValue(),'First line\nA');
  assert.equal(data.requests.length,0);
  await composer.press('Control+Enter');
  await page.waitForFunction(()=>document.querySelector('#message-form textarea').value==='');
  assert.deepEqual(data.threads[0].messages.map(m=>m.text),['First line\nA']);
  await composer.press('Control+Enter');
  assert.equal(data.requests.filter(r=>r.url==='/messages').length,1,'an empty required composer does not send');
  await composer.fill('Sent using Command'); await composer.press('Meta+Enter');
  await page.waitForFunction(()=>document.querySelector('#message-form textarea').value==='');
  assert.deepEqual(data.threads[0].messages.map(m=>m.text),['First line\nA','Sent using Command']);
  assert.equal(data.requests.filter(r=>r.url==='/messages').length,2);
}));

test('workspace a pending send stays single-flight after close and reopen and retains a newer persistent draft', async () => fixture(async (page,data) => {
  data.threads=[conversation([])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Submitted message');
  const pending=await holdRequest(page,'**/messages');
  await page.locator('#message-form button').click(); await pending.started;
  await page.locator('#close-thread').click(); await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form button').isDisabled(),true);
  await page.locator('#message-form textarea').fill('Newer unsent draft');
  await page.evaluate(()=>document.querySelector('#message-form').requestSubmit());
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#message-form button').isDisabled(),true,'polling cannot unlock an in-flight send in the reopened pane');
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>!document.querySelector('#message-form button').disabled);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Newer unsent draft');
  assert.deepEqual(data.threads[0].messages.map(m=>m.text),['Submitted message']);
  assert.equal(data.requests.filter(r=>r.url==='/messages').length,1);
  await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Newer unsent draft');
  await page.locator('#message-form button').click();
  await page.waitForFunction(()=>document.querySelector('#message-form textarea').value==='');
  assert.deepEqual(data.threads[0].messages.map(m=>m.text),['Submitted message','Newer unsent draft']);
}));

test('workspace Resume all stays single-flight across polling and recovers from failure without retrying', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Paused worker',state:'paused',pause_reason:'user'}];
  await manualPolling(page); await reloadPage(page);
  await openGlobalActions(page);
  const pending=await holdRequest(page,'**/resume-all');
  await page.locator('#resume-all').click(); await pending.started;
  assert.equal(await page.locator('#resume-all').isDisabled(),true);
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#resume-all').isDisabled(),true);
  await page.locator('#resume-all').dispatchEvent('click');
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>!bulkAction);
  assert.equal(await page.locator('#resume-all').isDisabled(),true);
  assert.equal(data.requests.filter(r=>r.url==='/resume-all').length,1);
  assert.equal(data.agents[0].state,'working');
  data.agents[0].state='paused'; await page.evaluate(()=>refresh());
  data.resumeAllError='Resume all unavailable';
  await page.locator('#resume-all').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Resume all unavailable');
  assert.equal(await page.locator('#resume-all').isEnabled(),true);
  await page.evaluate(()=>refresh());
  assert.equal(data.requests.filter(r=>r.url==='/resume-all').length,2,'an error and later polling never repeat the action');
}));

test('workspace Close and Reopen lock all lifecycle actions while pending and release them after completion or failure', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Lifecycle worker',state:'idle',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
  await manualPolling(page); await reloadPage(page);
  let confirmations=0;
  page.on('dialog',dialog=>{confirmations++;dialog.accept();});
  for(const action of ['close','reopen']) {
    const pending=await holdRequest(page,`**/agents/1/${action}`);
    await page.locator(`[data-agent="1"] [data-action=${action}]`).click(); await pending.started;
    await page.evaluate(()=>refresh());
    const actions=page.locator('[data-agent="1"] [data-action]:not([data-action=details])');
    assert.equal(await actions.evaluateAll(nodes=>nodes.every(node=>node.disabled)),true);
    assert.equal(await page.locator('[data-agent="1"] [data-action=details]').isEnabled(),true);
    await page.locator(`[data-agent="1"] [data-action=${action}]`).dispatchEvent('click');
    pending.release(); await pending.remove();
    await page.waitForFunction(()=>document.querySelector('[data-agent="1"] [data-action]:not([data-action=details])')?.disabled===false);
    assert.equal(data.requests.filter(r=>r.url===`/agents/1/${action}`).length,1);
    assert.equal(data.agents[0].state,action==='close'?'closed':'idle');
  }
  assert.equal(confirmations,2,'Close and Reopen each ask once');
  data.agentTransitionError='Close unavailable';
  await page.locator('[data-agent="1"] [data-action=close]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Close unavailable');
  assert.equal(await page.locator('[data-agent="1"] [data-action=close]').isEnabled(),true);
  await page.evaluate(()=>refresh());
  assert.equal(data.requests.filter(r=>r.url==='/agents/1/close').length,2);
  assert.equal(data.agents[0].state,'idle');
}));

test('workspace membership and usage scheduling remain single-flight through pane and dialog reopening', async () => fixture(async (page,data) => {
  data.threads=[conversation([])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click();
  await page.locator('[data-thread="1"]').click();
  const membership=await holdRequest(page,'**/threads/1/user');
  await openThreadDetails(page); await page.locator('#thread-membership').click(); await membership.started;
  await page.locator('#close-thread').click(); await page.locator('[data-thread="1"]').click();
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#thread-membership').isDisabled(),true);
  await page.locator('#thread-membership').dispatchEvent('click');
  membership.release(); await membership.remove();
  await page.waitForFunction(()=>document.querySelector('#thread-membership').textContent==='Join thread' && !document.querySelector('#thread-membership').disabled);
  assert.equal(data.requests.filter(r=>r.url==='/threads/1/user').length,1);
  assert.equal(data.threads[0].members.includes(0),false);
  await page.locator('[data-page=overview]').click(); await page.locator('[data-usage=codex]').click();
  const usage=await holdRequest(page,'**/usage/check');
  await page.locator('[data-check-usage=codex]').click(); await usage.started;
  await page.locator('#usage-dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('[data-usage=codex]').click(); await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-check-usage=codex]').isDisabled(),true);
  await page.locator('[data-check-usage=codex]').dispatchEvent('click');
  usage.release(); await usage.remove();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Usage check scheduled');
  assert.equal(await page.locator('[data-check-usage=codex]').isEnabled(),true);
  assert.equal(data.requests.filter(r=>r.url==='/usage/check').length,1);
}));

test('manual lifecycle actions each confirm once by default and cancellation never mutates', async () => fixture(async (page,data) => {
  await manualPolling(page); await reloadPage(page);
  for (const [initial,action,verb,consequence,problem] of [['working','pause','Pause',/stops its processes and releases its locks/],['paused','resume','Resume',/start work and consume provider quota/],['crashed','resume','Retry',/same model.*consume provider quota/],['paused','resume','Retry',/same model.*consume provider quota/,'Model not available'],['idle','close','Close',/cannot wake until reopened/],['closed','reopen','Reopen',/start work and consume provider quota/]]) {
    data.agents=[{id:1,project:projectId(1),name:'Careful worker',state:initial,pause_reason:'user',problem}]; await page.evaluate(()=>refresh());
    const prompts=[];
    page.once('dialog',dialog=>{prompts.push(dialog.message());dialog.dismiss();});
    const before=data.requests.length;
    await page.locator(`[data-agent="1"] [data-action=${action}]`).click();
    assert.equal(data.requests.length,before); assert.equal(data.agents[0].state,initial);
    assert.match(prompts[0],new RegExp(`^${verb} agent “Careful worker” \\(#1\\)`)); assert.match(prompts[0],consequence);
    page.once('dialog',dialog=>{prompts.push(dialog.message());dialog.accept();});
    await page.locator(`[data-agent="1"] [data-action=${action}]`).click();
    await page.waitForFunction(()=>agentTransitions.size===0&&refreshPending===0);
    assert.equal(data.requests.length,before+1); assert.deepEqual(prompts,[prompts[0],prompts[0]],'one prompt per click');
  }
}));

test('all six bulk lifecycle controls confirm captured unfiltered scope once and can be canceled', async () => fixture(async (page,data) => {
  await manualPolling(page); await reloadPage(page);
  for (const button of ['pause-project','resume-project','resume-project-restart','pause-all','resume-all','resume-restart']) {
    const pause=button.startsWith('pause'),scoped=button.includes('project');
    data.agents=[{id:1,project:projectId(1),name:'Visible',state:pause?'working':'paused',pause_reason:'restart'},{id:2,project:projectId(1),name:'Hidden by search',state:pause?'idle':'paused',pause_reason:'restart'},{id:3,project:projectId(2),state:pause?'done':'paused',pause_reason:'restart'}];
    await page.evaluate(()=>refresh()); await page.locator('#agent-search').fill('Visible');
    await page.waitForFunction(()=>!agentSearchTimer&&!state.pages.agentBrowser.pending);
    await openGlobalActions(page);
    const prompts=[],before=data.requests.length;
    page.once('dialog',dialog=>{prompts.push(dialog.message());dialog.dismiss();});
    await page.locator(`#${button}`).click(); assert.equal(data.requests.length,before);
    assert.match(prompts[0],new RegExp(`${scoped?2:3} .*agents ${scoped?`in project “example” \\(#${projectId(1)}\\)`:'across all projects'}`));
    assert.match(prompts[0],pause?/stops their processes and releases their locks/:/consume provider quota/);
    page.once('dialog',dialog=>{prompts.push(dialog.message());dialog.accept();});
    await page.locator(`#${button}`).click(); await page.waitForFunction(()=>!bulkAction&&refreshPending===0);
    assert.equal(data.requests.length,before+1); assert.deepEqual(prompts,[prompts[0],prompts[0]]);
    assert.deepEqual(data.requests.at(-1).body,scoped?{project:projectId(1)}:{});
  }
}));

test('confirmation preference applies immediately across projects, persists independently of Default and leaves other warnings enabled', async () => fixture(async (page,data) => {
  data.projects[0].config=configId(1);
  data.agents=[{id:1,project:projectId(1),name:'First',state:'working'},{id:2,project:projectId(2),name:'Second',state:'paused',pause_reason:'user'}];
  data.locks=[{id:1,project:projectId(1),name:'separate lock',holder:1}];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=settings]').click();
  const checkbox=page.locator('#confirm-agent-actions');
  assert.equal(await checkbox.isChecked(),true); assert.equal(await checkbox.isEnabled(),true);
  assert.equal(await checkbox.evaluate(el=>el.closest('form')),null);
  assert.equal(await page.locator('[form=settings-form]').isDisabled(),true);
  const before=JSON.stringify(data.configs);
  await checkbox.uncheck(); assert.match(await page.locator('#preferences-status').textContent(),/Saved in this browser/);
  assert.equal(await page.locator('[form=settings-form]').isDisabled(),true); assert.equal(data.requests.length,0); assert.equal(JSON.stringify(data.configs),before);
  await page.locator('[data-page=overview]').click();
  let prompts=0;
  page.on('dialog',dialog=>{prompts++;dialog.dismiss();});
  await page.locator('[data-action=free-lock]').click(); assert.equal(prompts,1,'unrelated lock confirmation stays enabled');
  await page.locator('[data-action=pause]').click(); await page.waitForFunction(()=>agentTransitions.size===0&&refreshPending===0); assert.equal(prompts,1);
  await page.locator('#project-select').selectOption(projectId(2)); await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0);
  await page.locator('[data-action=resume]').click(); await page.waitForFunction(()=>agentTransitions.size===0&&refreshPending===0); assert.equal(prompts,1);
  await reloadPage(page); assert.equal(await checkbox.isChecked(),false);
  await page.locator('[data-page=settings]').click(); await checkbox.check();
  await reloadPage(page); assert.equal(await checkbox.isChecked(),true); assert.equal(JSON.stringify(data.configs),before);
}));

test('disabling lifecycle confirmations bypasses each individual and bulk control, not launch limit warnings', async () => fixture(async (page,data) => {
  await manualPolling(page); await reloadPage(page);
  await page.locator('[data-page=settings]').click(); await page.locator('#confirm-agent-actions').uncheck(); await page.locator('[data-page=overview]').click();
  let prompts=0; page.on('dialog',dialog=>{prompts++;dialog.dismiss();});
  for(const [initial,action] of [['working','pause'],['paused','resume'],['crashed','resume'],['idle','close'],['closed','reopen']]) {
    data.agents=[{id:1,project:projectId(1),state:initial,pause_reason:'user'}]; await page.evaluate(()=>refresh());
    const before=data.requests.length;
    await page.locator(`[data-agent="1"] [data-action=${action}]`).click(); await page.waitForFunction(()=>agentTransitions.size===0&&refreshPending===0);
    assert.equal(data.requests.length,before+1); assert.equal(prompts,0);
  }
  for(const button of ['pause-project','resume-project','resume-project-restart','pause-all','resume-all','resume-restart']) {
    data.agents=[{id:1,project:projectId(1),state:button.startsWith('pause')?'idle':'paused',pause_reason:'restart'}]; await page.evaluate(()=>refresh()); await openGlobalActions(page);
    const before=data.requests.length;
    await page.locator(`#${button}`).click(); await page.waitForFunction(()=>!bulkAction&&refreshPending===0);
    assert.equal(data.requests.length,before+1); assert.equal(prompts,0);
  }
  data.hardLimit=true; await openLaunch(page); await page.locator('#launch-form [name=task]').fill('Review before a forced launch'); await page.locator('#launch-form button.primary').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('hard limit reached'));
  assert.equal(prompts,1,'hard-limit confirmation is not a lifecycle preference'); assert.equal(await page.locator('#launch-dialog').evaluate(dialog=>dialog.open),true);
  assert.equal(data.requests.filter(request=>request.url==='/agents').length,1,'canceling the limit warning does not force launch');
}));

test('missing or invalid confirmation preferences default to enabled and unavailable storage is reported', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Worker',state:'working'}];
  await manualPolling(page);
  for(const value of [null,'','0','FALSE',' false ','invalid','true']) {
    await page.evaluate(value=>value===null?localStorage.removeItem('acom:confirm-agent-actions'):localStorage.setItem('acom:confirm-agent-actions',value),value);
    await reloadPage(page); assert.equal(await page.locator('#confirm-agent-actions').isChecked(),true);
  }
  await page.addInitScript(()=>{for(const method of ['getItem','setItem'])Storage.prototype[method]=()=>{throw new Error('storage blocked');};});
  await reloadPage(page); await page.locator('[data-page=settings]').click(); await page.locator('#confirm-agent-actions').uncheck();
  assert.match(await page.locator('#preferences-status').textContent(),/this tab only.*storage is unavailable.*reload/);
  let prompts=0; page.on('dialog',dialog=>{prompts++;dialog.dismiss();});
  await page.locator('[data-page=overview]').click(); await page.locator('[data-action=pause]').click(); await page.waitForFunction(()=>agentTransitions.size===0&&refreshPending===0);
  assert.equal(prompts,0,'failed persistence does not undo the explicit tab preference');
  await reloadPage(page); assert.equal(await page.locator('#confirm-agent-actions').isChecked(),true);
}));

test('visual Boolean filters build idle OR limit without typing query syntax', async () => fixture(async (page,data) => {
  data.pageLimit=1;
  data.agents=[{id:1,project:projectId(1),name:'Idle',state:'idle'},{id:2,project:projectId(1),name:'Limit',state:'paused',pause_reason:'limit'},{id:3,project:projectId(1),name:'Manual',state:'paused',pause_reason:'user'}];
  await manualPolling(page);await reloadPage(page);await page.locator('#agent-filters > summary').click();
  assert.equal(await page.locator('#agent-filter-builder').count(),1,'the filter picker exposes a visual Boolean builder');
  const root=page.locator('[data-filter-root]');
  await root.locator('[data-filter-op]').first().selectOption('or');
  assert.equal(await root.locator('[data-filter-op]').first().inputValue(),'or','an empty group retains Match any');
  await addVisualCondition(page,root,'state',['idle']);
  assert.equal(await root.locator('[data-filter-op]').first().inputValue(),'or','adding the first child does not silently switch to Match all');
  await addVisualCondition(page,root,'pause_reason',['limit']);
  assert.equal(await page.locator('#agent-search').inputValue(),'','editing a visual draft does not apply it');
  assert.equal(await page.locator('[data-agent-count=all]').textContent(),'3');
  await applyVisualFilters(page);
  assert.equal(await page.locator('[data-agent-count=all]').textContent(),'2');
  assert.equal(await page.locator('[data-agent-count=active]').textContent(),'1');
  assert.equal(await page.locator('[data-agent-count=attention]').textContent(),'1');
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2]);
  assert.match(await page.locator('#agent-search').inputValue(),/state:.*idle.* OR pause_reason:.*limit/);
  await page.locator('#page-overview [data-more=agentBrowser]').click();await page.waitForFunction(()=>!state.pages.agentBrowser.pending);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2,1]);
  await page.evaluate(()=>refresh());
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2,1],'polling preserves loaded matches without duplicates');
  await page.locator('[data-agent-filter=active]').click();await page.waitForFunction(()=>!state.pages.agentBrowser.pending&&state.pages.agentBrowser.total===1);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[1],'category remains separate from the Boolean query');
  assert.equal(data.requests.length,0);
}));

async function openVisualFilters(page) {
  if(!await page.locator('#agent-filters').evaluate(el=>el.open))await page.locator('#agent-filters > summary').click();
  await page.waitForFunction(()=>!!currentAgentQuery()?.value);
}
async function addVisualCondition(page,parent,field,values) {
  const ids=await page.locator('.filter-condition[data-filter-node]').evaluateAll(nodes=>nodes.map(node=>node.dataset.filterNode));
  await parent.locator(':scope > .filter-editor-actions > [data-add-filter-condition]').click();
  const id=await page.locator('.filter-condition[data-filter-node]').evaluateAll((nodes,ids)=>nodes.find(node=>!ids.includes(node.dataset.filterNode)).dataset.filterNode,ids);
  const node=page.locator(`[data-filter-node="${id}"]`);
  await setVisualCondition(node,field,values);
  return node;
}
async function setVisualCondition(node,field,values) {
  await node.locator('[data-filter-field]').selectOption(field);
  while(await node.locator('[data-filter-value]').count()>1)await node.locator('[data-remove-filter-alternative]').last().click();
  for(let i=0;i<values.length;i++) {
    if(i)await node.locator('[data-add-filter-alternative]').click();
    const input=node.locator('[data-filter-value]').nth(i);
    const ungrouped=input.locator('xpath=ancestor::*[@data-filter-value-row][1]').locator('[data-filter-ungrouped]');
    if(values[i]===''&&field==='group') {if(await ungrouped.getAttribute('aria-pressed')!=='true')await ungrouped.click();}
    else {if(await ungrouped.count()&&await ungrouped.getAttribute('aria-pressed')==='true')await ungrouped.click();await input.fill(values[i]);}
  }
}
async function addVisualGroup(page,parent,op='and',exclude=false) {
  const ids=await page.locator('[data-filter-node]').evaluateAll(nodes=>nodes.map(node=>node.dataset.filterNode));
  await parent.locator(':scope > .filter-editor-actions > [data-add-filter-group]').click();
  const id=await page.locator('[data-filter-node]').evaluateAll((nodes,ids)=>nodes.find(node=>!ids.includes(node.dataset.filterNode)).dataset.filterNode,ids);
  const node=page.locator(`[data-filter-node="${id}"]`);
  await node.locator('[data-filter-op]').first().selectOption(op);
  if(exclude)await node.locator('[data-filter-exclude]').first().check();
  return node;
}
async function applyVisualFilters(page) {
  await page.locator('#apply-agent-filter').click();
  await page.waitForFunction(()=>!state.agentFilterDraft.pending&&!state.agentFilterDraft.dirty&&!agentSearchTimer&&!state.pages.agentBrowser.pending&&!!state.pages.agentBrowser.revision&&state.pages.agentBrowser.scope===collectionPath('agentBrowser')&&!!currentAgentQuery()?.value);
  assert.equal(await page.locator('#agent-filter-draft-error').isVisible(),false);
}
async function pickAgentFilter(page,field,values) {
  await openVisualFilters(page);
  const id=await page.locator('[data-filter-field]').evaluateAll((selects,field)=>selects.find(select=>select.value===field)?.closest('[data-filter-node]').dataset.filterNode,field);
  if(id)await setVisualCondition(page.locator(`[data-filter-node="${id}"]`),field,values);
  else await addVisualCondition(page,page.locator('[data-filter-root]'),field,values);
  await applyVisualFilters(page);
}

test('visual groups combine Match all, Match any and Exclude with missing values correctly', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Idle reviewer',group:'Security review',state:'idle',model:'good'},
    {id:2,project:projectId(1),name:'Limit reviewer',group:'Security review',state:'paused',pause_reason:'limit',model:'good'},
    {id:3,project:projectId(1),name:'Manual reviewer',group:'Security review',state:'paused',pause_reason:'user',model:'good'},
    {id:4,project:projectId(1),name:'Closed reviewer',group:'Security review',state:'closed',model:'good'},
    {id:5,project:projectId(1),name:'Bad model',group:'Security review',state:'idle',model:'bad'},
    {id:6,project:projectId(1),name:'Outside',group:'Other',state:'idle',model:'good'}];
  await manualPolling(page);await reloadPage(page);await openVisualFilters(page);
  const root=page.locator('[data-filter-root]');
  await addVisualCondition(page,root,'group',['Security review']);
  const exclusions=await addVisualGroup(page,root,'or',true);
  await addVisualCondition(page,exclusions,'state',['closed']);
  await addVisualCondition(page,exclusions,'pause_reason',['manual']);
  const model=await addVisualCondition(page,root,'model',['bad']);await model.locator('[data-filter-exclude]').check();
  await applyVisualFilters(page);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2,1]);
  assert.match(await page.locator('#agent-search').inputValue(),/NOT \(.* OR .*\)/);
  assert.match(await page.locator('#agent-search').inputValue(),/NOT model:/);
  assert.equal(await page.locator('[data-filter-exclude]:checked').count(),2);
  await page.evaluate(()=>refresh());assert.equal(await page.locator('[data-filter-exclude]:checked').count(),2);
  if(process.env.ACOM_UI_SCREENSHOT_DIR) {
    await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,'visual-filters-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,'visual-filters-mobile.png'),fullPage:true});
  }
}));

test('visual Text is one literal phrase while exact alternatives, Ungrouped and operators stay literal', async () => fixture(async (page,data) => {
  const group='Team, "Alpha" \\ review',phrase='OR (draft), group:x';
  data.agents=[{id:1,project:projectId(1),name:phrase,state:'idle',group},{id:2,project:projectId(1),name:'Second',state:'idle',group:'AND',task:phrase},
    {id:3,project:projectId(1),name:'Ungrouped',state:'idle',group:null,task:phrase},{id:4,project:projectId(1),name:'OR (draft),',state:'idle',group:'group:x'},
    {id:5,project:projectId(1),name:phrase,state:'idle',group:'Different'}];
  await manualPolling(page);await reloadPage(page);await openVisualFilters(page);
  const root=page.locator('[data-filter-root]');
  const text=await addVisualCondition(page,root,'',[phrase]);
  assert.equal(await text.locator('[data-add-filter-alternative]').isDisabled(),true,'Text uses one phrase, not exact-field alternatives');
  await addVisualCondition(page,root,'group',[group,'AND','']);await applyVisualFilters(page);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[3,2,1],'one phrase cannot span separate name/group fields');
  assert.equal(await page.locator('#agent-filter-builder img').count(),0);
  const parsed=agentQueryFixture(await page.locator('#agent-search').inputValue());
  assert.equal(parsed.expression.children.find(node=>node.clause.field===null).clause.values[0],phrase);
  assert.deepEqual(parsed.expression.children.find(node=>node.clause.field==='group').clause.values,['','AND',group].sort());
  assert.equal(await page.locator('[data-filter-ungrouped][aria-pressed=true]').count(),1,'Ungrouped is an explicit alternative, not a manufactured text value');
}));

test('typed advanced expressions import and edit without losing NOT chains or repeated fields', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'idle',group:'Team',model:'good'},{id:2,project:projectId(1),state:'paused',pause_reason:'limit',group:'Team',model:'good'},
    {id:3,project:projectId(1),state:'idle',group:'Other',model:'good'},{id:4,project:projectId(1),state:'paused',pause_reason:'user',group:'Team',model:'good'}];
  await manualPolling(page);await reloadPage(page);
  await page.locator('#agent-search').fill('NOT NOT (state:idle OR pause_reason:limit) AND NOT NOT group:Team AND group:Team AND NOT model:bad');
  await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.pages.agentBrowser.total===2);
  await openVisualFilters(page);
  assert.equal(await page.locator('[data-filter-field]').evaluateAll(selects=>selects.filter(select=>select.value==='group').length),2);
  const modelId=await page.locator('[data-filter-field]').evaluateAll(selects=>selects.find(select=>select.value==='model').closest('[data-filter-node]').dataset.filterNode);
  await page.locator(`[data-filter-node="${modelId}"] [data-filter-value]`).fill('also-bad');await applyVisualFilters(page);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2,1]);
  const raw=await page.locator('#agent-search').inputValue();
  assert.equal((raw.match(/group:/g)||[]).length,2,'repeated field clauses are retained rather than overwritten');
  assert.equal((raw.match(/NOT/g)||[]).length,5,'even NOT chains survive import and serialization');
  assert.equal(await page.locator('[data-filter-field]').evaluateAll(selects=>selects.filter(select=>select.value==='group').length),2);
}));

test('visual limits count exact-field alternatives separately from Text clauses', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'idle',task:'needle',group:'g1'}];
  await manualPolling(page);await reloadPage(page);
  const source=Array(63).fill('needle').join(' ')+' group:'+Array.from({length:66},(_,i)=>`g${i}`).join(',');
  await page.locator('#agent-search').fill(source);await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.agentBrowser[0]?.id===1);
  await openVisualFilters(page);
  assert.equal(await page.locator('[data-filter-field]').count(),64);
  const group=page.locator('.filter-condition').filter({has:page.locator('[data-filter-field] option:checked[value=group]')});
  assert.equal(await group.locator('[data-filter-value]').count(),66);
  await group.locator('[data-filter-value]').last().fill('new-group');
  assert.equal(await page.locator('#agent-filter-draft-error').isVisible(),false,'63 text leaves do not consume the separate field-value budget');
  await applyVisualFilters(page);assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[1]);
}));

test('Text clause chips focus their own condition rather than the first Text condition', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'idle',task:'first second'},{id:2,project:projectId(1),state:'idle',task:'first changed'}];
  await manualPolling(page);await reloadPage(page);await page.locator('#agent-search').fill('first second');
  await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.agentBrowser[0]?.id===1);
  await page.locator('[data-edit-agent-clause="1"]').click();
  const id=await page.evaluate(()=>document.activeElement.closest('[data-filter-node]').dataset.filterNode);
  const node=page.locator(`[data-filter-node="${id}"]`);
  assert.equal(await node.locator('[data-filter-field]').inputValue(),'');assert.equal(await node.locator('[data-filter-value]').inputValue(),'second');
  await node.locator('[data-filter-value]').fill('changed');await applyVisualFilters(page);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2]);
  assert.deepEqual(agentQueryFixture(await page.locator('#agent-search').inputValue()).clauses.map(clause=>clause.values[0]),['first','changed']);
}));

test('visual serialization quotes Rust whitespace in exact values and Text phrases', async () => fixture(async (page,data) => {
  const group='A\u0085B',text='Task\u0085phrase';
  data.agents=[{id:1,project:projectId(1),state:'idle',group,task:text},{id:2,project:projectId(1),state:'idle',group:'A',task:'B Task phrase'}];
  await manualPolling(page);await reloadPage(page);await page.locator('#agent-search').fill(`group:${JSON.stringify(group)} ${JSON.stringify(text)}`);
  await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.agentBrowser[0]?.id===1);
  await openVisualFilters(page);
  const input=page.locator('.filter-condition').filter({has:page.locator('[data-filter-field] option:checked[value=group]')}).locator('[data-filter-value]');
  await input.fill(group+'x');await input.fill(group);await applyVisualFilters(page);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[1]);
  assert.ok((await page.locator('#agent-search').inputValue()).includes(`group:${JSON.stringify(group)}`));
  assert.ok((await page.locator('#agent-search').inputValue()).includes(JSON.stringify(text)));
}));

test('a current filter chip safely opens a builder whose selected older DOM is deferred', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'idle',group:'Old'},{id:2,project:projectId(1),state:'idle',group:'New'}];
  await manualPolling(page);await reloadPage(page);await page.locator('#agent-search').fill('group:Old');
  await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.agentBrowser[0]?.id===1);
  await openVisualFilters(page);await selectText(page,'.filter-condition .filter-node-head label');
  await page.evaluate(()=>setAgentSearch('group:New'));
  assert.equal(await page.locator('[data-filter-value]').inputValue(),'Old','selected old builder text defers replacement during the search refresh');
  assert.match(await page.locator('[data-edit-agent-filter=group]').textContent(),/New/);
  await page.locator('[data-edit-agent-filter=group]').dispatchEvent('click');
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.equal(await page.locator('[data-filter-value]').inputValue(),'New');
  assert.equal(await page.locator('#agent-search').inputValue(),'group:New');
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2]);
}));

test('a structural edit cannot replay an old Exclude checkbox after a later real click', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'idle',group:'Team',model:'good'},{id:2,project:projectId(1),state:'idle',group:'Other',model:'good'}];
  await manualPolling(page);await reloadPage(page);await page.locator('#agent-search').fill('group:Team model:good');
  await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.agentBrowser[0]?.id===1);
  await openVisualFilters(page);await selectText(page,'[data-filter-root] > .filter-node-head > label:first-child');
  await page.locator('.filter-condition').filter({has:page.locator('[data-filter-field] option:checked[value=model]')}).locator('[data-remove-filter-node]').click();
  await page.locator('[data-filter-root] > .filter-node-head [data-filter-exclude]').check();
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.equal(await page.locator('[data-filter-root] > .filter-node-head [data-filter-exclude]').isChecked(),true,'a deferred structural snapshot must not undo the newer visible exclusion');
  assert.equal(await page.locator('.filter-condition').count(),1);
  await applyVisualFilters(page);assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2]);
}));

test('typed and visual positive pause filters both preserve the independent category', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'idle'},{id:2,project:projectId(1),state:'paused',pause_reason:'limit'}];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-agent-filter=active]').click();
  await page.locator('#agent-search').fill('pause_reason:limit');
  await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.pages.agentBrowser.total===0);
  assert.equal(await page.locator('[data-agent-filter=active]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-agent-count=all]').textContent(),'1');
  await page.locator('#agent-search').fill('');await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.agentBrowser[0]?.id===1);
  await pickAgentFilter(page,'pause_reason',['limit']);
  assert.equal(await page.locator('[data-agent-filter=active]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[]);
  assert.equal(await page.locator('[data-agent-count=all]').textContent(),'1');
  await page.locator('[data-agent-filter=all]').click();await page.waitForFunction(()=>!state.pages.agentBrowser.pending&&state.agentBrowser[0]?.id===2);
}));

test('incomplete or rejected visual drafts never change the applied results', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'idle'},{id:2,project:projectId(1),state:'paused',pause_reason:'limit'}];
  await manualPolling(page);await reloadPage(page);await pickAgentFilter(page,'state',['idle']);
  const applied=await page.locator('#agent-search').inputValue(),root=page.locator('[data-filter-root]');
  const leaf=await addVisualCondition(page,root,'model',['']);
  assert.equal(await page.locator('#apply-agent-filter').isDisabled(),true);
  assert.equal(await page.locator('#agent-filter-draft-error').isVisible(),true);
  await page.evaluate(()=>refresh());assert.equal(await page.locator('#agent-search').inputValue(),applied);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[1]);
  await leaf.locator('[data-filter-value]').fill('rejected');
  await page.route('**/agent-query?*',route=>new URL(route.request().url()).searchParams.get('search').includes('rejected')?route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Rejected test query'})}):route.continue());
  await page.locator('#apply-agent-filter').click();await page.waitForFunction(()=>document.querySelector('#agent-filter-draft-error').textContent.includes('Rejected test query'));
  assert.equal(await page.locator('#agent-search').inputValue(),applied);assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[1]);
  assert.equal(await page.locator('#connection-banner').isVisible(),false);
  await page.locator('#cancel-agent-filter').click();
  const group=await addVisualGroup(page,page.locator('[data-filter-root]'),'or');
  assert.equal(await page.locator('#apply-agent-filter').isDisabled(),true,'an unfinished empty group is not silently dropped');
  await group.locator('[data-remove-filter-node]').first().click();
  assert.equal(await page.locator('#agent-search').inputValue(),applied);
}));

test('dirty visual drafts survive polling, selection, disclosure and page changes but need reset after direct search', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'idle',group:'Applied'},{id:2,project:projectId(1),state:'paused',group:'Draft value'}];
  await manualPolling(page);await reloadPage(page);await pickAgentFilter(page,'group',['Applied']);
  let input=page.locator('[data-filter-value]');await input.fill('Draft value');await input.evaluate(el=>el.setSelectionRange(2,7));
  const handle=await input.elementHandle();await page.evaluate(()=>refresh());
  assert.equal(await input.evaluate((el,original)=>el===original,handle),true,'polling retains the actual draft input node');
  assert.equal(await input.inputValue(),'Draft value');assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd]),[2,7]);
  await page.locator('#agent-filters > summary').click();await page.evaluate(()=>refresh());await page.locator('#agent-filters > summary').click();
  await page.locator('[data-page=settings]').click();await page.locator('[data-page=overview]').click();
  assert.equal(await input.inputValue(),'Draft value');
  await page.locator('#agent-search').fill('state:paused');await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.agentBrowser[0]?.id===2);
  assert.equal(await input.inputValue(),'Draft value','direct search does not discard unsaved visual input');
  assert.equal(await page.locator('#apply-agent-filter').isDisabled(),true);assert.match(await page.locator('#agent-filter-draft-status').textContent(),/reset|changed|conflict/i);
  await page.locator('#cancel-agent-filter').click();input=page.locator('[data-filter-value]');
  assert.equal(await page.locator('[data-filter-field]').inputValue(),'state');assert.equal(await input.inputValue(),'paused');
  assert.equal(await page.locator('#agent-search').inputValue(),'state:paused');
}));

test('delayed visual Apply cannot overwrite newer edits, search or project selection', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),state:'idle',group:'First'},{id:2,project:projectId(1),state:'paused',group:'Second'},{id:3,project:projectId(2),state:'idle',group:'First'}];
  await manualPolling(page);await reloadPage(page);await openVisualFilters(page);
  await addVisualCondition(page,page.locator('[data-filter-root]'),'group',['First']);
  const pending=await holdRequest(page,url=>url.pathname==='/agent-query'&&url.searchParams.get('search').includes('First'),'GET');
  await page.locator('#apply-agent-filter').click();await pending.started;
  await page.locator('[data-filter-value]').fill('Second');pending.release();await pending.remove();
  await page.waitForFunction(()=>!state.agentFilterDraft.pending);
  assert.equal(await page.locator('#agent-search').inputValue(),'');assert.equal(await page.locator('[data-filter-value]').inputValue(),'Second');
  await applyVisualFilters(page);assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2]);
  await page.locator('[data-filter-value]').fill('First');
  const searchRace=await holdRequest(page,url=>url.pathname==='/agent-query'&&url.searchParams.get('search').includes('First'),'GET');
  await page.locator('#apply-agent-filter').click();await searchRace.started;
  await page.locator('#agent-search').fill('state:idle');await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&state.agentBrowser[0]?.id===1&&!state.pages.agentBrowser.pending);
  searchRace.release();await searchRace.remove();await page.waitForFunction(()=>!state.agentFilterDraft.pending);
  assert.equal(await page.locator('#agent-search').inputValue(),'state:idle');assert.equal(await page.locator('#apply-agent-filter').isDisabled(),true);
  await page.locator('#cancel-agent-filter').click();await page.locator('[data-filter-value]').fill('paused');
  const projectRace=await holdRequest(page,url=>url.pathname==='/agent-query'&&url.searchParams.get('search').includes('paused'),'GET');
  await page.locator('#apply-agent-filter').click();await projectRace.started;
  await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.selectedProject===projectId(2)&&refreshPending===0&&state.agentBrowser[0]?.id===3);
  projectRace.release();await projectRace.remove();await page.waitForFunction(()=>!state.agentFilterDraft.pending);
  assert.equal(await page.locator('#agent-search').inputValue(),'state:idle');assert.equal(await page.locator('[data-filter-value]').inputValue(),'paused');
  assert.equal(await page.locator('#apply-agent-filter').isDisabled(),true,'a draft from another project must be explicitly reset');
}));

test('exact query filters search all pages, preserve polling and expose editable removable chips', async () => fixture(async (page,data) => {
  data.pageLimit=1;
  data.agents=[{id:1,project:projectId(1),name:'Usage older',state:'paused',pause_reason:'limit',group:'Security review',harness:'codex',model:'model-one',effort:'high',task:'reentrancy'},{id:2,project:projectId(1),name:'Manual',state:'paused',pause_reason:'user'},{id:3,project:projectId(1),name:'Bulk manual',state:'paused',pause_reason:'all'},{id:4,project:projectId(1),name:'Restart',state:'paused',pause_reason:'restart'},{id:5,project:projectId(1),name:'Usage newer',state:'paused',pause_reason:'limit',group:'Security review',harness:'claude',model:'model-two',effort:'medium',task:'reentrancy'},...['working','idle','crashed','done','closed','replaced'].map((state,i)=>({id:6+i,project:projectId(1),name:state,state,task:'Security review reentrancy'})),{id:12,project:projectId(2),state:'paused',pause_reason:'limit'}];
  await manualPolling(page); await reloadPage(page); await page.locator('#agent-filters > summary').click();
  await page.locator('[data-agent-filter=active]').click(); await pickAgentFilter(page,'pause_reason',['limit']);
  assert.equal(await page.locator('[data-agent-filter=active]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#agent-count').textContent(),'Showing 0 of 0 matches · 11 total');
  await page.locator('[data-agent-filter=all]').click();
  await page.waitForFunction(()=>state.pages.agentBrowser.total===2&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('[data-agent-filter=all]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#agent-count').textContent(),'Showing 1 of 2 matches · 11 total');
  assert.equal(await page.locator('[data-agent-count=attention]').textContent(),'2');
  assert.equal(await page.locator('#resume-project-count').textContent(),'(5)','bulk scope stays independent of filters');
  await page.locator('#page-overview [data-more=agentBrowser]').click(); await page.waitForFunction(()=>!state.pages.agentBrowser.pending);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(a=>a.id)),[5,1]);
  const query=await page.locator('#agent-search').inputValue();await page.evaluate(()=>refresh());assert.equal(await page.locator('#agent-search').inputValue(),query); assert.equal(await page.locator('#agent-filters').evaluate(el=>el.open),true);
  await page.locator('#agent-search').fill(`${query} older`); await page.waitForFunction(()=>!agentSearchTimer&&state.pages.agentBrowser.total===1&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('#agents [data-agent]').getAttribute('data-agent'),'1');
  await page.locator('[data-remove-agent-clause="1"]').focus(); await page.locator('[data-remove-agent-clause="1"]').press('Enter'); await page.waitForFunction(()=>state.pages.agentBrowser.total===2&&!state.pages.agentBrowser.pending);
  assert.equal(await page.evaluate(()=>!!document.activeElement.closest('#agent-filter-chips')),true,'removing a focused chip keeps keyboard focus in the remaining filters');
  await pickAgentFilter(page,'pause_reason',['manual']); await page.waitForFunction(()=>state.agentBrowser[0]?.id===3&&!state.pages.agentBrowser.pending);
  await page.locator('#page-overview [data-more=agentBrowser]').click(); await page.waitForFunction(()=>!state.pages.agentBrowser.pending); assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(a=>a.id)),[3,2]);
  await pickAgentFilter(page,'pause_reason',['restart']); await page.waitForFunction(()=>state.agentBrowser[0]?.id===4&&!state.pages.agentBrowser.pending);
  await page.locator('#clear-agent-filters').focus(); await page.locator('#clear-agent-filters').press('Enter'); await page.waitForFunction(()=>state.pages.agentBrowser.total===11&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('#agent-filters > summary').evaluate(el=>document.activeElement===el),true,'clearing every filter returns focus to the disclosure');
  assert.equal(await page.locator('#agent-filter-chips button').count(),0); assert.equal(data.requests.length,0);
  await page.locator('#agent-search').fill('group:"Security review" state:paused,crashed reentrancy'); await page.waitForFunction(()=>!agentSearchTimer&&state.pages.agentBrowser.total===2&&!state.pages.agentBrowser.pending);
  await pickAgentFilter(page,'provider',['codex']);assert.equal(await page.locator('#agent-count').textContent(),'Showing 1 of 1 matches · 11 total');
  await pickAgentFilter(page,'model',['model-one']);await pickAgentFilter(page,'effort',['high']);assert.equal(await page.locator('#agents [data-agent]').getAttribute('data-agent'),'1');
  await page.locator('[data-edit-agent-filter=state]').click();
  let stateNode=page.locator('.filter-condition').filter({has:page.locator('[data-filter-field] option:checked[value=state]')});
  assert.deepEqual(await stateNode.locator('[data-filter-value]').evaluateAll(inputs=>inputs.map(input=>input.value)),['crashed','paused']);
  await stateNode.locator('[data-filter-value]').first().fill('working');await page.locator('#cancel-agent-filter').click();
  stateNode=page.locator('.filter-condition').filter({has:page.locator('[data-filter-field] option:checked[value=state]')});
  assert.deepEqual(await stateNode.locator('[data-filter-value]').evaluateAll(inputs=>inputs.map(input=>input.value)),['crashed','paused'],'Reset restores the applied alternatives rather than applying partial edits');
  if(process.env.ACOM_UI_SCREENSHOT_DIR) {
    await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
    await page.setViewportSize({width:1440,height:1000}); await page.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,'agent-filters-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true); await page.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,'agent-filters-mobile.png'),fullPage:true});
    await openSidebar(page);await page.locator('[data-page=settings]').click(); await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);}); await page.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,'preferences-mobile.png')});
  }
}));

test('changing query filters or project discards delayed list responses and clears obsolete cursors', async () => fixture(async (page,data) => {
  data.pageLimit=1; data.agents=[{id:1,project:projectId(1),state:'paused',pause_reason:'limit'},{id:2,project:projectId(1),state:'paused',pause_reason:'limit'},{id:3,project:projectId(1),state:'paused',pause_reason:'restart'},{id:4,project:projectId(2),state:'paused',pause_reason:'restart'}];
  await manualPolling(page); await reloadPage(page); await page.locator('#agent-filters > summary').click();
  const pending=await holdRequest(page,'**/agents?*search=pause_reason%3Alimit*','GET');
  await page.locator('#agent-search').fill('pause_reason:limit'); await pending.started;
  await page.locator('#agent-search').fill('pause_reason:restart'); await page.waitForFunction(()=>state.agentBrowser[0]?.id===3&&!state.pages.agentBrowser.pending);
  await page.locator('#project-select').selectOption(projectId(2)); await page.waitForFunction(()=>state.agentBrowser[0]?.id===4&&refreshPending===0);
  pending.release(); await pending.remove(); await page.waitForFunction(()=>!state.pages.agentBrowser.pending);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(a=>a.id)),[4]); assert.equal(await page.locator('#agent-search').inputValue(),'pause_reason:restart');
  assert.equal(await page.locator('#agent-count').textContent(),'Showing 1 of 1 matches · 1 total');
  assert.equal(await page.locator('#page-overview [data-more=agentBrowser]').isVisible(),false);
}));

test('invalid queries stay local, hide old results and pagination, and never silently broaden', async () => fixture(async (page,data) => {
  data.pageLimit=1;data.agents=[{id:1,project:projectId(1),name:'First',state:'idle'},{id:2,project:projectId(1),name:'Second',state:'paused',pause_reason:'limit'}];
  await manualPolling(page);await reloadPage(page);
  assert.equal(await page.locator('#page-overview [data-more=agentBrowser]').isVisible(),true);
  for(const source of ['unknown:foo','group:','group:"unterminated','state:paused,','provider:made-up','state:idle OR','NOT','()','state:idle AND OR state:paused','(state:idle']) {
    const before=data.getRequests.filter(url=>url.startsWith('/agents?')).length;
    await page.locator('#agent-search').fill(source);await page.waitForFunction(()=>!agentSearchTimer&&!!currentAgentQuery()?.error);
    assert.equal(await page.locator('#agent-search').getAttribute('aria-invalid'),'true');
    assert.equal(await page.locator('#agent-query-error').isVisible(),true);assert.match(await page.locator('#agents').textContent(),/Invalid search query/);
    assert.equal(await page.locator('#agents [data-agent]').count(),0);assert.equal(await page.locator('#page-overview [data-more=agentBrowser]').isVisible(),false);
    await page.evaluate(()=>refresh());assert.equal(await page.locator('#live-text').textContent(),'live');assert.equal(await page.locator('#connection-banner').isVisible(),false);
    assert.equal(data.getRequests.filter(url=>url.startsWith('/agents?')&&new URL(url,'http://test').searchParams.get('search')===source).length,0);
    assert.ok(data.getRequests.filter(url=>url.startsWith('/agents?')).length>=before,'ordinary unfiltered member pickers remain separate');
  }
  await page.locator('#clear-agent-filters').click();await page.waitForFunction(()=>!!currentAgentQuery()?.value&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('#agent-search').getAttribute('aria-invalid'),'false');assert.equal(await page.locator('#agent-query-error').isVisible(),false);
  assert.equal(await page.locator('#agent-count').textContent(),'Showing 1 of 2 matches · 2 total');
}));

test('Boolean query precedence, grouped alternatives and NOT include missing pause reasons correctly', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Idle reviewer',group:'Security review',state:'idle'},
    {id:2,project:projectId(1),name:'Limit reviewer',group:'Security review',state:'paused',pause_reason:'limit'},
    {id:3,project:projectId(1),name:'Manual reviewer',group:'Security review',state:'paused',pause_reason:'user'},
    {id:4,project:projectId(1),name:'Outside idle',group:'Other',state:'idle'},
    {id:5,project:projectId(1),name:'Outside limit',group:'Other',state:'paused',pause_reason:'limit'},
    {id:6,project:projectId(1),name:'Closed reviewer',group:'Security review',state:'closed'},
    {id:7,project:projectId(1),name:'Running reviewer',group:'Security review',state:'working',pause_reason:null}];
  await manualPolling(page);await reloadPage(page);
  const cases=[
    ['state:idle OR pause_reason:limit',[5,4,2,1]],
    ['group:"Security review" (state:idle OR pause_reason:limit)',[2,1]],
    ['state:idle OR pause_reason:limit group:"Security review"',[4,2,1]],
    ['state:paused NOT pause_reason:limit',[3]],
    ['NOT pause_reason:limit',[7,6,4,3,1]],
    ['NOT (state:closed OR state:working)',[5,4,3,2,1]],
    ['NOT NOT state:idle',[4,1]],
    ['state:idle pause_reason:limit',[]],
    ['group:a group:b',[]],
  ];
  for(const [query,ids] of cases) {
    await page.locator('#agent-search').fill(query);
    await page.waitForFunction(raw=>!agentSearchTimer&&currentAgentQuery()?.raw===raw&&!!currentAgentQuery()?.value&&state.pages.agentBrowser.scope===collectionPath('agentBrowser')&&!state.pages.agentBrowser.pending,query);
    assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),ids,query);
    assert.equal(await page.locator('#agent-query-error').isVisible(),false);
    assert.equal(await page.locator('[data-agent-count=all]').textContent(),String(ids.length));
    assert.equal(new Set(await page.locator('#agents [data-agent]').evaluateAll(rows=>rows.map(row=>row.dataset.agent))).size,ids.length);
  }
}));

test('advanced query chip opens the grouped visual tree without flattening it or changing category', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Idle reviewer',state:'idle',group:'Security review'},
    {id:2,project:projectId(1),name:'Quota reviewer',state:'paused',pause_reason:'limit',group:'Security review'},
    {id:3,project:projectId(1),name:'Outside idle',state:'idle',group:'Other'},
    {id:4,project:projectId(1),name:'Manual reviewer',state:'paused',pause_reason:'user',group:'Security review'}];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-agent-filter=active]').click();
  const raw='state:idle OR pause_reason:limit';await page.locator('#agent-search').fill(raw);
  await page.waitForFunction(()=>!agentSearchTimer&&!!currentAgentQuery()?.value&&state.pages.agentBrowser.scope===collectionPath('agentBrowser')&&state.pages.agentBrowser.total===2&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('[data-agent-filter=active]').getAttribute('aria-pressed'),'true','a pause-reason OR branch must not reset the active category');
  assert.equal(await page.locator('[data-edit-agent-filter]').count(),0);
  assert.equal(await page.locator('[data-edit-agent-query]').count(),1);
  assert.match(await page.locator('[data-edit-agent-query]').textContent(),/state:.*idle.* OR pause_reason:.*limit/);
  await page.locator('[data-edit-agent-query]').click();
  assert.equal(await page.locator('#agent-filters').evaluate(el=>el.open),true);
  assert.equal(await page.locator('[data-filter-root] [data-filter-op]').first().inputValue(),'or');
  assert.equal(await page.locator('[data-filter-field]').count(),2);
  assert.equal(await page.locator('#agent-filter-builder').evaluate(el=>el.contains(document.activeElement)),true);
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#agent-search').inputValue(),raw);
  await page.locator('#agent-search').fill(`(${raw}) AND group:"Security review"`);
  await page.waitForFunction(()=>!agentSearchTimer&&!!currentAgentQuery()?.value&&!state.pages.agentBrowser.pending&&state.pages.agentBrowser.total===1);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[1]);
  assert.equal(await page.locator('[data-filter-root] [data-filter-op]').first().inputValue(),'and');
  assert.equal(await page.locator('[data-filter-op]').nth(1).inputValue(),'or');
  await pickAgentFilter(page,'group',['Other']);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[3]);
  assert.match(await page.locator('#agent-search').inputValue(),/\(.* OR .*\).* AND group:/);
  await pickAgentFilter(page,'group',['Security review']);
  assert.equal(await page.locator('[data-edit-agent-query]').count(),1);
  await page.locator('[data-agent-filter=all]').click();
  await page.waitForFunction(()=>state.pages.agentBrowser.scope===collectionPath('agentBrowser')&&state.pages.agentBrowser.total===2&&!state.pages.agentBrowser.pending);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2,1]);
  await addVisualCondition(page,page.locator('[data-filter-root]'),'state',['working']);await applyVisualFilters(page);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[],'same-field additions AND the expression rather than overwriting its OR leaves');
  await page.locator('[data-agent-filter=active]').click();
  await page.locator('[data-clear-agent-filter=query]').click();
  await page.waitForFunction(()=>!state.pages.agentBrowser.pending&&state.pages.agentBrowser.total===2);
  assert.equal(await page.locator('#agent-search').inputValue(),'');
  assert.equal(await page.locator('[data-agent-filter=active]').getAttribute('aria-pressed'),'true','clearing the expression preserves the independent category');
  assert.equal(await page.locator('.filter-condition').count(),0);
  assert.equal(data.requests.length,0);
}));

test('Boolean query pagination and polling show every matching agent exactly once', async () => fixture(async (page,data) => {
  data.pageLimit=2;data.agents=Array.from({length:8},(_,index)=>({id:index+1,project:projectId(1),name:`Agent ${index+1}`,state:index%2?'paused':'idle',pause_reason:index%2?'limit':null}));
  await manualPolling(page);await reloadPage(page);await page.locator('#agent-search').fill('state:idle OR pause_reason:limit');
  await page.waitForFunction(()=>!agentSearchTimer&&!!currentAgentQuery()?.value&&state.pages.agentBrowser.scope===collectionPath('agentBrowser')&&state.pages.agentBrowser.total===8&&!state.pages.agentBrowser.pending);
  while(await page.locator('#page-overview [data-more=agentBrowser]').isVisible()) {
    await page.locator('#page-overview [data-more=agentBrowser]').click();await page.waitForFunction(()=>!state.pages.agentBrowser.pending);
  }
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[8,7,6,5,4,3,2,1]);
  await page.evaluate(()=>refresh());
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[8,7,6,5,4,3,2,1]);
  assert.equal(await page.locator('#agents [data-agent]').count(),8);
}));

test('quoted Boolean words and parentheses remain literal and long expression chips fit mobile', async () => fixture(async (page,data) => {
  const group='OR (draft) <img src=x onerror=alert(1)> '+ 'very-long-value-'.repeat(40);
  data.agents=[{id:1,project:projectId(1),name:'Literal OR (draft)',state:'idle',group},
    {id:2,project:projectId(1),name:'Another',state:'idle',group:'Other'},
    {id:3,project:projectId(1),name:'Literal AND NOT',state:'closed',group:'AND'}];
  await manualPolling(page);await reloadPage(page);await pickAgentFilter(page,'group',[group]);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[1]);
  const query=await page.locator('#agent-search').inputValue();
  await page.locator('#agent-search').fill(`(${query}) OR ("AND" "NOT")`);
  await page.waitForFunction(()=>!agentSearchTimer&&!!currentAgentQuery()?.value&&state.pages.agentBrowser.scope===collectionPath('agentBrowser')&&state.pages.agentBrowser.total===2&&!state.pages.agentBrowser.pending);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[3,1]);
  assert.equal(await page.locator('#agent-filter-chips img').count(),0,'query text cannot inject HTML');
  assert.match(await page.locator('[data-edit-agent-query]').textContent(),/<img src=x onerror=alert\(1\)>/);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('[data-edit-agent-query]').click();
  assert.equal(await page.locator('#agent-filter-builder').evaluate(el=>el.contains(document.activeElement)),true);
  await page.locator('#clear-agent-filters').click();await page.waitForFunction(()=>!state.pages.agentBrowser.pending);
  await pickAgentFilter(page,'group',['AND']);
  assert.equal(await page.locator('#agent-search').inputValue(),'group:"AND"');
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[3]);
}));

test('stale advanced chips cannot clear or focus a newer query and malformed expressions recover', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Idle',state:'idle'},{id:2,project:projectId(1),name:'Quota',state:'paused',pause_reason:'limit'}];
  await manualPolling(page);await reloadPage(page);await page.locator('#agent-search').fill('state:idle OR pause_reason:limit');
  await page.waitForFunction(()=>!agentSearchTimer&&!!currentAgentQuery()?.value&&!state.pages.agentBrowser.pending);
  await page.locator('#agent-search').blur();await selectText(page,'[data-edit-agent-query]');
  await page.evaluate(()=>{state.agentSearch='NOT state:idle';return refreshAgentBrowser();});
  assert.match(await page.locator('[data-edit-agent-query]').textContent(),/ OR /,'selected old expression remains until selection clears');
  await page.locator('[data-clear-agent-filter=query]').dispatchEvent('click');
  await page.locator('[data-edit-agent-query]').dispatchEvent('click');
  assert.equal(await page.evaluate(()=>state.agentSearch),'NOT state:idle');
  assert.equal(await page.locator('#agent-search').evaluate(el=>document.activeElement===el),false);
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.match(await page.locator('[data-edit-agent-query]').textContent(),/^NOT /);
  await page.locator('#agent-search').fill('NOT (state:idle OR)');await page.waitForFunction(()=>!agentSearchTimer&&!!currentAgentQuery()?.error);
  assert.equal(await page.locator('#agents [data-agent]').count(),0);
  assert.equal(await page.locator('#page-overview [data-more=agentBrowser]').isVisible(),false);
  await page.evaluate(()=>refresh());assert.equal(await page.locator('#live-text').textContent(),'live');
  await page.locator('#agent-search').fill('NOT pause_reason:limit');await page.waitForFunction(()=>!agentSearchTimer&&state.agentBrowser[0]?.id===1&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('#agent-query-error').isVisible(),false);
}));

test('literal values, alternatives and free words share one server query without rewriting typed input', async () => fixture(async (page,data) => {
  const group='Team, "Alpha" \\ review';
  data.agents=[{id:1,project:projectId(1),name:'Exact member',state:'crashed',group,harness:'codex',model:'custom:model',effort:'ultra',task:'reentrancy checks'},
    {id:2,project:projectId(1),name:'Task false positive',state:'crashed',group:'Different',harness:'codex',model:'custom:model',effort:'ultra',task:`${group} reentrancy checks`},
    {id:3,project:projectId(1),name:'Literal query text',state:'idle',group:null,task:'group:example reentrancy'},
    {id:4,project:projectId(1),name:'Another alternative',state:'paused',group:'Second team',harness:'claude',model:'other',effort:'high',task:'reentrancy'}];
  await manualPolling(page);await reloadPage(page);
  await pickAgentFilter(page,'group',[group,'Second team']);await pickAgentFilter(page,'state',['paused','crashed']);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[4,1]);
  assert.match(await page.locator('[data-edit-agent-filter=group]').textContent(),/Second team OR/);
  await pickAgentFilter(page,'model',['custom:model']);await pickAgentFilter(page,'effort',['ultra']);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[1]);
  let raw=`  group:${JSON.stringify(group)}   state:crashed,paused reentrancy  `;
  await page.locator('#agent-search').fill(raw);await page.waitForFunction(()=>!agentSearchTimer&&state.agentBrowser[0]?.id===1&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('#agent-search').inputValue(),raw);assert.equal(await page.locator('#agent-search').evaluate(el=>document.activeElement===el),true);
  const calls=data.getRequests.filter(url=>url.startsWith('/agent-query?')&&new URL(url,'http://test').searchParams.get('search')===raw).length;
  await page.evaluate(()=>refresh());assert.equal(await page.locator('#agent-search').inputValue(),raw);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/agent-query?')&&new URL(url,'http://test').searchParams.get('search')===raw).length,calls,'polling reuses server-validated clauses');
  await page.locator('#agent-search').fill('"group:example"');await page.waitForFunction(()=>!agentSearchTimer&&state.agentBrowser[0]?.id===3&&!state.pages.agentBrowser.pending);
  await page.locator('#agent-search').fill('ultra');await page.waitForFunction(()=>!agentSearchTimer&&state.pages.agentBrowser.total===0&&!state.pages.agentBrowser.pending);
  await page.locator('#clear-agent-filters').click();await page.waitForFunction(()=>!!currentAgentQuery()?.value&&!state.pages.agentBrowser.pending);
  await pickAgentFilter(page,'group',['']);assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[3]);
  assert.match(await page.locator('[data-edit-agent-filter=group]').textContent(),/Ungrouped/);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('#apply-agent-filter').isVisible(),true);
  assert.equal(data.requests.length,0);
}));

test('delayed query parsing cannot replace newer text, chips or selected-project results', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'First',group:'old',state:'idle'},{id:2,project:projectId(1),name:'Second',group:'new',state:'idle'},{id:3,project:projectId(2),name:'Elsewhere',group:'new',state:'idle'}];
  await manualPolling(page);await reloadPage(page);
  const pending=await holdRequest(page,url=>url.pathname==='/agent-query'&&url.searchParams.get('search')==='group:old','GET');
  await page.locator('#agent-search').fill('group:old');await pending.started;
  await page.locator('#agent-search').fill('group:new');await page.waitForFunction(()=>!agentSearchTimer&&state.agentBrowser[0]?.id===2&&!state.pages.agentBrowser.pending);
  await page.locator('#project-select').selectOption(projectId(2));await page.waitForFunction(()=>state.agentBrowser[0]?.id===3&&refreshPending===0);
  pending.release();await pending.remove();await page.waitForTimeout(50);
  assert.equal(await page.locator('#agent-search').inputValue(),'group:new');assert.match(await page.locator('[data-edit-agent-filter=group]').textContent(),/new/);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[3]);
}));

test('obsolete pause-reason parsing during a newer debounce cannot reset the selected category', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'New worker',state:'idle'},{id:2,project:projectId(1),name:'Paused',state:'paused',pause_reason:'limit'}];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-agent-filter=active]').click();
  const pending=await holdRequest(page,url=>url.pathname==='/agent-query'&&url.searchParams.get('search')==='pause_reason:limit','GET');
  await page.locator('#agent-search').fill('pause_reason:limit');await pending.started;
  await page.locator('#agent-search').fill('New');pending.release();await pending.remove();
  await page.waitForFunction(()=>!agentSearchTimer&&state.agentBrowser[0]?.id===1&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('[data-agent-filter=active]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#agent-search').inputValue(),'New');
}));

test('returning to a discarded in-flight query starts a fresh parse instead of remaining stuck', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Group worker',group:'Team',state:'idle'}];await manualPolling(page);await reloadPage(page);
  const pending=await holdRequest(page,url=>url.pathname==='/agent-query'&&url.searchParams.get('search')==='group:Team','GET');
  await page.locator('#agent-search').fill('group:Team');await pending.started;
  await page.evaluate(()=>{state.agentSearch='other';document.querySelector('#agent-search').value='other';clearTimeout(agentSearchTimer);agentSearchTimer=null;});
  pending.release();await pending.remove();await page.waitForFunction(()=>state.agentQuery?.raw==='group:Team'&&!state.agentQuery.pending);
  await page.locator('#agent-search').fill('group:Team');await page.waitForFunction(()=>!agentSearchTimer&&currentAgentQuery()?.value&&state.agentBrowser[0]?.id===1&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('[data-edit-agent-filter=group]').count(),1);
  assert.equal(data.getRequests.filter(url=>url.startsWith('/agent-query?')&&new URL(url,'http://test').searchParams.get('search')==='group:Team').length,2);
}));

test('selected stale chips cannot edit or remove a different current query clause', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Group worker',group:'Team',state:'idle'},{id:2,project:projectId(1),name:'Other worker',group:'Elsewhere',state:'idle'}];
  await manualPolling(page);await reloadPage(page);await page.locator('#agent-search').fill('group:Team');
  await page.waitForFunction(()=>!agentSearchTimer&&state.agentBrowser[0]?.id===1&&!state.pages.agentBrowser.pending);
  await page.locator('#agent-search').blur();
  await selectText(page,'[data-edit-agent-filter=group]');
  await page.evaluate(()=>{state.agentSearch='provider:codex';return refreshAgentBrowser();});
  assert.equal(await page.locator('[data-edit-agent-filter=group]').count(),1,'selected old chip deliberately remains until selection clears');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('[data-remove-agent-clause="0"]').dispatchEvent('click');
  assert.equal(await page.evaluate(()=>state.agentSearch),'provider:codex');
  await page.locator('[data-edit-agent-filter=group]').dispatchEvent('click');
  assert.equal(await page.locator('#agent-filters').evaluate(el=>el.open),false);
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.equal(await page.locator('[data-edit-agent-filter=provider]').count(),1);assert.deepEqual(errors,[]);
}));

test('picker quoting preserves literal whitespace accepted by the shared query parser', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Tabbed group',group:'Line\tBreak',state:'idle'}];
  await manualPolling(page);await reloadPage(page);
  await page.locator('#agent-search').fill('group:"Line\tBreak"');
  await page.waitForFunction(()=>!agentSearchTimer&&state.agentBrowser[0]?.id===1&&!state.pages.agentBrowser.pending);
  await page.locator('[data-edit-agent-filter=group]').click();
  const input=page.locator('[data-filter-value]');assert.equal(await input.inputValue(),'Line\tBreak');
  await input.fill('Line\tBreaks');await input.fill('Line\tBreak');await applyVisualFilters(page);
  await page.waitForFunction(()=>!!currentAgentQuery()?.value&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('#agent-search').inputValue(),'group:"Line\tBreak"');assert.equal(await page.locator('#agent-query-error').isVisible(),false);
  assert.equal(await page.evaluate(()=>quotedQueryValue('Line\nBreak')),'"Line\nBreak"');
  const quoted=await page.evaluate(()=>quotedQueryValue('Line\nBreak'));
  assert.equal(agentQueryFixture(`group:${quoted}`).clauses[0].values[0],'Line\nBreak');
}));

test('live agent updates preserve unrelated nodes, selected task text, focused controls and reading position', async () => fixture(async (page,data) => {
  data.agents=Array.from({length:20},(_,i)=>({id:i+1,project:projectId(1),name:`Worker ${i+1}`,state:'working',task:`Stable task ${i+1}`,context:100,total_tokens:1000,token_usage_state:'provisional'}));
  await manualPolling(page); await reloadPage(page);
  const task='[data-agent="10"] .agent-task';
  await page.locator(task).scrollIntoViewIfNeeded();
  const selected=await selectText(page,task);
  await page.evaluate(()=>{window.retainedCard=document.querySelector('[data-agent="10"]');window.retainedOther=document.querySelector('[data-agent="9"]');window.retainedButton=document.querySelector('[data-agent="10"] [data-action=details]');window.retainedButton.focus({preventScroll:true});});
  const top=await page.locator(task).evaluate(node=>node.getBoundingClientRect().top);
  Object.assign(data.agents[19],{status:'A status update that changes an earlier card. '.repeat(12),waiting:{started_at:1,expires_at:9999999999,remaining_secs:80}});
  Object.assign(data.agents[9],{total_tokens:2000,context:200});
  await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>document.querySelector('[data-agent="10"]')===window.retainedCard),true,'the same card survives changed accounting');
  assert.equal(await page.evaluate(()=>document.querySelector('[data-agent="9"]')===window.retainedOther),true,'an unrelated card is not recreated');
  assert.equal(await page.evaluate(()=>document.activeElement===window.retainedButton),true,'the original focused control survives polling');
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.match(await page.locator('[data-agent="10"] .token-summary').textContent(),/2,000/,'selection in the task does not freeze other fields');
  assert.ok(Math.abs(await page.locator(task).evaluate(node=>node.getBoundingClientRect().top)-top)<2,'earlier card changes do not shift the reading anchor');
}));

test('disappearing notice branches and optional detail fields retain selected text until selection clears',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Stopping worker',state:'paused',stopping:true,has_diagnostics:true,total_tokens:1,token_usage_state:'finalised'}];
  await manualPolling(page);await reloadPage(page);
  const selected=await selectText(page,'[data-part=stopping-reason]');
  data.agents[0].stopping=false;data.agents[0].total_tokens=2;await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.match(await page.locator('[data-agent="1"] .token-summary').textContent(),/2/);
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.equal(await page.locator('[data-part=stopping-reason]').count(),0);assert.equal(await page.locator('[data-part=diagnostics]').count(),1);
  data.agents[0].stopping=true;await page.evaluate(()=>refresh());await page.locator('[data-action=details]').click();
  const detail=await selectText(page,'#agent-field-stopping');data.agents[0].stopping=false;await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),detail);assert.equal(await page.locator('dt[data-key=stopping]').count(),1);
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.equal(await page.locator('dt[data-key=stopping]').count(),0);assert.equal(await page.locator('#agent-field-stopping').count(),0);
}));

test('a selected agent leaving a live filter is retained without stale actions and can rejoin before deselection',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Selected worker',state:'working',task:'Text being read'},{id:2,project:projectId(1),name:'Other worker',state:'working',total_tokens:1,token_usage_state:'final'}];
  await manualPolling(page);await reloadPage(page);await page.locator('[data-agent-filter=working]').click();await page.waitForFunction(()=>!state.pages.agentBrowser.pending&&state.agentFilter==='working');
  const selected=await selectText(page,'[data-agent="1"] .agent-task');
  data.agents[0].state='idle';data.agents[1].total_tokens=2;await page.evaluate(()=>refresh());
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.locator('[data-agent="1"]').getAttribute('data-retained-selection'),'true');
  assert.equal(await page.locator('[data-agent="1"] [data-action=pause]').isDisabled(),true);assert.equal(await page.locator('[data-agent="1"] [data-action=details]').isEnabled(),true);
  assert.match(await page.locator('[data-agent="2"] .token-summary').textContent(),/2/);
  assert.match(await page.locator('#agent-count').textContent(),/1 of 1 matches/,'server counts exclude the temporarily retained row');
  data.agents[0].state='working';await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-agent="1"]').getAttribute('data-retained-selection'),null);
  assert.equal(await page.locator('[data-agent="1"] [data-action=pause]').isEnabled(),true);
  data.agents[0].state='idle';await page.evaluate(()=>refresh());
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.equal(await page.locator('[data-agent="1"]').count(),0);assert.equal(await page.locator('[data-agent="2"]').count(),1);
}));

test('large loaded agent windows patch changed fields without replacing every card',async t=>fixture(async(page)=>{
  await manualPolling(page);await reloadPage(page);
  const result=await page.evaluate(()=>{
    state.agentBrowser=Array.from({length:500},(_,i)=>({id:i+1,name:`Synthetic worker ${i+1}`,state:'working',task:'Review a synthetic task',harness:'codex',model:'example-model',effort:'medium',total_tokens:1000,token_usage_state:'provisional'}));
    Object.assign(state.pages.agentBrowser,{project_total:500,total:500,counts:{all:500,active:500,attention:0,finished:0}});
    renderAgents();
    const root=document.querySelector('#agents'),nodes=[...root.querySelectorAll('[data-agent]')],observer=new MutationObserver(()=>{});
    observer.observe(root,{childList:true,subtree:true});
    const start=performance.now();state.agentBrowser[250].total_tokens=2000;renderAgents();
    const elapsed=performance.now()-start,records=observer.takeRecords();observer.disconnect();
    return {elapsed,reused:nodes.every(node=>root.querySelector(`[data-agent="${node.dataset.agent}"]`)===node),removedCards:records.flatMap(record=>[...record.removedNodes]).filter(node=>node.nodeType===1&&node.matches('[data-agent]')).length,total:root.querySelector('[data-agent="251"] .token-summary').textContent};
  });
  assert.equal(result.reused,true);assert.equal(result.removedCards,0);assert.match(result.total,/2,000/);
  t.diagnostic(`500 loaded cards, one changed counter: ${result.elapsed.toFixed(1)} ms; no card replacements (informational, not a timing assertion).`);
}));

test('collection contention retains its last page without a connection warning or blocking an open conversation', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Worker',state:'idle'}];
  data.threads=[conversation([incoming(1,'First retained message')])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('[data-message="1"]').waitFor();
  const top=await page.locator('#messages').evaluate(node=>node.getBoundingClientRect().top);
  await page.route(/\/agents\?/,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'collection changed; restart paging without a cursor'})}));
  data.agents[0].status='Force a new collection revision';
  data.threads[0].messages.push(incoming(2,'Arrived during collection contention'));
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#connection-banner').isVisible(),false,'changing snapshots are not network outages');
  assert.equal(await page.locator('#live-text').textContent(),'live');
  assert.deepEqual(await messageIds(page),[1,2],'an independent conversation still refreshes');
  assert.ok(Math.abs(await page.locator('#messages').evaluate(node=>node.getBoundingClientRect().top)-top)<2,'retry feedback does not shift the conversation');
  assert.equal(await page.locator('[data-agent="1"]').count(),1,'the last consistent collection remains visible');
}));

test('concurrent collection readers all treat exhausted snapshot retries as contention rather than failures',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Retained worker',state:'idle'}];
  await manualPolling(page);await reloadPage(page);
  await page.route(/\/agents\?/,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'collection changed; restart paging'})}));
  const results=await page.evaluate(async()=>{
    state.revisions.agents='changed';
    return (await Promise.allSettled([loadCollection('agents'),loadCollection('agents')])).map(result=>result.status);
  });
  assert.deepEqual(results,['fulfilled','fulfilled']);
  assert.equal(await page.evaluate(()=>state.pages.agents.retrying),true);
  assert.equal(await page.locator('#connection-banner').isVisible(),false);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Retained worker/);
}));

test('overview snapshot contention is retried as live churn rather than a connection outage',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Retained worker',state:'idle'}];
  await manualPolling(page);await reloadPage(page);
  await page.route('**/overview*',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'record changed; restart reading'})}));
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#connection-banner').isVisible(),false);
  assert.equal(await page.locator('#live-text').textContent(),'live');
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Retained worker/);
}));

test('keyed agent rendering cannot replay an obsolete selected empty-state or skip a later identical validation error',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Worker',state:'idle',task:'Selected task'}];
  await manualPolling(page);await reloadPage(page);await selectText(page,'[data-agent="1"] .agent-task');
  await page.locator('#agent-search').fill('state:invalid');
  await page.waitForFunction(()=>currentAgentQuery()?.error);
  await page.locator('#agent-search').fill('');
  await page.waitForFunction(()=>currentAgentQuery()?.value&&state.pages.agentBrowser?.total===1);
  await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));});
  assert.equal(await page.locator('[data-agent="1"]').count(),1,'an obsolete selected-region update cannot replace current cards');
  await page.locator('#agent-search').fill('state:invalid');
  await page.waitForFunction(()=>currentAgentQuery()?.error);
  assert.match(await page.locator('#agents').textContent(),/Invalid search query/,'a repeated empty-state still replaces keyed cards');
}));

test('connection feedback does not resize an open conversation or move its reading position', async () => fixture(async (page,data) => {
  data.threads=[conversation([incoming(1,'Retained conversation. '.repeat(200))])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('[data-message="1"]').waitFor();
  await page.locator('#messages').evaluate(node=>node.scrollTop=100);
  const before=await page.locator('#messages').evaluate(node=>({top:node.getBoundingClientRect().top,height:node.clientHeight,scroll:node.scrollTop}));
  await page.route('**/overview*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporarily unavailable'})}));
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#connection-banner').isVisible(),true);
  assert.deepEqual(await page.locator('#messages').evaluate(node=>({top:node.getBoundingClientRect().top,height:node.clientHeight,scroll:node.scrollTop})),before);
}));

for (const width of [1280,375]) test(`full-date history entries do not overlap at ${width}px`,async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Worker',state:'idle'}];
  data.history=[{id:1,project:projectId(1),agent:1,kind:'agent.state',at:1800000000,details:{from:'idle',to:'working'}}];
  await manualPolling(page); await page.setViewportSize({width,height:800}); await reloadPage(page); await page.locator('[data-action=details]').click();
  await page.locator('#agent-lifecycle > summary').click();
  const entry=page.locator('#agent-lifecycle-items .event').first(); await entry.waitFor();
  const boxes=await entry.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node.querySelector('time'));const a=range.getBoundingClientRect(),b=node.lastElementChild.getBoundingClientRect();return {overlap:a.right>b.left&&a.left<b.right&&a.bottom>b.top&&a.top<b.bottom,entry:node.getBoundingClientRect().right,right:Math.max(a.right,b.right)};});
  assert.equal(boxes.overlap,false,'full timestamps and descriptions occupy separate space');
  assert.ok(boxes.right<=boxes.entry+1,'history remains inside its scroll region');
}));

test('field-specific identity and task filters share visual and typed semantics without broad name matches',async()=>fixture(async(page,data)=>{
  data.agents=[
    {id:1,project:projectId(1),name:'Coordinator',state:'idle',task:'Review general work',launched_by:0,status:'Waiting for review'},
    {id:2,project:projectId(1),name:'Worker',state:'idle',task:'Ask Coordinator to review parser',launched_by:1,status:'Ready'},
    {id:3,project:projectId(1),name:'coordinator',state:'working',task:'Review parser',launched_by:1,status:'Waiting for review'},
  ];
  await manualPolling(page);await reloadPage(page);
  await page.locator('#agent-search').fill('name:"Coordinator"');
  await page.waitForFunction(()=>state.pages.agentBrowser?.total===1&&state.agentBrowser[0]?.id===1);
  await openVisualFilters(page);
  assert.equal(await page.locator('[data-filter-field]').inputValue(),'name');
  assert.equal(await page.locator('[data-filter-value]').inputValue(),'Coordinator');
  await page.locator('[data-filter-field]').selectOption('launched_by');
  await page.locator('[data-filter-value]').fill('1');
  await applyVisualFilters(page);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[3,2]);
  await page.locator('#agent-search').fill('task:"REVIEW PARSER" status:"waiting for"');
  await page.waitForFunction(()=>state.pages.agentBrowser?.total===1&&state.agentBrowser[0]?.id===3);
  await page.locator('#agent-search').fill('id:2');
  await page.waitForFunction(()=>state.pages.agentBrowser?.total===1&&state.agentBrowser[0]?.id===2);
  await page.locator('#agent-search').fill('launched_by:user');
  await page.waitForFunction(()=>state.pages.agentBrowser?.total===1&&state.agentBrowser[0]?.id===1);
}));

for (const width of [1600,1024,390,320]) for (const scenario of ['empty','populated','large-counts']) test(`agent quick filters align and wrap at ${width}px with ${scenario}`,async()=>fixture(async(page,data)=>{
  data.agents=scenario==='empty'?[]:['working','idle','paused','crashed','done','closed','replaced'].map((state,index)=>({id:index+1,project:projectId(1),name:`Worker ${state}`,state}));
  await manualPolling(page);await page.setViewportSize({width,height:900});await reloadPage(page);
  if(scenario==='large-counts')await page.locator('[data-agent-count]').evaluateAll(nodes=>nodes.forEach(node=>node.textContent='1,000,000'));
  await page.evaluate(()=>document.fonts.ready);
  const toolbar=page.locator('.agent-toolbar'),more=page.locator('.state-shortcuts > details > summary');
  if(process.env.ACOM_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.ACOM_UI_SCREENSHOT_DIR,{recursive:true});await toolbar.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,`agent-quick-filters-${scenario}-${width}.png`)});}
  const check=async()=>toolbar.evaluate(root=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};};
    const controls=[...root.querySelectorAll('[data-agent-filter],.state-shortcuts > details > summary')].filter(node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');
    const boxes=controls.map(rect),bounds=rect(root);
    const groups=[root.querySelector(':scope > .filter-actions'),root.querySelector('.state-shortcuts > .filter-actions')].map(group=>[...group.children].map(rect));
    const counts=[...root.querySelectorAll('[data-agent-count]')].filter(node=>node.getClientRects().length);
    return {overflow:document.documentElement.scrollWidth>innerWidth||root.scrollWidth>root.clientWidth,
      outside:boxes.some(box=>box.left<bounds.left-1||box.right>bounds.right+1),
      overlaps:boxes.some((a,index)=>boxes.slice(index+1).some(b=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1)),
      countOverflow:counts.some(node=>{const box=rect(node),button=rect(node.parentElement);return box.left<button.left||box.right>button.right||box.bottom>button.bottom;}),
      counts:counts.map(node=>node.textContent),groups,heights:boxes.map(box=>box.height),first:rect(root.querySelector('[data-agent-filter=working]')),more:rect(root.querySelector('.state-shortcuts > details > summary'))};
  });
  const closed=await check();
  assert.equal(closed.overflow,false,'quick filters must not widen the viewport or toolbar');
  assert.equal(closed.outside,false,'quick filters stay within their container');
  assert.equal(closed.overlaps,false,'controls never overlap');
  assert.equal(closed.countOverflow,false,'full counts stay within their buttons');
  assert.ok(closed.heights.every(height=>height>=32),'every quick-filter control has a usable height');
  if(width>=1024||scenario!=='large-counts')assert.ok(closed.heights.every(height=>Math.abs(height-32)<1),'buttons and More states share the same compact height');
  if(scenario==='large-counts')assert.ok(closed.counts.every(count=>count==='1,000,000'),'large counts remain exact, not truncated or abbreviated');
  if(width<=480)for(const group of closed.groups){
    assert.ok(Math.abs(group[0].top-group[1].top)<1&&Math.abs(group[2].top-group[3].top)<1,'mobile shortcuts form two intentional rows');
    assert.ok(Math.abs(group[0].left-group[2].left)<1&&Math.abs(group[1].left-group[3].left)<1,'mobile shortcut columns align');
    assert.ok(Math.abs(group[0].height-group[1].height)<1&&Math.abs(group[2].height-group[3].height)<1,'wrapped counts preserve equal row heights');
  }
  if(width>=1024&&scenario!=='large-counts')assert.ok(Math.abs(closed.more.top-closed.first.top)<1,'More states aligns with the exact-state row, not above it');
  await more.focus();await more.press('Enter');assert.equal(await page.locator('.state-shortcuts > details').evaluate(node=>node.open),true);
  const expanded=await check();assert.equal(expanded.overflow,false);assert.equal(expanded.outside,false);assert.equal(expanded.overlaps,false);assert.equal(expanded.countOverflow,false);
  const terminals=await page.locator('[aria-label="Additional agent states"]').boundingBox();
  assert.ok(terminals.y>=expanded.more.bottom-1,'expanded states appear below the disclosure');
  assert.ok(Math.abs(terminals.x-expanded.first.left)<1,'expanded states start at the row edge, not in a floating right column');
  if(process.env.ACOM_UI_SCREENSHOT_DIR)await toolbar.screenshot({path:path.join(process.env.ACOM_UI_SCREENSHOT_DIR,`agent-quick-filters-${scenario}-${width}-expanded.png`)});
  await page.locator('[data-agent-filter=closed]').click();await page.waitForFunction(()=>state.agentFilter==='closed'&&!state.pages.agentBrowser.pending);
  assert.equal(await page.locator('[data-agent-filter][aria-pressed=true]').count(),1);
  await more.focus();await more.press('Space');assert.equal(await page.locator('.state-shortcuts > details').evaluate(node=>node.open),false);
  assert.match(await page.locator('#agent-filter-chips').textContent(),/closed/i,'the selected terminal state remains visible when collapsed');
}));

test('state shortcuts replace summary views rather than stacking incompatible categories and keep whole-project counts',async()=>fixture(async(page,data)=>{
  data.pageLimit=2;
  data.agents=['working','idle','paused','crashed','done','closed','replaced'].map((state,index)=>({id:index+1,project:projectId(1),name:`Worker ${state}`,state,group:'Team'}));
  await manualPolling(page);await reloadPage(page);
  for(const state of ['working','idle','paused','crashed']) {
    assert.equal(await page.locator(`[data-agent-count=${state}]`).textContent(),'1');
    await page.locator(`[data-agent-filter=${state}]`).click();
    await page.waitForFunction(expected=>state.pages.agentBrowser?.scope===collectionPath('agentBrowser')&&state.agentBrowser.length===1&&state.agentBrowser[0]?.state===expected,state);
    assert.equal(await page.locator('[data-agent-filter][aria-pressed=true]').count(),1);
    assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.state)),[state]);
    assert.match(await page.locator('#agent-count').textContent(),/1 of 1 matches.*7 total/);
  }
  await page.locator('.state-shortcuts > details > summary').click();
  await page.locator('[data-agent-filter=closed]').click();
  await page.waitForFunction(()=>state.agentBrowser.length===1&&state.agentBrowser[0]?.state==='closed');
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.state)),['closed']);
  await page.locator('[data-agent-filter=active]').click();
  await page.waitForFunction(()=>state.pages.agentBrowser?.scope===collectionPath('agentBrowser')&&state.agentBrowser.length===2);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.state)),['idle','working']);
  assert.equal(await page.locator('[data-agent-filter=closed]').getAttribute('aria-pressed'),'false');
}));

test('crash type filters match only current crashes, retain unknown classification and import into the visual builder',async()=>fixture(async(page,data)=>{
  data.agents=[{id:1,project:projectId(1),name:'Transport failure',state:'crashed',failure_kind:'transport'},{id:2,project:projectId(1),name:'Unclassified failure',state:'crashed'},{id:3,project:projectId(1),name:'Recovered worker',state:'idle',failure_kind:'transport'}];
  await manualPolling(page);await reloadPage(page);await page.locator('#agent-search').fill('failure_kind:transport');
  await page.waitForFunction(()=>state.pages.agentBrowser?.total===1&&state.agentBrowser[0]?.id===1);
  await openVisualFilters(page);assert.equal(await page.locator('[data-filter-field]').inputValue(),'failure_kind');
  await page.locator('[data-filter-value]').fill('unknown');await applyVisualFilters(page);
  assert.deepEqual(await page.evaluate(()=>state.agentBrowser.map(agent=>agent.id)),[2]);
}));

test('workspace connection failures retain the last view and Retry now recovers without overlapping requests', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Visible worker',state:'idle',harness:'codex',model:'gpt-6.1-sol',effort:'medium'}];
  await manualPolling(page); await reloadPage(page);
  const unavailable=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Workspace is temporarily unavailable'})});
  await page.route('**/overview*',unavailable);
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#connection-banner').isVisible(),true);
  assert.match(await page.locator('#connection-message').textContent(),/retry|reconnect|connection/i);
  assert.match(await page.locator('[data-agent="1"]').textContent(),/Visible worker/);
  assert.equal(await page.locator('#project-select').inputValue(),projectId(1));
  await page.unroute('**/overview*',unavailable);
  const before=data.getRequests.filter(url=>url.startsWith('/overview')).length;
  const retry=await holdRequest(page,'**/overview*','GET');
  await page.locator('#retry-connection').click(); await retry.started;
  assert.equal(await page.locator('#retry-connection').isDisabled(),true);
  await page.locator('#retry-connection').dispatchEvent('click');
  retry.release(); await retry.remove();
  await page.waitForFunction(()=>document.querySelector('#connection-banner').hidden && !document.querySelector('#retry-connection').disabled);
  assert.equal(await page.locator('#live-text').textContent(),'live');
  assert.equal(await page.locator('#project-select').inputValue(),projectId(1));
  assert.equal(data.getRequests.filter(url=>url.startsWith('/overview')).length-before,1);
  assert.equal(data.requests.length,0);
}));

async function holdMessageReceipt(page) {
  let release, saved, finished;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { saved = resolve; });
  const completed = new Promise(resolve => { finished = resolve; });
  const handler = async route => {
    const response = await route.fetch(); saved();
    await gate;
    await route.fulfill({response}).catch(() => {});
    finished();
  };
  await page.route('**/messages', handler);
  return {started,release,remove:async() => {await completed; await page.unroute('**/messages',handler);}};
}

test('chat Markdown formats basic blocks and inline text while copying exact source', async () => fixture(async (page,data) => {
  const source = '# Review\n\nA **bold** and *italic* paragraph with `x < y`.\n\n- First item\n- Second item\n\n1. One\n2. Two\n\n> Quoted advice\n\n```solidity\nif (x < y) return "safe";\n```\n\n| Field | Value |\n| --- | --- |\n| owner | alice |\n\n[Docs](https://example.com/review) and [Email](mailto:review@example.com)\n';
  data.threads=[conversation([incoming(1,source)])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const message=page.locator('[data-message="1"] .message-text');
  await message.waitFor();
  assert.equal(await message.locator('h1').count(),1,'Markdown headings render as headings');
  assert.equal(await message.locator('h1').textContent(),'Review');
  assert.equal(await message.locator('h1').evaluate(node=>getComputedStyle(node).fontSize),'15px','chat headings do not inherit page-heading styling');
  assert.equal(await message.locator('strong').textContent(),'bold');
  assert.equal(await message.locator('em').textContent(),'italic');
  assert.equal(await message.locator('p code').textContent(),'x < y');
  assert.deepEqual(await message.locator('ul > li').allTextContents(),['First item','Second item']);
  assert.deepEqual(await message.locator('ol > li').allTextContents(),['One','Two']);
  assert.match(await message.locator('blockquote').textContent(),/Quoted advice/);
  assert.match(await message.locator('pre > code').textContent(),/if \(x < y\) return "safe";/);
  assert.deepEqual(await message.locator('thead th').allTextContents(),['Field','Value']);
  assert.deepEqual(await message.locator('tbody td').allTextContents(),['owner','alice']);
  assert.equal(await message.getByRole('link',{name:'Docs',exact:true}).getAttribute('href'),'https://example.com/review');
  assert.equal(await message.getByRole('link',{name:'Email',exact:true}).getAttribute('href'),'mailto:review@example.com');
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('[data-copy-message="1"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Message copied');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),source);
  assert.equal(await page.evaluate(()=>state.thread.messages[0].text),source);
  assert.equal(data.threads[0].messages[0].text,source);
}));

test('chat Markdown preserves plain-message line breaks without requiring Markdown punctuation', async () => fixture(async (page,data) => {
  data.threads=[conversation([incoming(1,'First line\nSecond line')])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const message=page.locator('[data-message="1"] .message-text');
  await message.waitFor();
  assert.equal(await message.locator('br').count(),1,'an ordinary newline remains a visible line break');
  assert.match(await message.textContent(),/First line\s*Second line/);
  assert.equal(await page.evaluate(()=>state.thread.messages[0].text),'First line\nSecond line');
}));

test('chat Markdown treats hostile HTML, images and unsafe or obfuscated destinations as inert text', async () => fixture(async (page,data) => {
  const source = [
    '<script>window.markdownUnsafe=true</script>',
    '<img src="https://attacker.example/raw" onerror="window.markdownUnsafe=true">',
    '<svg onload="window.markdownUnsafe=true"><a href="javascript:alert(1)">svg</a></svg>',
    '<iframe src="https://attacker.example/frame"></iframe>',
    '![pixel](https://attacker.example/pixel)',
    '[script](javascript:alert(1))', '[mixed](JaVaScRiPt:alert(1))',
    '[entity](java&#x73;cript:alert(1))', '[colon](javascript&#58;alert(1))',
    '[tab](java&#x09;script:alert(1))', '[encoded](%6aavascript:alert(1))',
    '[data](data:text/html;base64,PHNjcmlwdD4=)', '[file](file:///etc/passwd)',
    '[relative](/unexpected)', '[fragment](#unexpected)', '[protocol-relative](//attacker.example/link)',
    '[attribute](https://example.com/\"onmouseover=\"alert)',
    '```\"><img/src=x/onerror=window.markdownUnsafe=true>\nLiteral code\n```',
    '[allowed](https://example.com/review)',
  ].join('\n\n');
  data.threads=[conversation([incoming(1,source)])];
  const external=[]; const origin=new URL(page.url()).origin;
  page.on('request',request=>{if(new URL(request.url()).origin!==origin)external.push(request.url());});
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const message=page.locator('[data-message="1"] .message-text');
  await message.waitFor();
  assert.equal(await message.locator('script,img,svg,iframe,object,embed,style,link').count(),0);
  assert.equal(await message.locator('[onerror],[onload],[onmouseover],[src],[srcdoc]').count(),0);
  assert.equal(await page.evaluate(()=>window.markdownUnsafe),undefined);
  const hrefs=await message.locator('a').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')));
  assert.ok(hrefs.length>=1,'allowed links still render');
  assert.ok(hrefs.every(href=>/^(?:https?:\/\/|mailto:)/i.test(href)),`unsafe links rendered: ${JSON.stringify(hrefs)}`);
  for(const anchor of await message.locator('a[target="_blank"]').all())assert.match(await anchor.getAttribute('rel'),/noopener/);
  assert.match(await message.textContent(),/window\.markdownUnsafe=true/);
  assert.deepEqual(external,[],'message contents cannot trigger network requests');
}));

for(const failure of ['missing','tampered','throwing','rendering'])test(`chat Markdown ${failure} parser falls back to escaped plain source`, async () => fixture(async (page,data) => {
  const source='**Keep this source**\n<script>window.markdownUnsafe=true</script>\n![pixel](https://attacker.example/pixel)';
  data.threads=[conversation([incoming(1,source)])];
  if(failure==='missing')await page.route(`**${markdownAsset}`,route=>route.abort());
  if(failure==='tampered')await page.route(`**${markdownAsset}`,route=>route.fulfill({contentType:'text/javascript',body:'window.markdownTamperedExecuted = true;'}));
  if(failure==='throwing')await page.addInitScript(()=>Object.defineProperty(window,'markdownit',{
    configurable:true,set(){},get(){return()=>{window.markdownFactoryFailed=true;throw new Error('Parser unavailable');};},
  }));
  await manualPolling(page); await reloadPage(page);
  if(failure==='rendering')await page.evaluate(()=>{messageMarkdown.parse=()=>{window.markdownRenderingFailed=true;throw new Error('Rendering unavailable');};});
  await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const message=page.locator('[data-message="1"] .message-text');
  await message.waitFor();
  assert.equal(await message.locator('.message-plain').count(),1,'unavailable formatting keeps an explicit plain-text fallback');
  assert.equal(await message.textContent(),source);
  assert.equal(await message.locator('script,img,strong').count(),0);
  assert.equal(await message.locator('.message-plain').evaluate(node=>getComputedStyle(node).whiteSpace),'pre-wrap');
  assert.equal(await page.evaluate(()=>window.markdownUnsafe),undefined);
  if(failure==='tampered')assert.equal(await page.evaluate(()=>window.markdownTamperedExecuted),undefined,'SRI prevents altered dependency bytes from executing');
  if(failure==='throwing')assert.equal(await page.evaluate(()=>window.markdownFactoryFailed),true,'the real factory failure path is exercised, not an SRI rejection');
  if(failure==='rendering')assert.equal(await page.evaluate(()=>window.markdownRenderingFailed),true);
}));

test('chat Markdown deep nesting falls back without dropping quoted or listed source', async () => fixture(async (page,data) => {
  const sources=[`${'> '.repeat(30)}Keep the deeply quoted tail`,Array.from({length:30},(_,i)=>`${'  '.repeat(i)}- Nested item ${i}`).join('\n')+'\n'+'  '.repeat(30)+'- Keep the deeply listed tail'];
  data.threads=[conversation(sources.map((source,i)=>incoming(i+1,source)))];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  for(const [index,source] of sources.entries()) {
    const message=page.locator(`[data-message="${index+1}"] .message-text`);
    await message.waitFor();
    assert.equal(await message.locator('.message-plain').count(),1,'depth limits preserve the full source instead of silently discarding its tail');
    assert.equal(await message.textContent(),source);
  }
}));

test('chat Markdown large source falls back losslessly and copies without truncation', async () => fixture(async (page,data) => {
  const source='**Large message**\n'+('retained source '.repeat(5000))+'\nKeep the final <tail>.';
  data.threads=[conversation([incoming(1,source)])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const message=page.locator('[data-message="1"] .message-text');
  await message.waitFor();
  assert.equal(await message.locator('.message-plain').count(),1);
  assert.equal(await message.textContent(),source);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('[data-copy-message="1"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Message copied');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),source);
  assert.equal(await page.evaluate(()=>state.thread.messages[0].text),source);
}));

test('chat Markdown token amplification falls back without truncating large tables', async () => fixture(async (page,data) => {
  const source='| Item | First | Second |\n| --- | --- | --- |\n'+Array.from({length:1000},(_,i)=>`| ${i} | a | b |`).join('\n');
  assert.ok(source.length<65536,'the token budget is tested independently from the source-length budget');
  data.threads=[conversation([incoming(1,source)])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const message=page.locator('[data-message="1"] .message-text');
  await message.waitFor();
  assert.equal(await message.locator('.message-plain').count(),1);
  assert.equal(await message.locator('table').count(),0);
  assert.equal(await message.textContent(),source);
  assert.equal(await page.evaluate(()=>state.thread.messages[0].text),source);
}));

test('chat Markdown pending receipt and polling reuse selected rendered content while preserving raw copy', async () => fixture(async (page,data) => {
  const source='**Review update**\n\n`x < y` stays literal in code.';
  data.threads=[conversation([])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const receipt=await holdMessageReceipt(page);
  await page.locator('#message-form textarea').fill(source); await page.locator('#message-form button').click(); await receipt.started;
  assert.equal(await page.locator('.message.sending strong').textContent(),'Review update');
  assert.equal(await page.locator('.message.sending code').textContent(),'x < y');
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('.message.sending [data-copy-message]').click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),source);
  const selected=await selectText(page,'.message.sending .message-text');
  await page.evaluate(()=>refreshThread());
  assert.equal(await page.locator('#messages .message').count(),1);
  receipt.release(); await receipt.remove();
  await page.waitForFunction(()=>!document.querySelector('#message-form button').disabled);
  await page.evaluate(()=>refreshThread());
  assert.deepEqual(await messageIds(page),[1]);
  assert.equal(await page.locator('[data-pending-message]').count(),0);
  assert.equal(await page.locator('[data-message="1"] .message-text strong').textContent(),'Review update');
  assert.equal(await page.evaluate(()=>window.selectedNode===document.querySelector('[data-message="1"] .message-text')),true);
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.locator('[data-copy-message="1"]').click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),source);
  assert.equal(data.threads[0].messages[0].text,source);
}));

test('chat Markdown renders the first older-page message and retains its exact copy source', async () => fixture(async (page,data) => {
  const source='**Earlier review** with `original code`';
  data.pageLimit=2;data.reads[1]=4;
  data.threads=[conversation([incoming(1,source),incoming(2,'Second earlier reply'),incoming(3,'Recent reply'),incoming(4,'Latest reply')])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('[data-message="4"]').waitFor();
  assert.deepEqual(await messageIds(page),[3,4]);
  await page.locator('#thread-older').click(); await page.locator('[data-message="1"]').waitFor();
  assert.deepEqual(await messageIds(page),[1,2,3,4]);
  assert.equal(await page.locator('[data-message="1"] .message-text strong').count(),1,'the first prepended message keeps its rendered body');
  assert.equal(await page.locator('[data-message="1"] .message-text strong').textContent(),'Earlier review');
  assert.equal(await page.locator('[data-message="1"] .message-text code').textContent(),'original code');
  await page.context().grantPermissions(['clipboard-read','clipboard-write']); await page.locator('[data-copy-message="1"]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Message copied');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),source);
  await page.evaluate(()=>refreshThread()); assert.deepEqual(await messageIds(page),[1,2,3,4]);
}));

test('chat Markdown wide code and tables scroll inside mobile messages without widening the page', async () => fixture(async (page,data) => {
  const source=`\`\`\`text\n${'long_code_value_'.repeat(35)}\n\`\`\`\n\n| ${Array.from({length:20},(_,i)=>`Column ${i}`).join(' | ')} |\n| ${Array(20).fill('---').join(' | ')} |\n| ${Array(20).fill('Value').join(' | ')} |`;
  data.threads=[conversation([incoming(1,source)])];
  await manualPolling(page); await page.setViewportSize({width:320,height:568}); await reloadPage(page); await openSidebar(page);
  await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const message=page.locator('[data-message="1"] .message-text');
  await message.waitFor();
  assert.equal(await message.locator('pre').count(),1);
  assert.equal(await message.locator('table').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  for(const selector of ['pre','table'])assert.equal(await message.locator(selector).evaluate(node=>{
    let scroller=node;
    while(scroller!==node.closest('.message-text')&&!['auto','scroll'].includes(getComputedStyle(scroller).overflowX))scroller=scroller.parentElement;
    const messages=document.querySelector('#messages').getBoundingClientRect(),bounds=scroller.getBoundingClientRect();
    return ['auto','scroll'].includes(getComputedStyle(scroller).overflowX)&&scroller.scrollWidth>scroller.clientWidth&&bounds.left>=messages.left&&bounds.right<=messages.right;
  }),true,`${selector} scrolls inside the message viewport`);
  assert.equal(await message.locator('pre').evaluate(node=>getComputedStyle(node).overflowX==='auto'&&node.scrollWidth>node.clientWidth),true,'wide code stays horizontally scrollable');
  assert.equal(await page.locator('#message-form button').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight),true);
}));

test('sending messages appear immediately, remain copyable, and confirm without waiting for a refresh', async () => fixture(async (page,data) => {
  data.threads=[conversation([])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const pending=await holdRequest(page,'**/messages');
  const text='Keep exact text <tag>\nwith another line';
  await page.locator('#message-form textarea').fill(text); await page.locator('#message-form button').click(); await pending.started;
  assert.equal(await page.locator('.message.sending .message-text').textContent(),text);
  assert.equal(await page.locator('.message-delivery').textContent(),'Sending…');
  assert.equal(await page.locator('.message.sending').evaluate(node=>getComputedStyle(node).opacity),'1');
  assert.equal(await page.locator('.message.sending .message-text').evaluate(node=>getComputedStyle(node).opacity),'0.75');
  assert.equal(await page.locator('#messages .empty').count(),0);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.locator('.message.sending [data-copy-message]').click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),text);
  await page.route(/\/threads\/1\/messages(?:\?|$)/,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Refresh unavailable'})}));
  pending.release(); await pending.remove();
  await page.waitForFunction(()=>document.querySelector('#message-form textarea').value==='');
  assert.equal(await page.locator('[data-message="1"] .message-text').textContent(),text);
  assert.equal(await page.locator('.message.sending, .message-delivery').count(),0);
  assert.deepEqual(await page.evaluate(()=>state.thread.messages.map(message=>message.id)),[],'the POST confirmation cannot move the polling cursor');
  await page.locator('[data-message="1"] [data-copy-message]').click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),text);
  assert.equal(data.requests.filter(request=>request.url==='/messages').length,1);
}));

test('post confirmations cannot skip intervening peer messages or duplicate paged results', async () => fixture(async (page,data) => {
  data.threads=[conversation([incoming(10)])]; data.reads={1:10}; data.pageLimit=1;
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.waitForFunction(()=>state.thread?.messages.at(-1)?.id===10&&!threadLoading);
  const pattern=/\/threads\/1\/messages\?after=10(?:&|$)/, poll=await holdRequest(page,pattern,'GET');
  const started=page.waitForRequest(request=>request.method()==='GET'&&pattern.test(request.url()),{timeout:5000});
  await page.evaluate(()=>{window.heldMessagePoll=refreshThread();}); await started;
  data.threads[0].messages.push(incoming(11,'Intervening peer message'));
  await page.locator('#message-form textarea').fill('Confirmed outgoing'); await page.locator('#message-form button').click();
  await page.waitForFunction(()=>document.querySelector('#message-form textarea').value==='');
  assert.deepEqual(await messageIds(page),[10,12]);
  assert.deepEqual(await page.evaluate(()=>state.thread.messages.map(message=>message.id)),[10]);
  poll.release(); await poll.remove(); await page.evaluate(()=>window.heldMessagePoll);
  assert.deepEqual(await messageIds(page),[10,11,12]);
  assert.equal(await page.locator('[data-message="12"]').count(),1);
  assert.equal(await page.locator('[data-pending-message]').count(),0);
  assert.deepEqual(await page.evaluate(()=>state.thread.messages.map(message=>message.id)),[10,11,12]);
  assert.ok(data.getRequests.some(url=>url.startsWith('/threads/1/messages?after=10')));
  await page.evaluate(()=>refreshThread()); assert.deepEqual(await messageIds(page),[10,11,12]);
}));

for (const moveFallback of [false,true]) test(`polling before the POST receipt reconciles by IDs and preserves selection (${moveFallback ? 'move fallback' : 'native move'})`, async () => fixture(async (page,data) => {
  data.threads=[conversation([{id:1,sender:0,text:'Same text',at:1}])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  if (moveFallback) await page.locator('#messages').evaluate(node=>{node.moveBefore=undefined;});
  const receipt=await holdMessageReceipt(page);
  await page.locator('#message-form textarea').fill('Same text'); await page.locator('#message-form button').click(); await receipt.started;
  data.threads[0].messages.push({id:3,sender:0,text:'Same text',at:2},incoming(4,'Peer still appears immediately'));
  await page.evaluate(()=>refreshThread());
  assert.deepEqual(await page.evaluate(()=>state.thread.messages.map(message=>message.id)),[1,2,3,4]);
  assert.deepEqual(await messageIds(page),[1,4]);
  assert.equal(await page.locator('.message.sending').count(),1);
  assert.equal(await page.locator('.message-text').filter({hasText:'Same text'}).count(),2,'a polled copy does not duplicate the pending bubble');
  const selected = await selectText(page,'.message.sending .message-text');
  receipt.release(); await receipt.remove();
  await page.waitForFunction(()=>!document.querySelector('#message-form button').disabled);
  assert.deepEqual(await messageIds(page),[1,2,3,4]);
  assert.equal(await page.locator('.message-text').filter({hasText:'Same text'}).count(),3,'separate identical messages survive reconciliation');
  assert.equal(await page.locator('[data-pending-message]').count(),0);
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>window.selectedNode === document.querySelector('[data-message="2"] .message-text')),true,'confirmation reuses the selected pending text node');
}));

test('definite message rejections show Failed, retain the draft, and permit an explicit retry', async () => fixture(async (page,data) => {
  data.threads=[conversation([])]; data.messageFailure=true; data.messageFailureStatus=400;
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#message-form textarea').fill('Retry this rejected message'); await page.locator('#message-form button').click();
  await page.waitForFunction(()=>document.querySelector('.message.failed'));
  assert.match(await page.locator('.message-delivery').textContent(),/^Failed/);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Retry this rejected message');
  assert.equal(data.threads[0].messages.length,0);
  data.messageFailure=false; await page.locator('#message-form button').click();
  await page.waitForFunction(()=>document.querySelector('#message-form textarea').value==='');
  assert.equal(await page.locator('.message').count(),1);
  assert.equal(await page.locator('.message-delivery').count(),0);
  assert.equal(data.requests.filter(request=>request.url==='/messages').length,2);
}));

test('a lost message receipt stays unconfirmed, flushes polled messages, and never silently retries', async () => fixture(async (page,data) => {
  data.threads=[conversation([])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const abort=async route=>{await route.fetch(); await route.abort('failed');};
  await page.route('**/messages',abort);
  await page.locator('#message-form textarea').fill('Possibly saved'); await page.locator('#message-form button').click();
  await page.waitForFunction(()=>document.querySelector('.message.unconfirmed'));
  assert.match(await page.locator('.message-delivery').textContent(),/^Delivery unconfirmed/);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Possibly saved');
  await page.evaluate(()=>refreshThread());
  assert.deepEqual(await messageIds(page),[1]);
  assert.equal(await page.locator('.message.unconfirmed').count(),1,'matching text does not invent request identity');
  assert.equal(data.requests.filter(request=>request.url==='/messages').length,1);
  page.once('dialog',dialog=>dialog.dismiss()); await page.locator('#message-form button').click();
  assert.equal(data.requests.filter(request=>request.url==='/messages').length,1,'retry requires an explicit uncertainty confirmation');
  await page.unroute('**/messages',abort);
}));

test('a malformed successful message receipt cannot clear a draft or claim delivery', async () => fixture(async (page,data) => {
  data.threads=[conversation([])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.route('**/messages',route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
  await page.locator('#message-form textarea').fill('Keep this without a receipt ID'); await page.locator('#message-form button').click();
  await page.waitForFunction(()=>document.querySelector('.message.unconfirmed'));
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Keep this without a receipt ID');
  assert.equal(await page.locator('[data-message]').count(),0);
  assert.match(await page.locator('#toast').textContent(),/did not contain a message ID/);
  assert.equal(data.requests.filter(request=>request.url==='/messages').length,0);
}));

test('an outgoing receipt cannot replace another project or erase its newer draft', async () => fixture(async (page,data) => {
  data.threads=[conversation([]),conversation([],{id:2,project:projectId(2),title:'Other project'})];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const receipt=await holdMessageReceipt(page);
  await page.locator('#message-form textarea').fill('Sent in first project'); await page.locator('#message-form button').click(); await receipt.started;
  await page.locator('#project-select').selectOption(projectId(2)); await page.locator('[data-thread="2"]').click();
  await page.locator('#message-form textarea').fill('Other project draft');
  receipt.release(); await receipt.remove(); await page.waitForFunction(()=>pendingSends.size===0);
  assert.equal(await page.locator('#message-form textarea').inputValue(),'Other project draft');
  assert.equal(await page.locator('.message').count(),0);
  assert.equal(await page.evaluate(()=>state.thread.id),2);
  await page.locator('#project-select').selectOption(projectId(1)); await page.locator('[data-thread="1"]').click();
  assert.equal(await page.locator('[data-message="1"] .message-text').textContent(),'Sent in first project');
  assert.equal(await page.locator('.message').count(),1);
}));

test('modal scrolling contains wheel gestures at both boundaries without moving the background', async () => fixture(async (page,data) => {
  data.agents=Array.from({length:35},(_,i)=>({id:i+1,project:projectId(1),name:`Worker ${i+1}`,state:'paused',task:i===9?'Detail line\n'.repeat(90):'Review the example'}));
  data.agentLogs[10]=Array.from({length:80},(_,i)=>`Activity ${i}`);
  await manualPolling(page); await page.setViewportSize({width:1280,height:720}); await reloadPage(page);
  await page.locator('[data-agent="10"] [data-action=details]').click(); await page.locator('#agent-field-task').waitFor();
  const dialog=page.locator('#agent-dialog');
  assert.ok(await page.evaluate(()=>document.scrollingElement.scrollHeight>innerHeight),'the underlying page must genuinely be scrollable');
  assert.ok(await dialog.evaluate(node=>node.scrollHeight>node.clientHeight),'the detail modal must genuinely be scrollable');
  const background=await page.evaluate(()=>scrollY);
  assert.ok(background>0,'a downward-scrolled background also makes upward scroll leakage observable');
  const wheel=async (selector,delta)=>{
    const box=await page.locator(selector).boundingBox();
    await page.mouse.move(box.x+box.width-24,box.y+Math.min(90,box.height/2)); await page.mouse.wheel(0,delta); await page.waitForTimeout(160);
  };
  await dialog.evaluate(node=>{node.scrollTop=0;}); await wheel('#agent-dialog',450);
  assert.ok(await dialog.evaluate(node=>node.scrollTop>0),'wheel gestures still scroll modal content normally');
  assert.equal(await page.evaluate(()=>scrollY),background);
  await dialog.evaluate(node=>{node.scrollTop=node.scrollHeight;});
  await wheel('#agent-dialog',900);
  assert.equal(await page.evaluate(()=>scrollY),background,'a downward gesture at the modal end cannot scroll the document');
  await page.locator('#agent-log').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  await wheel('#agent-log',900);
  assert.equal(await page.evaluate(()=>scrollY),background,'nested output scroll boundaries cannot reach the document');
  await dialog.evaluate(node=>{node.scrollTop=0;});
  await wheel('#agent-dialog',-900);
  assert.equal(await page.evaluate(()=>scrollY),background,'an upward gesture at the modal start cannot scroll the document');
}));

test('modal dismissal stays accessible after scrolling and preserves native keyboard focus', async () => fixture(async (page,data) => {
  data.agents=[{id:1,project:projectId(1),name:'Long details',state:'paused',task:'Read this long detail\n'.repeat(90)}];
  await manualPolling(page); await page.setViewportSize({width:1280,height:720}); await reloadPage(page);
  const trigger=page.locator('[data-agent="1"] [data-action=details]');
  await trigger.click(); await page.locator('#agent-field-task').waitFor();
  const dialog=page.locator('#agent-dialog'), close=dialog.locator('.dialog-close');
  assert.equal(await close.count(),1,'each modal has one always-accessible close control');
  assert.match(await close.getAttribute('aria-label'),/^Close\b/);
  for(const id of ['agent-subscription-items','agent-diagnostics-items','agent-lifecycle-items']) {
    const region=page.locator(`#${id}`);
    assert.equal(await region.getAttribute('role'),'region'); assert.equal(await region.getAttribute('tabindex'),'0');
    assert.ok((await region.getAttribute('aria-label'))?.trim(),'nested activity regions have names for keyboard and screen-reader navigation');
  }
  await dialog.evaluate(node=>{node.scrollTop=node.scrollHeight;});
  const bounds=await dialog.boundingBox(), button=await close.boundingBox();
  assert.ok(button.y>=bounds.y&&button.y+button.height<=bounds.y+Math.min(bounds.height,70),'Close stays in the modal’s top-right corner while its content scrolls');
  assert.ok(button.x+button.width>=bounds.x+bounds.width-70);
  await close.click(); assert.equal(await dialog.isVisible(),false);
  assert.equal(await trigger.evaluate(node=>document.activeElement===node),true,'closing restores focus to the launching control');
  await trigger.click(); await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(),false);
  assert.equal(await trigger.evaluate(node=>document.activeElement===node),true,'Escape preserves native focus restoration');
  assert.deepEqual(data.requests,[],'dismissing a detail modal never mutates an agent');
}));

test('modal backdrop dismissal ignores inside interactions and drags that began in content', async () => fixture(async (page,data) => {
  await manualPolling(page); await reloadPage(page); await openLaunch(page);
  const dialog=page.locator('#launch-dialog');
  await page.locator('#launch-form [name=task]').fill('Keep this unsubmitted task');
  await page.locator('#launch-title').click(); assert.equal(await dialog.isVisible(),true);
  const title=await page.locator('#launch-title').boundingBox();
  await page.mouse.move(title.x+15,title.y+title.height/2); await page.mouse.down(); await page.mouse.move(5,5); await page.mouse.up();
  assert.equal(await dialog.isVisible(),true,'text selection ending on the backdrop must not dismiss a modal');
  await page.mouse.click(5,5); assert.equal(await dialog.isVisible(),false,'a complete backdrop click dismisses the modal');
  assert.deepEqual(data.requests,[],'backdrop dismissal must not submit the form');
  await openLaunch(page);
  assert.equal(await page.locator('#launch-form [name=task]').inputValue(),'Keep this unsubmitted task','dismissing and reopening does not erase entered form data');
}));

test('closing a nested modal restores its parent without unlocking or dismissing it', async () => fixture(async (page,data) => {
  await manualPolling(page); await reloadPage(page);
  await page.locator('[data-open=project-dialog]').click();
  await page.locator('#project-form [name=path]').fill('/projects/unsubmitted');
  await page.locator('#browse-project').click(); await page.locator('#folder-dialog').waitFor();
  await page.locator('#folder-dialog .dialog-close').click();
  assert.equal(await page.locator('#folder-dialog').isVisible(),false);
  assert.equal(await page.locator('#project-dialog').isVisible(),true);
  assert.equal(await page.locator('#browse-project').evaluate(node=>document.activeElement===node),true);
  assert.equal(await page.locator('#project-form [name=path]').inputValue(),'/projects/unsubmitted');
  await page.locator('#browse-project').click(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#folder-dialog').isVisible(),false);
  assert.equal(await page.locator('#project-dialog').isVisible(),true);
  await page.mouse.click(5,5); assert.equal(await page.locator('#project-dialog').isVisible(),false);
  assert.deepEqual(data.requests,[]);
}));

for(const viewport of [{width:1280,height:900},{width:375,height:760}])test(`message metadata floats outside the correct side of short, medium and long bubbles at ${viewport.width}px`,async()=>fixture(async(page,data)=>{
  const source='Review paragraph with **emphasis** and an exact copy.\n\n'.repeat(100);
  const medium=Array.from({length:6},(_,index)=>`Medium line ${index+1}`).join('\n');
  data.threads=[conversation([incoming(1,source),{id:2,sender:0,at:2,text:source},incoming(3,'Short agent reply'),{id:4,sender:0,at:4,text:'Short user reply'},incoming(5,medium),{id:6,sender:0,at:6,text:medium},incoming(7,'Keep space after the medium replies.\n'.repeat(30))])]; data.reads[1]=7;
  await manualPolling(page); await page.setViewportSize(viewport); await reloadPage(page);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await openSidebar(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  for(const id of [1,2,3,4,5,6]) {
    for(const progress of id<=2?[.25,.5,.75]:[.5]) {
      await page.locator(`[data-message="${id}"]`).evaluate((node,{progress,topAligned})=>{
        const messages=node.closest('#messages'), message=node.getBoundingClientRect(), box=messages.getBoundingClientRect();
        messages.scrollTop+=message.top-box.top+(topAligned?-12:message.height*progress-messages.clientHeight/2);
      },{progress,topAligned:id>=5});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const placement=await page.locator(`[data-message="${id}"] .message-head`).evaluate(node=>{
        const head=node.getBoundingClientRect(), messages=node.closest('#messages').getBoundingClientRect(), bubble=node.closest('.message').querySelector('.message-bubble');
        if(!bubble)return {external:false};
        const body=bubble.getBoundingClientRect(), visibleTop=Math.max(body.top,messages.top), visibleBottom=Math.min(body.bottom,messages.bottom);
        return {external:node.parentElement===bubble.parentElement&&!bubble.contains(node),background:getComputedStyle(node.parentElement).backgroundColor,bubbleBackground:getComputedStyle(bubble).backgroundColor,inside:head.top>=messages.top&&head.bottom<=messages.bottom&&head.top>=0&&head.bottom<=innerHeight,center:(head.top+head.bottom)/2,visibleCenter:(visibleTop+visibleBottom)/2,head:{left:head.left,right:head.right},body:{left:body.left,right:body.right}};
      });
      assert.equal(placement.external,true,'sender, date and copy are outside the message bubble, not inside its border/background');
      assert.equal(placement.background,'rgba(0, 0, 0, 0)','the layout row must not extend the bubble background behind metadata');
      assert.notEqual(placement.bubbleBackground,'rgba(0, 0, 0, 0)','only the separate bubble has the message background');
      assert.equal(placement.inside,true,`metadata stays visible while reading message ${id} at ${progress}`);
      assert.ok(id%2===1?placement.head.left>=placement.body.right+4:placement.head.right<=placement.body.left-4,`agent metadata belongs to the right and user metadata to the left of message ${id}`);
      assert.ok(Math.abs(placement.center-placement.visibleCenter)<=4,`metadata floats at the visible bubble midpoint for message ${id} at ${progress}, not pinned to its top: ${JSON.stringify(placement)}`);
      assert.match(await page.locator(`[data-message="${id}"] .message-head`).textContent(),id%2===1?/agent 1/:/you/);
      if(id<=2&&progress===.5) {
        const before=await page.locator('#messages').evaluate(node=>node.scrollTop);
        await page.locator(`[data-copy-message="${id}"]`).click();
        assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),source);
        assert.equal(await page.locator('#messages').evaluate(node=>node.scrollTop),before,'copying midway through a long message does not jump to its top');
      }
    }
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'metadata does not introduce horizontal page overflow');
}));

test('new-message divider survives read acknowledgements, earlier paging and polling until a conversation is reopened',async()=>fixture(async(page,data)=>{
  data.pageLimit=2; data.reads[1]=3;
  data.threads=[conversation([incoming(1),incoming(2),incoming(3),{id:4,sender:0,at:4,text:'Own reply'}, {...incoming(5),outside_membership:true},incoming(6),incoming(7)])];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  const boundary=page.locator('[data-unread-divider]');
  await boundary.waitFor(); assert.equal(await boundary.count(),1); assert.equal(await boundary.textContent(),'New messages');
  assert.equal(await boundary.evaluate(node=>node.nextElementSibling?.dataset.message),'6','the marker identifies the first real unread peer message, not earlier own or catch-up messages');
  await page.waitForFunction(()=>state.thread.unread===0); assert.equal(data.reads[1],7);
  await page.evaluate(()=>refresh()); assert.equal(await boundary.count(),1,'automatic read ACK does not immediately erase the reading boundary');
  while(await page.locator('#thread-older').isVisible()) {
    await page.locator('#thread-older').click();
    await page.waitForFunction(()=>{const button=document.querySelector('#thread-older');return button.hidden||!button.disabled;});
  }
  assert.deepEqual(await page.locator('#messages [data-message]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.message))),[1,2,3,4,5,6,7]);
  assert.equal(await boundary.evaluate(node=>node.previousElementSibling?.dataset.message),'5');
  assert.equal(await boundary.evaluate(node=>node.nextElementSibling?.dataset.message),'6');
  await page.evaluate(()=>{document.hasFocus=()=>false;document.querySelector('#messages').scrollTop=0;});
  data.threads[0].messages.push(incoming(8)); await page.evaluate(()=>refresh());
  assert.equal(await boundary.count(),1); assert.equal(await boundary.evaluate(node=>node.nextElementSibling?.dataset.message),'6','new arrivals cannot move an existing session boundary');
  await page.locator('#close-thread').click(); await page.locator('[data-thread="1"]').click();
  await boundary.waitFor();
  assert.equal(await boundary.count(),1); assert.equal(await boundary.evaluate(node=>node.nextElementSibling?.dataset.message),'8','reopening starts a new reading session from the current unread boundary');
}));

test('new-message divider excludes own, catch-up, pending and agent-only messages',async()=>fixture(async(page,data)=>{
  data.threads=[conversation([{id:1,sender:0,at:1,text:'Own reply'},{...incoming(2),outside_membership:true}]),conversation([incoming(4)],{id:2,title:'Agent-only discussion',members:[1]})];
  await manualPolling(page); await reloadPage(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('[data-message="2"]').waitFor();
  assert.equal(await page.locator('[data-unread-divider]').count(),0);
  const receipt=await holdMessageReceipt(page);
  try {
    await page.locator('#message-form textarea').fill('Pending own reply'); await page.locator('#message-form button').click(); await receipt.started;
    assert.equal(await page.locator('[data-unread-divider]').count(),0,'a local outgoing attempt cannot create an unread boundary');
  } finally {receipt.release();await receipt.remove();}
  await page.waitForFunction(()=>pendingSends.size===0);
  await page.evaluate(()=>{document.hasFocus=()=>false;});
  data.threads[0].messages.push(incoming(6,'First peer reply after opening')); await page.evaluate(()=>refresh());
  assert.equal(await page.locator('[data-unread-divider]').count(),1);
  assert.equal(await page.locator('[data-unread-divider]').evaluate(node=>node.nextElementSibling?.dataset.message),'6');
  await page.locator('[data-thread-filter=all]').click(); await page.locator('[data-thread="2"]').click();
  await page.waitForFunction(()=>state.thread?.id===2&&!state.thread.loadingNew);
  assert.equal(await page.locator('[data-unread-divider]').count(),0,'reading an agent-only public conversation does not invent user unread state');
}));

test('expanded thread metadata scrolls without hiding close or disclosure controls',async()=>fixture(async(page,data)=>{
  data.agents=Array.from({length:70},(_,i)=>({id:i+1,project:projectId(1),name:`Reviewer ${i+1} with a descriptive name`,state:'idle'}));
  data.threads=[conversation(Array.from({length:12},(_,i)=>incoming(i+1,'Read the earlier message\n'.repeat(4))),{members:[0,...data.agents.map(agent=>agent.id)]})]; data.reads[1]=12;
  await manualPolling(page); await page.setViewportSize({width:640,height:800}); await reloadPage(page);
  await openSidebar(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await page.locator('#messages').evaluate(node=>{node.scrollTop=120;});
  await openThreadDetails(page);
  const reading=await page.locator('#messages').evaluate(node=>node.scrollTop);
  const metadata=page.locator('#thread-details');
  assert.ok(await metadata.evaluate(node=>node.scrollHeight>node.clientHeight),'the large member list must exercise the metadata scroll boundary');
  await metadata.evaluate(node=>{node.scrollTop=node.scrollHeight;});
  const reachable=await page.locator('.thread-header').evaluate(header=>{
    const bounds=header.getBoundingClientRect();
    return ['#close-thread','#thread-details > summary'].every(selector=>{
      const node=header.querySelector(selector), box=node.getBoundingClientRect();
      return box.top>=bounds.top&&box.bottom<=bounds.bottom&&box.top>=0&&box.bottom<=innerHeight;
    });
  });
  assert.equal(reachable,true,'expanded metadata cannot scroll the conversation’s close and Details controls out of view');
  assert.equal(await page.locator('#thread-events').getAttribute('role'),'region');
  assert.equal(await page.locator('#thread-events').getAttribute('tabindex'),'0');
  assert.ok((await page.locator('#thread-events').getAttribute('aria-label'))?.trim());
  assert.equal(await page.locator('#messages').evaluate(node=>node.scrollTop),reading);
  await page.locator('#thread-details > summary').click(); assert.equal(await page.locator('#thread-details').evaluate(node=>node.open),false);
  assert.equal(await page.locator('#messages').evaluate(node=>node.scrollTop),reading);
  await page.locator('#close-thread').click(); assert.equal(await page.locator('#messages').count(),0);
}));

test('long thread titles cannot clip metadata or its management controls on a small screen',async()=>fixture(async(page,data)=>{
  const title='A descriptive thread title with enough context to stay understandable. '.repeat(12);
  data.agents=Array.from({length:20},(_,i)=>({id:i+1,project:projectId(1),name:`Reviewer ${i+1}`,state:'idle'}));
  data.threads=[conversation([incoming(1)],{title,members:[0,...data.agents.map(agent=>agent.id)]})]; data.reads[1]=1;
  await manualPolling(page); await page.setViewportSize({width:320,height:568}); await reloadPage(page);
  await openSidebar(page); await page.locator('[data-page=threads]').click(); await page.locator('[data-thread="1"]').click();
  await openThreadDetails(page);
  assert.equal(await page.locator('.thread-header h2').textContent(),title,'bounded title presentation retains the entire original title');
  assert.ok(await page.locator('#thread-details').evaluate(node=>node.clientHeight>0),'the title cannot consume all available Details space');
  await page.locator('#thread-details').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  for(const selector of ['#close-thread','#thread-details > summary','#change-thread-owner']) {
    assert.equal(await page.locator(selector).evaluate(node=>{
      const box=node.getBoundingClientRect(), x=box.left+box.width/2, y=box.top+box.height/2;
      return box.width>0&&box.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&node.contains(document.elementFromPoint(x,y));
    }),true,`${selector} is hit-testable, not merely present behind clipped metadata`);
  }
  await page.locator('#change-thread-owner').click(); assert.equal(await page.locator('#thread-owner-dialog').isVisible(),true);
  await page.locator('#thread-owner-dialog .dialog-close').click();
  await page.locator('#thread-details > summary').click();
  assert.equal(await page.locator('#thread-details').evaluate(node=>node.open),false);
  await page.locator('#close-thread').click(); assert.equal(await page.locator('#messages').count(),0);
}));
