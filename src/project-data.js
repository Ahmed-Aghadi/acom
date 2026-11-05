/* First-party project archive and captured-file controls. Nothing runs on polling. */
(() => {
  'use strict';
  const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const node=(tag,text)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=text;return item;};
  const bytes=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?`${value.toLocaleString()} bytes`:'unknown size';
  const count=value=>Number.isSafeInteger(value)&&value>=0;
  function styles(){if(document.getElementById('acom-project-data-style'))return;const style=node('style',`
    .project-data{min-width:0;font-size:14px;line-height:1.6;color:var(--ink,#eeeef0);container-type:inline-size}
    .project-data [hidden]{display:none!important}
    .project-data summary{cursor:pointer;font-size:14px;font-weight:600;line-height:1.5;padding:12px 0}
    .project-data-body{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
    .project-data fieldset{display:grid;align-content:start;gap:12px;min-width:0;margin:0;padding:16px;border:1px solid var(--line,#34343a);border-radius:4px;background:var(--panel,#1b1b1e)}
    .project-data legend{padding:0 8px;font-size:14px;font-weight:600;color:var(--ink,#eeeef0)}
    .project-data label{display:grid;gap:4px;min-width:0;font-size:12px;color:var(--secondary,#bbbcc4)}
    .project-data label:has(input[type=checkbox]){display:flex;align-items:start;gap:8px}
    .project-data input[type=checkbox]{flex:none;margin:3px 0;accent-color:var(--accent,#9aafff)}
    .project-data input:not([type=checkbox]),.project-data select{box-sizing:border-box;width:100%;min-width:0;min-height:36px;border:1px solid var(--line,#34343a);border-radius:4px;background:var(--bg,#141416);color:var(--ink,#eeeef0);font:inherit;padding:8px}
    .project-data input[type=text]{font-family:var(--mono,ui-monospace,monospace);font-size:12px}
    .project-data p{margin:0;font-size:12px;line-height:1.6;color:var(--muted,#a0a1ab);overflow-wrap:anywhere}
    .project-data>details>p{margin-bottom:16px;font-family:var(--mono,ui-monospace,monospace)}
    .project-data button{justify-self:start;box-sizing:border-box;min-height:32px;width:auto;border:1px solid var(--line,#34343a);border-radius:4px;background:var(--surface,#242427);color:var(--ink,#eeeef0);font:inherit;font-size:12px;padding:4px 12px;cursor:pointer}
    .project-data button:hover:not(:disabled){border-color:var(--muted,#a0a1ab)}
    .project-data button:disabled{opacity:.45;cursor:default}
    .project-data :is(button,input,select,summary,pre):focus-visible{outline:2px solid var(--accent,#9aafff);outline-offset:3px}
    .project-data [role=status]{white-space:pre-wrap;overflow-wrap:anywhere;max-height:192px;overflow:auto;overscroll-behavior:contain;font-variant-numeric:tabular-nums}
    .project-data>details+[role=status]{margin-top:12px}
    .project-data [role=status].inline-error{color:var(--danger,#e28b8b)}
    .project-data pre{max-height:256px;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono,ui-monospace,monospace);font-size:12px;line-height:1.6;padding:12px;border:1px solid var(--line,#34343a);border-radius:4px;background:var(--bg,#141416)}
    @container (min-width:720px){.project-data-body{grid-template-columns:repeat(2,minmax(0,1fr))}.project-data-body>fieldset:last-child{grid-column:1/-1}}
  `);style.id='acom-project-data-style';document.head.append(style);}
  function mount(host,options={}) {
    if(!host||typeof options.request!=='function')throw new TypeError('Project data host and request callback are required');
    styles();
    let context={...options},generation=0,destroyed=false,operation=null;
    const text=(item,value)=>{if(context.setText)context.setText(item,value);else if(item.textContent!==String(value))item.textContent=String(value);};
    const drafts=new Map(),root=node('section'),details=node('details'),summary=node('summary','Project archives and captured files'),body=node('div');body.className='project-data-body';
    const projectLabel=node('p'),status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    root.className='project-data';details.append(summary,projectLabel,body);root.append(details,status);host.replaceChildren(root);
    const group=title=>{const box=node('fieldset'),legend=node('legend',title);box.append(legend);body.append(box);return box;};
    const field=(box,label,type='text')=>{const wrapper=node('label',label+' '),input=node('input');input.type=type;input.setAttribute('aria-label',label);if(type==='checkbox')wrapper.prepend(input);else wrapper.append(input);box.append(wrapper);return input;};
    const button=(box,label,run)=>{const input=node('button',label);input.type='button';input.addEventListener('click',run);box.append(input);return input;};
    const note=(box,text)=>box.append(node('p',text));
    const exportBox=group('Export a project snapshot');
    note(exportBox,'The archive contains private core data and effective settings. It never overwrites an existing file. Logs and native conversation copies are optional.');
    const destination=field(exportBox,'Archive destination');destination.placeholder='/absolute/path/project.tar';
    const logs=field(exportBox,'Include output logs','checkbox'),native=field(exportBox,'Include native conversation copies','checkbox');
    const exportButton=button(exportBox,'Export snapshot',exportProject);
    const cleanupBox=group('Clean captured files');
    note(cleanupBox,'Pause active agents and wait for their tools to stop first. Core accounting, messages, delivery state and metric history are not removed. Native copies means files inside acom, not provider histories elsewhere.');
    const categoryLabel=node('label','Captured files '),category=node('select');category.setAttribute('aria-label','Captured files');
    for(const [value,label]of [['logs','Output logs'],['native','Imported native conversation copies']]){const item=node('option',label);item.value=value;category.append(item);}categoryLabel.append(category);cleanupBox.append(categoryLabel);
    const permanent=field(cleanupBox,'Delete permanently instead of moving to trash','checkbox');
    button(cleanupBox,'Preview cleanup',previewCleanup);
    const cleanupPreview=node('p');cleanupPreview.setAttribute('role','status');cleanupBox.append(cleanupPreview);
    const cleanupButton=button(cleanupBox,'Move captured files to trash',applyCleanup);
    const importBox=group('Import a project archive');
    note(importBox,'Inspect first, then choose its project folder. Import preserves the project identity and never overwrites a project. No workers, old processes, held locks or resumable native sessions are started.');
    const source=field(importBox,'Archive source');source.placeholder='/absolute/path/project.tar';
    const folder=field(importBox,'Imported project folder');folder.placeholder='/absolute/path/project';
    button(importBox,'Inspect archive',inspectArchive);
    const inspection=node('p');inspection.setAttribute('role','status');importBox.append(inspection);
    const settingsDetails=node('details'),settingsSummary=node('summary','Applied settings'),settingsPreview=node('pre');
    settingsPreview.tabIndex=0;settingsPreview.setAttribute('aria-label','Inspected applied settings');settingsDetails.append(settingsSummary,settingsPreview);importBox.append(settingsDetails);
    const accept=field(importBox,'Accept this binary’s different built-in Default settings','checkbox'),acceptLabel=accept.parentElement;
    const importButton=button(importBox,'Import inspected archive',importProject);
    let renderedReview=null;

    function key(){return context.project??'';}
    function draft(){const id=key();if(!drafts.has(id))drafts.set(id,{destination:'',logs:false,native:false,category:'logs',permanent:false,source:'',folder:'',accept:false,review:null,preview:null,status:'Nothing runs until you request it.',error:false});return drafts.get(id);}
    function active(version=generation,project=context.project){return !destroyed&&version===generation&&project===context.project&&(!context.current||context.current());}
    function save(){const item=draft();Object.assign(item,{destination:destination.value,logs:logs.checked,native:native.checked,category:category.value,permanent:permanent.checked,source:source.value,folder:folder.value,accept:accept.checked});return item;}
    function restore(){const item=draft();destination.value=item.destination;logs.checked=item.logs;native.checked=item.native;category.value=item.category;permanent.checked=item.permanent;source.value=item.source;folder.value=item.folder;accept.checked=item.accept;}
    function render(){
      if(destroyed)return;const item=draft(),selected=uuid(context.project),busy=!!operation;
      root.setAttribute('aria-busy',String(busy));
      text(projectLabel,selected?`${context.projectInfo?.name||'Project'} · ${context.project}`:'Select a project to export or clean its captured files. Import can add a project without selecting one.');
      exportBox.disabled=cleanupBox.disabled=busy||!selected;importBox.disabled=busy;
      exportButton.disabled=!selected||busy;
      text(cleanupPreview,item.preview?`${item.preview.files.toLocaleString()} files · ${bytes(item.preview.bytes)}. ${item.permanent?'Deletion cannot be undone.':'Moving to trash does not reclaim disk space.'}`:'Preview the selected category before removing anything.');
      text(cleanupButton,item.permanent?'Permanently delete captured files':'Move captured files to trash');cleanupButton.disabled=busy||!selected||!item.preview;
      const review=item.review;
      text(inspection,review?`Project ${review.project} · ${review.files.toLocaleString()} archived files · ${review.configuration.kind==='default'?'built-in Default':review.configuration.name||'Custom settings'}${review.already_exists?' · Already exists here; cannot import.':''}${review.default_changed?' · Built-in Default differs.':''}${warnings(review)?' · '+warnings(review):''}`:'No archive inspected for these paths.');
      settingsDetails.hidden=!review;
      if(review!==renderedReview){renderedReview=review;settingsDetails.open=false;text(settingsPreview,review?JSON.stringify(review.configuration.settings,null,2):'');}
      acceptLabel.hidden=!review?.default_changed;
      importButton.disabled=busy||!review||review.already_exists||review.default_changed&&!accept.checked||!item.folder.startsWith('/')||item.folder.includes('\0');
      text(status,busy&&operation.project!==context.project?'A previous selection’s request is still in progress.':item.status);
      status.classList.toggle('inline-error',item.error&&!busy);
    }
    function message(item,text,error=false){item.status=text;item.error=error;render();}
    function path(value,label){if(!value.startsWith('/')||value.includes('\0'))throw new Error(`${label} must be an absolute server-side path.`);return value;}
    function warnings(value){return [...new Set([value.warning,value.audit_warning,value.metrics_error,...(Array.isArray(value.warnings)?value.warnings:[])].filter(item=>typeof item==='string'&&item))].join(' ');}
    function receipt(value){return value?.result_truncated?`The response was shortened. Inspect its saved receipt at ${typeof value.receipt_path==='string'?value.receipt_path:'acom before retrying'}.`:'';}
    async function changed(item,callback){try{await callback?.();}catch{message(item,`${item.status} The view could not refresh; inspect current state before retrying.`);}}
    async function run(label,action){
      if(operation||!active())return;
      const item=save(),captured={project:context.project,version:generation,info:context.projectInfo,changed:context.onChanged,beforeExport:context.beforeExport,readReceipt:context.readReceipt};
      const pending={project:captured.project};operation=pending;message(item,label);
      try{await action(item,captured);}catch(error){if(!destroyed){item.status=`${error.message||'Request failed.'} Inspect current state before retrying.`;item.error=true;}}
      finally{if(operation===pending)operation=null;render();}
    }
    async function request(endpoint,body){return options.request(endpoint,{global:true,method:'POST',body:JSON.stringify(body)});}
    function exportProject(){return run('Exporting snapshot…',async(item,captured)=>{
      if(!uuid(captured.project))throw new Error('Select a project.');
      const target=path(item.destination,'Archive destination');
      if(!window.confirm(`Export project ${captured.info?.name||captured.project} (${captured.project}) to ${target}?\nThis archive contains private project data.${item.native?' Native conversation copies may contain additional sensitive context.':''}`))return message(item,'Export canceled.');
      if(!active(captured.version,captured.project))return;
      await captured.beforeExport?.(captured.project);
      if(!active(captured.version,captured.project))return;
      const result=await request(`/projects/${captured.project}/export`,{destination:target,logs:item.logs,native:item.native});
      if(result?.exported!==true&&result?.result_truncated!==true)throw new Error('Export response is incomplete.');
      message(item,`Snapshot exported to ${target}. ${warnings(result)} ${receipt(result)}`.trim());
    });}
    function previewCleanup(){return run('Inspecting captured files…',async(item,captured)=>{
      item.preview=null;if(!uuid(captured.project))throw new Error('Select a project.');
      const result=await request(`/projects/${captured.project}/cleanup`,{category:item.category,permanent:item.permanent,confirm:false});
      if(!active(captured.version,captured.project))return;
      if(!result?.preview||result.project!==captured.project||result.category!==item.category||!count(result.files)||!count(result.bytes))throw new Error('Cleanup preview response is incomplete.');
      item.preview=result;message(item,'Cleanup preview ready. No files were removed.');
    });}
    function applyCleanup(){return run('Removing captured files…',async(item,captured)=>{
      if(!uuid(captured.project)||!item.preview)throw new Error('Preview this project’s selected category first.');
      if(!window.confirm(`${item.permanent?'Permanently delete':'Move to trash'} ${item.preview.files.toLocaleString()} captured ${item.category} files for project ${captured.project}?\n${item.permanent?'This cannot be undone.':'Files remain recoverable in acom trash and still use disk space.'}\nCounts may have changed since the preview.`))return message(item,'Cleanup canceled.');
      if(!active(captured.version,captured.project))return;
      item.preview=null;
      const result=await request(`/projects/${captured.project}/cleanup`,{category:item.category,permanent:item.permanent,confirm:true});
      if(result?.removed!==true&&result?.result_truncated!==true)throw new Error('Cleanup response is incomplete.');
      message(item,`${result.deleted?'Captured files permanently deleted.':result.recoverable_at?'Captured files moved to '+result.recoverable_at+'.':'Captured-file cleanup completed.'} ${result.note||''} ${warnings(result)} ${receipt(result)}`.trim());
      await changed(item,captured.changed);
    });}
    function inspectArchive(){return run('Inspecting archive…',async(item,captured)=>{
      item.review=null;item.accept=false;accept.checked=false;
      const archive=path(item.source,'Archive source');
      let result=await request('/projects/inspect-archive',{source:archive});
      if(!active(captured.version,captured.project))return;
      if(result?.result_truncated){
        const endpoint=result.receipt_path;
        if(typeof captured.readReceipt!=='function'||typeof endpoint!=='string'||!/^\/global-receipts\/[1-9]\d{0,18}$/.test(endpoint)||BigInt(endpoint.slice(endpoint.lastIndexOf('/')+1))>9223372036854775807n)throw new Error('Archive inspection was shortened without a safe saved receipt.');
        result=await captured.readReceipt(endpoint,()=>active(captured.version,captured.project));
        if(!active(captured.version,captured.project))return;
      }
      if(result?.result_truncated||!uuid(result?.project)||typeof result.version!=='string'||!result.version||!count(result.files)||typeof result.already_exists!=='boolean'||typeof result.default_changed!=='boolean'||!['default','snapshot'].includes(result.configuration?.kind)||!result.configuration.settings||typeof result.configuration.settings!=='object'||Array.isArray(result.configuration.settings)||!Array.isArray(result.warnings)||!result.warnings.every(value=>typeof value==='string'))throw new Error('Archive inspection response is incomplete.');
      item.review=result;message(item,result.already_exists?'That project identity already exists. Import will not overwrite it.':'Archive inspected. Review the identity, settings and target folder before importing.');
    });}
    function importProject(){return run('Importing inspected archive…',async(item,captured)=>{
      const review=item.review;
      if(!review||review.already_exists||review.default_changed&&!item.accept)throw new Error('Inspect the archive and review its settings first.');
      const archive=path(item.source,'Archive source'),target=path(item.folder,'Imported project folder');
      if(!window.confirm(`Import project ${review.project} from ${archive} into ${target}?\nExisting projects are never overwritten. Archived agents remain stopped; no old sessions, background work or locks are restored.${review.default_changed?' This binary’s current Default settings will be applied.':''}`))return message(item,'Import canceled.');
      if(!active(captured.version,captured.project))return;
      item.review=null;
      const result=await request('/projects/import',{source:archive,path:target,version:review.version,accept_default_change:!!item.accept});
      if(result?.result_truncated!==true&&(result?.imported!==true||result.workers_started!==0))throw new Error('Import response is incomplete; check whether it committed.');
      message(item,`Project imported with no workers started. ${result.configuration_note||''} ${warnings(result)} ${receipt(result)}`.trim());
      await changed(item,captured.changed);
    });}
    for(const input of [destination,logs,native])input.addEventListener('input',save);
    for(const input of [category,permanent])input.addEventListener('change',()=>{save().preview=null;render();});
    source.addEventListener('input',()=>{const item=save();item.review=null;item.accept=false;accept.checked=false;render();});
    folder.addEventListener('input',()=>{save();render();});
    accept.addEventListener('change',()=>{save();render();});
    function updateContext(next={}){
      if(destroyed)return;
      const changedProject=Object.hasOwn(next,'project')&&next.project!==context.project;
      if(changedProject){save();generation++;}
      context={...context,...next};
      if(changedProject){const item=draft();item.review=null;item.preview=null;item.accept=false;restore();}
      render();
    }
    restore();render();
    return {updateContext,destroy(){if(destroyed)return;destroyed=true;generation++;root.remove();}};
  }
  window.acomProjectData=Object.freeze({mount});
})();
