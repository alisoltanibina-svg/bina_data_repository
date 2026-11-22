const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('js/locations.js','utf8');
function fixture() {
    const elements=new Map(), timers=new Map(), frames=[], requests=[], markers=[];
    let timerId=0, ready, clock=Date.now();
    class ClockDate extends Date { static now(){return clock;} }
    const node=()=>({textContent:'',value:'',hidden:false,children:[],handlers:{},classList:{toggle(){}},
        append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
        setAttribute(){},addEventListener(type,fn){this.handlers[type]=fn;},get childElementCount(){return this.children.length;}});
    const el=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
    let map;
    const group=()=>({items:[],removeLayer(marker){this.items=this.items.filter(item=>item!==marker);},clearLayers(){this.items=[];},addTo(target){target.layers.add(this);return this;}});
    function FakeMap() {
        map=this;this.layers=new Set();this.center={lat:35,lng:51};this.zoom=5;this.handlers={};
        this.attributionControl={setPrefix(){}};
        this.setView=(center,zoom)=>{this.center={lat:center[0],lng:center[1]};this.zoom=zoom;return this;};
        this.on=(event,fn)=>{this.handlers[event]=fn;return this;};
        this.hasLayer=layer=>this.layers.has(layer);this.removeLayer=layer=>this.layers.delete(layer);
        this.getZoom=()=>this.zoom;this.getCenter=()=>this.center;
        this.getBounds=()=>({getNorthEast:()=>this.center,getSouthWest:()=>this.center,
            getNorthWest:()=>this.center,getSouthEast:()=>this.center});
    }
    const point=(center,options)=>({center,options,addTo(group){group.items.push(this);markers.push(this);return this;},bindPopup(){return this;},on(){return this;}});
    const categories=[{category:'mosque',title:'مسجد',icon_url:'https://static.neshanmap.ir/poi/64/mosque.png'}];
    const live={min_zoom:8,radius_by_zoom:{8:100000,9:50000,10:25000,11:12000,12:5000,13:2000,14:1500,15:1000,16:700,17:500,18:500,19:500},debounce_ms:200,interval_ms:1000};
    const reply=payload=>({ok:true,status:200,json:async()=>payload,headers:{get(){return null;}}});
    let nearbyResolve;
    const context=vm.createContext({Intl,Math,Number,Object,JSON,Map,Date:ClockDate,Promise,AbortController,console,
        document:{hidden:false,getElementById:el,createElement:node,addEventListener(){}},navigator:{},
        window:{API_BASE_URL:'',addEventListener(){},location:{assign(){}}},
        onReady(fn){ready=fn;},setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;},
        clearTimeout(id){timers.delete(id);},cancelAnimationFrame(){},requestAnimationFrame(fn){frames.push(fn);},
        fetch:async(url,options)=>{
            requests.push({url,options});
            if(url.endsWith('/api/maps/config'))return reply({key:'map-only-key',maptype:'dreamy'});
            if(url.endsWith('/api/poi-explore/init'))return reply({categories,live});
            if(url.includes('/counts?'))return reply({provinces:[{province:'تهران',latitude:35,longitude:51,count:null}],unassigned_count:0});
            return new Promise(resolve=>{nearbyResolve=resolve;});
        },
        L:{Map:FakeMap,layerGroup:group,canvas:()=>({}),marker:point,icon:options=>options,
            divIcon:options=>options,circle:(center,options)=>({addTo(){return this;},remove(){}})}});
    vm.runInContext(source,context);
    const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
    return {context,el,timers,requests,markers,frames,flush,reply,advance(ms){clock+=ms;},
        run:code=>vm.runInContext(code,context), async start(){ready();await flush();},
        map:()=>map,resolveNearby(payload){nearbyResolve(reply(payload));},resolveNearbyResponse(response){nearbyResolve(response);}};
}
test('live requests begin at regional zoom and remain restricted to Iran',()=>{
    const f=fixture();
    assert.equal(f.run(`locationNearbyPlan('mosque',{lat:35,lng:51},7,{min_zoom:8})`),null);
    assert.equal(f.run(`locationNearbyPlan('mosque',{lat:45,lng:51},15,{min_zoom:13})`),null);
    const plan=f.run(`locationNearbyPlan('mosque',{lat:35,lng:51},15,{min_zoom:13,radius_by_zoom:{15:1000}})`);
    assert.equal(plan.radius,1000);assert.equal(plan.zoom,15);
    const regional=f.run(`locationNearbyPlan('mosque',{lat:35,lng:51},8,{min_zoom:8,radius_by_zoom:{8:100000}})`);
    assert.equal(regional.radius,100000);assert.equal(regional.zoom,8);
    assert.equal(f.run('locationMarkerSize(null,100)'),28);
    assert.ok(f.run('locationMarkerSize(100,100)')>f.run('locationMarkerSize(1,100)'));
});
test('regional zoom schedules a nearby request without street-level zoom',async()=>{
    const f=fixture();await f.start();
    f.el('location-categories').children[0].handlers.click();await f.flush();
    const map=f.map();map.zoom=8;map.handlers.moveend();
    const pending=[...f.timers.values()].find(timer=>timer.delay===200);
    assert.ok(pending);pending.fn();await f.flush();
    const request=f.requests.find(request=>request.url.endsWith('/nearby'));
    assert.ok(request);assert.equal(JSON.parse(request.options.body).zoom,8);
});
test('small map moves do not request another circle; category and radius changes do',()=>{
    const f=fixture();
    f.run(`previous={category:'mosque',latitude:35,longitude:51,radius:1000}`);
    assert.equal(f.run(`locationSearchChanged(previous,{...previous,latitude:35.0001})`),false);
    assert.equal(f.run(`locationSearchChanged(previous,{...previous,latitude:35.01})`),true);
    assert.equal(f.run(`locationSearchChanged(previous,{...previous,category:'library'})`),true);
    assert.equal(f.run(`locationSearchChanged(previous,{...previous,radius:500})`),true);
});
test('province view only reads local counts and shows unknown instead of zero',async()=>{
    const f=fixture();await f.start();
    f.el('location-categories').children[0].handlers.click();await f.flush();
    assert.equal(f.requests.some(request=>request.url.endsWith('/nearby')),false);
    assert.equal(f.markers[0].options.icon.html.children[1].textContent,'نامشخص');
    assert.match(f.el('locations-status').textContent,/نامشخص/);
});
test('map events debounce into one live request and stale responses cannot add markers',async()=>{
    const f=fixture();await f.start();
    f.el('location-categories').children[0].handlers.click();await f.flush();
    const map=f.map();map.zoom=15;
    map.handlers.zoomend();map.handlers.moveend();map.handlers.moveend();
    let scheduled=[...f.timers.entries()].filter(([,timer])=>timer.delay===200);
    assert.equal(scheduled.length,1);
    f.timers.delete(scheduled[0][0]);scheduled[0][1].fn();await f.flush();
    const request=f.requests.find(request=>request.url.endsWith('/nearby'));
    assert.equal(request.options.cache,'no-store');assert.equal(request.options.method,'POST');
    assert.equal(JSON.parse(request.options.body).zoom,15);
    map.handlers.movestart();assert.equal(request.options.signal.aborted,true);
    const markerCount=f.markers.length;
    f.resolveNearby({center:{latitude:35,longitude:51},radius_m:1000,places:[{name:'Stale',latitude:35,longitude:51}]});await f.flush();
    f.frames.forEach(fn=>fn());
    assert.equal(f.markers.length,markerCount);
});
test('live points use Neshan icons in batches and hide without discarding on summary zoom',async()=>{
    const f=fixture();await f.start();
    f.el('location-categories').children[0].handlers.click();await f.flush();
    const map=f.map();map.zoom=15;map.handlers.moveend();
    const scheduled=[...f.timers.entries()].find(([,timer])=>timer.delay===200);
    f.timers.delete(scheduled[0]);scheduled[1].fn();await f.flush();
    f.resolveNearby({center:{latitude:35,longitude:51},radius_m:1000,places:Array.from({length:250},(_,i)=>({name:String(i),latitude:35,longitude:51}))});await f.flush();
    assert.equal(f.frames.length,1);
    f.frames.shift()();assert.equal(f.markers.length,51);
    f.frames.shift()();assert.equal(f.markers.length,101);
    f.frames.shift()();assert.equal(f.markers.length,151);
    f.frames.shift()();assert.equal(f.markers.length,201);
    f.frames.shift()();assert.equal(f.markers.length,251);
    assert.equal(f.markers.at(-1).options.icon.iconUrl,'https://static.neshanmap.ir/poi/64/mosque.png');
    assert.equal(f.markers.at(-1).options.title,'249');
    const liveLayer=[...map.layers].find(layer=>layer.items.length===250);
    assert.ok(liveLayer);
    map.zoom=5;map.handlers.moveend();
    assert.equal(liveLayer.items.length,250);
    assert.equal(map.layers.has(liveLayer),false);
    assert.equal([...map.layers].some(layer=>layer.items.length===1),true);
});

test('sign-in return keeps Location Information as an allowed destination',()=>{
    const shared=fs.readFileSync('js/shared.js','utf8');
    const values=new Map();
    const context=vm.createContext({sessionStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},
        SITE:{page:path=>'/html/'+path}});
    vm.runInContext(shared.slice(shared.indexOf('const AUTH_NEXT_KEY'),shared.indexOf('function applyBannerAvatar')),context);
    vm.runInContext(`setAuthNext({page:'locations',search:''}); next=takeAuthNext()`,context);
    assert.equal(vm.runInContext('hrefForAuthNext(next)',context),'/html/locations.html');
    assert.equal(values.size,0);
});

test('next viewport searches after a short interval rather than the old 35-second wait',async()=>{
    const f=fixture();await f.start();
    f.el('location-categories').children[0].handlers.click();await f.flush();
    const map=f.map();map.zoom=15;map.handlers.moveend();
    const scheduled=[...f.timers.entries()].find(([,timer])=>timer.delay===200);
    f.timers.delete(scheduled[0]);scheduled[1].fn();await f.flush();
    f.resolveNearby({center:{latitude:35,longitude:51},radius_m:1000,places:[]});await f.flush();
    f.frames.shift()();
    map.center={lat:35.01,lng:51};map.handlers.moveend();
    const waits=[...f.timers.values()].map(timer=>timer.delay);
    assert.equal(waits.length,1);
    assert.ok(waits[0]>=200 && waits[0]<=1000);
    assert.match(f.el('locations-status').textContent,/در حال جستجو/);
});
test('real Retry-After still delays the next live search',async()=>{
    const f=fixture();await f.start();
    f.el('location-categories').children[0].handlers.click();await f.flush();
    const map=f.map();map.zoom=15;map.handlers.moveend();
    const scheduled=[...f.timers.entries()].find(([,timer])=>timer.delay===200);
    f.timers.delete(scheduled[0]);scheduled[1].fn();await f.flush();
    f.resolveNearbyResponse({status:429,headers:{get:()=> '120'}});await f.flush();
    const waits=[...f.timers.values()].map(timer=>timer.delay);
    assert.equal(waits.length,1);
    assert.ok(waits[0]>119000);
    assert.equal(f.markers.length,1);
});

async function loadPlaces(f,places) {
    const scheduled=[...f.timers.entries()].find(([,timer])=>timer.delay>=200);
    assert.ok(scheduled);f.timers.delete(scheduled[0]);scheduled[1].fn();await f.flush();
    f.resolveNearby({center:{latitude:f.map().center.lat,longitude:f.map().center.lng},radius_m:1000,places});
    await f.flush();while(f.frames.length)f.frames.shift()();
}
async function selectedFixture() {
    const f=fixture();await f.start();
    f.el('location-categories').children[0].handlers.click();await f.flush();
    f.map().center={lat:35,lng:51};f.map().zoom=15;f.map().handlers.moveend();return f;
}
const place=(name,latitude=35,longitude=51)=>({name,latitude,longitude});
test('small movements reuse results; new searches preserve markers and merge duplicates',async()=>{
    const f=await selectedFixture();await loadPlaces(f,[place('A')]);
    const map=f.map(), layer=[...map.layers].find(layer=>layer.items.some(item=>item.options.title==='A'));
    const original=layer.items[0];
    map.center={lat:35.0001,lng:51};map.handlers.moveend();
    assert.equal(f.timers.size,0);assert.equal(layer.items[0],original);
    map.center={lat:35.01,lng:51};map.handlers.moveend();
    assert.equal(layer.items[0],original);
    await loadPlaces(f,[place('A'),place('B',35.01)]);
    assert.equal(layer.items.length,2);assert.equal(layer.items[0],original);
    map.center={lat:35,lng:51};map.handlers.moveend();
    assert.equal(f.timers.size,0);assert.equal(layer.items.length,2);
    map.zoom=16;map.handlers.moveend();
    assert.equal(layer.items.length,2);assert.equal(f.timers.size,1);
});
test('expired and distant points are evicted and expired searches are repeated',async()=>{
    const f=await selectedFixture();await loadPlaces(f,[place('A')]);
    const map=f.map(), layer=[...map.layers].find(layer=>layer.items.some(item=>item.options.title==='A'));
    f.advance(15*60000+1);map.handlers.moveend();
    assert.equal(layer.items.length,0);assert.equal(f.timers.size,1);
    await loadPlaces(f,[place('B')]);
    map.center={lat:36,lng:51};map.handlers.moveend();
    assert.equal(layer.items.length,0);assert.equal(f.timers.size,1);
});
test('marker memory has a fixed cap',async()=>{
    const f=await selectedFixture();
    await loadPlaces(f,Array.from({length:500},(_,i)=>place(String(i))));
    const layer=[...f.map().layers].find(layer=>layer.items.length===500);
    for(let batch=1;batch<=4;batch++) {
        f.map().center={lat:35+batch*.01,lng:51};f.map().handlers.moveend();
        await loadPlaces(f,Array.from({length:500},(_,i)=>place(String(batch*500+i))));
    }
    assert.equal(layer.items.length,2000);
    assert.equal(layer.items.some(item=>item.options.title==='0'),false);
});
test('returning from summary zoom restores markers without requesting the same area',async()=>{
    const f=await selectedFixture();await loadPlaces(f,[place('A')]);
    const map=f.map(), layer=[...map.layers].find(layer=>layer.items.some(item=>item.options.title==='A'));
    map.zoom=5;map.handlers.moveend();assert.equal(map.layers.has(layer),false);
    map.zoom=15;map.handlers.moveend();assert.equal(map.layers.has(layer),true);
    assert.equal(layer.items.length,1);assert.equal(f.timers.size,0);
});

test('search radius covers the visible corners with a margin and stays bounded',()=>{
    const f=fixture();
    f.run(`bounds={getNorthEast:()=>({lat:35.1,lng:51.2}),getSouthWest:()=>({lat:34.9,lng:50.8}),
        getNorthWest:()=>({lat:35.1,lng:50.8}),getSouthEast:()=>({lat:34.9,lng:51.2})}`);
    const plan=f.run(`locationNearbyPlan('mosque',{lat:35,lng:51},15,{min_zoom:8,radius_by_zoom:{15:1000}},bounds)`);
    assert.ok(plan.radius>25000);assert.ok(plan.radius<30000);
    f.run(`bounds.getNorthEast=()=>({lat:40,lng:60})`);
    assert.equal(f.run(`locationNearbyPlan('mosque',{lat:35,lng:51},15,{min_zoom:8,radius_by_zoom:{15:1000}},bounds).radius`),100000);
});
test('city markers survive a short trip outside the city and more than two minutes',async()=>{
    const f=await selectedFixture();await loadPlaces(f,[place('City mosque')]);
    const layer=[...f.map().layers].find(layer=>layer.items.some(item=>item.options.title==='City mosque'));
    f.advance(5*60000);f.map().center={lat:35.2,lng:51};f.map().handlers.moveend();
    assert.equal(layer.items.length,1);
    await loadPlaces(f,[place('Outskirts mosque',35.2)]);
    assert.equal(layer.items.length,2);
});
