const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function report(overrides={}){
 return {state:'paused',paused:true,worker_alive:true,service_key_configured:true,collection_authorized:true,
 can_pause:false,can_resume:true,can_start_collection:true,resume_blocked_reason:'',collection_mode:'coverage',categories:[],
 search_sources:[{version:'version',summary:{ready:10,review:1,review_points:[{name:'Review'}]}}],
 job:{id:'job-a',radius_m:500,search_dataset_version:'version',status:'running',categories:['library'],requests:[],details:{}},
 geography:{percent:20,completed_searches:2,expected_searches:10,completed_points:2,total_points:10,empty_searches:1,excluded_points:1,
 current_province:'A',provinces:[{province:'A',percent:40,completed_points:2,total_points:5,completed_searches:2,expected_searches:5,pending_searches:3},
 {province:'B',percent:0,completed_points:0,total_points:5,completed_searches:0,expected_searches:5,pending_searches:5}]},...overrides};
}
function page(initial){
 const elements=new Map(),calls=[];let current=initial,held=null;
 const node=()=>({children:[],disabled:false,hidden:false,value:'',textContent:'',selectedOptions:[],
 get options(){return this.children;},append(...items){this.children.push(...items);if(!this.value && items[0]?.value)this.value=items[0].value;},
 replaceChildren(...items){this.children=[];this.value='';this.append(...items);}});
 const el=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const context={document:{getElementById:el,createElement:node},window:{confirm:()=>true},setInterval:()=>assert.fail('Background polling registered'),
 adminFetch:async(path,options)=>{
  calls.push({path,method:options?.method || 'GET',body:options?.body});
  if(path.endsWith('/status')){const snapshot=current;if(held){const wait=held;held=null;await wait;}return snapshot;}
  if(path.endsWith('/categories'))return ['library'];
  if(path.endsWith('/settlements'))return [{id:'point-1',name:'Capital',province:'A',county:'County',latitude:35.5,longitude:50.5}];
  if(path.endsWith('/pause'))current=report();
  if(path.endsWith('/start') || path.endsWith('/resume'))current=report({paused:false,state:'waiting',can_pause:true,can_resume:false,can_start_collection:false});
  if(path.endsWith('/settlement-pilot'))current=report({collection_mode:'pilot',can_resume:true,can_start_collection:false,pilot:{id:9,status:'pending',province:'A',details_saved:0}});
  return {};
 }};
 vm.runInNewContext(fs.readFileSync('js/admin-poi.js','utf8'),context);
 return {el,calls,load:()=>context.window.AdminPoi.load(),set:value=>current=value,
 hold:()=>{let release;held=new Promise(resolve=>release=resolve);return release;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('reports have no timers and only load on explicit request',async()=>{
 const p=page(report());assert.equal(p.calls.length,0);await p.load();const n=p.calls.length;await settle();assert.equal(p.calls.length,n);
 assert.ok(p.calls.every(c=>c.method==='GET'));await p.el('poi-refresh').onclick();assert.equal(p.calls.filter(c=>c.path.endsWith('/status')).length,2);
});
test('pause then production start follows fresh server state',async()=>{
 const p=page(report({paused:false,can_pause:true,can_resume:false,can_start_collection:false}));await p.load();
 await p.el('poi-pause').onclick();assert.equal(p.el('poi-resume').disabled,false);
 await p.el('poi-resume').onclick();assert.equal(p.el('poi-resume').disabled,true);assert.equal(p.el('poi-pause').disabled,false);
 assert.ok(p.calls.some(c=>c.path.endsWith('/start')));
});
test('an older manual refresh cannot overwrite action results',async()=>{
 const p=page(report({paused:false,can_pause:true,can_resume:false,can_start_collection:false}));await p.load();
 const release=p.hold(),older=p.load(),pause=p.el('poi-pause').onclick();await settle();assert.equal(p.el('poi-resume').disabled,true);
 release();await older;await pause;assert.equal(p.el('poi-pause').disabled,true);assert.equal(p.el('poi-resume').disabled,false);
});
test('readiness blockers remain explained with disabled controls',async()=>{
 for(const reason of ['missing_service_key','no_active_job','worker_not_running','worker_outdated','authorization_required','storage_cleanup_required','pilot_review_required']){
  const p=page(report({can_resume:false,can_start_collection:false,resume_blocked_reason:reason}));await p.load();
  assert.equal(p.el('poi-resume').disabled,true);assert.ok(p.el('poi-readiness').textContent.length>10);assert.ok(p.el('poi-resume').title.length>10);
 }
});
test('verification uses source point identity and job radius without manual coordinates',async()=>{
 const p=page(report({collection_mode:'pilot',can_resume:false,can_start_collection:false,resume_blocked_reason:'pilot_required'}));await p.load();
 assert.equal(p.el('poi-verification').hidden,false);assert.match(p.el('poi-point-coordinates').textContent,/35.5/);
 p.el('poi-pilot-form').onsubmit({preventDefault(){}});await settle();
 const writes=p.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/admin/poi/settlement-pilot');
 assert.deepEqual(JSON.parse(writes[0].body),{settlement_id:'point-1',category:'library',radius_m:500});
 assert.ok(!p.calls.some(c=>c.path.endsWith('/start') || c.path.endsWith('/resume')));
});
test('production hides verification and shows all-province progress',async()=>{
 const p=page(report());await p.load();assert.equal(p.el('poi-verification').hidden,true);assert.equal(p.el('poi-attach-panel').hidden,true);
 assert.equal(p.el('poi-progress').value,20);assert.equal(p.el('poi-areas').children.length,2);
 assert.equal(p.el('poi-create').hidden,true);assert.ok(!p.calls.some(c=>c.path.endsWith('/settlements')));
});
test('completed verification activates production directly without another pilot',async()=>{
 const p=page(report({collection_mode:'pilot',can_resume:false,can_start_collection:true,resume_blocked_reason:'pilot_completed',pilot:{id:9,status:'complete',details_saved:1}}));await p.load();
 assert.equal(p.el('poi-verification').hidden,true);await p.el('poi-resume').onclick();
 assert.equal(p.calls.filter(c=>c.method==='POST')[0].path,'/api/admin/poi/start');
});


test('polygon plans show area progress and do not offer legacy point-only creation',async()=>{
 const d=report();d.can_resume=false;d.can_start_collection=false;d.resume_blocked_reason='coverage_not_ready';
 d.search_sources[0].summary.algorithm='full-polygon-and-point-sources-v1';
 Object.assign(d.geography,{scope:'verified_polygon_union_and_3km_points',plan_id:'plan-1',area_percent:25,
   metric_area_m2:1000000,completed_area_m2:250000,completed_point_searches:2,expected_point_searches:10,pending_tiles:3,result_limit:0});
 const p=page(d);await p.load();
 assert.equal(p.el('poi-progress').value,25);assert.equal(p.el('poi-create').hidden,true);
 assert.equal(p.el('poi-create-source').options.length,0);
 assert.match(p.el('poi-full-plan-help').textContent,/plan-1/);
 assert.ok(!p.el('poi-progress-label').textContent.includes('???'));
 assert.equal(p.el('poi-resume').disabled,true);
});


test('coverage preparation starts in admin and progress stays manual',async()=>{
 const d=report({coverage_setup:{can_prepare:true,sources_available:true,has_plan:false}});
 const p=page(d);await p.load();p.el('poi-coverage-categories').selectedOptions=[{value:'library'}];
 assert.equal(p.el('poi-coverage-prepare').disabled,false);
 await p.el('poi-coverage-form').onsubmit({preventDefault(){}});
 const write=p.calls.find(c=>c.path==='/api/admin/poi/coverage/prepare');
 assert.deepEqual(JSON.parse(write.body),{categories:['library'],radius_m:2000});
 const n=p.calls.length;await settle();assert.equal(p.calls.length,n);
 p.set(report({can_resume:false,can_start_collection:false,resume_blocked_reason:'coverage_preparing',
 coverage_setup:{can_prepare:false,sources_available:true},preparation:{state:'running',message:'Building',verified_tiles:3,total_tiles:12}}));
 await p.load();assert.equal(p.el('poi-coverage-prepare').disabled,true);assert.equal(p.el('poi-resume').disabled,true);
 assert.equal(p.el('poi-preparation-progress').value,25);assert.match(p.el('poi-preparation-status').textContent,/Building/);
});

test('confirmed coverage limit is saved in admin without starting collection',async()=>{
 const d=report({coverage_setup:{can_prepare:true,sources_available:true,has_plan:true},geography:{scope:'verified_polygon_union_and_3km_points',plan_id:'plan',pending_tiles:0,result_limit:0,provinces:[]}});
 const p=page(d);await p.load();p.el('poi-coverage-limit-mode').value='capped';p.el('poi-coverage-limit-mode').onchange();p.el('poi-coverage-limit').value='8';
 await p.el('poi-coverage-limit-form').onsubmit({preventDefault(){}});
 const writes=p.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);
 assert.equal(writes[0].path,'/api/admin/poi/coverage/limit');assert.deepEqual(JSON.parse(writes[0].body),{mode:'capped',result_limit:8});
});


test('unknown-limit mode submits no guessed number and clearly labels incomplete results',async()=>{
 const d=report({coverage_setup:{can_prepare:true,sources_available:true,has_plan:true},geography:{scope:'verified_polygon_union_and_3km_points',plan_id:'plan',pending_tiles:0,result_limit:0,result_limit_mode:'unknown',provinces:[]}});
 const p=page(d);await p.load();
 assert.equal(p.el('poi-coverage-limit-mode').value,'unknown');
 assert.equal(p.el('poi-coverage-limit').required,false);assert.equal(p.el('poi-coverage-limit').disabled,true);
 assert.equal(p.el('poi-coverage-limit-number').hidden,true);
 assert.ok(p.el('poi-coverage-limit-status').textContent.includes('نامشخص'));
 await p.el('poi-coverage-limit-form').onsubmit({preventDefault(){}});
 const write=p.calls.find(c=>c.path==='/api/admin/poi/coverage/limit');assert.deepEqual(JSON.parse(write.body),{mode:'unknown'});
 assert.ok(!p.calls.some(c=>c.method==='POST' && c.path.endsWith('/start')));
});
