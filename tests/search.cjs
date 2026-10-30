// Real-server search/navigation regression. Disposable state, no native clients or model turns.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {projectHome}=require('./fixture-workspace.cjs');

test('real server search, membership discovery and deep links preserve project scope and read state',async()=>{
  const binary=fs.realpathSync(process.env.ACOM_BINARY||path.resolve(__dirname,'../target/debug/acom'));
  for(const client of ['claude','codex'])assert.ok(!fs.existsSync(path.join(path.dirname(binary),client)));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'acom-search-test-')),home=path.join(root,'state'),empty=path.join(root,'empty-bin');
  fs.mkdirSync(home);fs.mkdirSync(empty);
  const env={...process.env,ACOM_HOME:home,CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),PATH:empty};
  for(const key of ['ACOM_ID','ACOM_URL','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY'])delete env[key];
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`,server=spawn(binary,['serve','--port',String(port)],{cwd:root,env,stdio:['ignore','ignore','pipe']});
  let errors='',browser;server.stderr.on('data',bytes=>errors+=bytes);
  const request=async(route,body)=>{const response=await fetch(base+route,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{'Content-Type':'application/json'}});const value=await response.json();assert.ok(response.ok,`${route}: ${JSON.stringify(value)}`);return value;};
  try{
    const deadline=Date.now()+15000;
    while(true){assert.equal(server.exitCode,null,errors);try{if((await fetch(base+'/overview')).ok)break;}catch(_){}assert.ok(Date.now()<deadline,errors);await new Promise(resolve=>setTimeout(resolve,50));}
    const projects=[];
    for(const name of ['sample-one','sample-two']){const directory=path.join(root,name);fs.mkdirSync(directory);projects.push(await request('/projects',{path:directory}));}
    for(const [index,project] of projects.entries()){
      const db=new DatabaseSync(path.join(projectHome(home,project.id),'acom.db'));
      try{
        db.exec(`PRAGMA busy_timeout=5000; BEGIN;
          INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(1,1,'Reader','Sample task','codex','test','medium','paused',0,0),(2,1,'Reviewer','Sample task','codex','test','medium','paused',0,0);
          INSERT INTO threads(id,project,title,created_by,created_at) VALUES(1,1,'Review notes',0,1),(2,1,'Private notes',0,2),(3,1,'Other notes',0,3);
          INSERT INTO thread_access(thread_id,private,joinable) VALUES(2,1,0);
          INSERT INTO members(thread_id,agent_id,last_notified) VALUES(1,0,1000),(1,1,1000),(2,2,1000),(3,1,1000),(3,2,1000);
          INSERT INTO member_intervals(thread_id,agent_id,start_after) VALUES(1,0,0),(1,1,0),(2,2,0),(3,1,0),(3,2,0);`);
        const insert=db.prepare('INSERT INTO messages(id,thread_id,sender,text,at) VALUES(?,?,?,?,?)');
        for(let id=1;id<=80;id++)insert.run(id,1,1,`${index?'Other project':'Sample'} message ${id}${id===13?' needle %_ <img src=x onerror=alert(1)>':''}`,100+id);
        insert.run(81,2,2,'Private needle',181);insert.run(82,3,2,'Other discussion',182);db.exec('COMMIT');
      }finally{db.close();}
    }
    const scoped=`/p/${projects[0].id}`,ids=page=>page.items.map(item=>item.id);
    assert.deepEqual(ids(await request(`${scoped}/messages/search?text=needle&viewer=1`)),[13]);
    assert.deepEqual(ids(await request(`${scoped}/messages/search?text=needle`)),[81,13]);
    assert.deepEqual(ids(await request(`${scoped}/messages/search?id=13&thread=2`)),[]);
    assert.deepEqual(ids(await request(`${scoped}/messages/search?text=%25_&sender=1&from=113&to=113`)),[13]);
    const matches=await request(`${scoped}/threads?members=1,2&member_match=all`);assert.deepEqual(ids(matches),[3]);
    assert.equal((await request(`${scoped}/threads?members=1,2&member_match=any`)).total,3);
    const context=await request(`${scoped}/threads/1/messages/context?message=13&limit=5`);assert.deepEqual(ids(context),[11,12,13,14,15]);
    assert.equal((await request(`${scoped}/threads/1/metadata`)).last_read,0);
    const first=await request(`${scoped}/messages/search?text=Sample&limit=7`),all=[...ids(first)];let page=first;
    while(page.has_more){page=await request(`${scoped}/messages/search?text=Sample&limit=7&before=${page.next_before}&through=${page.through}&revision=${page.revision}`);all.push(...ids(page));}
    assert.equal(all.length,80);assert.equal(new Set(all).size,80);
    assert.match((await request(`/p/${projects[1].id}/messages/13`)).text,/Other project/);
    if(process.env.ACOM_BROWSER_TEST==='1'){
      const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
      browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM||undefined});
      const browserPage=await browser.newPage({viewport:{width:1300,height:1000}}),pageErrors=[];
      browserPage.on('pageerror',error=>pageErrors.push(error.message));
      await browserPage.goto(`${base}/?project=${projects[0].id}&thread=1&message=13`);
      try{await browserPage.locator('#messages [data-message="13"].message-target').waitFor();}
      catch(error){assert.fail(`${error.message}\nPage errors: ${JSON.stringify(pageErrors)}\n${(await browserPage.locator('body').innerText()).slice(-6000)}`);}
      assert.equal((await request(`${scoped}/threads/1/metadata`)).last_read,0);
      await browserPage.locator('#message-form textarea').fill('Unsent sample draft');
      await browserPage.locator('#thread-message-search').click();
      await browserPage.locator('#message-search-form [name=query]').fill('%_');
      await browserPage.locator('#message-search-form button[type=submit]').click();
      await browserPage.locator('[data-message-result="13"]').waitFor();
      assert.equal(await browserPage.locator('#message-search-results img').count(),0);
      assert.equal((await request(`${scoped}/threads/1/metadata`)).last_read,0);
      await browserPage.locator('#message-search-dialog').press('Escape');
      await browserPage.locator('#thread-message-search').click();
      await browserPage.locator('#message-search-form button[type=submit]').click();
      await browserPage.locator('[data-message-result="13"]').waitFor();
      await browserPage.locator('[data-message-result="13"]').click();
      await browserPage.locator('#messages [data-message="13"].message-target').waitFor();
      assert.equal(await browserPage.locator('#message-form textarea').inputValue(),'Unsent sample draft');
      await browserPage.locator('#thread-newer').click();
      assert.equal(await browserPage.locator('#messages [data-message="13"]').count(),1);
      assert.equal((await request(`${scoped}/threads/1/metadata`)).last_read,0);
      await browserPage.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Clipboard blocked');}}}));
      const prompt=browserPage.waitForEvent('dialog');
      const copy=browserPage.locator('[data-copy-message-link="13"]').click();
      const fallback=await prompt;assert.equal(fallback.type(),'prompt');
      assert.equal(fallback.defaultValue(),`${base}/?project=${projects[0].id}&thread=1&message=13`);
      await fallback.dismiss();await copy;
      assert.deepEqual(pageErrors,[]);
    }
    for(const project of projects){const db=new DatabaseSync(path.join(projectHome(home,project.id),'acom.db'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM agents WHERE pid IS NOT NULL OR session_id IS NOT NULL').get().n,0);}finally{db.close();}}
  }finally{
    try{if(browser)await browser.close();}
    finally{
      try{if(server.exitCode===null&&server.signalCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),10000);await stopped;clearTimeout(timer);}}
      finally{fs.rmSync(root,{recursive:true,force:true});}
    }
  }
});
