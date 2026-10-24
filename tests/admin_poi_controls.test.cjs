const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
function report(overrides = {}) {
    return {state:'paused',paused:true,service_key_configured:true,worker_alive:true,
        can_pause:false,can_resume:true,resume_blocked_reason:'',categories:[],
        job:{id:'job-a',status:'running',areas:[],requests:[],details:{}},...overrides};
}
function page(initial) {
    const elements=new Map(), calls=[];
    let current=initial, held=null, poll=null;
    const node=()=>({children:[],disabled:false,hidden:false,value:'',textContent:'',selectedOptions:[],
        append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;}});
    const el=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
    const context={document:{getElementById:el,createElement:node,hidden:false},window:{confirm:()=>true},
        setInterval:callback=>{poll=callback;},adminFetch:async(path,options)=>{
            calls.push({path,method:options?.method || 'GET'});
            if(path.endsWith('/status')) {
                const snapshot=current;
                if(held) {const wait=held;held=null;await wait;}
                return snapshot;
            }
            if(path.endsWith('/categories'))return ['library'];
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
    for(const reason of ['no_active_job','worker_not_running']) {
        const p=page(report({can_resume:false,resume_blocked_reason:reason}));await p.load();
        assert.equal(p.el('poi-resume').disabled,true);
        assert.ok(p.el('poi-readiness').textContent.length>20);
        assert.ok(p.el('poi-resume').title.length>20);
    }
});
