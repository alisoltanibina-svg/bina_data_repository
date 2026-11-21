const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture() {
    const elements = new Map();
    const railSections = ['database', 'topic', 'subtopic', 'indicator', 'filter'];
    const events = {};
    const makeElement = () => {
        const classes = new Set();
        const node = {hidden:false, disabled:false, textContent:'', attributes:{}, children:[], style:{}, dataset:{}, events:{},
            classList:{add(value){classes.add(value);},remove(value){classes.delete(value);}, contains(value){return classes.has(value);},
                toggle(value,on){if(on) classes.add(value); else classes.delete(value);}},
            setAttribute(name,value){this.attributes[name]=value;}, querySelector(){return null;},
            replaceChildren(...children){this.children=children;}, append(...children){this.children.push(...children);},
            appendChild(child){this.children.push(child);}, addEventListener(type,fn){this.events[type]=fn;},
            focus(){this.focused=true;}, click(){this.events.click?.({});}};
        return node;
    };
    const element = id => {
        if (!elements.has(id)) elements.set(id,makeElement());
        return elements.get(id);
    };
    for (const section of railSections) {
        element(`dd-${section}-btn`).dataset.explorerSection=section;
        element(`dd-${section}-menu`).hidden=true;
    }
    element('explorer-selection-panel').hidden=true;
    const context = vm.createContext({console, Intl, URLSearchParams, Map, Set, Number,
        window:{API_BASE_URL:'', clearInterval(){}, addEventListener(){}},
        document:{getElementById:element, querySelector:element,
            querySelectorAll(selector){return selector==='[data-explorer-section]' ? railSections.map(section=>element(`dd-${section}-btn`)) : [];},
            createElement:makeElement, createTextNode(text){return {textContent:text};}, addEventListener(type,fn){events[type]=fn;}},
        onReady(){}, debounce:fn=>fn, toFa:String, requestAnimationFrame(fn){fn();}, cancelAnimationFrame(){}});
    vm.runInContext(fs.readFileSync('js/explorer.js','utf8'), context);
    return {context, element, events, run:code=>vm.runInContext(code,context)};
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

test('rail opens a single adjacent panel, switches content, and toggles closed', () => {
    const f=fixture();
    f.run(`bindExplorerDropdowns()`);
    f.element('dd-topic-btn').click();
    assert.equal(f.element('explorer-selection-panel').hidden,false);
    assert.equal(f.element('dd-topic-menu').hidden,false);
    assert.equal(f.element('dd-topic-btn').attributes['aria-expanded'],'true');
    f.element('dd-database-btn').click();
    assert.equal(f.element('dd-topic-menu').hidden,true);
    assert.equal(f.element('dd-database-menu').hidden,false);
    assert.equal(f.element('explorer-selection-title').textContent,'دیتابیس');
    f.element('dd-database-btn').click();
    assert.equal(f.element('explorer-selection-panel').hidden,true);
    assert.equal(f.element('view-dashboard').classList.contains('has-selection-panel'),false);
    for(const section of ['database','topic','subtopic','indicator','filter']) {
        assert.equal(f.element(`dd-${section}-btn`).hidden,false);
        assert.equal(f.element(`dd-${section}-btn`).attributes['aria-expanded'],'false');
    }
});
test('close button and Escape restore focus to the selected rail item', () => {
    const f=fixture();
    f.run(`bindExplorerDropdowns(); setExplorerSection('topic')`);
    f.element('btn-close-selection-panel').click();
    assert.equal(f.element('explorer-selection-panel').hidden,true);
    assert.equal(f.element('dd-topic-btn').focused,true);
    f.run(`setExplorerSection('database')`);
    let prevented=false;
    f.events.keydown({key:'Escape', preventDefault(){prevented=true;}});
    assert.equal(prevented,true);
    assert.equal(f.element('explorer-selection-panel').hidden,true);
    assert.equal(f.element('dd-database-btn').focused,true);
});
test('module entry keeps the panel closed and topic selection opens its subject list', () => {
    const f=fixture();
    f.run(`explorerModules=[{module_name:'Monitor',active:true,hierarchy:{Domain:{Subject:['Example']}}}]; enterExplorerModule(explorerModules[0]);`);
    assert.equal(f.element('explorer-selection-panel').hidden,true);
    assert.equal(f.element('canvas-reveal-wrapper').hidden,true);
    assert.equal(f.element('dd-subtopic-btn').disabled,false);
    assert.equal(f.element('dd-filter-btn').disabled,false);
    f.run(`openTopicIndex('Domain')`);
    assert.equal(f.element('dd-subtopic-menu').hidden,false);
    assert.equal(f.element('explorer-selection-context').textContent,'Domain');
    assert.equal(f.element('canvas-reveal-wrapper').hidden,true);
    assert.equal(f.run('activeIndicatorGlob'),null);
    assert.equal(f.element('dd-subtopic-menu').children[0].textContent,'Subject');
});
test('disabled sections do not replace the current panel', () => {
    const f=fixture();
    f.run(`setExplorerSection('topic')`);
    f.element('dd-filter-btn').disabled=true;
    f.run(`setExplorerSection('filter')`);
    assert.equal(f.run('explorerOpenSection'),'topic');
    assert.equal(f.element('dd-topic-menu').hidden,false);
});
test('database panel keeps future modules disabled and identifies current selection', () => {
    const f=fixture();
    f.run(`explorerModules=[{module_name:'Monitor',active:true},{module_name:'Future',active:false}]; activeExplorerModule=explorerModules[0]; renderExplorerModuleOptions();`);
    const options=f.element('explorer-module-options').children;
    assert.equal(options[0].attributes['aria-pressed'],'true');
    assert.equal(options[1].disabled,true);
});
test('Metadata renders plain values for the labeled facts layout', () => {
    const f=fixture();
    f.run(`renderIndicatorDescription({measurement_unit:'Percent',source_name:'Source',question:'Question',description:'Description'})`);
    assert.equal(f.element('indicator-unit').textContent,'Percent');
    assert.equal(f.element('indicator-source').textContent,'Source');
    assert.equal(f.element('indicator-question').hidden,false);
    f.run(`renderIndicatorDescription({})`);
    assert.equal(f.element('indicator-question').hidden,true);
});

test('all rail sections can open before selection and explain prerequisites', () => {
    const f=fixture();
    f.run(`syncExplorerDropdowns(); bindExplorerDropdowns()`);
    for (const section of ['database','topic','subtopic','indicator','filter']) {
        f.element(`dd-${section}-btn`).click();
        assert.equal(f.element('explorer-selection-panel').hidden,false);
        assert.equal(f.element(`dd-${section}-menu`).hidden,false);
    }
    assert.match(f.element('dd-subtopic-menu').children[0].textContent,/ابتدا حوزه/);
    assert.match(f.element('dd-indicator-menu').children[0].textContent,/ابتدا حوزه و موضوع/);
    assert.match(f.element('dimension-filters').children[0].textContent,/پس از انتخاب/);
    assert.equal(f.run('activeIndicatorGlob'),null);
});

test('filter bulk actions update checkboxes and data without changing other dimensions or closing the panel', () => {
    const f=fixture();
    f.run(`explorerRawScores=[1,2].map(sex=>({year:1400,value:sex*10,province_name:'Tehran',series_id:'sex'+sex,series_label:'Tehran / '+sex,dim_cat_values:{province:'2',sex:String(sex)}}));
        explorerFilters=[{name:'sex',values:[{value:'1',label:'Male'},{value:'2',label:'Female'}]}, {name:'province',values:[{value:'2',label:'Tehran'}]}];
        explorerFilterSelection={sex:new Set(['1']),province:new Set(['2'])};
        renderDimensionFilters(); setExplorerSection('filter');`);
    const group=f.element('dimension-filters').children[0];
    const actions=group.children[1].children;
    const inputs=group.children.slice(2).map(label=>label.children[0]);
    assert.equal(actions[0].textContent,'انتخاب همه');
    assert.equal(actions[1].textContent,'پاک کردن همه');
    actions[0].click();
    assert.deepEqual(inputs.map(input=>input.checked),[true,true]);
    assert.equal(f.run('kscoreData.length'),2);
    actions[1].click();
    assert.deepEqual(inputs.map(input=>input.checked),[false,false]);
    assert.equal(f.run('kscoreData.length'),0);
    assert.equal(f.run(`explorerFilterSelection.province.has('2')`),true);
    assert.equal(f.element('explorer-selection-panel').hidden,false);
    actions[0].click();
    assert.equal(f.run('kscoreData.length'),2);
});
