// Isolated controller regressions. No project, server or provider calls.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002',IMPORTED='00000000-0000-4000-8000-000000000003';
const asset=path.join(__dirname,'../src/project-data.js');
const review={project:IMPORTED,version:'pinned-file-version',files:3,already_exists:false,default_changed:false,configuration:{kind:'snapshot',name:'Test',settings:{allow_agent_model_change:false,prompt_guidance:{launch:'Synthetic guidance'}}},warnings:[]};
async function fixture(run){
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:900}});
    await page.setContent('<div id="host"></div>');await page.addScriptTag({path:asset});
    await page.evaluate(({A,review})=>{
      window.calls=[];window.receiptCalls=[];window.receiptResponse=null;window.confirmations=[];window.confirmResult=true;window.visible=true;window.changed=0;window.response=null;window.review=review;
      window.confirm=text=>{confirmations.push(text);return confirmResult;};
      window.controller=acomProjectData.mount(document.querySelector('#host'),{project:A,projectInfo:{id:A,name:'Synthetic'},current:()=>visible,onChanged:async()=>{changed++;},readReceipt:async(path,current)=>{receiptCalls.push({path,current:current()});return receiptResponse?receiptResponse(path,current):review;},request:async(endpoint,options)=>{
        const body=JSON.parse(options.body);calls.push({endpoint,body,global:options.global});
        if(window.response)return window.response(endpoint,body);
        if(endpoint.endsWith('/inspect-archive'))return review;
        if(endpoint.endsWith('/import'))return {imported:true,id:review.project,workers_started:0,warnings:[]};
        if(endpoint.endsWith('/export'))return {exported:true,warnings:[]};
        return body.confirm?{removed:true,recoverable_at:'/synthetic/trash',note:'Core state unchanged.'}:{preview:true,project:A,category:body.category,files:2,bytes:8192};
      }});
    },{A,review});
    await run(page);
  }finally{await browser.close();}
}
async function open(page){await page.getByText('Project archives and captured files',{exact:true}).click();}
async function importPaths(page){await page.getByLabel('Archive source',{exact:true}).fill('/synthetic/export.tar');await page.getByLabel('Imported project folder',{exact:true}).fill('/synthetic/restored');}
async function settled(page,text){await page.waitForFunction(text=>document.querySelector('#host > section > [role=status]').textContent.includes(text),text);await page.waitForFunction(()=>document.querySelector('#host > section').getAttribute('aria-busy')==='false');}

test('panel is lazy, preserves per-project input drafts and never scans on context refresh',async()=>fixture(async page=>{
  assert.equal(await page.evaluate(()=>calls.length),0);await open(page);
  await page.getByLabel('Archive destination',{exact:true}).fill('/synthetic/first.tar');
  await page.evaluate(A=>{controller.updateContext({project:A,projectInfo:{id:A,name:'Updated'}});},A);
  assert.equal(await page.getByLabel('Archive destination',{exact:true}).inputValue(),'/synthetic/first.tar');
  await page.evaluate(B=>controller.updateContext({project:B}),B);assert.equal(await page.getByLabel('Archive destination',{exact:true}).inputValue(),'');
  await page.getByLabel('Archive destination',{exact:true}).fill('/synthetic/second.tar');
  await page.evaluate(A=>controller.updateContext({project:A}),A);assert.equal(await page.getByLabel('Archive destination',{exact:true}).inputValue(),'/synthetic/first.tar');
  assert.equal(await page.evaluate(()=>calls.length),0);await page.evaluate(()=>controller.destroy());assert.equal(await page.locator('#host').innerHTML(),'');
}));

test('unchanged polling keeps selected status text and focused path input intact',async()=>fixture(async page=>{
  await open(page);await page.getByLabel('Archive destination',{exact:true}).fill('/synthetic/export.tar');
  await page.evaluate(A=>{
    const target=document.querySelector('#host > section > [role=status]');
    const range=document.createRange();range.selectNodeContents(target);getSelection().removeAllRanges();getSelection().addRange(range);
    controller.updateContext({project:A});controller.updateContext({project:A});
  },A);
  assert.equal(await page.evaluate(()=>getSelection().toString()),'Nothing runs until you request it.');
  await page.getByLabel('Archive destination',{exact:true}).focus();
  await page.evaluate(A=>{const input=document.activeElement;input.setSelectionRange(3,10);controller.updateContext({project:A});},A);
  assert.deepEqual(await page.getByLabel('Archive destination',{exact:true}).evaluate(input=>[input===document.activeElement,input.selectionStart,input.selectionEnd]),[true,3,10]);
}));

test('export is confirmed, explicitly scoped and keeps native copies opt-in',async()=>fixture(async page=>{
  await open(page);await page.getByLabel('Archive destination',{exact:true}).fill('/synthetic/first.tar');
  assert.equal(await page.getByLabel('Include native conversation copies',{exact:true}).isChecked(),false);
  await page.getByLabel('Include output logs',{exact:true}).check();await page.getByLabel('Include native conversation copies',{exact:true}).check();
  await page.getByRole('button',{name:'Export snapshot',exact:true}).click();await settled(page,'Snapshot exported');
  assert.deepEqual(await page.evaluate(()=>calls),[{endpoint:`/projects/${A}/export`,body:{destination:'/synthetic/first.tar',logs:true,native:true},global:true}]);
  assert.match(await page.evaluate(()=>confirmations[0]),/private project data.*Native conversation/s);
  assert.equal(await page.evaluate(()=>changed),0);
}));

test('canceling export sends nothing and invalid relative paths never reach the API',async()=>fixture(async page=>{
  await open(page);await page.getByLabel('Archive destination',{exact:true}).fill('relative.tar');
  await page.getByRole('button',{name:'Export snapshot',exact:true}).click();await settled(page,'absolute server-side path');
  assert.equal(await page.evaluate(()=>calls.length),0);await page.getByLabel('Archive destination',{exact:true}).fill('/synthetic/export.tar');
  await page.evaluate(()=>confirmResult=false);await page.getByRole('button',{name:'Export snapshot',exact:true}).click();await settled(page,'Export canceled');
  assert.equal(await page.evaluate(()=>calls.length),0);
}));

test('confirmed export waits for draft synchronization and rechecks context before writing',async()=>fixture(async page=>{
  await open(page);await page.getByLabel('Archive destination',{exact:true}).fill('/synthetic/export.tar');
  await page.evaluate(()=>{window.flushes=[];controller.updateContext({beforeExport:project=>{flushes.push(project);return new Promise(resolve=>window.finishFlush=resolve);}});});
  await page.getByRole('button',{name:'Export snapshot',exact:true}).click();await page.waitForFunction(()=>typeof finishFlush==='function');
  assert.deepEqual(await page.evaluate(()=>flushes),[A]);assert.equal(await page.evaluate(()=>calls.length),0);
  await page.evaluate(B=>{controller.updateContext({project:B});finishFlush();},B);
  await page.waitForFunction(()=>document.querySelector('#host > section').getAttribute('aria-busy')==='false');
  assert.equal(await page.evaluate(()=>calls.length),0,'context changes while flushing cannot export a different or stale selection');
}));

test('canceled export never flushes drafts and failed synchronization blocks export',async()=>fixture(async page=>{
  await open(page);await page.getByLabel('Archive destination',{exact:true}).fill('/synthetic/export.tar');
  await page.evaluate(()=>{window.flushes=0;confirmResult=false;controller.updateContext({beforeExport:async()=>{flushes++;throw new Error('Resolve the draft conflict first.');}});});
  await page.getByRole('button',{name:'Export snapshot',exact:true}).click();await settled(page,'Export canceled');
  assert.equal(await page.evaluate(()=>flushes),0);
  await page.evaluate(()=>confirmResult=true);await page.getByRole('button',{name:'Export snapshot',exact:true}).click();await settled(page,'draft conflict');
  assert.equal(await page.evaluate(()=>flushes),1);assert.equal(await page.evaluate(()=>calls.length),0);
}));

test('import requires inspection, binds the inspected version and refreshes without choosing a project',async()=>fixture(async page=>{
  await open(page);await importPaths(page);assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'Archive inspected');
  await page.getByRole('button',{name:'Import inspected archive',exact:true}).click();await settled(page,'Project imported with no workers started');
  assert.deepEqual(await page.evaluate(()=>calls),[
    {endpoint:'/projects/inspect-archive',body:{source:'/synthetic/export.tar'},global:true},
    {endpoint:'/projects/import',body:{source:'/synthetic/export.tar',path:'/synthetic/restored',version:review.version,accept_default_change:false},global:true},
  ]);
  assert.equal(await page.evaluate(()=>changed),1);assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
}));

test('different built-in Default requires explicit acceptance and changing the source invalidates inspection',async()=>fixture(async page=>{
  await page.evaluate(()=>{response=()=>({...review,configuration:{kind:'default',settings:review.configuration.settings},default_changed:true});});
  await open(page);await importPaths(page);await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'Archive inspected');
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
  await page.getByLabel('Accept this binary’s different built-in Default settings',{exact:true}).check();
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isEnabled(),true);
  await page.getByLabel('Imported project folder',{exact:true}).fill('/synthetic/other');
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isEnabled(),true,'a target-folder edit does not require copying the archive again');
  await page.getByLabel('Archive source',{exact:true}).fill('/synthetic/other.tar');
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
  assert.equal(await page.getByText('No archive inspected for these paths.',{exact:true}).isVisible(),true);
}));

test('archive can be inspected before choosing or changing its import folder',async()=>fixture(async page=>{
  await open(page);await page.getByLabel('Archive source',{exact:true}).fill('/synthetic/export.tar');
  await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'Archive inspected');
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true,'an import still needs an absolute folder');
  await page.getByLabel('Imported project folder',{exact:true}).fill('/synthetic/first');
  await page.getByLabel('Imported project folder',{exact:true}).fill('/synthetic/second');
  await page.getByRole('button',{name:'Import inspected archive',exact:true}).click();await settled(page,'Project imported with no workers started');
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.endpoint.endsWith('/inspect-archive')).length),1);
  assert.equal(await page.evaluate(()=>calls.at(-1).body.path),'/synthetic/second');
  assert.equal(await page.evaluate(()=>calls.at(-1).body.version),review.version);
}));

test('existing identities and malformed inspection receipts cannot enable import',async()=>fixture(async page=>{
  await open(page);await importPaths(page);await page.evaluate(()=>{response=()=>({...review,already_exists:true});});
  await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'already exists');
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{response=()=>({...review,version:null});});await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'inspection response is incomplete');
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
}));

test('applied settings are collapsed, safely rendered as JSON and bounded for keyboard scrolling',async()=>fixture(async page=>{
  await page.evaluate(()=>{response=()=>({...review,configuration:{...review.configuration,settings:{'<script>window.injected=true</script>':'<img src=x onerror="window.injected=true">',guidance:'Review context. '.repeat(4000)}}});});
  await open(page);await importPaths(page);await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'Archive inspected');
  const disclosure=page.getByText('Applied settings',{exact:true});
  assert.equal(await disclosure.evaluate(item=>item.parentElement.open),false);
  await disclosure.click();
  const json=JSON.parse(await page.getByLabel('Inspected applied settings',{exact:true}).textContent());
  assert.equal(json['<script>window.injected=true</script>'],'<img src=x onerror="window.injected=true">');
  assert.equal(await page.locator('#host script,#host img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
  const code=page.getByLabel('Inspected applied settings',{exact:true});await code.focus();
  const dimensions=await code.evaluate(item=>({tabIndex:item.tabIndex,maxHeight:getComputedStyle(item).maxHeight,overflow:getComputedStyle(item).overflowY,height:item.clientHeight,scroll:item.scrollHeight}));
  assert.equal(dimensions.tabIndex,0);assert.equal(dimensions.overflow,'auto');assert.notEqual(dimensions.maxHeight,'none');assert.ok(dimensions.scroll>dimensions.height);
  await page.evaluate(A=>controller.updateContext({project:A}),A);assert.equal(await disclosure.evaluate(item=>item.parentElement.open),true);
}));

test('large inspections read one explicit global receipt without repeating the inspection write',async()=>fixture(async page=>{
  await page.evaluate(()=>{response=()=>({result_truncated:true,receipt_path:'/global-receipts/12'});});
  await open(page);await importPaths(page);await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'Archive inspected');
  assert.deepEqual(await page.evaluate(()=>receiptCalls),[{path:'/global-receipts/12',current:true}]);
  assert.equal(await page.evaluate(()=>calls.length),1);assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isEnabled(),true);
  await page.getByText('Applied settings',{exact:true}).click();assert.deepEqual(JSON.parse(await page.getByLabel('Inspected applied settings',{exact:true}).textContent()),review.configuration.settings);
}));

test('inspection receipt paths reject other scopes, origins, queries and invalid positive IDs',async()=>fixture(async page=>{
  await open(page);await importPaths(page);
  const unsafe=['https://example.test/global-receipts/1','//example.test/global-receipts/1',`/p/${A}/receipts/1`,'/global-receipts/0','/global-receipts/01','/global-receipts/-1','/global-receipts/1?offset=0','/global-receipts/1#fragment','/global-receipts/1/../2','/global-receipts/9223372036854775808'];
  for(const receiptPath of unsafe){
    await page.evaluate(receiptPath=>{response=()=>({result_truncated:true,receipt_path:receiptPath});},receiptPath);
    await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'without a safe saved receipt');
    assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
  }
  assert.equal(await page.evaluate(()=>receiptCalls.length),0);assert.equal(await page.evaluate(()=>calls.length),unsafe.length);
}));

test('saved inspection reads keep their captured context even after switching away and back',async()=>fixture(async page=>{
  await page.evaluate(()=>{response=()=>({result_truncated:true,receipt_path:'/global-receipts/9'});receiptResponse=(path,current)=>new Promise(resolve=>{window.receiptCurrent=current;window.resolveReceipt=resolve;});});
  await open(page);await importPaths(page);await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await page.waitForFunction(()=>typeof resolveReceipt==='function');
  await page.evaluate(({A,B})=>{controller.updateContext({project:B,readReceipt:()=>{throw new Error('The new context callback must not be used');}});controller.updateContext({project:A});window.staleCurrent=receiptCurrent();resolveReceipt(review);},{A,B});
  await page.waitForFunction(()=>document.querySelector('#host > section').getAttribute('aria-busy')==='false');
  assert.equal(await page.evaluate(()=>staleCurrent),false);assert.equal(await page.evaluate(()=>receiptCalls.length),1);assert.equal(await page.evaluate(()=>calls.length),1);
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
  assert.equal(await page.getByText('No archive inspected for these paths.',{exact:true}).isVisible(),true);
  assert.equal(await page.getByText('Applied settings',{exact:true}).isVisible(),false);
}));

test('unavailable, malformed or repeatedly shortened settings receipts cannot enable import or retry writes',async()=>fixture(async page=>{
  await open(page);await importPaths(page);
  await page.evaluate(()=>{response=()=>({result_truncated:true,receipt_path:'/global-receipts/5'});receiptResponse=()=>{throw new Error('Saved receipt unavailable.');};});
  await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'Saved receipt unavailable');
  await page.evaluate(()=>{receiptResponse=()=>({result_truncated:true,receipt_path:'/global-receipts/6'});});
  await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'inspection response is incomplete');
  await page.evaluate(()=>{receiptResponse=()=>({...review,configuration:{kind:'snapshot',settings:null}});});
  await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'inspection response is incomplete');
  assert.equal(await page.evaluate(()=>calls.length),3);assert.equal(await page.evaluate(()=>receiptCalls.length),3);assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
}));

test('generic import and cleanup warnings remain visible once',async()=>fixture(async page=>{
  await open(page);await importPaths(page);await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'Archive inspected');
  await page.evaluate(()=>{response=(endpoint,body)=>endpoint.endsWith('/import')?{imported:true,workers_started:0,warning:'Server is closing; refresh later.'}:body.confirm?{removed:true,warning:'Cleanup warning.'}:{preview:true,project:'00000000-0000-4000-8000-000000000001',category:body.category,files:1,bytes:512};});
  await page.getByRole('button',{name:'Import inspected archive',exact:true}).click();await settled(page,'Server is closing; refresh later.');
  await page.getByRole('button',{name:'Preview cleanup',exact:true}).click();await settled(page,'Cleanup preview ready');
  await page.getByRole('button',{name:'Move captured files to trash',exact:true}).click();await settled(page,'Cleanup warning.');
  const text=await page.locator('#host > section > [role=status]').textContent();assert.equal(text.split('Cleanup warning.').length-1,1);
}));

test('stale inspection results never attach to another project and drafts survive the switch',async()=>fixture(async page=>{
  await open(page);await importPaths(page);await page.evaluate(()=>{response=()=>new Promise(resolve=>window.resolveInspection=resolve);});
  await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await page.waitForFunction(()=>typeof resolveInspection==='function');
  await page.evaluate(B=>{controller.updateContext({project:B});resolveInspection(review);},B);
  await page.waitForFunction(()=>document.querySelector('#host > section').getAttribute('aria-busy')==='false');
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
  await page.evaluate(A=>controller.updateContext({project:A}),A);assert.equal(await page.getByLabel('Archive source',{exact:true}).inputValue(),'/synthetic/export.tar');
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>calls.length),1);
}));

test('cleanup previews are nonmutating and confirmation applies only to their captured project and category',async()=>fixture(async page=>{
  await open(page);await page.getByRole('button',{name:'Preview cleanup',exact:true}).click();await settled(page,'Cleanup preview ready');
  assert.deepEqual(await page.evaluate(()=>calls[0]),{endpoint:`/projects/${A}/cleanup`,body:{category:'logs',permanent:false,confirm:false},global:true});
  await page.getByRole('button',{name:'Move captured files to trash',exact:true}).click();await settled(page,'Captured files moved');
  assert.deepEqual(await page.evaluate(()=>calls[1]),{endpoint:`/projects/${A}/cleanup`,body:{category:'logs',permanent:false,confirm:true},global:true});
  assert.equal(await page.evaluate(()=>changed),1);assert.equal(await page.getByRole('button',{name:'Move captured files to trash',exact:true}).isDisabled(),true);
  assert.match(await page.evaluate(()=>confirmations[0]),/remain recoverable.*still use disk space/s);
}));

test('changing cleanup category or permanence requires a new preview',async()=>fixture(async page=>{
  await open(page);await page.getByRole('button',{name:'Preview cleanup',exact:true}).click();await settled(page,'Cleanup preview ready');
  await page.getByLabel('Delete permanently instead of moving to trash',{exact:true}).check();
  assert.equal(await page.getByRole('button',{name:'Permanently delete captured files',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Preview cleanup',exact:true}).click();await settled(page,'Cleanup preview ready');
  await page.getByLabel('Captured files',{exact:true}).selectOption('native');
  assert.equal(await page.getByRole('button',{name:'Permanently delete captured files',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>calls.every(call=>call.body.confirm===false)),true);
}));

test('an uncertain import is not automatically retried and requires a fresh inspection',async()=>fixture(async page=>{
  await open(page);await importPaths(page);await page.getByRole('button',{name:'Inspect archive',exact:true}).click();await settled(page,'Archive inspected');
  await page.evaluate(()=>{response=()=>{throw new Error('Connection interrupted after submission.');};});
  await page.getByRole('button',{name:'Import inspected archive',exact:true}).click();await settled(page,'Inspect current state before retrying');
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.endpoint.endsWith('/import')).length),1);
  assert.equal(await page.getByRole('button',{name:'Import inspected archive',exact:true}).isDisabled(),true);
}));

test('inactive views do not issue calls, and hostile labels stay plain text',async()=>fixture(async page=>{
  await open(page);await page.getByLabel('Archive destination',{exact:true}).fill('/synthetic/export.tar');
  await page.evaluate(()=>{visible=false;controller.updateContext({projectInfo:{name:'<img src=x onerror="window.injected=true">'}});});
  await page.getByRole('button',{name:'Export snapshot',exact:true}).click();assert.equal(await page.evaluate(()=>calls.length),0);
  assert.equal(await page.locator('#host img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
}));
