// File: explorer.js
// Purpose: JavaScript for the Explorer (landing & subtopics) page.
//   Provides UI logic for the staggered mosaic landing, subtopic cards, indicator charts,
//   lazy-loading of large background images, and search suggestions.
// Notes: Comments standardized to English; Persian UI strings are not modified.

// -- Explorer page initialization --
function registerExplorerChartPlugin() {
    if (typeof Chart === 'undefined' || registerExplorerChartPlugin._done) return;
    registerExplorerChartPlugin._done = true;
    Chart.register({
    id: 'lineSweepPlugin',
    beforeDatasetDraw(chart, args) {
        const ds = chart.data.datasets[args.index];
        if (ds.sweepProgress !== undefined && ds.sweepProgress < 1) {
            const ctx = chart.ctx;
            const { top, left, width, height } = chart.chartArea;
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top - 20, width * ds.sweepProgress, height + 40);
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

let sweepReq = null;
let sweepStartTime = null;

function startSweep(chart) {
    if (sweepReq) cancelAnimationFrame(sweepReq);
    sweepStartTime = null;
    
    let datasetsToSweep = chart.data.datasets.filter(ds => ds.sweepProgress !== undefined && ds.sweepProgress < 1);
    if(datasetsToSweep.length === 0) return;
    
    function animate(timestamp) {
        if (!sweepStartTime) sweepStartTime = timestamp;
        let progress = (timestamp - sweepStartTime) / 1500; 
        
        if (progress >= 1) {
            datasetsToSweep.forEach(ds => ds.sweepProgress = 1);
            chart.draw();
            return;
        }
        
        let curvedProgress = 1 - Math.pow(1 - progress, 3); 
        datasetsToSweep.forEach(ds => ds.sweepProgress = curvedProgress);
        chart.draw();
        sweepReq = requestAnimationFrame(animate);
    }
    sweepReq = requestAnimationFrame(animate);
}

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
let explorerMapGeoLayer = null;
let explorerMapLabelsLayer = null;
let explorerMapFitted = false;
let explorerSelectedProvince = null;
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
    try {
        const response = await fetch(`${API_BASE_URL}/api/explorer/init`, { credentials: 'include' });
        if (response.status === 401 || response.status === 403) {
            setAuthNext({ page: 'explorer', search: window.location.search || '' });
            window.location.replace(authLoginUrl());
            return;
        }
        const data = await response.json();

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

        if (queryIndicator && queryTopic) {
            if (querySource === 'search') {
                const navSubtopicsBtn = document.getElementById('btn-nav-subtopics');
                if (navSubtopicsBtn) navSubtopicsBtn.style.display = 'none';
            }
            setTimeout(() => loadIndicator(queryIndicator, queryTopic), 50);
        } else if (queryOpenTopic) {
            openTopicIndex(queryOpenTopic);
        }

    } catch (err) {
        console.error("Error Loading API Data", err);
        showNotice("مشکل در ارتباط با سرور.");
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
    return Object.keys(topicsHierarchy[topic] || {});
}

function indicatorsOf(topic, subtopic) {
    const list = (topicsHierarchy[topic] || {})[subtopic];
    return Array.isArray(list) ? list : [];
}

function findSubtopicForIndicator(topic, indicator) {
    const subs = topicsHierarchy[topic] || {};
    for (const [sub, list] of Object.entries(subs)) {
        if (list && list.indexOf(indicator) !== -1) return sub;
    }
    return subtopicsOf(topic)[0] || '';
}

function closeExplorerDropdowns() {
    document.querySelectorAll('.ex-dd').forEach(dd => {
        dd.classList.remove('is-open');
        const btn = dd.querySelector('.ex-dd-toggle');
        const menu = dd.querySelector('.ex-dd-menu');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        if (menu) menu.hidden = true;
    });
}

function fillDropdownMenu(menu, items, current, onPick, iconForItem = null) {
    if (!menu) return;
    menu.replaceChildren();
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item;
        if (item === current) btn.className = 'is-current';
        if (iconForItem) {
            const icon = document.createElement('img');
            icon.className = 'ex-dd-topic-icon';
            icon.src = iconForItem(item);
            icon.alt = '';
            icon.width = 24;
            icon.height = 24;
            icon.decoding = 'async';
            const label = document.createElement('span');
            label.className = 'ex-dd-topic-label';
            label.textContent = item;
            btn.classList.add('ex-dd-topic-item');
            btn.replaceChildren(icon, label);
        }
        btn.addEventListener('click', () => {
            closeExplorerDropdowns();
            onPick(item);
        });
        menu.appendChild(btn);
    });
}

function explorerDropdownWidthOptions(kind) {
    const topics = Object.keys(topicsHierarchy);
    if (kind === 'topic') return topics;
    const subtopics = Object.values(topicsHierarchy).flatMap(subs => Object.keys(subs || {}));
    if (kind === 'subtopic') return [...new Set(subtopics)];
    if (kind === 'indicator') {
        return [...new Set(Object.values(topicsHierarchy).flatMap(subs =>
            Object.values(subs || {}).flatMap(items => Array.isArray(items) ? items : [])
        ))];
    }
    return [];
}

function sizeExplorerDropdowns() {
    document.querySelectorAll('.ex-dd').forEach(dropdown => {
        const toggle = dropdown.querySelector('.ex-dd-toggle');
        const menu = dropdown.querySelector('.ex-dd-menu');
        if (!toggle || !menu) return;
        const measure = toggle.cloneNode(true);
        measure.removeAttribute('id');
        measure.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        measure.setAttribute('aria-hidden', 'true');
        measure.tabIndex = -1;
        Object.assign(measure.style, {
            position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
            width: 'max-content', maxWidth: 'none', minWidth: '0', fontWeight: '700'
        });
        const label = measure.querySelector('.ex-dd-value');
        if (!label) return;
        label.style.flex = '0 0 auto';
        label.textContent = '';
        dropdown.appendChild(measure);
        try {
            let width = measure.getBoundingClientRect().width;
            // Measure the full catalog, not the options filtered by the current selection.
            const catalog = explorerDropdownWidthOptions(dropdown.dataset.dd);
            const options = catalog.length ? catalog : [...menu.querySelectorAll('button')].map(option => option.textContent);
            options.forEach(text => {
                label.textContent = text;
                width = Math.max(width, measure.getBoundingClientRect().width);
            });
            if (width > 0) dropdown.style.setProperty('--ex-dd-width', Math.ceil(width) + 'px');
        } finally {
            measure.remove();
        }
    });
}

function syncExplorerDropdowns() {
    const topic = activeTopicGlob || '';
    const sub = activeSubtopicGlob || findSubtopicForIndicator(topic, activeIndicatorGlob);
    activeSubtopicGlob = sub;
    const topicVal = document.getElementById('dd-topic-value');
    const subVal = document.getElementById('dd-subtopic-value');
    const indVal = document.getElementById('dd-indicator-value');
    if (topicVal) topicVal.textContent = topic || '—';
    if (subVal) subVal.textContent = sub || '—';
    if (indVal) indVal.textContent = activeIndicatorGlob || '—';
    fillDropdownMenu(document.getElementById('dd-topic-menu'), explorerTopicsInAtlasOrder(), topic, nextTopic => {
        openTopicIndex(nextTopic);
    }, item => SITE.asset(`images/تاپیک ${item}.webp`));
    fillDropdownMenu(document.getElementById('dd-subtopic-menu'), subtopicsOf(topic), sub, nextSub => {
        const first = indicatorsOf(topic, nextSub)[0];
        if (first) loadIndicator(first, topic);
    });
    fillDropdownMenu(document.getElementById('dd-indicator-menu'), indicatorsOf(topic, sub), activeIndicatorGlob, nextInd => {
        loadIndicator(nextInd, topic);
    });
    sizeExplorerDropdowns();
}

function placeMobileDropdown(btn, menu) {
    if (!window.matchMedia('(max-width: 767px)').matches) {
        menu.style.position = '';
        menu.style.top = '';
        menu.style.left = '';
        menu.style.right = '';
        menu.style.width = '';
        menu.style.maxWidth = '';
        menu.style.zIndex = '';
        return;
    }
    const head = document.querySelector('#view-dashboard .ex-dash-head') || btn;
    const box = head.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = Math.round(box.bottom + 6) + 'px';
    menu.style.left = '10px';
    menu.style.right = '10px';
    menu.style.width = 'auto';
    menu.style.maxWidth = 'none';
    menu.style.zIndex = '4000';
}

function bindExplorerDropdowns() {
    document.querySelectorAll('.ex-dd').forEach(dd => {
        const btn = dd.querySelector('.ex-dd-toggle');
        const menu = dd.querySelector('.ex-dd-menu');
        if (!btn || !menu) return;
        btn.addEventListener('click', event => {
            event.stopPropagation();
            const open = dd.classList.contains('is-open');
            closeExplorerDropdowns();
            if (!open) {
                dd.classList.add('is-open');
                btn.setAttribute('aria-expanded', 'true');
                menu.hidden = false;
                placeMobileDropdown(btn, menu);
            }
        });
        menu.addEventListener('click', event => event.stopPropagation());
    });
    document.addEventListener('click', closeExplorerDropdowns);
    window.addEventListener('resize', debounce(sizeExplorerDropdowns, 150));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizeExplorerDropdowns);
}

function openTopicIndex(topic) {
    if (!topic) return;
    applyExplorerTheme(topic);
    const indicator = firstTopicIndicator(topic);
    if (!indicator) {
        showNotice('شاخصی برای این موضوع نیست.');
        return;
    }
    loadIndicator(indicator, topic);
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
    if (!container) return;
    const gen = ++mosaicRenderGen;

    killMosaicAnimations();
    const topics = mosaicTopics();
    if (!topics.length) {
        container.innerHTML = '';
        return;
    }

    const layout = mosaicLayout();
    mosaicLayoutKey = String(layout.cols);
    setTopicChrome('#a18447');

    const topicCards = topics.map((topic, i) => topicFlipHtml(topic, i, layout.cols)).join('');
    const rows = Math.max(1, Math.ceil(topics.length / layout.cols));

    container.className = 'ex-stage is-pending';
    container.innerHTML = `
        <section class="ex-hero">
            <h1 class="ex-title">کاوشگر داده</h1>
            <p class="ex-lead">برای دیدن شاخص‌ها یکی از زیرحوزه‌ها را انتخاب کنید</p>
        </section>
        <div class="ex-topics" style="--ex-cols:${layout.cols};--ex-rows:${rows}">${topicCards}</div>
    `;

    container.querySelectorAll('.ex-room').forEach(card => {
        const topic = card.dataset.topic;
        if (!topic) return;
        card.style.setProperty('--topic-accent', topicAccent(topic));
        const photo = card.querySelector('.ex-room-photo');
        if (photo) photo.style.backgroundImage = cssUrl(topicTileSrc(topic));
    });
    bindMosaicInteractions(container);

    if (window.matchMedia('(max-width: 767px)').matches) {
        container.classList.remove('is-pending');
        return;
    }

    Promise.race([
        waitForMosaicImages(container),
        new Promise(resolve => setTimeout(resolve, 2500))
    ]).then(() => {
        if (gen !== mosaicRenderGen) return;
        initStaggeredAnimations(container);
    });
}

async function loadIndicator(indicatorName, topicName) {
    const request = ++explorerIndicatorRequest;
    activeIndicatorGlob = indicatorName;
    if (topicName) activeTopicGlob = topicName;
    if (activeTopicGlob) applyExplorerTheme(activeTopicGlob);
    
    killMosaicAnimations();
    document.getElementById('view-landing').style.display = 'none';
    document.getElementById('view-dashboard').classList.remove('hidden');
    document.getElementById('indicator-title').innerText = indicatorName;
    activeSubtopicGlob = findSubtopicForIndicator(activeTopicGlob, indicatorName);
    syncExplorerDropdowns();

    try {
        const response = await fetch(`${API_BASE_URL}/api/explorer/indicator?name=${encodeURIComponent(indicatorName)}`, { credentials: 'include' });
        if (response.status === 401 || response.status === 403) {
            setAuthNext({ page: 'explorer', search: window.location.search || '' });
            window.location.replace(authLoginUrl());
            return;
        }
        const data = await response.json();
        if (request !== explorerIndicatorRequest) return;

        let srcName = data.description && data.description.source_name ? data.description.source_name : "مرکز آمار و مراجع رسمی";
        let narrative = data.description && data.description.description ? data.description.description : "توضیحات تکمیلی برای این شاخص در دسترس نیست.";
        
        document.getElementById('indicator-source').textContent = `منبع: ${srcName}`;
        document.getElementById('insight-text').innerText = narrative;

        kscoreData = data.scores;
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
            document.getElementById('indicator-period').textContent = `دوره: ${toFa(uniqueYears[0])} — ${toFa(uniqueYears[uniqueYears.length-1])}`;
        } else {
            document.getElementById('indicator-period').textContent = 'دوره: نامشخص';
        }

        if (chartInstance) {
            chartInstance.destroy();
            chartInstance = null;
        }
        if (scatterProvinceChart) {
            scatterProvinceChart.destroy();
            scatterProvinceChart = null;
        }

        activeDatasets = [];
        hiddenDatasets = {};
        document.querySelectorAll('.province-checkbox').forEach(cb => { cb.checked = false; });

        isBulkAction = true;
        setChartMode(currentChartMode);

    } catch (err) {
        console.error("Error fetching indicator data", err);
    }
}

function goBackToLanding() {
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
    if (currentChartMode === 'compare') drawScatterProvince();
    else if (currentChartMode === 'table') renderIndicatorTable();
    else if (currentChartMode === 'map') renderExplorerMap();
    else drawChart();
}

function setChartMode(mode) {
    const nextMode = ['trend', 'compare', 'table', 'map'].includes(mode) ? mode : 'trend';
    if (nextMode !== 'map') stopExplorerMapPlayback();
    currentChartMode = nextMode;
    const trendBtn = document.getElementById('btn-chart-trend');
    const compareBtn = document.getElementById('btn-chart-compare');
    const tableBtn = document.getElementById('btn-chart-table');
    const mapBtn = document.getElementById('btn-chart-map');
    const trendWrap = document.getElementById('trend-chart-wrap');
    const compareWrap = document.getElementById('compare-chart-wrap');
    const tableWrap = document.getElementById('table-chart-wrap');
    const mapWrap = document.getElementById('map-chart-wrap');
    const title = document.getElementById('chart-panel-title');
    if (trendBtn) trendBtn.classList.toggle('active', currentChartMode === 'trend');
    if (compareBtn) compareBtn.classList.toggle('active', currentChartMode === 'compare');
    if (tableBtn) tableBtn.classList.toggle('active', currentChartMode === 'table');
    if (mapBtn) mapBtn.classList.toggle('active', currentChartMode === 'map');
    if (trendWrap) trendWrap.classList.toggle('is-active', currentChartMode === 'trend');
    if (compareWrap) compareWrap.classList.toggle('is-active', currentChartMode === 'compare');
    if (tableWrap) tableWrap.classList.toggle('is-active', currentChartMode === 'table');
    if (mapWrap) mapWrap.classList.toggle('is-active', currentChartMode === 'map');
    setProvinceFilterEnabled(currentChartMode === 'trend');
    if (title) {
        if (currentChartMode === 'compare') {
            const year = getComparisonYear();
            const yearTxt = year != null ? ` — سال ${toFa(year)}` : '';
            title.textContent = `مقایسه استانی${yearTxt}`;
        } else if (currentChartMode === 'table') title.textContent = 'جدول امتیاز استان‌ها بر اساس سال';
        else if (currentChartMode === 'map') title.textContent = 'پراکندگی جغرافیایی امتیاز استان‌ها';
        else title.textContent = 'روند تغییرات زمانی شاخص';
    }
    const countryLegend = document.getElementById('btn-country-legend');
    if (countryLegend) countryLegend.hidden = currentChartMode !== 'trend';
    if (activeIndicatorGlob) refreshActiveChart();
    requestAnimationFrame(() => {
        try { if (currentChartMode === 'trend' && chartInstance) chartInstance.resize(); } catch (e) {}
        try { if (currentChartMode === 'compare' && scatterProvinceChart) scatterProvinceChart.resize(); } catch (e) {}
    });
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
    const title = document.getElementById('chart-panel-title');
    if (title && currentChartMode === 'compare') {
        title.textContent = 'مقایسه استانی' + (year != null ? ` — سال ${toFa(year)}` : '');
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

    if (scatterProvinceChart) {
        scatterProvinceChart.data.datasets[0].data = data;
        scatterProvinceChart.data.datasets[0].backgroundColor = colors;
        scatterProvinceChart.options.scales.x.min = scatterXMin;
        scatterProvinceChart.options.scales.x.max = scatterXMax;
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
                        label: (ctx) => `امتیاز: ${toFaFixed(ctx.parsed.y, 2)}`
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
                        text: 'استان',
                        font: { family: 'PeydaFaNumWeb', size: 12, weight: 'bold' },
                        color: '#4b5563'
                    }
                },
                y: {
                    ticks: {
                        font: { family: 'PeydaFaNumWeb' },
                        color: '#64748b',
                        callback: (v) => toFaFixed(v, 2)
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

function getChartSeries(provName) {
    let records = kscoreData.filter(d => d.province_name === provName);
    return currentChartYears.map(y => {
        let rec = records.find(r => Number(r.year) === y);
        return rec ? Number(rec.value) : null;
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
    provinceHeader.textContent = 'استان';
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
        const score = Number(record.value);
        if (record.province_name === 'کل کشور' || !Number.isFinite(year) || !Number.isFinite(score)) return;
        scoresByProvinceYear.set(`${record.province_name}\u0000${year}`, score);
    });

    provincesList.forEach(provinceName => {
        const row = document.createElement('tr');
        const provinceCell = document.createElement('th');
        provinceCell.scope = 'row';
        provinceCell.className = 'indicator-table-province';
        provinceCell.textContent = provinceName;
        row.appendChild(provinceCell);
        currentChartYears.forEach(year => {
            const cell = document.createElement('td');
            const score = scoresByProvinceYear.get(`${provinceName}\u0000${year}`);
            cell.textContent = Number.isFinite(score) ? toFaFixed(score, 2) : '—';
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
    if (!status) return;
    status.textContent = message || '';
    status.hidden = !visible;
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
    minLabel.textContent = hasValues ? toFaFixed(min, 2) : '—';
    maxLabel.textContent = hasValues ? toFaFixed(max, 2) : '—';
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

function initExplorerLeafletMap() {
    if (explorerLeafletMap) return Promise.resolve(explorerLeafletMap);
    if (explorerMapInitPromise) return explorerMapInitPromise;
    explorerMapInitPromise = (async () => {
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
            zoomControl: true, scrollWheelZoom: true, doubleClickZoom: true,
            touchZoom: true, boxZoom: true, keyboard: true, attributionControl: true,
            // Neshan dreamy tiles are available from zoom 4.
            minZoom: 4, maxZoom: 9, zoomSnap: 0.25
        }).setView([32, 53], 5);
        explorerLeafletMap.attributionControl.setPrefix(false);
        explorerLeafletMap.on('click', clearExplorerMapSelection);
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
    value.style.left = String(maxIndex ? (activeIndex / maxIndex) * 100 : 0) + '%';
}

function updateExplorerMapPlaybackControl() {
    const button = document.getElementById('btn-explorer-map-play');
    if (!button) return;
    const playing = explorerMapPlaybackTimer !== null;
    button.setAttribute('aria-pressed', playing ? 'true' : 'false');
    button.setAttribute('aria-label', playing ? 'توقف پخش سال‌ها' : 'پخش سال‌ها');
    const label = button.querySelector('span'); if (label) label.textContent = playing ? 'توقف' : 'پخش سال‌ها';
    const icon = button.querySelector('i'); if (icon) { icon.classList.toggle('fa-play', !playing); icon.classList.toggle('fa-pause', playing); }
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
    if (!currentChartYears.length) { setExplorerMapStatus('برای این شاخص، دادهٔ سالانه‌ای موجود نیست.', true); return; }
    if (!explorerMapGeoJson || !explorerLeafletMap) {
        setExplorerMapStatus('در حال بارگذاری نقشه...', true);
        ensureExplorerMapGeoJson().then(() => initExplorerLeafletMap()).then(() => { if (currentChartMode === 'map') renderExplorerMap(); }).catch(error => {
            console.error('Unable to load Explorer map data', error);
            if (currentChartMode === 'map') setExplorerMapStatus('بارگذاری نقشه ممکن نشد. لطفاً صفحه را دوباره بارگذاری کنید.', true);
        });
        return;
    }
    const map = explorerLeafletMap;
    explorerMapYearIndex = Math.min(Math.max(explorerMapYearIndex, 0), currentChartYears.length - 1);
    const year = currentChartYears[explorerMapYearIndex], scores = new Map();
    kscoreData.forEach(record => {
        if (Number(record.year) !== Number(year)) return;
        const key = normalizeMapProvinceName(record.province_name), score = Number(record.value);
        if (key && key !== NATIONAL_PROVINCE_KEY && Number.isFinite(score)) scores.set(key, score);
    });
    const allValues = kscoreData.filter(record => normalizeMapProvinceName(record.province_name) !== NATIONAL_PROVINCE_KEY).map(record => Number(record.value)).filter(Number.isFinite);
    const min = allValues.length ? Math.min(...allValues) : 0;
    const max = allValues.length ? Math.max(...allValues) : 1;
    map.invalidateSize({ animate: false, pan: false });
    if (!explorerMapFitted && explorerMapBounds) { map.fitBounds(explorerMapBounds, { padding: [38, 30], animate: false }); explorerMapFitted = true; }
    if (explorerMapGeoLayer) explorerMapGeoLayer.remove();
    if (explorerMapLabelsLayer) explorerMapLabelsLayer.remove();
    explorerMapLabelsLayer = L.layerGroup().addTo(map);
    const provinceStyle = feature => {
        const name = feature.properties && (feature.properties.ProvincNam || feature.properties.ADM1_FA || feature.properties.Name);
        const key = normalizeMapProvinceName(name);
        const selected = key === explorerSelectedProvince;
        return {
            color: selected ? '#881337' : '#ffffff', weight: selected ? 3 : 1.25,
            opacity: 1, fillColor: selected ? '#e11d48' : mapColorForScore(scores.get(key), min, max),
            fillOpacity: selected ? 0.9 : 0.78
        };
    };
    explorerMapGeoLayer = L.geoJSON(explorerMapGeoJson, {
        bubblingMouseEvents: false,
        style: provinceStyle,
        onEachFeature: (feature, layer) => {
            const name = (feature.properties && (feature.properties.ProvincNam || feature.properties.ADM1_FA || feature.properties.Name)) || '';
            layer.on('click', () => {
                explorerSelectedProvince = normalizeMapProvinceName(name);
                explorerMapGeoLayer.setStyle(provinceStyle);
                layer.bringToFront();
            });
            const score = scores.get(normalizeMapProvinceName(name));
            const scoreText = Number.isFinite(score) ? `امتیاز: ${toFaFixed(score, 2)}` : 'داده‌ای ثبت نشده است';
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
    setExplorerMapStatus('', false);
    updateExplorerMapPlaybackControl();
}
function drawChart() {
    const ctx = document.getElementById('mainChart').getContext('2d');
    
    const trendProvs = activeDatasets.slice();
    let desiredLabels = trendProvs.slice();
    let countrySeries = getChartSeries('کل کشور');
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
                label: prov, data: getChartSeries(prov),
                borderColor: provinceColors[prov], borderWidth: 2.5, borderJoinStyle: 'round', borderCapStyle: 'round',
                tension: 0.4, fill: false, pointBackgroundColor: 'white', pointBorderColor: provinceColors[prov], pointBorderWidth: 2, order: 2,
                animation: false,
                sweepProgress: 0
            });
        });

        chartInstance = new Chart(ctx, {
            type: 'line',
            data: { labels: currentChartYears.map(toFa), datasets: datasets },
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
            if (isBulkAction) ds.sweepProgress = 0;
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
                    label: prov, data: getChartSeries(prov),
                    borderColor: provinceColors[prov], borderWidth: 2.5, borderJoinStyle: 'round', borderCapStyle: 'round',
                    tension: 0.4, fill: false, pointBackgroundColor: 'white', pointBorderColor: provinceColors[prov], pointBorderWidth: 2, order: 2,
                    animation: false,
                    sweepProgress: 0 
                });
            }
        });

        chartInstance.data.labels = currentChartYears.map(toFa);
        Object.assign(chartInstance.options.scales.y, getTrendScaleBounds());
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

function getTrendScaleBounds() {
    let min = Infinity;
    let max = -Infinity;
    // Use the whole indicator, independently of selected or hidden province series.
    for (const record of kscoreData) {
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
    return { min, max };
}

function getChartOptions() {
    return {
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 0, 
        animation: false, 
        interaction: { mode: 'nearest', intersect: true, axis: 'xy' },
        plugins: {
            datalabels: { display: false },
            legend: { display: false },
            tooltip: {
                titleFont: { family: 'PeydaFaNumWeb', size: 14 }, bodyFont: { family: 'PeydaFaNumWeb', size: 13, weight: 'bold' }, rtl: true,
                backgroundColor: 'rgba(255, 255, 255, 0.95)', titleColor: '#1f2937', bodyColor: '#1f2937',
                borderColor: '#e5e7eb', borderWidth: 1, padding: 12, boxPadding: 6,
                displayColors: true
            }
        },
        scales: {
            x: { ticks: { font: { family: 'PeydaFaNumWeb' }, color: '#64748b' }, grid: { display: false } },
            y: { ...getTrendScaleBounds(), ticks: { font: { family: 'PeydaFaNumWeb' }, color: '#64748b' }, grid: { color: '#e2e8f0', drawBorder: false }, border: { dash: [4, 4] } }
        }
    };
}

// Ensure charts resize smoothly across screen sizes
const onExplorerResize = debounce(() => {
    closeExplorerDropdowns();
    try { if (chartInstance && typeof chartInstance.resize === 'function') chartInstance.resize(); } catch (e) {}
    try { if (scatterProvinceChart && typeof scatterProvinceChart.resize === 'function') scatterProvinceChart.resize(); } catch (e) {}
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
    const insightLayer = document.getElementById('insight-layer');
    const countryLegend = document.getElementById('btn-country-legend');
    if (countryLegend) countryLegend.addEventListener('click', toggleCountryLegend);
    const openInsight = document.getElementById('btn-open-insight');
    const closeInsight = document.getElementById('btn-close-insight');
    function setInsightOpen(on) {
        if (!insightLayer) return;
        insightLayer.hidden = !on;
    }
    if (openInsight) openInsight.addEventListener('click', () => setInsightOpen(true));
    if (closeInsight) closeInsight.addEventListener('click', () => setInsightOpen(false));
    if (insightLayer) {
        insightLayer.addEventListener('click', (event) => {
            if (event.target === insightLayer) setInsightOpen(false);
        });
    }
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
