const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {hidden:false, textContent:'', classList:{toggle(){},add(){},remove(){}},
            setAttribute(){}, querySelector(){return null;}, replaceChildren(){}});
        return elements.get(id);
    };
    const context = vm.createContext({console, Intl, URLSearchParams, Map, Set, Number,
        window:{API_BASE_URL:'', clearInterval(){}, addEventListener(){}},
        document:{getElementById:element, querySelector:element, querySelectorAll(){return [];}},
        onReady(){}, debounce:fn=>fn, toFa:String, requestAnimationFrame(){}, cancelAnimationFrame(){}});
    vm.runInContext(fs.readFileSync('js/explorer.js','utf8'), context);
    return {context, element, run:code=>vm.runInContext(code,context)};
}
test('chart waits for domain, subject, and successful score load', () => {
    const f=fixture();
    f.run(`syncExplorerVisibility()`);
    assert.equal(f.element('canvas-reveal-wrapper').hidden,true);
    f.run(`activeTopicGlob='Domain'; syncExplorerVisibility()`);
    assert.equal(f.element('canvas-reveal-wrapper').hidden,true);
    f.run(`activeSubtopicGlob='Subject'; activeIndicatorGlob='Indicator'; explorerLoadState='loading'; syncExplorerVisibility()`);
    assert.equal(f.element('canvas-reveal-wrapper').hidden,true);
    f.run(`explorerLoadState='ready'; syncExplorerVisibility()`);
    assert.equal(f.element('canvas-reveal-wrapper').hidden,false);
    f.run(`explorerTab='metadata'; syncExplorerVisibility()`);
    assert.equal(f.element('canvas-reveal-wrapper').hidden,true);
    assert.equal(f.element('insight-layer').hidden,false);
});
test('multiple dimension combinations remain separate and checkbox filtering is exact', () => {
    const f=fixture();
    f.run(`explorerRawScores=[1,2].map(sex=>({year:1400,value:sex*10,province_name:'Tehran',series_id:'sex'+sex,series_label:'Tehran / '+sex,dim_cat_values:{province:'2',sex:String(sex)}}));
        explorerFilters=[{name:'sex'}]; explorerFilterSelection={sex:new Set(['1','2'])}; applyDimensionFilters(false);`);
    assert.equal(f.run('provincesList.length'),2);
    f.run(`explorerFilterSelection.sex.delete('2'); applyDimensionFilters(false)`);
    assert.equal(f.run('kscoreData.length'),1);
    assert.equal(f.run('getChartSeries(provincesList[0])[0]'),10);
    f.run(`explorerFilterSelection.sex.clear(); applyDimensionFilters(false)`);
    assert.equal(f.run('kscoreData.length'),0);
});
test('map refuses multiple breakdowns per province and non-geographic indicators', () => {
    const f=fixture();
    f.run(`explorerFilters=[{name:'province'}]; kscoreData=[1,2].map(value=>({year:1400,value,geographic_province:'Tehran'})); renderExplorerMap()`);
    assert.equal(f.element('explorer-leaflet-map').hidden,true);
    assert.match(f.element('explorer-map-status').textContent,/فقط یک مقدار/);
    f.run(`explorerFilters=[{name:'sex'}]; kscoreData=[]; renderExplorerMap()`);
    assert.match(f.element('explorer-map-status').textContent,/استانی/);
});
test('missing scores stay missing', () => {
    const f=fixture();
    f.run(`currentChartYears=[1400]; kscoreData=[{province_name:'A',year:1400,value:null}]`);
    assert.equal(f.run(`getChartSeries('A')[0]`),null);
});
