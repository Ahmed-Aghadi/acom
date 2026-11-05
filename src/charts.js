/* First-party, dependency-free chart renderer. Fetching and paging belong to the caller. */
(() => {
  'use strict';
  const NS='http://www.w3.org/2000/svg';
  const COLORS=Array.from({length:8},(_,index)=>`var(--acom-chart-series-${index+1})`);
  const WIDTH=960,HEIGHT=300,LEFT=94,RIGHT=22,TOP=18,BOTTOM=52;
  const style=`
    .acom-chart{--acom-chart-series-1:var(--accent,#9aafff);--acom-chart-series-2:#d6b776;--acom-chart-series-3:#83b5a0;--acom-chart-series-4:#ba9ed0;--acom-chart-series-5:#d794a0;--acom-chart-series-6:#7bb9c8;--acom-chart-series-7:#b0bd82;--acom-chart-series-8:#cfa684;min-width:0;color:var(--ink,#eeeef0);font-size:14px;line-height:1.5}
    :root[data-theme=light] .acom-chart{--acom-chart-series-2:#8c651d;--acom-chart-series-3:#34765a;--acom-chart-series-4:#8058a0;--acom-chart-series-5:#aa4e68;--acom-chart-series-6:#277888;--acom-chart-series-7:#657a2d;--acom-chart-series-8:#a56436}
    .acom-chart [hidden],.acom-chart-history [hidden]{display:none!important}
    .acom-chart-history{min-width:0}
    .acom-chart-history>summary{cursor:pointer;font-size:14px;font-weight:600;line-height:1.5;padding:12px 0}
    .acom-chart-tools{display:flex;align-items:end;gap:8px;flex-wrap:wrap;margin:12px 0;color:var(--secondary,#bbbcc4);font-size:12px;line-height:1.5}
    .acom-chart-tools label{display:grid;gap:4px;min-width:0;max-width:100%}
    .acom-chart-tools label:has(input[type=checkbox]){display:flex;align-items:center;gap:8px;min-height:32px}
    .acom-chart-tools :is(button,select,input:not([type=checkbox])){box-sizing:border-box;min-height:32px;max-width:100%;border:1px solid var(--line,#34343a);border-radius:4px;background:var(--panel,#1b1b1e);color:var(--ink,#eeeef0);font:inherit;padding:4px 8px}
    .acom-chart-tools button{flex:0 0 auto;width:auto;cursor:pointer}
    .acom-chart-tools button:hover:not(:disabled){background:var(--surface,#242427)}
    .acom-chart-tools button[aria-pressed=true]{border-color:var(--accent,#9aafff);background:var(--accent-soft,#9aafff16);color:var(--accent,#9aafff)}
    .acom-chart-tools :is(button,select,input):focus-visible,.acom-chart-history>summary:focus-visible{outline:2px solid var(--accent,#9aafff);outline-offset:3px}
    .acom-chart-tools button:disabled{opacity:.45;cursor:default}
    .acom-chart-note{margin:8px 0;font-size:12px;line-height:1.6;color:var(--muted,#a0a1ab)}
    .acom-chart-panel{margin:20px 0;min-width:0}
    .acom-chart-panel h4{margin:0 0 8px;font-size:14px;font-weight:600;text-transform:none}
    .acom-chart-viewport{box-sizing:border-box;max-width:1226px;overflow-x:auto;overscroll-behavior-x:contain;border:1px solid var(--line,#34343a);border-radius:4px;background:var(--panel,#1b1b1e);padding:4px}
    .acom-chart-panel svg{display:block;width:100%;min-width:900px;height:auto;touch-action:auto}
    .acom-chart-viewport:focus-visible{outline:2px solid var(--accent,#9aafff);outline-offset:3px}
    .acom-chart-panel svg:focus-visible{outline:2px solid var(--accent,#9aafff);outline-offset:-2px}
    .acom-chart-panel svg text{font-family:var(--mono,ui-monospace,monospace);font-size:14px;fill:var(--muted,#a0a1ab)}
    .acom-chart-readout{display:block;min-height:60px;max-height:100px;overflow:auto;overscroll-behavior:contain;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 0;color:var(--secondary,#bbbcc4);font-variant-numeric:tabular-nums}
    .acom-chart-legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;line-height:1.6;max-height:100px;overflow:auto;overscroll-behavior:contain;list-style:none;padding:0;margin:4px 0;color:var(--secondary,#bbbcc4)}
    .acom-chart-legend li{display:flex;gap:8px;align-items:center;min-width:0;overflow-wrap:anywhere}
    .acom-chart-swatch{display:inline-block;width:16px;height:3px;flex:none}
    .acom-chart-empty{min-height:180px;display:grid;place-items:center;font-size:14px;color:var(--muted,#a0a1ab)}
    .acom-chart-summary{font-size:12px;line-height:1.6;max-height:128px;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--secondary,#bbbcc4);font-variant-numeric:tabular-nums}
    .acom-chart-loading .acom-chart-note{color:var(--secondary,#bbbcc4)}
  `;

  function element(name,text,className){const item=document.createElement(name);if(text!==undefined)item.textContent=text;if(className)item.className=className;return item;}
  function svg(name,attributes={}){const item=document.createElementNS(NS,name);for(const [key,value]of Object.entries(attributes))item.setAttribute(key,String(value));return item;}
  function setText(node,text){if(node.textContent!==text)node.textContent=text;}
  function time(value){const date=new Date(value*1000);return Number.isFinite(date.valueOf())?date.toLocaleString():`${value} Unix seconds`;}
  function counter(value){try{return typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)?BigInt(value):null;}catch{return null;}}
  function number(point,kind){if(!point?.value||point.value.kind!==kind)return null;return kind==='counter'?counter(point.value.value):typeof point.value.value==='number'&&Number.isFinite(point.value.value)?point.value.value:null;}
  function exact(point){if(!point?.value)return 'unavailable';if(point.value.kind==='counter'){const value=counter(point.value.value);return value===null?'unavailable':value.toLocaleString();}return typeof point.value.value==='number'&&Number.isFinite(point.value.value)?point.value.value.toLocaleString(undefined,{maximumFractionDigits:6}):'unavailable';}
  function compact(value){if(typeof value!=='bigint')return value.toLocaleString(undefined,{maximumSignificantDigits:5});const abs=value<0n?-value:value;for(const [unit,label]of [[1000000000000n,'T'],[1000000000n,'B'],[1000000n,'M'],[1000n,'K']])if(abs>=unit)return `${value/unit}.${abs%unit*10n/unit}${label}`;return String(value);}
  function key(sample){return JSON.stringify([sample.project??'',sample.series?.entity,sample.series?.metric,sample.origin?.id]);}
  function pointKey(item){return JSON.stringify([key(item.sample),item.sample.id,item.point.observed_at,item.position]);}
  function validRange(range){return range&&Number.isFinite(range.from)&&Number.isFinite(range.to)&&range.from>=0&&range.to>range.from;}
  function sameRange(a,b){return a?.from===b?.from&&a?.to===b?.to;}
  function gap(envelope){return envelope.has_gap||envelope.coverage_gap;}
  function installStyle(){if(document.getElementById('acom-chart-style'))return;const item=element('style',style);item.id='acom-chart-style';document.head.append(item);}

  function mount(host,initial={}){
    if(!host||typeof host.replaceChildren!=='function')throw new TypeError('Chart host is required');
    installStyle();
    const root=element('section',undefined,'acom-chart'),tools=element('div',undefined,'acom-chart-tools');
    const note=element('div',undefined,'acom-chart-note'),panelsHost=element('div'),empty=element('div',undefined,'acom-chart-empty');
    const summary=element('div',undefined,'acom-chart-summary');
    const panels=new Map();let data={},view=null,follow=false,destroyed=false,controlRange=null;
    const button=(label,handler,title)=>{const item=element('button',label);item.type='button';item.title=title;item.addEventListener('click',handler);tools.append(item);return item;};
    const zoomIn=button('Zoom in',()=>zoom(.5),'Zoom into the middle of the selected range (+)');
    const zoomOut=button('Zoom out',()=>zoom(2),'Show a wider time range (-)');
    const reset=button('Reset view',()=>resetView(),'Restore the range selected above (0)');
    const followButton=button('Follow latest',()=>{follow=!follow;view=null;data.onFollowChange?.(follow);if(follow)data.onRangeChange?.(null);render();},'Follow incoming samples (F)');
    root.append(tools,note,panelsHost,empty,summary);host.replaceChildren(root);

    function samples(){return Array.isArray(data.samples)?data.samples.filter(sample=>sample?.series&&sample?.origin&&sample?.envelope&&Number.isFinite(sample.envelope.first?.observed_at)&&Number.isFinite(sample.envelope.last?.observed_at)):[];}
    function baseRange(){if(validRange(data.range))return data.range;const values=samples();if(!values.length)return null;let from=Infinity,to=0;for(const sample of values){from=Math.min(from,sample.envelope.first.observed_at);to=Math.max(to,sample.envelope.last.observed_at+1);}if(to-from<2){from=Math.max(0,from-30);to+=30;}return {from,to};}
    function range(){return validRange(view)?view:baseRange();}
    function changeRange(next){if(!validRange(next))return;view={from:Math.max(0,Math.floor(next.from)),to:Math.ceil(next.to)};follow=false;data.onFollowChange?.(false);data.onRangeChange?.({...view});render();}
    function zoom(factor){const current=range();if(!current)return;const centre=(current.from+current.to)/2,half=Math.max(1,(current.to-current.from)*factor/2);changeRange({from:Math.max(0,centre-half),to:centre+half});}
    function resetView(){view=null;data.onRangeChange?.(null);render();}
    function summaryText(){
      const values=Array.isArray(data.summaries)?data.summaries:[];
      return values.map(item=>{const metrics=Object.entries(item.values??{}).map(([metric,value])=>`${metric}: ${value.known_subtotal===null?'unknown':counter(value.known_subtotal)?.toLocaleString()??'unknown'} known subtotal · ${value.quality??'unknown'}${value.unknown_series?` · ${value.unknown_series} unknown series`:''}${value.corrections?` · ${value.corrections} corrections`:''}`);return `${item.project??'Project'}${metrics.length?': '+metrics.join(' | '):''}${item.history_error?' · History unavailable':''}`;}).join('\n');
    }

    function createPanel(metric){
      const container=element('div',undefined,'acom-chart-panel'),title=element('h4',metric.replaceAll('_',' '));
      const plot=svg('svg',{viewBox:`0 0 ${WIDTH} ${HEIGHT}`,tabindex:'0',role:'group','aria-label':`${metric.replaceAll('_',' ')} history. Left and right arrows inspect points. Plus and minus zoom. Zero resets. F follows latest.`});
      const drawing=svg('g'),selection=svg('g',{'pointer-events':'none'}),line=svg('line',{y1:TOP,y2:HEIGHT-BOTTOM,stroke:'var(--muted,#a0a1ab)','stroke-dasharray':'3 3'}),dot=svg('circle',{r:4,fill:'var(--panel,#1b1b1e)',stroke:'var(--accent,#9aafff)','stroke-width':2});
      selection.append(line,dot);selection.setAttribute('visibility','hidden');plot.append(drawing,selection);
      const readout=element('output','Point details appear here on hover or with the arrow keys.','acom-chart-readout');readout.setAttribute('aria-live','off');
      const legend=element('ul',undefined,'acom-chart-legend');legend.setAttribute('aria-label','Chart series');
      const viewport=element('div',undefined,'acom-chart-viewport');viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label',`${metric.replaceAll('_',' ')} chart. Scroll horizontally to view the plot.`);viewport.append(plot);
      container.append(title,viewport,readout,legend);panelsHost.append(container);
      const panel={container,plot,drawing,selection,line,dot,readout,legend,points:[],selected:null,domain:null,drag:null};
      function inspect(index,announce=false){const item=panel.points[index];if(!item)return;readout.setAttribute('aria-live',announce?'polite':'off');panel.selected=pointKey(item);line.setAttribute('x1',item.x);line.setAttribute('x2',item.x);dot.setAttribute('cx',item.x);dot.setAttribute('cy',item.y);selection.setAttribute('visibility','visible');const source=item.sample;const envelope=source.envelope;const details=[`${time(item.point.observed_at)} · ${source.project?source.project+' · ':''}${source.series.entity} · ${source.series.metric}`,`${exact(item.point)} · ${item.point.quality??'unknown'} · numeric observation ${item.point.value_observed_at===null||item.point.value_observed_at===undefined?'unavailable':time(item.point.value_observed_at)}`,`Origin ${source.origin.id}${source.origin.imported_at===null||source.origin.imported_at===undefined?'':' · imported '+time(source.origin.imported_at)}${envelope.resolution_secs?` · ${envelope.resolution_secs}s envelope · min ${exact(envelope.minimum)}, max ${exact(envelope.maximum)}`:''}${envelope.has_gap?' · contains unavailable data':''}${envelope.has_correction?' · correction':''}${source.crosses_range?' · overlaps range boundary':''}`];if(envelope.coverage_gap)details.push('Intermediate observations were not recorded.');setText(readout,details.join('\n'));
        if(announce){const bounds=viewport.getBoundingClientRect(),marker=dot.getBoundingClientRect();if(marker.left<bounds.left+12)viewport.scrollLeft+=marker.left-bounds.left-12;else if(marker.right>bounds.right-12)viewport.scrollLeft+=marker.right-bounds.right+12;}
      }
      const xForEvent=event=>{const bounds=plot.getBoundingClientRect();return Math.max(LEFT,Math.min(WIDTH-RIGHT,(event.clientX-bounds.left)*WIDTH/Math.max(1,bounds.width)));};
      plot.addEventListener('pointermove',event=>{if(!panel.points.length)return;const x=xForEvent(event);let best=0;for(let index=1;index<panel.points.length;index++)if(Math.abs(panel.points[index].x-x)<Math.abs(panel.points[best].x-x))best=index;inspect(best);});
      plot.addEventListener('pointerdown',event=>{if(event.button!==0||event.pointerType==='touch'||!panel.domain)return;panel.drag=xForEvent(event);plot.setPointerCapture?.(event.pointerId);});
      plot.addEventListener('pointerup',event=>{if(panel.drag===null||!panel.domain)return;const start=panel.drag,end=xForEvent(event);panel.drag=null;if(Math.abs(end-start)<8)return;const domain=panel.domain,at=x=>domain.from+(x-LEFT)/(WIDTH-LEFT-RIGHT)*(domain.to-domain.from);changeRange({from:at(Math.min(start,end)),to:at(Math.max(start,end))});});
      plot.addEventListener('pointercancel',()=>{panel.drag=null;});
      plot.addEventListener('keydown',event=>{const selected=panel.points.findIndex(item=>pointKey(item)===panel.selected);if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();inspect(event.key==='Home'?0:event.key==='End'?panel.points.length-1:event.key==='ArrowLeft'?Math.max(0,selected-1):Math.min(panel.points.length-1,selected+1),true);}else if(['+','=','-','0','f','F'].includes(event.key)){event.preventDefault();if(event.key==='0')resetView();else if(event.key==='f'||event.key==='F')followButton.click();else zoom(event.key==='-'?2:.5);}});
      panel.inspect=inspect;return panel;
    }

    function drawPanel(panel,metric,rows,domain){
      panel.domain=domain;const kind=rows[0].series.kind,groups=new Map(),extrema=[];let omitted=0;
      for(const sample of rows){if(sample.series.kind!==kind){omitted++;continue;}const id=key(sample);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(sample);for(const point of [sample.envelope.first,sample.envelope.last,sample.envelope.minimum,sample.envelope.maximum]){const value=number(point,kind);if(value!==null&&point.observed_at>=domain.from&&point.observed_at<domain.to)extrema.push(value);}}
      const zero=kind==='counter'?0n:0;let min=extrema.length?extrema[0]:zero,max=min;for(const value of extrema){if(value<min)min=value;if(value>max)max=value;}
      if(max===min){if(kind==='counter'){min=min>0n?min-1n:0n;max+=1n;}else{const pad=Math.max(1,Math.abs(max)*.01);min-=pad;max+=pad;}}
      const x=at=>LEFT+(at-domain.from)/(domain.to-domain.from)*(WIDTH-LEFT-RIGHT);
      const y=value=>HEIGHT-BOTTOM-(kind==='counter'?Number((value-min)*1000000n/(max-min))/1000000:(value-min)/(max-min))*(HEIGHT-TOP-BOTTOM);
      const children=[];for(let index=0;index<=4;index++){const cy=TOP+(HEIGHT-TOP-BOTTOM)*index/4,value=kind==='counter'?max-(max-min)*BigInt(index)/4n:max-(max-min)*index/4;children.push(svg('line',{x1:LEFT,x2:WIDTH-RIGHT,y1:cy,y2:cy,stroke:'var(--line,#34343a)'}));const label=svg('text',{x:LEFT-8,y:cy+4,'text-anchor':'end'});label.textContent=compact(value);children.push(label);}
      for(let index=0;index<=3;index++){const at=domain.from+(domain.to-domain.from)*index/3,label=svg('text',{x:LEFT+(WIDTH-LEFT-RIGHT)*index/3,y:HEIGHT-25,'text-anchor':index===0?'start':index===3?'end':'middle'});label.textContent=time(Math.round(at));children.push(label);}
      const legendItems=[],points=[];let groupIndex=0;
      for(const group of groups.values()){
        group.sort((a,b)=>a.envelope.first.observed_at-b.envelope.first.observed_at||a.id-b.id);const sample=group[0],color=COLORS[groupIndex++%COLORS.length];let path='',lastPoint=null;
        const uncertain=group.some(item=>gap(item.envelope)||item.envelope.qualities?.some(quality=>quality!=='final'));
        for(const row of group){const envelope=row.envelope;if(gap(envelope))lastPoint=null;
          for(const [position,point]of [['first',envelope.first],['last',envelope.last]]){if(position==='last'&&JSON.stringify(envelope.first)===JSON.stringify(point))continue;const value=number(point,kind);if(value===null){lastPoint=null;continue;}if(point.observed_at<domain.from||point.observed_at>=domain.to)continue;const item={sample:row,point,position,x:x(point.observed_at),y:y(value)};points.push(item);path+=`${lastPoint?' L':' M'}${item.x.toFixed(2)} ${item.y.toFixed(2)}`;lastPoint=gap(envelope)?null:item;children.push(svg('circle',{cx:item.x,cy:item.y,r:envelope.has_correction?3.8:2.2,fill:envelope.has_correction?'var(--warn,#d6b776)':color}));}
          const low=number(envelope.minimum,kind),high=number(envelope.maximum,kind);if(low!==null&&high!==null&&envelope.last.observed_at>=domain.from&&envelope.last.observed_at<domain.to)children.push(svg('line',{x1:x(envelope.last.observed_at),x2:x(envelope.last.observed_at),y1:y(low),y2:y(high),stroke:color,'stroke-opacity':'.45','stroke-width':3}));
          if(gap(envelope)||envelope.has_correction)lastPoint=null;
        }
        if(path)children.push(svg('path',{d:path,fill:'none',stroke:color,'stroke-width':1.8,'stroke-dasharray':uncertain?'5 3':'none'}));
        const item=element('li'),swatch=element('span',undefined,'acom-chart-swatch');swatch.style.backgroundColor=color;const label=element('span',`${sample.project?sample.project.slice(0,8)+' · ':''}${sample.series.entity} · origin ${sample.origin.id.slice(0,8)}${uncertain?' · uncertain/provisional':''}`);item.append(swatch,label);legendItems.push(item);
      }
      panel.points=points.sort((a,b)=>a.point.observed_at-b.point.observed_at||a.sample.id-b.sample.id);panel.drawing.replaceChildren(...children);panel.legend.replaceChildren(...legendItems);
      const selected=panel.points.findIndex(item=>pointKey(item)===panel.selected);if(selected>=0)panel.inspect(selected);else{panel.selection.setAttribute('visibility','hidden');setText(panel.readout,`${points.length?`Inspect ${points.length} observed endpoints with hover or arrow keys.`:'No numeric observations in this range. Unavailable values are not zero.'}${omitted?' Mixed units were omitted.':''}`);}
    }

    function render(){
      if(destroyed)return;const rows=samples(),domain=range(),metrics=new Map();for(const row of rows){if(!['counter','gauge'].includes(row.series.kind))continue;if(!metrics.has(row.series.metric))metrics.set(row.series.metric,[]);metrics.get(row.series.metric).push(row);}
      root.classList.toggle('acom-chart-loading',!!data.loading);root.setAttribute('aria-busy',String(!!data.loading));followButton.setAttribute('aria-pressed',String(follow));zoomIn.disabled=zoomOut.disabled=reset.disabled=!domain;
      setText(note,`${data.loading?'Updating. ':''}${rows.length} stored envelopes · ${data.scope??'selected origin scope'} · lines remain separate by project, agent and origin. Dashed lines are uncertain. Missing values are not zero.${rows.some(row=>row.crosses_range)?' Some envelopes overlap the requested range boundary.':''}`);
      for(const [metric,panel]of panels)if(!metrics.has(metric)){panel.container.remove();panels.delete(metric);}
      if(domain)for(const [metric,values]of metrics){let panel=panels.get(metric);if(!panel){panel=createPanel(metric);panels.set(metric,panel);}drawPanel(panel,metric,values,domain);}
      empty.hidden=metrics.size>0;setText(empty,data.loading?'Loading recorded observations…':'No recorded observations in this range.');
      const text=summaryText();setText(summary,text);summary.hidden=!text;
    }
    function update(next={}){if(destroyed)return;if(Object.hasOwn(next,'range')&&!sameRange(controlRange,next.range)){controlRange=next.range;view=null;}if(Object.hasOwn(next,'follow'))follow=!!next.follow;data={...data,...next};render();}
    update(initial);
    return {update,destroy(){if(destroyed)return;destroyed=true;panels.clear();if(root.parentNode===host)root.remove();}};
  }
  function createPanel(host,options={}){
    const request=options.request;if(typeof request!=='function')throw new TypeError('Chart request callback is required');
    const details=element('details'),heading=element('summary','Usage history'),body=element('div'),controls=element('div',undefined,'acom-chart-tools');
    details.className='acom-chart-history';
    const status=element('p','Expand to load bounded historical data.','acom-chart-note');status.setAttribute('role','status');
    const plot=element('div'),maintenance=element('div',undefined,'acom-chart-tools');
    details.append(heading,body);body.append(controls,status,plot,maintenance);host.replaceChildren(details);
    const select=(label,values)=>{const wrapper=element('label',label+' '),input=element('select');input.setAttribute('aria-label',label);for(const [value,text]of values){const option=element('option',text);option.value=value;input.append(option);}wrapper.append(input);controls.append(wrapper);return input;};
    const mode=select('Source',[['project','Project agents'],['projects','Selected projects'],['account','Account usage']]);
    const projects=select('Projects',[]);projects.multiple=true;projects.size=3;
    const metric=select('Metric',[]),account=select('Account series',[]);
    const period=select('Time range',[['3600','Last hour'],['86400','Last day'],['604800','Last week'],['custom','Custom']]);period.value='86400';
    const scope=select('Origins',[['recorded_here','Recorded by this installation'],['all','All stored history'],['since_import','Since this import']]);
    const from=element('input'),to=element('input');for(const [label,input]of [['From',from],['To',to]]){input.type='datetime-local';input.step='1';const wrapper=element('label',label+' ');wrapper.append(input);controls.append(wrapper);wrapper.hidden=true;}
    const addButton=(parent,label,handler)=>{const button=element('button',label);button.type='button';button.addEventListener('click',handler);parent.append(button);return button;};
    const loadButton=addButton(controls,'Refresh',()=>load(false,true));
    const moreButton=addButton(controls,'Load more',()=>{setFollow(false);load(true,true);});moreButton.disabled=true;
    const projectButton=addButton(controls,'More projects',async()=>{try{const result=await context.loadProjects?.();if(Array.isArray(result))updateContext({projects:result});}catch(error){setText(status,error.message);}});
    const catalogButton=addButton(controls,'More account series',()=>loadCatalog(true));catalogButton.hidden=true;
    const followLabel=element('label',' Follow '),followInput=element('input');followInput.type='checkbox';followLabel.prepend(followInput);controls.append(followLabel);
    const resolution=element('input');resolution.type='number';resolution.min='1';resolution.max='31536000';resolution.step='1';resolution.value='60';resolution.setAttribute('aria-label','Downsampling resolution in seconds');resolution.style.width='7rem';
    const downsample=addButton(maintenance,'Preview downsampling',()=>maintain('downsample'));
    const clear=addButton(maintenance,'Preview clear',()=>maintain('clear'));
    maintenance.prepend(element('span','Optional history only · all origins · resolution (seconds) '),resolution);
    const resetHistory=addButton(maintenance,'Recover unavailable history',recover);resetHistory.hidden=true;
    let context={},contextKey=null,generation=0,abort=null,catalogAbort=null,destroyed=false,loading=false,maintenanceBusy=false,lastLoad=0,rows=[],summaries=[],next=null,lastQuery=null,accountRows=[],accountNext=null,catalogLoading=false,projectSignature='',metricSignature='',accountSignature='';
    const chart=mount(plot,{samples:[],scope:'recorded_here',onRangeChange:range=>{if(range){period.value='custom';from.value=localTime(range.from);to.value=localTime(range.to);}else if(period.value==='custom')period.value='86400';syncControls();load(false,true);},onFollowChange:enabled=>{followInput.checked=enabled;if(enabled)load(false,true);}});
    const timer=setInterval(()=>{if(details.open&&followInput.checked&&!document.hidden)load(false,false);},5000);

    function localTime(epoch){const date=new Date(epoch*1000);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);}
    function active(version=generation){return !destroyed&&generation===version&&context.current?.()!==false;}
    function setFollow(enabled){followInput.checked=enabled;chart.update({follow:enabled});}
    function maintenanceLock(enabled){maintenanceBusy=enabled;for(const control of [downsample,clear,resetHistory,resolution,mode,projects,metric,account,period,scope,from,to])control.disabled=enabled;}
    function range(){const end=Math.floor(Date.now()/1000)+1;if(period.value==='custom'){const start=Date.parse(from.value)/1000,finish=Date.parse(to.value)/1000;if(!validRange({from:start,to:finish}))throw new Error('Select a valid custom time range.');return {from:Math.floor(start),to:Math.ceil(finish)};}return {from:Math.max(0,end-Number(period.value)),to:end};}
    function selectedProjects(){return Array.from(projects.selectedOptions,option=>option.value);}
    function importScopeAvailable(){const selected=context.agent?[context.project]:selectedProjects();return (context.agent||mode.value!=='account')&&selected.length>0&&selected.every(id=>(context.projects??[]).some(project=>project.id===id&&project.imported_at!==null&&project.imported_at!==undefined));}
    function setOptions(input,values,selected){const old=selected??input.value;input.replaceChildren(...values.map(([value,label])=>{const option=element('option',label);option.value=value;option.selected=Array.isArray(old)?old.includes(value):value===old;return option;}));if(!input.multiple&&!input.value&&input.options.length)input.value=input.options[0].value;}
    function syncControls(){
      const agent=Number.isInteger(context.agent)&&context.agent>0;
      mode.parentElement.hidden=agent;projects.parentElement.hidden=agent||mode.value==='account';account.parentElement.hidden=mode.value!=='account'||agent;
      projects.multiple=mode.value==='projects'&&!agent;projects.size=projects.multiple?3:1;
      const definitions=mode.value==='account'&&!agent?[['usage_pct','Usage percentage'],['check_attempt_at','Last check attempt'],['check_success_at','Last successful check']]:[['total_tokens','Total tokens'],['fresh_in','Fresh input'],['cache_read','Cache reads'],['cache_write','Cache writes'],['output','Output'],['context_tokens','Context tokens']];
      const key=JSON.stringify(definitions);if(key!==metricSignature){metricSignature=key;setOptions(metric,definitions);}
      for(const input of [from,to])input.parentElement.hidden=period.value!=='custom';
      projectButton.hidden=agent||mode.value==='account'||typeof context.loadProjects!=='function';
      catalogButton.hidden=agent||mode.value!=='account'||accountNext===null;
      if(mode.value==='account'&&!agent){const choices=accountRows.filter(item=>item.series.metric===metric.value).map(item=>[item.series.entity,item.series.entity]),signature=JSON.stringify(choices);if(signature!==accountSignature){accountSignature=signature;const old=account.value;setOptions(account,choices,old);}}
      maintenance.hidden=mode.value==='projects'&&selectedProjects().length!==1;
      scope.querySelector('option[value="since_import"]').disabled=!importScopeAvailable();
    }
    function updateContext(nextContext={}){
      if(destroyed)return;const updated={...context,...nextContext},key=JSON.stringify([updated.project??null,updated.agent??null]),changed=key!==contextKey;context=updated;
      if(changed){contextKey=key;generation++;abort?.abort();catalogAbort?.abort();catalogLoading=false;loading=false;rows=[];summaries=[];next=null;lastQuery=null;lastLoad=0;mode.value='project';followInput.checked=false;chart.update({samples:[],summaries:[],range:null,loading:false,follow:false});}
      const signature=JSON.stringify((context.projects??[]).map(item=>[item.id,item.name]));
      if(signature!==projectSignature||changed){projectSignature=signature;const selected=changed&&context.project?[context.project]:selectedProjects();setOptions(projects,(context.projects??[]).map(item=>[item.id,item.name||item.id]),selected.length?selected:context.project?[context.project]:[]);}
      if(context.project&&Array.from(projects.options).some(option=>option.value===context.project)&&!selectedProjects().length)projects.value=context.project;
      if(!projects.value&&projects.options.length)projects.options[0].selected=true;
      syncControls();
    }
    function query(){
      const timeRange=range(),agent=Number.isInteger(context.agent)&&context.agent>0,selected=agent?[context.project]:selectedProjects();
      if(!agent&&mode.value!=='account'&&(!selected.length||selected.length>16))throw new Error('Select 1–16 projects.');
      if(agent&&!context.project)throw new Error('An agent history requires its project.');
      if(scope.value==='since_import'&&!importScopeAvailable())throw new Error('Since this import applies only when every selected project is imported. Choose another origin scope.');
      const params=new URLSearchParams({metric:metric.value,from:String(timeRange.from),to:String(timeRange.to),scope:scope.value,order:'desc',limit:'100',max_bytes:'16000'});
      params.set('resolution_secs',String(Math.max(1,Math.ceil((timeRange.to-timeRange.from)/180))));
      let path;
      if(!agent&&mode.value==='account'){if(!account.value)throw new Error('No recorded account series is selected.');params.set('entity',account.value);path='/metrics';}
      else if(agent){params.set('entity',`agent:${context.agent}`);path=`/p/${context.project}/metrics`;}
      else{params.set('projects',selected.join(','));path='/metrics/projects';}
      return {path,params:params.toString(),range:timeRange,scope:scope.value,project:agent?context.project:selected.length===1?selected[0]:null,entity:agent?`agent:${context.agent}`:mode.value==='account'?account.value:'agent:*',metric:metric.value};
    }
    async function loadCatalog(append=false){
      if(catalogLoading||!active()||!details.open)return;catalogLoading=true;const version=generation,controller=new AbortController();catalogAbort?.abort();catalogAbort=controller;
      try{const response=await request('/metrics/series?limit=100&max_bytes=16000'+(append&&accountNext!==null?'&after='+accountNext:''),{global:true,signal:controller.signal});if(!active(version))return;accountRows=append?[...accountRows,...response.items]:response.items;accountNext=response.next;syncControls();}
      catch(error){if(active(version)){setText(status,error.message);if(error.status===503)resetHistory.hidden=false;}}finally{if(catalogAbort===controller)catalogLoading=false;}
    }
    async function load(append=false,force=false){
      if(!details.open||!active()||loading||(!force&&Date.now()-lastLoad<5000))return;
      if(append&&(!next||!lastQuery))return;
      const version=generation;
      try{
        if(mode.value==='account'&&!context.agent&&!accountRows.length)await loadCatalog(false);
        if(!active(version))return;
        const selected=append?lastQuery:query();const controller=new AbortController();abort?.abort();abort=controller;loading=true;lastLoad=Date.now();loadButton.disabled=true;moreButton.disabled=true;chart.update({loading:true});setText(status,'Loading a bounded page of recorded observations…');
        const params=new URLSearchParams(selected.params);if(append)params.set('cursor',JSON.stringify(next));
        const response=await request(selected.path+'?'+params,{global:true,signal:controller.signal});
        if(!active(version)||abort!==controller){if(generation===version)lastLoad=0;return;}
        const incoming=(response.items??[]).map(item=>item.project||!selected.project?item:{...item,project:selected.project});
        const merged=append?[...rows,...incoming]:incoming,map=new Map();for(const item of merged)map.set(JSON.stringify([item.project??'',item.id,item.origin?.id]),item);rows=Array.from(map.values());
        const summaryMap=new Map((append?summaries:[]).map(item=>[item.project,item]));for(const item of response.summaries??[])summaryMap.set(item.project,item);summaries=Array.from(summaryMap.values());next=response.next;lastQuery=selected;
        chart.update({samples:rows,summaries,scope:selected.scope,range:response.range??selected.range,loading:false,follow:followInput.checked});
        resetHistory.hidden=!(response.status?.available===false||response.summaries?.some(item=>item.status?.available===false));
        setText(status,`${rows.length} stored envelopes loaded${next?' · more available':''}. Individual series, not a fabricated project-total timeline.${rows.length>=5000?' Narrow the range to inspect more.':''}`);
      }catch(error){if(active(version)&&error.name!=='AbortError'){setText(status,error.message||'History could not be loaded.');if(error.status===503)resetHistory.hidden=false;chart.update({loading:false});}}
      finally{if(!destroyed&&generation===version){loading=false;loadButton.disabled=false;moreButton.disabled=!next||rows.length>=5000;chart.update({loading:false});}}
    }
    async function maintain(action){
      if(!active()||loading||maintenanceBusy)return;const version=generation;maintenanceLock(true);
      try{
        const selected=query();if(!selected.project&&selected.path!=='/metrics')throw new Error('Select one project for history maintenance.');
        if(scope.value!=='all')throw new Error('History maintenance covers all origins. Select All stored history first.');
        const seconds=Number(resolution.value);if(action==='downsample'&&(!Number.isInteger(seconds)||seconds<1||seconds>31536000))throw new Error('Select a valid downsampling resolution.');
        setFollow(false);const kind=selected.metric==='context_tokens'||selected.metric==='usage_pct'||selected.metric.startsWith('check_')?'gauge':'counter';
        const selection={series:[{entity:selected.entity,metric:selected.metric,kind}],...selected.range};
        const endpoint=selected.project?`/p/${selected.project}/metrics/maintenance`:'/metrics/maintenance';
        const payload={action:'preview_'+action,selection,...(action==='downsample'?{resolution_secs:seconds}:{})};
        const preview=await request(endpoint,{global:true,method:'POST',body:JSON.stringify(payload)});if(!active(version))return;
        const result=preview.result;const description=action==='clear'?`${result.removed} stored envelopes will be removed.`:`${result.before} stored envelopes will become ${result.after}; discarded detail cannot be recovered.`;
        if(!window.confirm(`${action==='clear'?'Clear':'Downsample'} ${selected.metric} history in ${selected.project||'account usage'}, across all origins, from ${time(selected.range.from)} to ${time(selected.range.to)}?\n${description}\n${result.skipped_boundary} boundary envelopes will be kept. Core accounting is unchanged.`))return;
        if(!active(version))return;
        const applied=await request(endpoint,{global:true,method:'POST',body:JSON.stringify({...payload,action,confirm:true})});if(!active(version))return;
        await load(false,true);if(applied.warnings?.length)setText(status,applied.warnings.join(' '));
      }catch(error){if(active(version))setText(status,error.message||'History maintenance failed. Inspect state before retrying.');}
      finally{maintenanceLock(false);}
    }
    async function recover(){
      if(!active()||maintenanceBusy)return;const version=generation;maintenanceLock(true);
      try{const selected=context.agent?[context.project]:selectedProjects(),accountMode=!context.agent&&mode.value==='account';if(!accountMode&&selected.length!==1)throw new Error('Select one project to recover its history.');const endpoint=accountMode?'/metrics/reset':`/p/${selected[0]}/metrics/reset`;if(!window.confirm('Create a fresh optional history store? Existing metric files will be preserved in history-trash. Core accounting is unchanged.'))return;if(!active(version))return;await request(endpoint,{global:true,method:'POST',body:JSON.stringify({confirm:true})});if(active(version)){resetHistory.hidden=true;accountRows=[];await load(false,true);}}
      catch(error){if(active(version))setText(status,error.message);}
      finally{maintenanceLock(false);}
    }
    for(const input of [mode,projects,metric,account,period,scope,from,to])input.addEventListener('change',()=>{generation++;abort?.abort();loading=false;next=null;lastQuery=null;syncControls();load(false,true);});
    followInput.addEventListener('change',()=>{chart.update({follow:followInput.checked});if(followInput.checked)load(false,true);});
    details.addEventListener('toggle',()=>{if(details.open)load(false,true);else{generation++;abort?.abort();loading=false;}});
    updateContext(options);
    return {updateContext,refresh:()=>!lastQuery||followInput.checked?load(false,false).catch(()=>{}):Promise.resolve(),destroy(){if(destroyed)return;destroyed=true;generation++;abort?.abort();catalogAbort?.abort();clearInterval(timer);chart.destroy();details.remove();}};
  }
  window.acomCharts=Object.freeze({mount,createPanel});
})();
