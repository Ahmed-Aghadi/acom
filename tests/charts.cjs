// Isolated browser tests for the first-party renderer. No server or provider calls.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const asset=path.join(__dirname,'../src/charts.js');

function sample(id,at,value,extra={}) {
  const point={observed_at:at,value_observed_at:value===null?null:at,value:value===null?null:{kind:'counter',value},quality:value===null?'unknown':'final'};
  return {id,series:{entity:'agent:1',metric:'total_tokens',kind:'counter'},origin:{id:'origin-a',source_instance:'installation-a',imported_at:null},envelope:{first:point,last:point,minimum:value===null?null:point,maximum:value===null?null:point,observations:1,qualities:[point.quality],has_gap:value===null,has_correction:false,checkpoint:false,resolution_secs:0,sampled_at:at},crosses_range:false,...extra};
}
async function browserTest(run) {
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM});
  try {const page=await browser.newPage({viewport:{width:1100,height:800}});await page.setContent('<div id="chart" style="width:900px"></div>');await page.addScriptTag({path:asset});await run(page);}
  finally {await browser.close();}
}

test('counter point text and scaling remain exact above JavaScript precision, with safe labels',async()=>browserTest(async page=>{
  const rows=[sample(1,110,'18446744073709551614'),sample(2,190,'18446744073709551615')];
  rows[0].series.entity='<img src=x onerror="window.injected=true">';rows[1].series.entity=rows[0].series.entity;
  await page.evaluate(rows=>{window.chart=acomCharts.mount(document.querySelector('#chart'),{samples:rows,range:{from:100,to:200},scope:'all'});},rows);
  const plot=page.locator('#chart svg');await plot.focus();await plot.press('Home');
  assert.match(await page.locator('.acom-chart-readout').innerText(),/18,446,744,073,709,551,614/);
  await plot.press('End');assert.match(await page.locator('.acom-chart-readout').innerText(),/18,446,744,073,709,551,615/);
  assert.equal(await page.locator('.acom-chart-readout').getAttribute('aria-live'),'polite');
  const ys=await plot.locator('g').first().locator('circle').evaluateAll(nodes=>nodes.map(node=>Number(node.getAttribute('cy'))));
  assert.ok(Math.abs(ys[0]-ys[1])>100,'a one-token change is visible despite the large absolute count');
  assert.equal(await page.locator('#chart img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
  assert.equal(await page.locator('.acom-chart-empty').isVisible(),false);
}));

test('unknown samples break lines and project or origin boundaries are not joined',async()=>browserTest(async page=>{
  const rows=[sample(1,110,'10'),sample(2,140,null),sample(3,170,'12'),sample(4,180,'15',{project:'project-b'}),sample(5,190,'20',{origin:{id:'origin-b',source_instance:'installation-b',imported_at:150}})];
  rows[2].envelope.has_correction=true;
  await page.evaluate(rows=>{window.chart=acomCharts.mount(document.querySelector('#chart'),{samples:rows,range:{from:100,to:200},scope:'all'});},rows);
  assert.equal(await page.locator('.acom-chart-legend li').count(),3);
  const paths=await page.locator('#chart path').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('d')));
  assert.ok(paths.every(value=>!value.includes(' L')),'no path interpolates across the unknown observation');
  await page.locator('#chart svg').focus();await page.locator('#chart svg').press('ArrowRight');await page.locator('#chart svg').press('ArrowRight');
  assert.match(await page.locator('.acom-chart-readout').innerText(),/correction/);
}));

test('coalesced source coverage is visible without pretending known endpoints are unknown',async()=>browserTest(async page=>{
  const rows=[sample(1,110,'10'),sample(2,150,'12'),sample(3,190,'14')];
  rows[1].envelope.coverage_gap=true;
  await page.evaluate(rows=>{window.chart=acomCharts.mount(document.querySelector('#chart'),{samples:rows,range:{from:100,to:200},scope:'all'});},rows);
  const paths=await page.locator('#chart path').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('d')));
  assert.ok(paths.every(value=>!value.includes(' L')),'an omitted interval is not drawn as a continuous line');
  await page.locator('#chart svg').focus();await page.locator('#chart svg').press('Home');await page.locator('#chart svg').press('ArrowRight');
  const text=await page.locator('.acom-chart-readout').innerText();
  assert.match(text,/12 · final/);assert.match(text,/Intermediate observations were not recorded/);assert.doesNotMatch(text,/contains unavailable data/);
}));

test('live updates preserve chart focus and user zoom, with keyboard reset and follow',async()=>browserTest(async page=>{
  await page.evaluate(rows=>{window.ranges=[];window.chart=acomCharts.mount(document.querySelector('#chart'),{samples:rows,range:{from:100,to:200},scope:'recorded_here',onRangeChange:range=>ranges.push(range)});},[sample(1,140,'10'),sample(2,160,'20')]);
  const plot=page.locator('#chart svg');await plot.focus();await plot.press('+');
  assert.deepEqual(await page.evaluate(()=>ranges.at(-1)),{from:125,to:175});
  await page.evaluate(row=>chart.update({samples:[row],loading:true}),sample(3,150,'30'));
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#chart svg')),true);
  await plot.press('-');assert.deepEqual(await page.evaluate(()=>ranges.at(-1)),{from:100,to:200});
  await plot.press('0');assert.equal(await page.evaluate(()=>ranges.at(-1)),null);
  await plot.press('f');assert.equal(await page.getByRole('button',{name:'Follow latest',exact:true}).getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>chart.destroy());assert.equal(await page.locator('#chart').innerHTML(),'');
}));

test('panel is lazy and bounded, merges explicit pages once, and does not poll without follow',async()=>browserTest(async page=>{
  await page.evaluate(rows=>{
    window.requests=[];window.panel=acomCharts.createPanel(document.querySelector('#chart'),{project:'project-a',projects:[{id:'project-a',name:'Sample'}],current:()=>true,request:async(path,options)=>{requests.push({path,options});const paging=new URL(path,'http://fixture').searchParams.has('cursor');return {items:paging?rows:rows.slice(0,1),summaries:[],next:paging?null:{page:1}};}});
  },[sample(1,Math.floor(Date.now()/1000)-30,'10'),sample(2,Math.floor(Date.now()/1000)-10,'20')]);
  assert.equal(await page.evaluate(()=>requests.length),0);
  await page.locator('#chart summary').click();await page.waitForFunction(()=>document.querySelector('#chart p[role=status]').textContent.includes('1 stored envelopes'));
  assert.equal(await page.evaluate(()=>requests.length),1);
  await page.getByRole('button',{name:'Load more',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#chart p[role=status]').textContent.includes('2 stored envelopes'));
  await page.evaluate(()=>panel.refresh());assert.equal(await page.evaluate(()=>requests.length),2);
  const request=await page.evaluate(()=>requests[1]);const params=new URL(request.path,'http://fixture').searchParams;
  assert.equal(params.get('order'),'desc');assert.equal(params.get('limit'),'100');assert.equal(params.get('max_bytes'),'16000');assert.equal(params.get('projects'),'project-a');assert.deepEqual(JSON.parse(params.get('cursor')),{page:1});
  await page.evaluate(()=>panel.destroy());
}));

test('panel ignores stale project responses and recovers after becoming inactive during a request',async()=>browserTest(async page=>{
  await page.evaluate(()=>{window.pending=[];window.visible=true;window.panel=acomCharts.createPanel(document.querySelector('#chart'),{project:'project-a',projects:[{id:'project-a',name:'A'},{id:'project-b',name:'B'}],current:()=>visible,request:path=>new Promise(resolve=>pending.push({path,resolve}))});});
  await page.locator('#chart summary').click();await page.waitForFunction(()=>pending.length===1);
  await page.evaluate(()=>{panel.updateContext({project:'project-b'});panel.refresh();});await page.waitForFunction(()=>pending.length===2);
  await page.evaluate(row=>pending[1].resolve({items:[row],next:null}),sample(1,Math.floor(Date.now()/1000)-10,'20',{project:'project-b'}));
  await page.waitForFunction(()=>document.querySelector('.acom-chart-legend')?.textContent.includes('project-'));
  await page.evaluate(row=>pending[0].resolve({items:[row],next:null}),sample(1,Math.floor(Date.now()/1000)-10,'99',{project:'project-a'}));
  await page.locator('#chart svg').focus();await page.locator('#chart svg').press('Home');assert.match(await page.locator('.acom-chart-readout').innerText(),/project-b/);assert.doesNotMatch(await page.locator('.acom-chart-readout').innerText(),/project-a/);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>pending.length===3);
  await page.evaluate(row=>{visible=false;pending[2].resolve({items:[row],next:null});},sample(2,Math.floor(Date.now()/1000)-5,'25',{project:'project-b'}));
  await page.waitForTimeout(20);await page.evaluate(()=>{visible=true;});await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>pending.length===4);
  await page.evaluate(row=>pending[3].resolve({items:[row],next:null}),sample(3,Math.floor(Date.now()/1000)-2,'30',{project:'project-b'}));
  await page.waitForFunction(()=>!document.querySelector('.acom-chart').classList.contains('acom-chart-loading'));
  await page.evaluate(()=>panel.destroy());
}));

test('maintenance previews remain bound to their project when context changes before confirmation',async()=>browserTest(async page=>{
  await page.evaluate(()=>{window.calls=[];window.preview=null;window.panel=acomCharts.createPanel(document.querySelector('#chart'),{project:'project-a',projects:[{id:'project-a',name:'A'},{id:'project-b',name:'B'}],current:()=>true,request:async(path,options)=>{calls.push({path,options});if(options?.method==='POST')return new Promise(resolve=>preview=resolve);return {items:[],next:null};}});});
  await page.locator('#chart summary').click();
  await page.getByLabel('Origins', {exact:false}).selectOption('all');await page.getByRole('button',{name:'Preview clear',exact:true}).click();await page.waitForFunction(()=>preview!==null);
  await page.evaluate(()=>{panel.updateContext({project:'project-b'});preview({result:{removed:1,skipped_boundary:0}});});
  await page.waitForTimeout(30);
  const posts=await page.evaluate(()=>calls.filter(call=>call.options?.method==='POST'));
  assert.equal(posts.length,1);assert.equal(posts[0].path,'/p/project-a/metrics/maintenance');assert.equal(JSON.parse(posts[0].options.body).action,'preview_clear');
  await page.evaluate(()=>panel.destroy());
}));

test('narrow charts retain readable labels in a named scroll region without widening the page',async()=>browserTest(async page=>{
  await page.setViewportSize({width:390,height:800});
  await page.evaluate(rows=>{
    document.documentElement.dataset.theme='dark';
    document.documentElement.style.cssText='--bg:#141416;--panel:#1b1b1e;--ink:#eeeef0;--muted:#a0a1ab;--line:#34343a;--accent:#9aafff';
    document.body.style.margin='16px';document.querySelector('#chart').style.width='100%';
    window.chart=acomCharts.mount(document.querySelector('#chart'),{samples:rows,range:{from:100,to:200}});
  },[sample(1,110,'10'),sample(2,190,'20')]);
  const region=page.getByRole('region',{name:'total tokens chart. Scroll horizontally to view the plot.',exact:true});
  const dimensions=await region.evaluate(item=>({width:item.clientWidth,scroll:item.scrollWidth,page:document.documentElement.scrollWidth,viewport:innerWidth,label:parseFloat(getComputedStyle(item.querySelector('text')).fontSize)*item.querySelector('svg').getBoundingClientRect().width/960}));
  assert.ok(dimensions.scroll>dimensions.width);assert.ok(dimensions.page<=dimensions.viewport);assert.ok(dimensions.label>=12);
  await region.focus();await region.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('.acom-chart-viewport').scrollLeft>0);
  assert.ok(await region.evaluate(item=>item.scrollLeft)>0,'the chart region supports keyboard horizontal scrolling');
  const plot=page.locator('#chart svg');await plot.focus();await plot.press('Home');
  assert.match(await page.locator('.acom-chart-readout').innerText(),/10 · final/);
  const markerIsVisible=()=>region.evaluate(item=>{const bounds=item.getBoundingClientRect(),marker=item.querySelector('svg>g:nth-child(2)>circle').getBoundingClientRect();return marker.left>=bounds.left&&marker.right<=bounds.right;});
  const pageY=await page.evaluate(()=>scrollY);
  await plot.press('End');assert.equal(await markerIsVisible(),true,'End reveals its selected point inside the chart only');
  assert.match(await page.locator('.acom-chart-readout').innerText(),/20 · final/);
  await plot.press('Home');assert.equal(await markerIsVisible(),true,'Home reveals the first point again');
  await plot.press('ArrowRight');assert.equal(await markerIsVisible(),true);
  await plot.press('ArrowLeft');assert.equal(await markerIsVisible(),true);
  assert.equal(await page.evaluate(()=>scrollY),pageY,'keyboard inspection does not move the page');
  await region.evaluate(item=>item.scrollLeft=400);await page.evaluate(()=>chart.update({loading:true}));
  assert.equal(await region.evaluate(item=>item.scrollLeft),400,'live redraw preserves manual horizontal position');
  await plot.dispatchEvent('pointermove',{clientX:20,clientY:100,pointerType:'mouse'});
  assert.equal(await region.evaluate(item=>item.scrollLeft),400,'pointer inspection never scrolls the plot');
  const dark=await plot.locator('path').evaluate(item=>getComputedStyle(item).stroke);
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';document.documentElement.style.setProperty('--accent','#365ce5');});
  assert.notEqual(await plot.locator('path').evaluate(item=>getComputedStyle(item).stroke),dark,'series colors follow the current theme without replacing the plot');
}));

test('wide charts bound plot height and text size without changing pointer inspection coordinates',async()=>browserTest(async page=>{
  await page.evaluate(rows=>{
    document.body.style.margin='0';document.querySelector('#chart').style.width='100%';
    window.chart=acomCharts.mount(document.querySelector('#chart'),{samples:rows,range:{from:100,to:200}});
  },[sample(1,110,'10'),sample(2,190,'20')]);
  const plot=page.locator('#chart svg');
  for(const width of [1600,2600]){
    await page.setViewportSize({width,height:1000});
    const dimensions=await plot.evaluate(item=>({height:item.getBoundingClientRect().height,label:parseFloat(getComputedStyle(item.querySelector('text')).fontSize)*item.getBoundingClientRect().width/960,page:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(dimensions.height<=380.5);assert.ok(dimensions.label>=12&&dimensions.label<=18);assert.ok(dimensions.page<=dimensions.viewport);
    const bounds=await plot.boundingBox();
    await page.mouse.move(bounds.x+bounds.width*.19,bounds.y+bounds.height/2);assert.match(await page.locator('.acom-chart-readout').innerText(),/10 · final/);
    await page.mouse.move(bounds.x+bounds.width*.89,bounds.y+bounds.height/2);assert.match(await page.locator('.acom-chart-readout').innerText(),/20 · final/);
  }
}));
