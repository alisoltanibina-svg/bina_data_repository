const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
function report(overrides = {}) {
    return {state:'paused',paused:true,service_key_configured:true,worker_alive:true,
        can_pause:false,can_resume:true,resume_blocked_reason:'',categories:[],
        job:{id:'job-a',status:'running',categories:['library'],areas:[],requests:[],details:{}},...overrides};
}
function page(initial) {
    const elements=new Map(), calls=[];
    let current=initial, held=null, poll=null;
    const node=()=>({children:[],disabled:false,hidden:false,value:'',textContent:'',selectedOptions:[],
        append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;}});
    const el=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
    const context={document:{getElementById:el,createElement:node,hidden:false},window:{confirm:()=>true},
        setInterval:callback=>{poll=callback;},adminFetch:async(path,options)=>{
            calls.push({path,method:options?.method || 'GET',body:options?.body});
            if(path.endsWith('/status')) {
                const snapshot=current;
                if(held) {const wait=held;held=null;await wait;}
                return snapshot;
            }
            if(path.endsWith('/categories'))return ['library'];
            if(path.endsWith('/settlements'))return [{id:'point-1',name:'Capital',province:'A',county:'County',latitude:35.5,longitude:50.5}];
            if(path.endsWith('/pilot'))current=report({pilot:{id:9,status:'pending',province:'A',category:'library',latitude:35.7,longitude:51.4,radius_m:500,details_saved:0}});
            if(path.endsWith('/pause'))current=report({can_pause:false,can_resume:true});
            if(path.endsWith('/resume'))current=report({paused:false,state:'waiting',can_pause:true,can_resume:false});
            return {};
        }};
    vm.runInNewContext(fs.readFileSync('js/admin-poi.js','utf8'),context);
    return {el,calls,load:()=>context.window.AdminPoi.load(),poll:()=>poll(),set:value=>current=value,
        hold:()=>{let release;held=new Promise(resolve=>release=resolve);return release;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('missing service key explains disabled controls and status loading is read-only',async()=>{
    const p=page(report({state:'not_configured',job:null,service_key_configured:false,
        can_resume:false,resume_blocked_reason:'missing_service_key'}));
    await p.load();
    assert.equal(p.el('poi-pause').disabled,true);
    assert.equal(p.el('poi-resume').disabled,true);
    assert.match(p.el('poi-readiness').textContent,/NESHAN_SERVICE_API_KEY/);
    assert.ok(p.calls.every(call=>call.method==='GET'));
});

test('pause then resume follows fresh server state without blindly enabling buttons',async()=>{
    const p=page(report({paused:false,can_pause:true,can_resume:false}));await p.load();
    await p.el('poi-pause').onclick();
    assert.equal(p.el('poi-pause').disabled,true);
    assert.equal(p.el('poi-resume').disabled,false);
    await p.el('poi-resume').onclick();
    assert.equal(p.el('poi-pause').disabled,false);
    assert.equal(p.el('poi-resume').disabled,true);
});

test('an older poll cannot leave controls in the state before a pause',async()=>{
    const p=page(report({paused:false,can_pause:true,can_resume:false}));await p.load();
    const release=p.hold(), older=p.load();
    const pause=p.el('poi-pause').onclick();await settle();
    assert.equal(p.el('poi-pause').disabled,true);
    assert.equal(p.el('poi-resume').disabled,true);
    release();await older;await pause;
    assert.equal(p.el('poi-pause').disabled,true);
    assert.equal(p.el('poi-resume').disabled,false);
    assert.equal(p.calls.filter(call=>call.method==='POST').length,1);
});

test('missing job or worker explains why resume is unavailable',async()=>{
    for(const reason of ['no_active_job','worker_not_running','authorization_required','storage_cleanup_required','pilot_required','pilot_completed','pilot_review_required']) {
        const p=page(report({can_resume:false,resume_blocked_reason:reason}));await p.load();
        assert.equal(p.el('poi-resume').disabled,true);
        assert.ok(p.el('poi-readiness').textContent.length>20);
        assert.ok(p.el('poi-resume').title.length>20);
    }
});


test('pilot preparation sends only the chosen origin and never implicitly resumes',async()=>{
    const p=page(report());await p.load();
    p.el('poi-pilot-lat').value='35.7';p.el('poi-pilot-lon').value='51.4';
    p.el('poi-pilot-radius').value='500';p.el('poi-pilot-category').value='library';
    p.el('poi-pilot-form').onsubmit({preventDefault(){}});await settle();
    const writes=p.calls.filter(call=>call.method==='POST');
    assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/admin/poi/pilot');
    assert.deepEqual(JSON.parse(writes[0].body),{latitude:35.7,longitude:51.4,category:'library',radius_m:500});
    assert.ok(!p.calls.some(call=>call.path.endsWith('/resume')));
    assert.match(p.el('poi-pilot-status').textContent,/\u06f9/);
});

test('status polling preserves the entered pilot coordinates',async()=>{
    const p=page(report());await p.load();
    p.el('poi-pilot-lat').value='35.7';p.el('poi-pilot-lon').value='51.4';
    await p.load();
    assert.equal(p.el('poi-pilot-lat').value,'35.7');
    assert.equal(p.el('poi-pilot-lon').value,'51.4');
});


test('attached source pilot uses source identity and polling does not resume collection',async()=>{
    const p=page(report({job:{id:'job-a',radius_m:500,search_dataset_version:'version',categories:['library'],areas:[],requests:[],details:{}},
        search_sources:[{version:'version',summary:{ready:1,review:0,review_points:[]}}]}));
    await p.load();
    p.el('poi-settlement-select').value='point-1';p.el('poi-settlement-select').onchange();
    assert.equal(p.el('poi-pilot-lat').value,35.5);assert.equal(p.el('poi-pilot-lat').readOnly,true);
    p.el('poi-pilot-category').value='library';
    p.el('poi-pilot-form').onsubmit({preventDefault(){}});await settle();
    const writes=p.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);
    assert.equal(writes[0].path,'/api/admin/poi/settlement-pilot');
    assert.deepEqual(JSON.parse(writes[0].body),{settlement_id:'point-1',category:'library',radius_m:500});
    assert.ok(!p.calls.some(c=>c.path.endsWith('/resume')));
});
