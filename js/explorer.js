// File: explorer.js
// Purpose: JavaScript for the Explorer (landing & subtopics) page.
//   Provides UI logic for the staggered mosaic landing, subtopic cards, indicator charts,
//   lazy-loading of large background images, and search suggestions.
// Notes: Comments standardized to English; Persian UI strings are not modified.

// Format scores consistently; years keep their ungrouped calendar labels.
const explorerNumberFormatter = new Intl.NumberFormat('en-US', {
    useGrouping: true,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
});
const explorerLabelCollator = new Intl.Collator('fa', { sensitivity: 'base', numeric: true });

function formatExplorerNumber(value) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '';
    // Normalize rounded negative zero before adding grouping and Persian digits.
    const rounded = Number(Number(value).toFixed(2));
    return toFa(explorerNumberFormatter.format(rounded === 0 ? 0 : rounded));
}

// -- Explorer page initialization --
function registerExplorerChartPlugin() {
    if (typeof Chart === 'undefined' || registerExplorerChartPlugin._done) return;
    registerExplorerChartPlugin._done = true;
    Chart.Interaction.modes.explorerLine = explorerLineHover;
    Chart.Tooltip.positioners.explorerLine = (_items, position) => position;
    Chart.register({
    id: 'lineSweepPlugin',
    beforeDatasetDraw(chart, args) {
        const ds = chart.data.datasets[args.index];
        if (ds.sweepProgress !== undefined && ds.sweepProgress < 1) {
            const ctx = chart.ctx;
            const { top, left, width, height } = chart.chartArea;
            ctx.save();
            ctx.beginPath();
            ctx.rect(left - 12, top - 20, width * ds.sweepProgress + 12, height + 40);
            ctx.clip();
        }
    },
    afterDatasetDraw(chart, args) {
        const ds = chart.data.datasets[args.index];
        if (ds.sweepProgress !== undefined && ds.sweepProgress < 1) {
            chart.ctx.restore();
        }
    }
    });
}

function explorerLineHover(chart, event) {
    const {x, y} = event;
    const area = chart.chartArea;
    if (x < area.left || x > area.right || y < area.top || y > area.bottom) return [];
    let closest = null;
    let distance = 10;
    for (const meta of chart.getSortedVisibleDatasetMetas()) {
        const dataset = chart.data.datasets[meta.index];
        if (dataset.sweepProgress != null && dataset.sweepProgress < 1 &&
            x > area.left + area.width * dataset.sweepProgress) continue;
        const interpolated = meta.dataset.interpolate({x}, 'x');
        for (const point of (Array.isArray(interpolated) ? interpolated : [interpolated])) {
            if (!point || !Number.isFinite(point.y) || Math.abs(point.y - y) > distance) continue;
            let index = -1;
            let nearestX = Infinity;
            meta.data.forEach((element, i) => {
                if (!element.skip && Math.abs(element.x - x) < nearestX) {
                    nearestX = Math.abs(element.x - x);
                    index = i;
                }
            });
            if (index < 0) continue;
            distance = Math.abs(point.y - y);
            closest = {element: meta.data[index], datasetIndex: meta.index, index};
        }
    }
    return closest ? [closest] : [];
}

let sweepReq = null;
let sweepStartTime = null;

function startSweep(chart) {
    if (sweepReq !== null) cancelAnimationFrame(sweepReq);
    sweepReq = null;
    sweepStartTime = null;
    
    let datasetsToSweep = chart.data.datasets.filter(ds => ds.sweepProgress !== undefined && ds.sweepProgress < 1);
    if(datasetsToSweep.length === 0) return;
    const startingProgress = new Map(datasetsToSweep.map(ds => [ds, ds.sweepProgress]));
    
    function animate(timestamp) {
        sweepReq = null;
        if (chart !== chartInstance) return;
        if (sweepStartTime === null) sweepStartTime = timestamp;
        let progress = (timestamp - sweepStartTime) / 1500; 
        
        if (progress >= 1) {
            datasetsToSweep.forEach(ds => ds.sweepProgress = 1);
            chart.draw();
            return;
        }
        
        let curvedProgress = 1 - Math.pow(1 - progress, 3); 
        datasetsToSweep.forEach(ds => {
            const initial = startingProgress.get(ds);
            ds.sweepProgress = initial + (1 - initial) * curvedProgress;
        });
        chart.draw();
        sweepReq = requestAnimationFrame(animate);
    }
    sweepReq = requestAnimationFrame(animate);
}

let explorerModules = [];
let activeExplorerModule = null;
let explorerRawScores = [];
let explorerFilters = [];
let explorerFilterSelection = {};
let explorerFilterInputs = [];
let explorerTab = 'chart';
let explorerChartType = 'trend';
let explorerLoadState = 'idle';
let explorerOpenSection = null;
let kscoreData = [];
let topicsColorData = []; 
let topicsHierarchy = {};

let activeDatasets = []; 
let provincesList = [];
let chartInstance = null;
let scatterProvinceChart = null;
let activeIndicatorGlob = null;
let explorerIndicatorRequest = 0;
let activeTopicGlob = null;
let activeSubtopicGlob = null;
let currentChartYears = [];
let currentChartMode = 'trend';
let latestYearGlob = null;
let latestScoresGlob = [];
let explorerMapGeoJson = null;
let explorerMapLoadPromise = null;
let explorerMapYearIndex = 0;
let explorerCompareYearIndex = 0;
let explorerMapPlaybackTimer = null;
let explorerLeafletMap = null;
let explorerMapInitPromise = null;
let explorerMapSdkPromise = null;
let explorerMapLoaded = false;
let explorerMapGeoLayer = null;
let explorerMapLabelsLayer = null;
let explorerMapFitted = false;
let explorerMapViewportSize = "";
let explorerSelectedProvince = null;
const EXPLORER_LEGEND_STAGES = 8;
let explorerHoveredLegendStage = null;
let explorerMapScores = new Map();
let explorerMapScoreMin = 0, explorerMapScoreMax = 1;
let explorerMapBounds = null;

let isBulkAction = true; 
let hiddenDatasets = {};

const provinceColorPalette = [
    '#e6194B', '#f59e0B', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', 
    '#d946ef', '#06b6d4', '#14b8a6', '#84cc16', '#eab308', '#f97316', '#ef4444',
    '#6366f1', '#a855f7', '#0ea5e9', '#059669', '#65a30d', '#ca8a04', '#ea580c',
    '#dc2626', '#4f46e5', '#9333ea', '#0284c7', '#0d9488', '#4d7c0f', '#b45309',
    '#c2410c', '#b91c1c', '#4338ca', '#7e22ce'
];
let provinceColors = {};

const API_BASE_URL = window.API_BASE_URL;

async function loadExplorerData() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await dashboardFetch(`${API_BASE_URL}/api/explorer/init`, { credentials: 'include', signal: controller.signal });
        if (response.status === 401 || response.status === 403) {
            setAuthNext({ page: 'explorer', search: window.location.search || '' });
            window.location.replace(authLoginUrl());
            return;
        }
        const data = await response.json();

        if (!response.ok) throw new Error(data.detail || "Explorer unavailable");
        explorerModules = data.modules || [];
        topicsColorData = data.colors;
        topicsHierarchy = data.hierarchy;
        provincesList = data.provinces;

        provincesList.forEach((prov, i) => {
            provinceColors[prov] = provinceColorPalette[i % provinceColorPalette.length];
        });
        activeDatasets = [];

        renderMosaicMenu();
        renderProvincesList();

        const urlParams = new URLSearchParams(window.location.search);
        const queryIndicator = urlParams.get('indicator');
        const queryTopic = urlParams.get('topic');
        const querySource = urlParams.get('source');
        const queryOpenTopic = urlParams.get('openTopic');
        if (urlParams.get('module') === 'locations') {
            const locations = explorerModules.find(module => module.kind === 'locations' && module.active);
            if (locations) { enterExplorerModule(locations); return; }
        }

        if (queryIndicator && queryTopic) {
            const module = explorerModules.find(m => m.active && m.kind !== 'locations');
            if (module) enterExplorerModule(module, {autoSelect: false});
            if (querySource === 'search') {
                const navSubtopicsBtn = document.getElementById('btn-nav-subtopics');
                if (navSubtopicsBtn) navSubtopicsBtn.style.display = 'none';
            }
            setTimeout(() => loadIndicator(queryIndicator, queryTopic), 50);
        } else if (queryOpenTopic) {
            const module = explorerModules.find(m => m.active && m.kind !== 'locations');
            if (module) enterExplorerModule(module, {autoSelect: false});
            openTopicIndex(queryOpenTopic);
        }

    } catch (err) {
        console.error("Error Loading API Data", err);
        document.getElementById('mosaic-menu').textContent = 'دریافت ماژول‌ها انجام نشد. صفحه را دوباره بارگذاری کنید.';
        showNotice("مشکل در ارتباط با سرور.");
    } finally {
        clearTimeout(timeout);
    }
}

function topicAccent(topic) {
    const row = topicsColorData.find(t => t.topic_name === topic);
    return (row && (row.master_color || row.upper_color)) || '#0078d7';
}

function applyExplorerTheme(topic) {
    if (!topic) return;
    const accent = topicAccent(topic);
    setTopicChrome(accent);
    try {
        sessionStorage.setItem('themeTopicAccent', accent);
    } catch (e) {}
}

function countTopicIndicators(topic) {
    return Object.values(topicsHierarchy[topic] || {}).reduce((n, list) => n + (list ? list.length : 0), 0);
}

let mosaicAnimCtx = null;
let mosaicRenderGen = 0;
let mosaicLayoutKey = '';

function mosaicTopics() {
    return Object.keys(topicsHierarchy).filter(topic => {
        const subs = topicsHierarchy[topic];
        return subs && Object.keys(subs).length > 0;
    });
}

function explorerTopicsInAtlasOrder() {
    // Both Atlas topics and Explorer colors arrive in topics.id order.
    const remaining = new Set(mosaicTopics());
    const ordered = [];
    topicsColorData.forEach(row => {
        if (remaining.delete(row.topic_name)) ordered.push(row.topic_name);
    });
    return ordered.concat([...remaining]);
}

function topicTileSrc(topic) {
    return encodeURI(SITE.asset(`images/${topic}-tile.webp`));
}

function mosaicLayout() {
    const n = mosaicTopics().length || 9;
    const w = window.innerWidth;
    if (w < 768) {
        if (n % 3 === 0) return { cols: 3 };
        return { cols: 2 };
    }
    if (w < 980) return { cols: 2 };
    if (n % 4 === 0) return { cols: 4 };
    if (n % 3 === 0) return { cols: 3 };
    return { cols: 4 };
}

function firstTopicIndicator(topic) {
    const subs = topicsHierarchy[topic] || {};
    for (const list of Object.values(subs)) {
        if (list && list.length) return list[0];
    }
    return null;
}

function subtopicsOf(topic) {
    return Object.keys(topicsHierarchy[topic] || {}).sort(explorerLabelCollator.compare);
}

function indicatorsOf(topic, subtopic) {
    const list = (topicsHierarchy[topic] || {})[subtopic];
    return Array.isArray(list) ? [...list].sort(explorerLabelCollator.compare) : [];
}

function findSubtopicForIndicator(topic, indicator) {
    const subs = topicsHierarchy[topic] || {};
    for (const [sub, list] of Object.entries(subs)) {
        if (list && list.indexOf(indicator) !== -1) return sub;
    }
    return subtopicsOf(topic)[0] || '';
}

const explorerSectionTitles = {database: 'دیتابیس', topic: 'حوزه', subtopic: 'موضوع', indicator: 'شاخص', filter: 'فیلتر'};

function syncExplorerGuide() {
    const guide = document.getElementById('explorer-rail-guide');
    const target = explorerLoadState === 'empty' ? null : !activeTopicGlob ? 'topic' : !activeSubtopicGlob ? 'subtopic' : null;
    guide.hidden = !target;
    guide.dataset.target = target || '';
    if (!target) return;
    const button = document.getElementById(`dd-${target}-btn`);
    const dashboard = document.getElementById('view-dashboard');
    if (typeof button.getBoundingClientRect === 'function') {
        const buttonBox = button.getBoundingClientRect();
        const dashboardBox = dashboard.getBoundingClientRect();
        if (dashboard.classList.contains('ex-monitor-layout')) {
            guide.style.left = `${buttonBox.left - dashboardBox.left + buttonBox.width / 2 - 18}px`;
            guide.style.top = `${buttonBox.bottom - dashboardBox.top + 24}px`;
            return;
        }
        if (buttonBox.height > 0) guide.style.top = `${buttonBox.top - dashboardBox.top + buttonBox.height / 2}px`;
    }
}

function resizeExplorerViews() {
    requestAnimationFrame(() => {
        syncExplorerGuide();
        if (chartInstance) chartInstance.resize();
        if (scatterProvinceChart) scatterProvinceChart.resize();
        if (currentChartMode === 'map' && explorerLeafletMap) syncExplorerMapViewport(true);
    });
}

function closeExplorerDropdowns(restoreFocus = false) {
    const previous = explorerOpenSection;
    explorerOpenSection = null;
    document.getElementById('explorer-selection-panel').hidden = true;
    document.getElementById('view-dashboard').classList.remove('has-selection-panel');
    document.querySelectorAll('[data-explorer-section]').forEach(button => {
        button.classList.remove('is-active');
        button.setAttribute('aria-expanded', 'false');
    });
    Object.keys(explorerSectionTitles).forEach(section => {
        document.getElementById(`dd-${section}-menu`).hidden = section !== 'filter' ||
            !document.getElementById('view-dashboard').classList.contains('ex-monitor-layout');
    });
    if (restoreFocus && previous) document.getElementById(`dd-${previous}-btn`).focus();
    resizeExplorerViews();
}

function updateExplorerPanelHeading() {
    if (!explorerOpenSection) return;
    document.getElementById('explorer-selection-title').textContent = explorerSectionTitles[explorerOpenSection];
    const context = {database: activeExplorerModule && activeExplorerModule.module_name,
        topic: activeExplorerModule && activeExplorerModule.module_name,
        subtopic: activeTopicGlob, indicator: activeSubtopicGlob, filter: activeIndicatorGlob};
    document.getElementById('explorer-selection-context').textContent = context[explorerOpenSection] || '';
}

function setExplorerSection(section) {
    if (!Object.hasOwn(explorerSectionTitles, section)) return;
    const button = document.getElementById(`dd-${section}-btn`);
    if (button.disabled) return;
    if (section === 'filter' && document.getElementById('view-dashboard').classList.contains('ex-monitor-layout')) {
        closeExplorerDropdowns();
        document.getElementById('explorer-filters-title').focus({preventScroll: true});
        return;
    }
    const alreadyOpen = explorerOpenSection === section;
    closeExplorerDropdowns();
    if (alreadyOpen) return;
    explorerOpenSection = section;
    document.getElementById('explorer-selection-panel').hidden = false;
    document.getElementById('view-dashboard').classList.add('has-selection-panel');
    button.classList.add('is-active');
    button.setAttribute('aria-expanded', 'true');
    document.getElementById(`dd-${section}-menu`).hidden = false;
    const dashboard = document.getElementById('view-dashboard');
    if (dashboard.classList.contains('ex-monitor-layout') && typeof button.getBoundingClientRect === 'function') {
        const box = button.getBoundingClientRect(), desk = dashboard.getBoundingClientRect();
        const panel = document.getElementById('explorer-selection-panel');
        const width = Math.min(360, Math.max(0, desk.width - 24));
        panel.style.left = `${Math.max(12, Math.min(box.left - desk.left, desk.width - width - 12))}px`;
        panel.style.top = `${box.bottom - desk.top + 8}px`;
    }
    updateExplorerPanelHeading();
    document.getElementById('explorer-selection-title').focus({preventScroll: true});
    resizeExplorerViews();
}

function renderExplorerModuleOptions() {
    const root = document.getElementById('explorer-module-options');
    root.replaceChildren();
    explorerModules.forEach(module => {
        const button = document.createElement('button');
        button.type = 'button';
        button.disabled = !module.active;
        button.className = 'ex-module-option';
        const current = activeExplorerModule && activeExplorerModule.module_name === module.module_name;
        button.classList.toggle('is-current', !!current);
        button.setAttribute('aria-pressed', String(!!current));
        const label = document.createElement('span');
        label.textContent = module.module_name;
        const description = document.createElement('small');
        description.textContent = module.active ? (module.description || '') : 'به‌زودی';
        button.append(label, description);
        button.addEventListener('click', () => enterExplorerModule(module));
        root.append(button);
    });
}

function fillDropdownMenu(menu, items, current, onPick, emptyMessage = 'گزینه‌ای برای نمایش وجود ندارد.', iconForItem = null) {
    if (!menu) return;
    menu.replaceChildren();
    if (!items.length) {
        const hint = document.createElement('p');
        hint.className = 'ex-selection-empty';
        hint.textContent = emptyMessage;
        menu.appendChild(hint);
        return;
    }
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item;
        btn.classList.toggle('is-current', item === current);
        btn.setAttribute('aria-pressed', String(item === current));
        if (iconForItem) {
            const icon = document.createElement('img');
            icon.className = 'ex-dd-topic-icon';
            icon.src = iconForItem(item);
            icon.alt = ''; icon.width = 24; icon.height = 24; icon.decoding = 'async';
            icon.addEventListener('error', () => { icon.hidden = true; });
            const label = document.createElement('span');
            label.className = 'ex-dd-topic-label'; label.textContent = item;
            btn.classList.add('ex-dd-topic-item');
            btn.replaceChildren(icon, label);
        }
        btn.addEventListener('click', () => {
            closeExplorerDropdowns(true);
            onPick(item);
        });
        menu.appendChild(btn);
    });
}

function syncExplorerDropdowns() {
    document.getElementById('dd-topic-value').textContent = activeTopicGlob || 'انتخاب حوزه';
    document.getElementById('dd-subtopic-value').textContent = activeSubtopicGlob || 'انتخاب موضوع';
    document.getElementById('dd-indicator-value').textContent = activeIndicatorGlob || 'انتخاب خودکار';
    fillDropdownMenu(document.getElementById('dd-topic-menu'), explorerTopicsInAtlasOrder(), activeTopicGlob, openTopicIndex,
        undefined, item => encodeURI(SITE.asset(`images/تاپیک ${item}-active.webp`)));
    fillDropdownMenu(document.getElementById('dd-subtopic-menu'), subtopicsOf(activeTopicGlob), activeSubtopicGlob, sub => {
        activeSubtopicGlob = sub;
        const first = indicatorsOf(activeTopicGlob, sub)[0];
        if (first) loadIndicator(first, activeTopicGlob);
    }, activeTopicGlob ? 'موضوعی برای این حوزه ثبت نشده است.' : 'ابتدا حوزهٔ مورد نظر خود را انتخاب کنید.');
    fillDropdownMenu(document.getElementById('dd-indicator-menu'), indicatorsOf(activeTopicGlob, activeSubtopicGlob), activeIndicatorGlob,
        name => loadIndicator(name, activeTopicGlob), activeSubtopicGlob ? 'شاخصی برای این موضوع ثبت نشده است.' : 'ابتدا حوزه و موضوع مورد نظر خود را انتخاب کنید.');
    if (explorerLoadState !== 'ready' || !explorerFilters.length) {
        const filters = document.getElementById('dimension-filters');
        filters.replaceChildren();
        const hint = document.createElement('p');
        hint.className = 'ex-selection-empty';
        hint.textContent = explorerLoadState === 'ready' ? 'برای این شاخص فیلتری ثبت نشده است.' :
            explorerLoadState === 'loading' ? 'در حال بارگذاری فیلترها…' : 'فیلتری برای نمایش وجود ندارد.';
        filters.appendChild(hint);
    }
    updateExplorerPanelHeading();
}

function bindExplorerDropdowns() {
    document.querySelectorAll('[data-explorer-section]').forEach(button => {
        button.addEventListener('click', () => setExplorerSection(button.dataset.explorerSection));
    });
    document.getElementById('btn-close-selection-panel').addEventListener('click', () => closeExplorerDropdowns(true));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && explorerOpenSection) {
            event.preventDefault();
            closeExplorerDropdowns(true);
        }
    });
}

function resetExplorerSelection() {
    closeExplorerDropdowns();
    ++explorerIndicatorRequest;
    stopExplorerMapPlayback();
    if (chartInstance) chartInstance.destroy();
    if (scatterProvinceChart) scatterProvinceChart.destroy();
    chartInstance = scatterProvinceChart = null;
    activeIndicatorGlob = activeSubtopicGlob = null;
    explorerRawScores = kscoreData = [];
    currentChartYears = [];
    explorerFilters = [];
    explorerLoadState = 'idle';
    document.getElementById('dimension-filters').replaceChildren();
    explorerFilterInputs = [];
    syncExplorerDropdowns();
    syncExplorerVisibility();
}

function selectDefaultExplorerIndicator(topics) {
    for (const topic of topics) {
        for (const subtopic of subtopicsOf(topic)) {
            const first = indicatorsOf(topic, subtopic)[0];
            if (!first) continue;
            activeTopicGlob = topic;
            activeSubtopicGlob = subtopic;
            loadIndicator(first, topic);
            return true;
        }
    }
    explorerLoadState = 'empty';
    syncExplorerDropdowns(); syncExplorerVisibility();
    return false;
}

function enterExplorerModule(module, {autoSelect = true} = {}) {
    if (!module.active) return;
    if (module.kind === 'locations') { window.location.assign(SITE.page('locations.html')); return; }
    activeExplorerModule = module;
    topicsHierarchy = module.hierarchy;
    activeTopicGlob = null;
    resetExplorerSelection();
    document.getElementById('view-landing').style.display = 'none';
    document.getElementById('view-dashboard').classList.remove('hidden');
    renderExplorerModuleOptions();
    if (autoSelect) selectDefaultExplorerIndicator(explorerTopicsInAtlasOrder());
    document.getElementById('dd-topic-btn').focus({preventScroll: true});
}

function openTopicIndex(topic) {
    if (!topic || !topicsHierarchy[topic]) return;
    activeTopicGlob = topic;
    resetExplorerSelection();
    selectDefaultExplorerIndicator([topic]);
}

function syncExplorerVisibility() {
    const ready = !!(activeTopicGlob && activeSubtopicGlob && activeIndicatorGlob && explorerLoadState === 'ready');
    document.getElementById('explorer-selection-prompt').hidden = ready;
    document.getElementById('explorer-selection-prompt').textContent = explorerLoadState === 'loading' ? 'در حال بارگذاری داده‌ها…' :
        explorerLoadState === 'error' ? 'دریافت داده‌ها انجام نشد؛ شاخص را دوباره انتخاب کنید.' :
        explorerLoadState === 'empty' ? 'برای این بخش شاخصی ثبت نشده است.' :
        !activeTopicGlob ? 'لطفاً حوزه و موضوع مورد نظر خود را انتخاب کنید' : 'لطفاً موضوع مورد نظر خود را انتخاب کنید';
    const monitorLayout = document.getElementById('view-dashboard').classList.contains('ex-monitor-layout');
    document.getElementById('canvas-reveal-wrapper').hidden = !ready || (!monitorLayout && explorerTab === 'metadata');
    document.getElementById('insight-layer').hidden = !ready || (!monitorLayout && explorerTab !== 'metadata');
    const metadataPlaceholder = document.getElementById('explorer-metadata-placeholder');
    if (metadataPlaceholder) {
        metadataPlaceholder.hidden = ready;
        metadataPlaceholder.textContent = explorerLoadState === 'loading' ? 'در حال بارگذاری فراداده…' : 'فراداده‌ای برای نمایش وجود ندارد.';
    }
    document.querySelector('.ex-chart-foot').hidden = !ready || explorerTab !== 'chart';
    document.getElementById('btn-toggle-chart-type').hidden = monitorLayout || !ready || explorerTab !== 'chart';
    document.getElementById('chart-panel-title').hidden = !ready;
    syncExplorerGuide();
}

function isLandingVisible() {
    const el = document.getElementById('view-landing');
    return !!(el && el.style.display !== 'none' && !el.classList.contains('hidden'));
}

function killMosaicAnimations() {
    if (typeof gsap === 'undefined') return;
    if (mosaicAnimCtx) {
        mosaicAnimCtx.revert();
        mosaicAnimCtx = null;
    }
    if (typeof ScrollTrigger !== 'undefined') {
        ScrollTrigger.getAll().forEach(st => {
            const trigger = st.trigger;
            if (trigger && trigger.closest && trigger.closest('#mosaic-menu')) st.kill();
        });
    }
}

function waitForMosaicImages(root) {
    const urls = new Set();
    root.querySelectorAll('.ex-room-photo, .ex-room-visual').forEach(el => {
        const bg = el.style.backgroundImage;
        const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1]) urls.add(m[1]);
    });
    if (urls.size === 0) return Promise.resolve();
    return Promise.all([...urls].map(src => new Promise(resolve => {
        const im = new Image();
        im.onload = im.onerror = () => resolve();
        im.src = src;
    })));
}

function topicFlipHtml(topic, index, cols) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const tone = (row + col) % 2 === 0 ? 'gold' : 'olive';
    const n = countTopicIndicators(topic);
    return `
        <article class="ex-room" data-col="${col}" data-tone="${tone}" data-topic="${escapeHtml(topic)}">
            <button type="button" class="ex-room-face">
                <div class="ex-room-visual">
                    <div class="ex-room-photo"></div>
                    <div class="ex-room-copy">
                        <h2>${escapeHtml(topic)}</h2>
                        <p class="ex-room-count">${toFa(n)} شاخص</p>
                    </div>
                </div>
            </button>
        </article>
    `;
}

function bindMosaicInteractions(container) {
    container.querySelectorAll('.ex-room').forEach(card => {
        const topic = card.dataset.topic;
        card.addEventListener('mouseenter', () => {
            container.classList.add('is-topic-hover');
            applyExplorerTheme(topic);
        });
        const face = card.querySelector('.ex-room-face');
        if (face) face.addEventListener('click', () => openTopicIndex(topic));
    });
    const topicsEl = container.querySelector('.ex-topics');
    if (topicsEl) {
        topicsEl.addEventListener('mouseleave', () => {
            container.classList.remove('is-topic-hover');
            setTopicChrome('#a18447');
        });
    }
}

function initStaggeredAnimations(container) {
    killMosaicAnimations();
    if (window.matchMedia('(max-width: 767px)').matches || typeof gsap === 'undefined' || !isLandingVisible()) {
        container.classList.remove('is-pending');
        return;
    }

    const rooms = container.querySelectorAll('.ex-room');
    const hero = container.querySelector('.ex-hero');
    const panels = container.querySelectorAll('.ex-panel');

    mosaicAnimCtx = gsap.context(() => {
        if (hero) gsap.set(hero.children, { y: 14, autoAlpha: 0 });
        gsap.set(rooms, { y: 18, autoAlpha: 0 });
        gsap.set(panels, { y: 18, autoAlpha: 0 });
        container.classList.remove('is-pending');

        if (hero) {
            gsap.to(hero.children, {
                y: 0,
                autoAlpha: 1,
                duration: 0.9,
                stagger: 0.1,
                ease: 'power2.out'
            });
        }
        gsap.to(rooms, {
            y: 0,
            autoAlpha: 1,
            duration: 0.85,
            delay: 0.12,
            stagger: 0.05,
            ease: 'power2.out'
        });
        gsap.to(panels, {
            y: 0,
            autoAlpha: 1,
            duration: 0.95,
            delay: 0.28,
            stagger: 0.12,
            ease: 'power2.out'
        });
    }, container);

    if (typeof ScrollTrigger !== 'undefined') {
        requestAnimationFrame(() => ScrollTrigger.refresh());
    }
}

function renderMosaicMenu() {
    const container = document.getElementById('mosaic-menu');
    container.className = 'ex-module-grid';
    container.replaceChildren();
    explorerModules.forEach(module => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'ex-module-card';
        card.disabled = !module.active;
        const title = document.createElement('h1');
        title.textContent = module.module_name;
        const description = document.createElement('p');
        description.textContent = module.description || '';
        card.append(title, description);
        if (!module.active) {
            const status = document.createElement('span');
            status.className = 'ex-module-status';
            const lock = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            lock.setAttribute('viewBox', '0 0 24 24');
            lock.setAttribute('width', '18');
            lock.setAttribute('height', '18');
            lock.setAttribute('aria-hidden', 'true');
            lock.setAttribute('fill', 'none');
            lock.setAttribute('stroke', 'currentColor');
            lock.setAttribute('stroke-width', '1.8');
            lock.setAttribute('stroke-linecap', 'round');
            lock.setAttribute('stroke-linejoin', 'round');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Zm6 5v2');
            lock.append(path);
            status.append(lock, document.createTextNode('به‌زودی'));
            card.append(status);
        }
        card.addEventListener('click', () => enterExplorerModule(module));
        container.append(card);
    });
    if (!explorerModules.length) container.textContent = 'ماژولی برای نمایش ثبت نشده است.';
}

function renderIndicatorDescription(description) {
    const details = description || {};
    const question = String(details.question || '').trim();
    const unit = String(details.measurement_unit || '').trim();
    const source = String(details.source_name || '').trim() || 'مرکز آمار و مراجع رسمی';
    const narrative = String(details.description || '').trim() || 'توضیحات تکمیلی برای این شاخص در دسترس نیست.';
    const questionEl = document.getElementById('indicator-question');
    questionEl.textContent = question;
    questionEl.hidden = !question;
    document.getElementById('indicator-unit').textContent = unit || 'نامشخص';
    document.getElementById('indicator-source').textContent = source;
    document.getElementById('insight-text').textContent = narrative;
}

async function loadIndicator(indicatorName, topicName) {
    const request = ++explorerIndicatorRequest;
    explorerLoadState = 'loading';
    activeIndicatorGlob = indicatorName;
    if (topicName) activeTopicGlob = topicName;
    if (activeTopicGlob) applyExplorerTheme(activeTopicGlob);
    
    killMosaicAnimations();
    document.getElementById('view-landing').style.display = 'none';
    document.getElementById('view-dashboard').classList.remove('hidden');
    document.getElementById('indicator-title').innerText = indicatorName;
    renderIndicatorDescription(null);
    document.getElementById('insight-text').textContent = 'در حال بارگذاری اطلاعات...';
    document.getElementById('indicator-period').textContent = 'نامشخص';
    if (!indicatorsOf(activeTopicGlob, activeSubtopicGlob).includes(indicatorName)) {
        activeSubtopicGlob = findSubtopicForIndicator(activeTopicGlob, indicatorName);
    }
    syncExplorerDropdowns();
    syncExplorerVisibility();

    try {
        const response = await dashboardFetch(`${API_BASE_URL}/api/explorer/indicator?name=${encodeURIComponent(indicatorName)}`, { credentials: 'include' });
        if (response.status === 401 || response.status === 403) {
            setAuthNext({ page: 'explorer', search: window.location.search || '' });
            window.location.replace(authLoginUrl());
            return;
        }
        const data = await response.json();
        if (request !== explorerIndicatorRequest) return;
        if (!response.ok) throw new Error(data.detail || "Indicator unavailable");

        renderIndicatorDescription(data.description);

        explorerRawScores = data.scores || [];
        explorerFilters = data.filters || [];
        preserveExplorerFilterSelections(explorerFilters);
        explorerLoadState = 'ready';
        renderDimensionFilters();
        syncExplorerDropdowns();
        applyDimensionFilters(false);
        latestYearGlob = data.latest_year != null ? Number(data.latest_year) : null;
        latestScoresGlob = Array.isArray(data.latest_scores) ? data.latest_scores : [];
        
        let uniqueYears = [...new Set(kscoreData.map(d => Number(d.year)))].sort((a,b)=>a-b);
        currentChartYears = uniqueYears;
        stopExplorerMapPlayback();
        explorerMapYearIndex = Math.max(0, uniqueYears.length - 1);
        explorerCompareYearIndex = Math.max(0, uniqueYears.length - 1);
        explorerSelectedProvince = null;
        if (latestYearGlob == null && uniqueYears.length) latestYearGlob = uniqueYears[uniqueYears.length - 1];

        if(uniqueYears.length > 0) {
            document.getElementById('indicator-period').textContent = `${toFa(uniqueYears[0])} — ${toFa(uniqueYears[uniqueYears.length-1])}`;
        } else {
            document.getElementById('indicator-period').textContent = 'نامشخص';
        }

        if (chartInstance) {
            chartInstance.destroy();
            chartInstance = null;
        }
        if (scatterProvinceChart) {
            scatterProvinceChart.destroy();
            scatterProvinceChart = null;
        }

        activeDatasets = [...provincesList];
        hiddenDatasets = {};
        document.querySelectorAll('.province-checkbox').forEach(cb => { cb.checked = false; });

        isBulkAction = true;
        syncExplorerVisibility();
        setChartMode(currentChartMode);

    } catch (err) {
        if (request !== explorerIndicatorRequest) return;
        explorerLoadState = 'error';
        syncExplorerVisibility();
        console.error("Error fetching indicator data", err);
    }
}

function goBackToLanding() {
    resetExplorerSelection();
    const insightLayer = document.getElementById('insight-layer');
    if (insightLayer) insightLayer.hidden = true;
    document.getElementById('view-dashboard').classList.add('hidden');
    const header = document.getElementById('main-header');
    if (header) header.classList.add('hidden');
    const landing = document.getElementById('view-landing');
    landing.style.display = '';
    landing.classList.remove('hidden');
    renderMosaicMenu();
}

function renderProvincesList() {
    const container = document.getElementById('provinces-list');
    container.innerHTML = '';
    provincesList.forEach(prov => {
        const div = document.createElement('div');
        div.className = 'province-item';
        
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.id = `prov-${prov}`;
        cb.className = 'province-checkbox';
        cb.checked = activeDatasets.includes(prov);
        cb.style.accentColor = provinceColors[prov];
        
        cb.addEventListener('change', (e) => {
            isBulkAction = false; 
            if(e.target.checked) { if(!activeDatasets.includes(prov)) activeDatasets.push(prov); } 
            else { activeDatasets = activeDatasets.filter(p => p !== prov); }
            if(activeIndicatorGlob) refreshActiveChart();
        });

        const label = document.createElement('label');
        label.htmlFor = `prov-${prov}`;
        label.className = 'ml-3 text-sm text-gray-700 cursor-pointer select-none flex-1 pr-3';
        label.innerText = prov;
        
        div.appendChild(cb); 
        div.appendChild(label); 
        container.appendChild(div);
    });
}

function filterProvinces() {
    const term = document.getElementById('province-search').value;
    const items = document.querySelectorAll('.province-item');
    items.forEach(item => {
        const label = item.querySelector('label').innerText;
        item.style.display = label.includes(term) ? 'flex' : 'none';
    });
}

function selectAllProvinces() {
    activeDatasets = [...provincesList];
    document.querySelectorAll('.province-checkbox').forEach(cb => cb.checked = true);
    isBulkAction = true; 
    if(activeIndicatorGlob) refreshActiveChart();
}

function clearAllProvinces() {
    activeDatasets = [];
    document.querySelectorAll('.province-checkbox').forEach(cb => cb.checked = false);
    isBulkAction = true; 
    if(activeIndicatorGlob) refreshActiveChart();
}

function setProvinceFilterEnabled(enabled) {
    const aside = document.querySelector('#view-dashboard .ex-side, .ex-prov-rail');
    if (aside) aside.classList.toggle('is-disabled', !enabled);
    document.querySelectorAll('.province-checkbox').forEach(cb => { cb.disabled = !enabled; });
    const search = document.getElementById('province-search');
    if (search) search.disabled = !enabled;
}

function refreshActiveChart() {
    if (explorerLoadState !== 'ready') return;
    if (currentChartMode === 'compare') drawScatterProvince();
    else if (currentChartMode === 'table') renderIndicatorTable();
    else if (currentChartMode === 'map') renderExplorerMap();
    else if (currentChartMode === 'metadata') return;
    else drawChart();
}

function setChartMode(mode) {
    if (['trend', 'compare'].includes(mode)) {
        explorerChartType = mode;
        explorerTab = 'chart';
    } else if (['table', 'map', 'metadata'].includes(mode)) explorerTab = mode;
    currentChartMode = explorerTab === 'chart' ? explorerChartType : explorerTab;
    stopExplorerMapPlayback();
    ['trend', 'compare', 'table', 'map'].forEach(name => {
        document.getElementById(`${name}-chart-wrap`).classList.toggle('is-active', name === currentChartMode);
    });
    document.querySelectorAll('[data-explorer-tab]').forEach(button => {
        const selected = ['trend', 'compare'].includes(button.dataset.explorerTab)
            ? button.dataset.explorerTab === currentChartMode : button.dataset.explorerTab === explorerTab;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', String(selected));
    });
    document.getElementById('btn-toggle-chart-type').textContent = explorerChartType === 'trend' ? 'نمایش نمودار مقایسه‌ای' : 'نمایش نمودار روندی';
    document.getElementById('chart-panel-title').textContent = activeIndicatorGlob || '';
    document.getElementById('btn-country-legend').hidden = currentChartMode !== 'trend';
    syncExplorerVisibility();
    if (explorerLoadState === 'ready' && explorerTab !== 'metadata') refreshActiveChart();
}

function explorerSeriesRows() {
    // Assign colors using the complete catalog, so filtering cannot renumber colors.
    const labels = new Map(explorerRawScores.map(row => [row.series_id, row.series_label]));
    const counts = new Map();
    const colors = new Map();
    let colorIndex = 0;
    for (const [id, label] of labels) {
        counts.set(label, (counts.get(label) || 0) + 1);
        colors.set(id, label === 'کل کشور' ? '#1e293b' : provinceColorPalette[colorIndex++ % provinceColorPalette.length]);
    }
    return explorerRawScores.map(row => ({...row, geographic_province: row.province_name,
        province_name: counts.get(row.series_label) > 1 ? `${row.series_label} (${row.series_id})` : row.series_label,
        series_color: colors.get(row.series_id)}));
}

function syncExplorerFilterColors(rows = explorerSeriesRows()) {
    const series = [...new Map(rows.map(row => [row.series_id, row])).values()];
    explorerFilterInputs.forEach(({input, dimension, value, colorKey}) => {
        const matching = series.filter(row => row.dim_cat_values[dimension] === value && explorerFilters.every(filter =>
            filter.name === dimension || row.dim_cat_values[filter.name] === undefined ||
            explorerFilterSelection[filter.name].has(row.dim_cat_values[filter.name])));
        const colors = [...new Set(matching.map(row => row.series_color))];
        input.style.accentColor = colors.length === 1 ? colors[0] : 'var(--ex-olive)';
        colorKey.replaceChildren();
        colorKey.hidden = colors.length <= 1;
        colors.slice(0, 6).forEach(color => {
            const swatch = document.createElement('i');
            swatch.style.backgroundColor = color;
            colorKey.append(swatch);
        });
        if (colors.length > 6) {
            const remaining = document.createElement('small');
            remaining.textContent = `+${toFa(colors.length - 6)}`;
            colorKey.append(remaining);
        }
    });
}

function preserveExplorerFilterSelections(filters) {
    // Keep unavailable dimensions/values in memory so switching back restores them.
    filters.forEach(filter => {
        if (!Object.prototype.hasOwnProperty.call(explorerFilterSelection, filter.name)) {
            explorerFilterSelection[filter.name] = new Set(filter.values.map(value => value.value));
        }
    });
}

function renderDimensionFilters() {
    explorerFilterInputs = [];
    const root = document.getElementById('dimension-filters');
    root.replaceChildren();
    const titles = {province: 'استان', sex: 'جنسیت', residence: 'محل سکونت'};
    explorerFilters.forEach(filter => {
        const group = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = titles[filter.name] || filter.name;
        group.append(legend);
        const inputs = [];
        const actions = document.createElement('div');
        actions.className = 'ex-filter-actions';
        [[true, 'انتخاب همه'], [false, 'پاک کردن همه']].forEach(([selectAll, text]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.setAttribute('aria-label', `${text} — ${titles[filter.name] || filter.name}`);
            button.disabled = !filter.values.length;
            button.addEventListener('click', () => {
                const selected = new Set(filter.values.filter(value => selectAll ||
                    (filter.name === 'province' && normalizeMapProvinceName(value.label) === NATIONAL_PROVINCE_KEY))
                    .map(value => value.value));
                explorerFilterSelection[filter.name] = selected;
                inputs.forEach(({input, value}) => { input.checked = selected.has(value); });
                applyDimensionFilters();
            });
            actions.append(button);
        });
        group.append(actions);
        filter.values.forEach(value => {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = explorerFilterSelection[filter.name].has(value.value);
            inputs.push({input, value: value.value});
            input.addEventListener('change', () => {
                const selected = explorerFilterSelection[filter.name];
                if (input.checked) selected.add(value.value); else selected.delete(value.value);
                applyDimensionFilters();
            });
            const colorKey = document.createElement('span');
            colorKey.className = 'ex-filter-color-key';
            colorKey.setAttribute('aria-hidden', 'true');
            explorerFilterInputs.push({input, dimension: filter.name, value: value.value, colorKey});
            label.append(input, document.createTextNode(value.label), colorKey);
            group.append(label);
        });
        root.append(group);
    });
    syncExplorerFilterColors();
}

function applyDimensionFilters(refresh = true) {
    const allRows = explorerSeriesRows();
    kscoreData = allRows.filter(row => explorerFilters.every(filter =>
        row.dim_cat_values[filter.name] === undefined || explorerFilterSelection[filter.name].has(row.dim_cat_values[filter.name])));
    // Chart/table renderers use province_name as the complete series label.
    provinceColors = Object.fromEntries(allRows.map(row => [row.province_name, row.series_color]));
    syncExplorerFilterColors(allRows);
    provincesList = [...new Set(kscoreData.map(row => row.province_name))].filter(name => name !== 'کل کشور');
    activeDatasets = [...provincesList];
    currentChartYears = [...new Set(kscoreData.filter(row => row.year != null).map(row => Number(row.year)))].sort((a,b) => a-b);
    latestScoresGlob = kscoreData.filter(row => Number(row.year) === latestYearGlob);
    if (refresh) refreshActiveChart();
}

let scatterPointsCache = [];

function getComparisonYear() {
    if (!currentChartYears.length) return latestYearGlob;
    explorerCompareYearIndex = Math.min(Math.max(explorerCompareYearIndex, 0), currentChartYears.length - 1);
    return currentChartYears[explorerCompareYearIndex];
}

function updateComparisonTimeline() {
    const timeline = document.getElementById('explorer-compare-timeline');
    const label = document.getElementById('explorer-compare-timeline-value');
    const year = getComparisonYear();
    if (timeline && label) {
        const last = Math.max(0, currentChartYears.length - 1);
        timeline.max = String(last);
        timeline.value = String(explorerCompareYearIndex);
        timeline.disabled = currentChartYears.length < 2;
        label.textContent = year != null ? toFa(year) : '—';
        timeline.setAttribute('aria-valuetext', label.textContent);
        label.style.left = (last ? explorerCompareYearIndex / last * 100 : 0) + '%';
    }
    renderExplorerYearTicks('compare', explorerCompareYearIndex, index => {
        explorerCompareYearIndex = index;
        if (currentChartMode === 'compare') drawScatterProvince();
    });
}

function renderExplorerYearTicks(view, selectedIndex, onSelect) {
    const years = document.getElementById(`explorer-${view}-years`);
    const scale = document.getElementById(`explorer-${view}-year-scale`);
    if (years && scale) {
        scale.style.minWidth = `${Math.max(0, currentChartYears.length - 1) * 44}px`;
        years.replaceChildren();
        currentChartYears.forEach((availableYear, index) => {
            const tick = document.createElement('button');
            tick.type = 'button';
            tick.textContent = toFa(availableYear);
            tick.style.left = (currentChartYears.length > 1 ? index / (currentChartYears.length - 1) * 100 : 0) + '%';
            tick.setAttribute('aria-label', `سال ${toFa(availableYear)}`);
            tick.setAttribute('aria-current', String(index === selectedIndex));
            tick.addEventListener('click', () => onSelect(index));
            years.append(tick);
        });
    }
}

function getComparisonPoints() {
    const year = getComparisonYear();
    let rows = kscoreData.filter(record => year != null && Number(record.year) === Number(year));
    if (!rows.length && year != null && Number(year) === Number(latestYearGlob)) {
        rows = Array.isArray(latestScoresGlob) ? latestScoresGlob : [];
    }
    const byProv = new Map();
    rows.forEach(record => {
        const raw = record.value;
        if (typeof raw !== 'number' && typeof raw !== 'string') return;
        if (typeof raw === 'string' && !raw.trim()) return;
        const value = Number(raw);
        if (Number.isFinite(value)) byProv.set(record.province_name, value);
    });
    return provincesList.filter(name => normalizeMapProvinceName(name) !== NATIONAL_PROVINCE_KEY && byProv.has(name))
        .map(name => ({ name, value: byProv.get(name) }));
}

function drawScatterProvince() {
    const canvas = document.getElementById('scatterProvinceChart');
    if (!canvas) return;
    updateComparisonTimeline();
    const points = getComparisonPoints();
    scatterPointsCache = points;
    const bubbleR = window.matchMedia('(max-width: 767px)').matches ? 8 : 24;
    // Keep an entire bubble-width inside the chart at both horizontal edges.
    const scatterXMin = -1;
    const scatterXMax = Math.max(1, points.length);
    const data = points.map((p, i) => ({ x: i, y: p.value, province: p.name, r: bubbleR }));
    const colors = points.map(p => provinceColors[p.name] || '#3b82f6');
    const scaleBounds = getIndicatorScaleBounds();
    if (Number.isFinite(scaleBounds.min) && Number.isFinite(scaleBounds.max)) {
        const padding = (scaleBounds.max - scaleBounds.min) * 0.08;
        scaleBounds.min -= padding;
        scaleBounds.max += padding;
    }

    if (scatterProvinceChart) {
        scatterProvinceChart.data.datasets[0].data = data;
        scatterProvinceChart.data.datasets[0].backgroundColor = colors;
        scatterProvinceChart.options.scales.x.min = scatterXMin;
        scatterProvinceChart.options.scales.x.max = scatterXMax;
        Object.assign(scatterProvinceChart.options.scales.y, scaleBounds);
        scatterProvinceChart.update('none');
        return;
    }

    scatterProvinceChart = new Chart(canvas.getContext('2d'), {
        type: 'bubble',
        data: {
            datasets: [{
                data,
                backgroundColor: colors,
                borderColor: '#ffffff',
                borderWidth: 2,
                clip: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            resizeDelay: 0,
            layout: { padding: bubbleR + 2 },
            plugins: {
                legend: { display: false },
                datalabels: {
                    display: () => !window.matchMedia('(max-width: 767px)').matches,
                    color: '#ffffff',
                    align: 'center',
                    anchor: 'center',
                    textAlign: 'center',
                    clip: false,
                    clamp: true,
                    font: { family: 'PeydaFaNumWeb', size: 8, weight: 'bold' },
                    formatter: (value) => {
                        const name = (value && value.province) || '';
                        return name.includes(' ') ? name.split(' ') : name;
                    }
                },
                tooltip: {
                    rtl: true,
                    titleFont: { family: 'PeydaFaNumWeb', size: 13 },
                    bodyFont: { family: 'PeydaFaNumWeb', size: 13, weight: 'bold' },
                    callbacks: {
                        title: (items) => (items[0] && items[0].raw && items[0].raw.province) || '',
                        label: (ctx) => `امتیاز: ${formatExplorerNumber(ctx.parsed.y)}`
                    }
                }
            },
            scales: {
                x: {
                    min: scatterXMin,
                    max: scatterXMax,
                    ticks: { display: false },
                    grid: { display: false },
                    title: {
                        display: true,
                        text: 'تفکیک',
                        font: { family: 'PeydaFaNumWeb', size: 12, weight: 'bold' },
                        color: '#4b5563'
                    }
                },
                y: {
                    ...scaleBounds,
                    ticks: {
                        includeBounds: false,
                        font: { family: 'PeydaFaNumWeb' },
                        color: '#64748b',
                        callback: (v) => formatExplorerNumber(v)
                    },
                    grid: { color: '#e2e8f0', drawBorder: false },
                    title: {
                        display: true,
                        text: 'امتیاز',
                        font: { family: 'PeydaFaNumWeb', size: 12, weight: 'bold' },
                        color: '#4b5563'
                    }
                }
            }
        }
    });
}

function getChartSeries(provName, years = currentChartYears) {
    let records = kscoreData.filter(d => d.province_name === provName);
    return years.map(y => {
        let rec = records.find(r => Number(r.year) === y);
        return rec && rec.value !== null && rec.value !== '' && Number.isFinite(Number(rec.value)) ? Number(rec.value) : null;
    });
}
function renderIndicatorTable() {
    const table = document.getElementById('indicator-score-table');
    if (!table) return;
    const head = table.querySelector('thead');
    const body = table.querySelector('tbody');
    if (!head || !body) return;

    head.replaceChildren();
    body.replaceChildren();

    const headerRow = document.createElement('tr');
    const provinceHeader = document.createElement('th');
    provinceHeader.scope = 'col';
    provinceHeader.className = 'indicator-table-province';
    provinceHeader.textContent = 'تفکیک';
    headerRow.appendChild(provinceHeader);
    currentChartYears.forEach(year => {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = toFa(year);
        headerRow.appendChild(cell);
    });
    head.appendChild(headerRow);

    const scoresByProvinceYear = new Map();
    kscoreData.forEach(record => {
        const year = Number(record.year);
        const score = record.value == null || record.value === '' ? NaN : Number(record.value);
        if (!Number.isFinite(year) || !Number.isFinite(score)) return;
        scoresByProvinceYear.set(`${record.province_name}\u0000${year}`, score);
    });

    const tableSeries = [...new Set(kscoreData.map(record => record.province_name))];
    const countryIndex = tableSeries.indexOf('کل کشور');
    if (countryIndex > 0) tableSeries.unshift(...tableSeries.splice(countryIndex, 1));
    tableSeries.forEach(provinceName => {
        const row = document.createElement('tr');
        const provinceCell = document.createElement('th');
        provinceCell.scope = 'row';
        provinceCell.className = 'indicator-table-province';
        provinceCell.textContent = provinceName;
        row.appendChild(provinceCell);
        currentChartYears.forEach(year => {
            const cell = document.createElement('td');
            const score = scoresByProvinceYear.get(`${provinceName}\u0000${year}`);
            cell.textContent = Number.isFinite(score) ? formatExplorerNumber(score) : '—';
            row.appendChild(cell);
        });
        body.appendChild(row);
    });
}

const NATIONAL_PROVINCE_KEY = '\u06a9\u0644\u06a9\u0634\u0648\u0631';

function normalizeMapProvinceName(value) {
    return String(value || '').normalize('NFKC').replace(/[\u064A\u0649]/g, '\u06CC').replace(/\u0643/g, '\u06A9').replace(/[\s\u200C]+/g, '');
}

function setExplorerMapStatus(message, visible) {
    const status = document.getElementById('explorer-map-status');
    if (status) {
        status.textContent = message || '';
        status.hidden = !visible;
    }
    const target = document.getElementById('explorer-leaflet-map');
    if (target) {
        target.inert = visible;
        target.classList.toggle('is-loading', visible);
        target.setAttribute('aria-busy', String(visible));
    }
    const controls = document.querySelector('.explorer-map-controls');
    if (controls) controls.inert = visible;
    if (!explorerLeafletMap) return;
    if (visible) explorerLeafletMap.stop();
    ['dragging', 'touchZoom', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard'].forEach(name => {
        const handler = explorerLeafletMap[name];
        if (handler) handler[visible ? 'disable' : 'enable']();
    });
}

function completeExplorerMapLoading() {
    if (!explorerLeafletMap || !explorerMapGeoLayer || currentChartMode !== 'map' || !currentChartYears.length) return false;
    if (!explorerMapLoaded) {
        let pending = false;
        explorerLeafletMap.eachLayer(layer => {
            if (typeof layer.isLoading === 'function' && layer.isLoading()) pending = true;
        });
        if (pending) return false;
        explorerMapLoaded = true;
    }
    setExplorerMapStatus('', false);
    return true;
}

function geometryPolygons(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates || []];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates || [];
    return [];
}

function ringArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
    return Math.abs(area / 2);
}

function pointToSegmentDistanceSquared(point, start, end) {
    let x = start[0], y = start[1], dx = end[0] - x, dy = end[1] - y;
    if (dx || dy) {
        const t = ((point[0] - x) * dx + (point[1] - y) * dy) / ((dx * dx) + (dy * dy));
        if (t > 1) { x = end[0]; y = end[1]; }
        else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = point[0] - x; dy = point[1] - y;
    return (dx * dx) + (dy * dy);
}

function pointToPolygonDistance(point, polygon) {
    let inside = false;
    let minDistanceSquared = Infinity;
    polygon.forEach(ring => {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if (((a[1] > point[1]) !== (b[1] > point[1])) && (point[0] < ((b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1])) + a[0])) inside = !inside;
            minDistanceSquared = Math.min(minDistanceSquared, pointToSegmentDistanceSquared(point, a, b));
        }
    });
    return (inside ? 1 : -1) * Math.sqrt(minDistanceSquared);
}

function makeInteriorCell(x, y, halfSize, polygon) {
    const distance = pointToPolygonDistance([x, y], polygon);
    return { x, y, h: halfSize, d: distance, max: distance + (halfSize * Math.SQRT2) };
}

function heapPush(heap, cell) {
    heap.push(cell);
    let index = heap.length - 1;
    for (; index > 0;) {
        const parent = Math.floor((index - 1) / 2);
        if (heap[parent].max >= cell.max) break;
        heap[index] = cell; index = parent;
    }
    heap[index] = cell;
}

function heapPop(heap) {
    const top = heap[0], last = heap.pop();
    if (!heap.length) return top;
    let index = 0;
    while (true) {
        let child = (index * 2) + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && heap[child + 1].max > heap[child].max) child += 1;
        if (heap[child].max <= last.max) break;
        heap[index] = heap[child]; index = child;
    }
    heap[index] = last;
    return top;
}

function interiorPointForPolygon(polygon, precision = 0.008) {
    const outer = polygon[0] || [];
    if (!outer.length) return { point: [0, 0], distance: 0 };
    let minX = outer[0][0], minY = outer[0][1], maxX = minX, maxY = minY;
    outer.forEach(point => { minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]); maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]); });
    const cellSize = Math.min(maxX - minX, maxY - minY) || 1;
    const heap = [];
    for (let x = minX; x < maxX; x += cellSize) for (let y = minY; y < maxY; y += cellSize) heapPush(heap, makeInteriorCell(x + (cellSize / 2), y + (cellSize / 2), cellSize / 2, polygon));
    let best = makeInteriorCell((minX + maxX) / 2, (minY + maxY) / 2, 0, polygon);
    outer.forEach(point => { const candidate = makeInteriorCell(point[0], point[1], 0, polygon); if (candidate.d > best.d) best = candidate; });
    while (heap.length) {
        const cell = heapPop(heap);
        if (cell.d > best.d) best = cell;
        if (cell.max - best.d <= precision) continue;
        const half = cell.h / 2;
        heapPush(heap, makeInteriorCell(cell.x - half, cell.y - half, half, polygon));
        heapPush(heap, makeInteriorCell(cell.x + half, cell.y - half, half, polygon));
        heapPush(heap, makeInteriorCell(cell.x - half, cell.y + half, half, polygon));
        heapPush(heap, makeInteriorCell(cell.x + half, cell.y + half, half, polygon));
    }
    return { point: [best.x, best.y], distance: best.d };
}

function interiorPointForGeometry(geometry) {
    const polygons = geometryPolygons(geometry).filter(polygon => polygon[0] && polygon[0].length);
    if (!polygons.length) return { point: [0, 0], distance: 0 };
    const polygon = polygons.reduce((largest, candidate) => ringArea(candidate[0]) > ringArea(largest[0]) ? candidate : largest, polygons[0]);
    return interiorPointForPolygon(polygon);
}

function prepareExplorerMap(geoJson) {
    if (!Array.isArray(geoJson && geoJson.features) || !geoJson.features.length) throw new Error('Iran GeoJSON has no province boundaries.');
    explorerMapBounds = L.geoJSON(geoJson).getBounds();
    if (!explorerMapBounds.isValid()) throw new Error('Iran GeoJSON has invalid province boundaries.');
}

function ensureExplorerMapGeoJson() {
    if (explorerMapGeoJson) return Promise.resolve(explorerMapGeoJson);
    if (explorerMapLoadPromise) return explorerMapLoadPromise;
    const url = (typeof SITE !== 'undefined' && SITE.staticFile) ? SITE.staticFile('data/iran.geojson') : 'data/iran.geojson';
    explorerMapLoadPromise = fetch(url, { credentials: 'same-origin' })
        .then(response => { if (!response.ok) throw new Error(`Map data request failed (${response.status})`); return response.json(); })
        .then(data => { prepareExplorerMap(data); explorerMapGeoJson = data; return data; })
        .catch(error => { explorerMapLoadPromise = null; throw error; });
    return explorerMapLoadPromise;
}

function explorerLegendStageForScore(score, min, max) {
    if (!Number.isFinite(score)) return 'no-data';
    const ratio = max > min ? Math.min(1, Math.max(0, (score - min) / (max - min))) : 0.62;
    return Math.min(EXPLORER_LEGEND_STAGES - 1, Math.floor(ratio * EXPLORER_LEGEND_STAGES));
}

function explorerProvinceStyle(feature) {
    const properties = feature.properties || {};
    const key = normalizeMapProvinceName(properties.ProvincNam || properties.ADM1_FA || properties.Name);
    const selected = key === explorerSelectedProvince;
    const score = explorerMapScores.get(key);
    const style = {
        color: selected ? '#881337' : '#ffffff', weight: selected ? 3 : 1.25,
        opacity: 1, fillColor: selected ? '#e11d48' : mapColorForScore(score, explorerMapScoreMin, explorerMapScoreMax),
        fillOpacity: selected ? 0.9 : 0.78
    };
    if (explorerHoveredLegendStage !== null) {
        const matches = explorerLegendStageForScore(score, explorerMapScoreMin, explorerMapScoreMax) === explorerHoveredLegendStage;
        style.color = matches ? '#000000' : '#cccccc';
        style.weight = matches ? 2.5 : 1;
        style.fillOpacity = matches ? 0.95 : 0.15;
    }
    return style;
}

function setExplorerLegendHighlight(stage) {
    explorerHoveredLegendStage = stage;
    if (explorerMapGeoLayer) explorerMapGeoLayer.setStyle(explorerProvinceStyle);
    const bar = document.querySelector('.explorer-map-legend-bar');
    if (bar) Array.from(bar.children).forEach((segment, index) => segment.classList.toggle('is-highlighted', index === stage));
}

function bindExplorerMapLegend() {
    const bar = document.querySelector('.explorer-map-legend-bar');
    const noData = document.querySelector('.explorer-map-legend-no-data');
    if (!bar || bar.dataset.hoverBound) return;
    bar.dataset.hoverBound = 'true';
    bar.removeAttribute('aria-hidden');
    const bind = (segment, stage) => {
        segment.tabIndex = 0;
        segment.setAttribute('role', 'img');
        segment.addEventListener('mouseenter', () => setExplorerLegendHighlight(stage));
        segment.addEventListener('mouseleave', () => setExplorerLegendHighlight(null));
        segment.addEventListener('focus', () => setExplorerLegendHighlight(stage));
        segment.addEventListener('blur', () => setExplorerLegendHighlight(null));
    };
    Array.from(bar.children).forEach((segment, index) => bind(segment, index));
    if (noData) { noData.setAttribute('aria-label', 'بدون داده'); bind(noData, 'no-data'); }
}

function mapColorForScore(score, min, max) {
    if (!Number.isFinite(score)) return '#e5e7eb';
    const ratio = max > min ? Math.min(1, Math.max(0, (score - min) / (max - min))) : 0.62;
    const low = [238, 240, 210], high = [81, 88, 17];
    return `rgb(${low.map((value, index) => Math.round(value + ((high[index] - value) * ratio))).join(', ')})`;
}

function updateExplorerMapLegend(min, max, hasValues) {
    const minLabel = document.getElementById('explorer-map-legend-min');
    const maxLabel = document.getElementById('explorer-map-legend-max');
    if (!minLabel || !maxLabel) return;
    minLabel.textContent = hasValues ? formatExplorerNumber(Math.floor(min)) : '—';
    maxLabel.textContent = hasValues ? formatExplorerNumber(Math.ceil(max)) : '—';
    const bar = document.querySelector('.explorer-map-legend-bar');
    if (bar) Array.from(bar.children).forEach((segment, index) => {
        const lower = min + (max - min) * index / EXPLORER_LEGEND_STAGES;
        const upper = min + (max - min) * (index + 1) / EXPLORER_LEGEND_STAGES;
        const label = hasValues ? `امتیاز از ${formatExplorerNumber(lower)} تا ${formatExplorerNumber(upper)}` : 'بدون داده';
        segment.setAttribute('aria-label', label);
        segment.title = label;
    });
}

function escapeMapLabel(value) {
    const el = document.createElement('div');
    el.textContent = value;
    return el.innerHTML;
}

function provinceLabelLines(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return [String(name || '')];
    const lines = ['', ''];
    words.forEach(word => {
        const target = lines[0].length <= lines[1].length ? 0 : 1;
        lines[target] = lines[target] ? `${lines[target]} ${word}` : word;
    });
    return lines.filter(Boolean);
}

function explorerProvinceLabel(name, feature) {
    const position = feature.__explorerInteriorPoint || (feature.__explorerInteriorPoint = interiorPointForGeometry(feature.geometry));
    const latLng = [position.point[1], position.point[0]];
    const zoom = explorerLeafletMap.getZoom();
    const center = explorerLeafletMap.project(latLng, zoom);
    const east = explorerLeafletMap.project([latLng[0], latLng[1] + position.distance], zoom);
    const north = explorerLeafletMap.project([latLng[0] + position.distance, latLng[1]], zoom);
    const safeRadius = Math.max(1, Math.min(Math.abs(east.x - center.x), Math.abs(north.y - center.y)));
    const safeBox = Math.max(7, safeRadius * 1.15);
    const lines = provinceLabelLines(name);
    const longestLine = Math.max(...lines.map(line => line.length), 1);
    const fontSize = Math.max(4.8, Math.min(12, safeBox / (longestLine * 0.62), safeBox / (lines.length * 1.24)));
    const lineHeight = fontSize * 1.18;
    const labelHeight = lineHeight * lines.length;
    const labelWidth = Math.min(safeBox, Math.max(fontSize * 1.8, longestLine * fontSize * 0.62));
    const labelText = lines.map(escapeMapLabel).join('<br>');
    return L.marker(latLng, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: 'explorer-province-label', html: `<span style="display:block;width:${labelWidth.toFixed(1)}px;height:${labelHeight.toFixed(1)}px;font-size:${fontSize.toFixed(1)}px;line-height:${lineHeight.toFixed(1)}px">${labelText}</span>`, iconSize: [0, 0], iconAnchor: [labelWidth / 2, labelHeight / 2] })
    });
}

function clearExplorerMapSelection() {
    if (explorerSelectedProvince === null) return;
    explorerSelectedProvince = null;
    if (explorerMapGeoLayer) explorerMapGeoLayer.resetStyle();
}

function syncExplorerMapViewport(forceFit = false) {
    if (!explorerLeafletMap || currentChartMode !== 'map') return false;
    const target = document.getElementById('explorer-leaflet-map');
    const width = target && target.clientWidth;
    const height = target && target.clientHeight;
    // Hidden tabs have no usable size. Fit only after their layout is visible.
    if (!width || !height) return false;
    const size = `${width}x${height}`;
    if (explorerMapBounds && (forceFit || !explorerMapFitted || size !== explorerMapViewportSize)) {
        explorerLeafletMap.invalidateSize({ animate: false, pan: false });
        explorerLeafletMap.fitBounds(explorerMapBounds, {
            padding: width < 480 ? [12, 12] : [38, 30], animate: false,
        });
        explorerMapFitted = true;
        explorerMapViewportSize = size;
    }
    return true;
}

function ensureExplorerMapSdk() {
    if (explorerMapSdkPromise) return explorerMapSdkPromise;
    explorerMapSdkPromise = new Promise((resolve, reject) => {
        const base = 'https://static.neshan.org/sdk/leaflet/v1.9.4/neshan-sdk/v1.0.8/';
        const style = document.createElement('link');
        style.rel = 'stylesheet';
        style.href = base + 'index.css';
        const script = document.createElement('script');
        script.src = base + 'index.js';
        script.async = true;
        let remaining = 2;
        const fail = () => {
            clearTimeout(timeout);
            style.onload = script.onload = style.onerror = script.onerror = null;
            style.remove();
            script.remove();
            reject(new Error('Neshan map SDK could not be loaded.'));
        };
        const ready = () => {
            if (--remaining) return;
            if (typeof L === 'undefined') { fail(); return; }
            clearTimeout(timeout);
            style.onload = script.onload = style.onerror = script.onerror = null;
            resolve();
        };
        const timeout = setTimeout(fail, 15000);
        style.onload = script.onload = ready;
        style.onerror = script.onerror = fail;
        document.head.append(style, script);
    }).catch(error => { explorerMapSdkPromise = null; throw error; });
    return explorerMapSdkPromise;
}

function initExplorerLeafletMap() {
    if (explorerLeafletMap) return Promise.resolve(explorerLeafletMap);
    if (explorerMapInitPromise) return explorerMapInitPromise;
    explorerMapInitPromise = (async () => {
        await ensureExplorerMapSdk();
        if (typeof L === 'undefined') throw new Error('Neshan map SDK did not load.');
        const target = document.getElementById('explorer-leaflet-map');
        if (!target) throw new Error('Explorer map container is missing.');
        const response = await fetch(`${API_BASE_URL}/api/maps/config`, {
            credentials: 'include', cache: 'no-store'
        });
        if (!response.ok) throw new Error(`Map configuration unavailable: ${response.status}`);
        const config = await response.json();
        if (typeof config.key !== 'string' || !config.key.trim()) throw new Error('Neshan map key is missing.');
        explorerLeafletMap = new L.Map(target, {
            key: config.key, maptype: config.maptype,
            // Page scrolling must not move the map before its layers are ready.
            zoomControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
            touchZoom: false, boxZoom: false, keyboard: false, attributionControl: true,
            // Neshan dreamy tiles are available from zoom 4.
            minZoom: 4, maxZoom: 9, zoomSnap: 0.25
        }).setView([32, 53], 5);
        explorerLeafletMap.attributionControl.setPrefix(false);
        setExplorerMapStatus('در حال بارگذاری نقشه...', true);
        const watchTiles = layer => {
            if (typeof layer.isLoading === 'function') layer.on('load', completeExplorerMapLoading);
        };
        explorerLeafletMap.eachLayer(watchTiles);
        explorerLeafletMap.on('layeradd', event => watchTiles(event.layer));
        explorerLeafletMap.on('click', clearExplorerMapSelection);
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(() => {
                if (currentChartMode === 'map') requestAnimationFrame(renderExplorerMap);
            });
            observer.observe(target);
        }
        explorerLeafletMap.on('zoomend', () => {
            if (explorerMapFitted && currentChartMode === 'map' && explorerMapGeoJson) requestAnimationFrame(renderExplorerMap);
        });
        return explorerLeafletMap;
    })().catch(error => { explorerMapInitPromise = null; throw error; });
    return explorerMapInitPromise;
}

function updateExplorerMapTimeline() {
    const timeline = document.getElementById('explorer-map-timeline');
    const value = document.getElementById('explorer-map-timeline-value');
    if (!timeline || !value) return;
    const hasYears = currentChartYears.length > 0;
    timeline.min = '0';
    timeline.max = String(Math.max(0, currentChartYears.length - 1));
    const maxIndex = Math.max(0, currentChartYears.length - 1);
    const activeIndex = Math.min(Math.max(explorerMapYearIndex, 0), maxIndex);
    timeline.value = String(activeIndex);
    timeline.disabled = !hasYears;
    value.textContent = hasYears ? toFa(currentChartYears[activeIndex]) : '—';
    timeline.setAttribute('aria-valuetext', value.textContent);
    value.style.left = String(maxIndex ? (activeIndex / maxIndex) * 100 : 0) + '%';
    renderExplorerYearTicks('map', activeIndex, index => {
        stopExplorerMapPlayback();
        explorerMapYearIndex = index;
        if (currentChartMode === 'map') renderExplorerMap();
    });
}

function updateExplorerMapPlaybackControl() {
    const button = document.getElementById('btn-explorer-map-play');
    if (!button) return;
    const playing = explorerMapPlaybackTimer !== null;
    button.setAttribute('aria-pressed', playing ? 'true' : 'false');
    button.setAttribute('aria-label', playing ? 'توقف پخش سال‌ها' : 'پخش سال‌ها');
    const label = button.querySelector('span'); if (label) label.textContent = playing ? 'توقف' : 'پخش سال‌ها';
    const icon = button.querySelector('svg');
    if (icon) icon.innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="m7 3 14 9-14 9z"/>';
}

function stopExplorerMapPlayback() {
    if (explorerMapPlaybackTimer !== null) { window.clearInterval(explorerMapPlaybackTimer); explorerMapPlaybackTimer = null; }
    updateExplorerMapPlaybackControl();
}

function toggleExplorerMapPlayback() {
    if (!currentChartYears.length) return;
    if (explorerMapPlaybackTimer !== null) { stopExplorerMapPlayback(); return; }
    explorerMapPlaybackTimer = window.setInterval(() => { explorerMapYearIndex = (explorerMapYearIndex + 1) % currentChartYears.length; renderExplorerMap(); }, 1400);
    updateExplorerMapPlaybackControl();
}

function renderExplorerMap() {
    const geographic = new Map();
    let ambiguous = false;
    for (const row of kscoreData) {
        if (!row.geographic_province) continue;
        const key = `${row.geographic_province}:${row.year}`;
        if (geographic.has(key)) ambiguous = true;
        geographic.set(key, row);
    }
    if (!explorerFilters.some(f => f.name === 'province') || !geographic.size || ambiguous) {
        setExplorerMapStatus(ambiguous ? 'برای نمایش نقشه، از هر تفکیک غیر استانی فقط یک مقدار انتخاب کنید.' : 'این شاخص دادهٔ استانی برای نمایش روی نقشه ندارد.', true);
        document.getElementById('explorer-leaflet-map').hidden = true;
        return;
    }
    document.getElementById('explorer-leaflet-map').hidden = false;
    const mapRows = [...geographic.values()].map(row => ({...row, province_name: row.geographic_province}));
    if (!currentChartYears.length) { setExplorerMapStatus('برای این شاخص، دادهٔ سالانه‌ای موجود نیست.', true); return; }
    if (!explorerMapGeoJson || !explorerLeafletMap) {
        setExplorerMapStatus('در حال بارگذاری نقشه...', true);
        ensureExplorerMapSdk().then(ensureExplorerMapGeoJson).then(() => initExplorerLeafletMap()).then(() => { if (currentChartMode === 'map') renderExplorerMap(); }).catch(error => {
            console.error('Unable to load Explorer map data', error);
            if (currentChartMode === 'map') setExplorerMapStatus('بارگذاری نقشه ممکن نشد. لطفاً صفحه را دوباره بارگذاری کنید.', true);
        });
        return;
    }
    const map = explorerLeafletMap;
    if (!syncExplorerMapViewport()) return;
    explorerMapYearIndex = Math.min(Math.max(explorerMapYearIndex, 0), currentChartYears.length - 1);
    const year = currentChartYears[explorerMapYearIndex], scores = new Map();
    mapRows.forEach(record => {
        if (Number(record.year) !== Number(year)) return;
        const key = normalizeMapProvinceName(record.province_name), score = record.value == null ? NaN : Number(record.value);
        if (key && key !== NATIONAL_PROVINCE_KEY && Number.isFinite(score)) scores.set(key, score);
    });
    const allValues = mapRows.filter(record => record.value != null && normalizeMapProvinceName(record.province_name) !== NATIONAL_PROVINCE_KEY).map(record => Number(record.value)).filter(Number.isFinite);
    const min = allValues.length ? Math.min(...allValues) : 0;
    const max = allValues.length ? Math.max(...allValues) : 1;
    if (explorerMapGeoLayer) explorerMapGeoLayer.remove();
    if (explorerMapLabelsLayer) explorerMapLabelsLayer.remove();
    explorerMapLabelsLayer = L.layerGroup().addTo(map);
    explorerMapScores = scores;
    explorerMapScoreMin = min; explorerMapScoreMax = max;
    explorerMapGeoLayer = L.geoJSON(explorerMapGeoJson, {
        bubblingMouseEvents: false,
        style: explorerProvinceStyle,
        onEachFeature: (feature, layer) => {
            const name = (feature.properties && (feature.properties.ProvincNam || feature.properties.ADM1_FA || feature.properties.Name)) || '';
            layer.on('click', () => {
                explorerSelectedProvince = normalizeMapProvinceName(name);
                explorerMapGeoLayer.setStyle(explorerProvinceStyle);
                layer.bringToFront();
            });
            const score = scores.get(normalizeMapProvinceName(name));
            const scoreText = Number.isFinite(score) ? `امتیاز: ${formatExplorerNumber(score)}` : 'داده‌ای ثبت نشده است';
            layer.bindTooltip(`${escapeMapLabel(name)}<br>${scoreText}`, { sticky: true, direction: 'top', className: 'explorer-score-tooltip' });
            explorerProvinceLabel(name, feature).addTo(explorerMapLabelsLayer);
        }
    }).addTo(map);
    explorerMapGeoLayer.eachLayer(layer => {
        const properties = layer.feature.properties || {};
        if (normalizeMapProvinceName(properties.ProvincNam || properties.ADM1_FA || properties.Name) === explorerSelectedProvince) layer.bringToFront();
    });
    updateExplorerMapLegend(min, max, allValues.length > 0);
    updateExplorerMapTimeline();
    if (!completeExplorerMapLoading()) setExplorerMapStatus('در حال بارگذاری نقشه...', true);
    updateExplorerMapPlaybackControl();
}
function drawChart() {
    const ctx = document.getElementById('mainChart').getContext('2d');
    // Filtering a series must not move the surviving lines along the time axis.
    const indicatorYears = [...new Set(explorerRawScores.filter(row => row.year != null && Number.isFinite(Number(row.year)))
        .map(row => Number(row.year)))].sort((a,b) => a-b);
    const trendYears = indicatorYears.length ? indicatorYears : currentChartYears;
    
    const trendProvs = activeDatasets.filter(name => name !== 'کل کشور');
    let desiredLabels = trendProvs.slice();
    let countrySeries = getChartSeries('کل کشور', trendYears);
    let hasCountry = countrySeries.some(v => v !== null);
    
    if(hasCountry) {
        desiredLabels.unshift('میانگین کل کشور');
    }

    if (!chartInstance) {
        const datasets = [];
        if(hasCountry) {
            datasets.push({
                label: 'میانگین کل کشور', data: countrySeries,
                borderColor: '#1e293b', backgroundColor: 'rgba(30, 41, 59, 0.05)',
                borderWidth: 4, borderJoinStyle: 'round', borderCapStyle: 'round', tension: 0.4, fill: true, order: 1,
                borderDash: [8, 4],
                hidden: hiddenDatasets['میانگین کل کشور'] === true,
                animation: false,
                sweepProgress: 0 
            });
        }
        
        trendProvs.forEach((prov) => {
            datasets.push({
                label: prov, data: getChartSeries(prov, trendYears),
                borderColor: provinceColors[prov], borderWidth: 2.5, borderJoinStyle: 'round', borderCapStyle: 'round',
                tension: 0.4, fill: false, pointBackgroundColor: 'white', pointBorderColor: provinceColors[prov], pointBorderWidth: 2, order: 2,
                animation: false,
                sweepProgress: 0
            });
        });

        chartInstance = new Chart(ctx, {
            type: 'line',
            data: { labels: trendYears.map(toFa), datasets: datasets },
            options: getChartOptions() 
        });

        startSweep(chartInstance);
    } else {
        let existingDatasets = chartInstance.data.datasets;
        
        for (let i = existingDatasets.length - 1; i >= 0; i--) {
            if (!desiredLabels.includes(existingDatasets[i].label)) {
                existingDatasets.splice(i, 1);
            }
        }
        
        existingDatasets.forEach(ds => {
            ds.data = ds.label === 'میانگین کل کشور' ? countrySeries : getChartSeries(ds.label, trendYears);
        });
        
        let existingLabels = existingDatasets.map(d => d.label);

        if (hasCountry && !existingLabels.includes('میانگین کل کشور')) {
            existingDatasets.unshift({
                label: 'میانگین کل کشور', data: countrySeries,
                borderColor: '#1e293b', backgroundColor: 'rgba(30, 41, 59, 0.05)',
                borderWidth: 4, borderJoinStyle: 'round', borderCapStyle: 'round', tension: 0.4, fill: true, order: 1,
                borderDash: [8, 4],
                hidden: hiddenDatasets['میانگین کل کشور'] === true,
                animation: false,
                sweepProgress: 0
            });
        }

        trendProvs.forEach((prov) => {
            if (!existingLabels.includes(prov)) {
                existingDatasets.push({
                    label: prov, data: getChartSeries(prov, trendYears),
                    borderColor: provinceColors[prov], borderWidth: 2.5, borderJoinStyle: 'round', borderCapStyle: 'round',
                    tension: 0.4, fill: false, pointBackgroundColor: 'white', pointBorderColor: provinceColors[prov], pointBorderWidth: 2, order: 2,
                    animation: false,
                    sweepProgress: 0 
                });
            }
        });

        chartInstance.data.labels = trendYears.map(toFa);
        Object.assign(chartInstance.options.scales.y, getIndicatorScaleBounds(0.04));
        chartInstance.update('none'); 

        startSweep(chartInstance);
    }
    isBulkAction = false;
    syncCountryLegend();
}

function syncCountryLegend() {
    const btn = document.getElementById('btn-country-legend');
    if (!btn) return;
    const off = hiddenDatasets['میانگین کل کشور'] === true;
    btn.classList.toggle('is-off', off);
    btn.setAttribute('aria-pressed', off ? 'false' : 'true');
}

function toggleCountryLegend() {
    const off = hiddenDatasets['میانگین کل کشور'] !== true;
    hiddenDatasets['میانگین کل کشور'] = off;
    if (chartInstance) {
        const index = chartInstance.data.datasets.findIndex(d => d.label === 'میانگین کل کشور');
        if (index >= 0) {
            if (off) chartInstance.hide(index);
            else chartInstance.show(index);
        }
    }
    syncCountryLegend();
}

function getIndicatorScaleBounds(paddingRatio = 0) {
    let min = Infinity;
    let max = -Infinity;
    // Keep both chart scales fixed across filters, hidden series, and selected years.
    for (const record of explorerRawScores) {
        const raw = record.value;
        if (typeof raw !== 'number' && typeof raw !== 'string') continue;
        if (typeof raw === 'string' && !raw.trim()) continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        min = Math.min(min, value);
        max = Math.max(max, value);
    }
    if (min === Infinity) return { min: undefined, max: undefined };
    if (min === max) {
        const padding = Math.max(Math.abs(min) * 0.05, 1);
        return { min: min - padding, max: max + padding };
    }
    const padding = (max - min) * paddingRatio;
    return { min: min - padding, max: max + padding };
}

function getChartOptions() {
    return {
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 0, 
        animation: false, 
        layout: { padding: 12 },
        datasets: { line: { clip: 12 } },
        interaction: { mode: 'explorerLine', intersect: false, axis: 'xy' },
        plugins: {
            datalabels: { display: false },
            legend: { display: false },
            tooltip: {
                position: 'explorerLine',
                titleFont: { family: 'PeydaFaNumWeb', size: 14 }, bodyFont: { family: 'PeydaFaNumWeb', size: 13, weight: 'bold' }, rtl: true,
                backgroundColor: 'rgba(255, 255, 255, 0.95)', titleColor: '#1f2937', bodyColor: '#1f2937',
                borderColor: '#e5e7eb', borderWidth: 1, padding: 12, boxPadding: 6,
                displayColors: true,
                callbacks: {
                    label: (ctx) => `${ctx.dataset.label ? ctx.dataset.label + ': ' : ''}${formatExplorerNumber(ctx.parsed.y)}`
                }
            }
        },
        scales: {
            x: { ticks: { font: { family: 'PeydaFaNumWeb' }, color: '#64748b' }, grid: { display: false } },
            y: { ...getIndicatorScaleBounds(0.04), ticks: { includeBounds: false, callback: formatExplorerNumber, font: { family: 'PeydaFaNumWeb' }, color: '#64748b' }, grid: { color: '#e2e8f0', drawBorder: false }, border: { dash: [4, 4] } }
        }
    };
}

// Ensure charts resize smoothly across screen sizes
const onExplorerResize = debounce(() => {
    syncExplorerGuide();
    try { if (chartInstance && typeof chartInstance.resize === 'function') chartInstance.resize(); } catch (e) {}
    try { if (scatterProvinceChart && typeof scatterProvinceChart.resize === 'function') scatterProvinceChart.resize(); } catch (e) {}
    if (currentChartMode === 'map' && explorerLeafletMap) renderExplorerMap();
    const layout = mosaicLayout();
    const nextKey = String(layout.cols);
    if (isLandingVisible() && nextKey !== mosaicLayoutKey) {
        mosaicLayoutKey = nextKey;
        renderMosaicMenu();
    } else if (typeof ScrollTrigger !== 'undefined') {
        ScrollTrigger.refresh();
    }
}, 150);
window.addEventListener('resize', onExplorerResize);

function bindExplorerChrome() {
    bindExplorerMapLegend();
    bindExplorerDropdowns();
    const back = document.getElementById('btn-nav-subtopics');
    if (back) back.addEventListener('click', goBackToLanding);
    const trend = document.getElementById('btn-chart-trend');
    if (trend) trend.addEventListener('click', () => setChartMode('trend'));
    const compare = document.getElementById('btn-chart-compare');
    if (compare) compare.addEventListener('click', () => setChartMode('compare'));
    const table = document.getElementById('btn-chart-table');
    if (table) table.addEventListener('click', () => setChartMode('table'));
    const map = document.getElementById('btn-chart-map');
    if (map) map.addEventListener('click', () => setChartMode('map'));
    const mapPlay = document.getElementById('btn-explorer-map-play');
    if (mapPlay) mapPlay.addEventListener('click', toggleExplorerMapPlayback);
    const compareTimeline = document.getElementById('explorer-compare-timeline');
    if (compareTimeline) compareTimeline.addEventListener('input', () => {
        explorerCompareYearIndex = Number(compareTimeline.value);
        if (currentChartMode === 'compare') drawScatterProvince();
    });
    const mapTimeline = document.getElementById('explorer-map-timeline');
    if (mapTimeline) mapTimeline.addEventListener('input', () => {
        stopExplorerMapPlayback();
        explorerMapYearIndex = Number(mapTimeline.value);
        if (currentChartMode === 'map') renderExplorerMap();
    });
    const search = document.getElementById('province-search');
    if (search) search.addEventListener('input', filterProvinces);
    const selectAll = document.getElementById('btn-select-all-provinces');
    if (selectAll) selectAll.addEventListener('click', selectAllProvinces);
    const clearAll = document.getElementById('btn-clear-all-provinces');
    if (clearAll) clearAll.addEventListener('click', clearAllProvinces);
    const countryLegend = document.getElementById('btn-country-legend');
    if (countryLegend) countryLegend.addEventListener('click', toggleCountryLegend);
    document.querySelectorAll('[data-explorer-tab]').forEach(button => button.addEventListener('click', () => {
        const tab = button.dataset.explorerTab;
        setChartMode(tab === 'chart' ? explorerChartType : tab);
    }));
    document.getElementById('btn-toggle-chart-type').addEventListener('click', () =>
        setChartMode(explorerChartType === 'trend' ? 'compare' : 'trend'));

}

function startExplorer() {
    if (applyChartDefaults()) registerExplorerChartPlugin();
    else showNotice('مشکل در بارگذاری نمودار.');
    bindExplorerChrome();

    function go() {
        loadExplorerData();
    }
    if (typeof window.binaWhenAuthReady === 'function') {
        window.binaWhenAuthReady(function (ok) {
            if (ok) go();
        });
        return;
    }
    go();
}

onReady(startExplorer);
