const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture() {
    const layers=Array.from({length:31},(_,i)=>({feature:{properties:{ProvincNam:`Province ${i}`}},
        styles:[],tooltips:[],handlers:{},setStyle(style){this.styles.push({...style});return this;},
        setTooltipContent(html){this.tooltips.push(html);},bindTooltip(){},on(type,handler){this.handlers[type]=handler;},bringToFront(){}}));
    const group={eachLayer(fn){layers.forEach(fn);},addTo(){return this;}};
    const context=vm.createContext({WeakMap,Object,console,geojsonLayer:group,loadedGeoJSON:null,map:{},currentIndex:'Topic',
        selectedProvince:null,hoveredStageIndex:null,window:{location:{hash:''}},
        getProvinceScore:(name,topic)=>Number(name.split(' ')[1])+(topic==='Other'?1:0),
        getHeatmapColor:score=>`color-${score}`,atlasLegendStageForScore:score=>Math.floor(score/10),
        updateDefaultPanel(){},refitMapView(){},
        L:{geoJSON(data,options){layers.forEach(layer=>options.onEachFeature(layer.feature,layer));return group;}}});
    const source=fs.readFileSync('js/index.js','utf8');
    vm.runInContext(source.slice(source.indexOf('const atlasLayerStyles'),source.indexOf('function renderTopicDetails')),context);
    const run=code=>vm.runInContext(code,context);
    run('renderMapData({})');
    const counts=()=>({styles:layers.reduce((n,l)=>n+l.styles.length,0),tooltips:layers.reduce((n,l)=>n+l.tooltips.length,0)});
    return {layers,run,counts};
}
test('unchanged updates do not repaint provinces or rewrite tooltips',()=>{
    const f=fixture();
    assert.deepEqual(f.counts(),{styles:31,tooltips:31});
    f.run('updateMapStyles(); updateMapStyles()');
    assert.deepEqual(f.counts(),{styles:31,tooltips:31});
});
test('hover and mouseout update only the affected province',()=>{
    const f=fixture();
    const target=f.layers[5];
    for(let i=0;i<10;i++) {
        target.handlers.mouseover({target});
        target.handlers.mouseout();
    }
    assert.deepEqual(f.counts(),{styles:51,tooltips:31});
    assert.equal(target.styles.at(-1).fillOpacity,.85);
    assert.equal(f.layers[6].styles.length,1);
});
test('province selection repaints only old and new selections and preserves hover restoration',()=>{
    const f=fixture();
    f.run(`selectedProvince='Province 5'; updateMapStyles()`);
    assert.deepEqual(f.counts(),{styles:32,tooltips:31});
    const target=f.layers[5];
    assert.equal(target.styles.at(-1).fillColor,'#e11d48');
    target.handlers.mouseover({target});target.handlers.mouseout();
    assert.equal(target.styles.at(-1).fillOpacity,.9);
    assert.equal(target.styles.at(-1).fillColor,'#e11d48');
    f.run(`selectedProvince='Province 6'; updateMapStyles()`);
    assert.deepEqual(f.counts(),{styles:36,tooltips:31});
    assert.equal(f.layers[5].styles.at(-1).fillColor,'color-5');
    assert.equal(f.layers[6].styles.at(-1).fillColor,'#e11d48');
});
test('topic and legend changes still refresh changed scores and styles',()=>{
    const f=fixture();
    f.run(`currentIndex='Other'; updateMapStyles()`);
    assert.deepEqual(f.counts(),{styles:62,tooltips:62});
    assert.match(f.layers[5].tooltips.at(-1),/6/);
    f.run(`hoveredStageIndex=0; updateMapStyles()`);
    assert.deepEqual(f.counts(),{styles:93,tooltips:62});
    const muted=f.layers[20];
    muted.handlers.mouseover({target:muted});muted.handlers.mouseout();
    assert.equal(muted.styles.at(-1).fillOpacity,.15);
    assert.equal(muted.styles.at(-1).color,'#ccc');
    f.run('hoveredStageIndex=null; updateMapStyles()');
    assert.equal(muted.styles.at(-1).fillOpacity,.85);
});
