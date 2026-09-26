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
let activeTopicGlob = null;
let activeSubtopicGlob = null;
let currentChartYears = [];
let currentChartMode = 'trend';
let latestYearGlob = null;
let latestScoresGlob = [];

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
        const response = await fetch(`${API_BASE_URL}/api/explorer/init`);
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

function topicTileSrc(topic) {
    return encodeURI(SITE.asset(`images/${topic}-tile.webp`));
}

function mosaicLayout() {
    const n = mosaicTopics().length || 9;
    const w = window.innerWidth;
    if (w < 640) return { cols: 1 };
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

function fillDropdownMenu(menu, items, current, onPick) {
    if (!menu) return;
    menu.replaceChildren();
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item;
        if (item === current) btn.className = 'is-current';
        btn.addEventListener('click', () => {
            closeExplorerDropdowns();
            onPick(item);
        });
        menu.appendChild(btn);
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
    fillDropdownMenu(document.getElementById('dd-topic-menu'), mosaicTopics(), topic, nextTopic => {
        openTopicIndex(nextTopic);
    });
    fillDropdownMenu(document.getElementById('dd-subtopic-menu'), subtopicsOf(topic), sub, nextSub => {
        const first = indicatorsOf(topic, nextSub)[0];
        if (first) loadIndicator(first, topic);
    });
    fillDropdownMenu(document.getElementById('dd-indicator-menu'), indicatorsOf(topic, sub), activeIndicatorGlob, nextInd => {
        loadIndicator(nextInd, topic);
    });
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
            }
        });
        menu.addEventListener('click', event => event.stopPropagation());
    });
    document.addEventListener('click', closeExplorerDropdowns);
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
    if (typeof gsap === 'undefined' || !isLandingVisible()) {
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

    Promise.race([
        waitForMosaicImages(container),
        new Promise(resolve => setTimeout(resolve, 2500))
    ]).then(() => {
        if (gen !== mosaicRenderGen) return;
        initStaggeredAnimations(container);
    });
}

async function loadIndicator(indicatorName, topicName) {
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
        const response = await fetch(`${API_BASE_URL}/api/explorer/indicator?name=${encodeURIComponent(indicatorName)}`);
        const data = await response.json();

        let srcName = data.description && data.description.source_name ? data.description.source_name : "مرکز آمار و مراجع رسمی";
        let narrative = data.description && data.description.description ? data.description.description : "توضیحات تکمیلی برای این شاخص در دسترس نیست.";
        
        document.getElementById('indicator-source').textContent = `منبع: ${srcName}`;
        document.getElementById('insight-text').innerText = narrative;

        kscoreData = data.scores;
        latestYearGlob = data.latest_year != null ? Number(data.latest_year) : null;
        latestScoresGlob = Array.isArray(data.latest_scores) ? data.latest_scores : [];
        
        let uniqueYears = [...new Set(kscoreData.map(d => Number(d.year)))].sort((a,b)=>a-b);
        currentChartYears = uniqueYears;
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
        setTimeout(() => setChartMode('trend'), 50);

    } catch (err) {
        console.error("Error fetching indicator data", err);
    }
}

function goBackToLanding() {
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
    else drawChart();
}

function setChartMode(mode) {
    currentChartMode = mode === 'compare' ? 'compare' : 'trend';
    const trendBtn = document.getElementById('btn-chart-trend');
    const compareBtn = document.getElementById('btn-chart-compare');
    const trendWrap = document.getElementById('trend-chart-wrap');
    const compareWrap = document.getElementById('compare-chart-wrap');
    const title = document.getElementById('chart-panel-title');
    if (trendBtn) trendBtn.classList.toggle('active', currentChartMode === 'trend');
    if (compareBtn) compareBtn.classList.toggle('active', currentChartMode === 'compare');
    if (trendWrap) trendWrap.classList.toggle('is-active', currentChartMode === 'trend');
    if (compareWrap) compareWrap.classList.toggle('is-active', currentChartMode === 'compare');
    setProvinceFilterEnabled(currentChartMode === 'trend');
    if (title) {
        if (currentChartMode === 'compare') {
            const yearTxt = latestYearGlob != null ? ` — سال ${toFa(latestYearGlob)}` : '';
            title.textContent = `مقایسه استانی آخرین سال${yearTxt}`;
        } else {
            title.textContent = 'روند تغییرات زمانی شاخص';
        }
    }
    if (activeIndicatorGlob) refreshActiveChart();
    requestAnimationFrame(() => {
        try { if (currentChartMode === 'trend' && chartInstance) chartInstance.resize(); } catch (e) {}
        try { if (currentChartMode === 'compare' && scatterProvinceChart) scatterProvinceChart.resize(); } catch (e) {}
    });
}

let scatterPointsCache = [];

function getLatestPoints() {
    let rows = Array.isArray(latestScoresGlob) ? latestScoresGlob.slice() : [];
    if (!rows.length && latestYearGlob != null) {
        rows = kscoreData.filter(d => Number(d.year) === latestYearGlob && d.province_name !== 'کل کشور');
    }
    const byProv = {};
    rows.forEach(r => {
        const val = Number(r.value);
        if (isFinite(val)) byProv[r.province_name] = val;
    });
    return provincesList
        .filter(p => byProv[p] != null)
        .map(p => ({ name: p, value: byProv[p] }));
}

function drawScatterProvince() {
    const canvas = document.getElementById('scatterProvinceChart');
    if (!canvas) return;
    const points = getLatestPoints();
    scatterPointsCache = points;
    const data = points.map((p, i) => ({ x: i, y: p.value, province: p.name, r: 26 }));
    const colors = points.map(p => provinceColors[p.name] || '#3b82f6');

    if (scatterProvinceChart) {
        scatterProvinceChart.data.datasets[0].data = data;
        scatterProvinceChart.data.datasets[0].backgroundColor = colors;
        scatterProvinceChart.options.scales.x.max = Math.max(0.5, points.length - 0.5);
        scatterProvinceChart.update();
        return;
    }

    scatterProvinceChart = new Chart(canvas.getContext('2d'), {
        type: 'bubble',
        data: {
            datasets: [{
                data,
                backgroundColor: colors,
                borderColor: '#ffffff',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                datalabels: {
                    color: '#ffffff',
                    align: 'center',
                    anchor: 'center',
                    textAlign: 'center',
                    clip: false,
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
                    min: -0.6,
                    max: Math.max(0.5, points.length - 0.5),
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
        chartInstance.update('none'); 

        startSweep(chartInstance);
    }
    isBulkAction = false; 
}

function getChartOptions() {
    return {
        responsive: true, maintainAspectRatio: false, 
        animation: false, 
        interaction: { mode: 'nearest', intersect: true, axis: 'xy' },
        plugins: {
            datalabels: { display: false },
            legend: { 
                position: 'bottom', 
                labels: { 
                    font: { family: 'PeydaFaNumWeb', size: 13 }, 
                    usePointStyle: false, 
                    boxWidth: 16,
                    boxHeight: 16,
                    borderRadius: 4,
                    padding: 20,
                    filter: function(item, chart) {
                        return item.text === 'میانگین کل کشور';
                    }
                },
                onClick: function(e, legendItem, legend) {
                    const index = legendItem.datasetIndex;
                    const ci = legend.chart;
                    const labelText = legendItem.text;

                    if (ci.isDatasetVisible(index)) {
                        ci.hide(index);
                        legendItem.hidden = true;
                        hiddenDatasets[labelText] = true; 
                    } else {
                        ci.show(index);
                        legendItem.hidden = false;
                        hiddenDatasets[labelText] = false; 
                    }
                }
            },
            tooltip: {
                titleFont: { family: 'PeydaFaNumWeb', size: 14 }, bodyFont: { family: 'PeydaFaNumWeb', size: 13, weight: 'bold' }, rtl: true,
                backgroundColor: 'rgba(255, 255, 255, 0.95)', titleColor: '#1f2937', bodyColor: '#1f2937',
                borderColor: '#e5e7eb', borderWidth: 1, padding: 12, boxPadding: 6,
                displayColors: true
            }
        },
        scales: {
            x: { ticks: { font: { family: 'PeydaFaNumWeb' }, color: '#64748b' }, grid: { display: false } },
            y: { ticks: { font: { family: 'PeydaFaNumWeb' }, color: '#64748b' }, grid: { color: '#e2e8f0', drawBorder: false }, border: { dash: [4, 4] } }
        }
    };
}

// Ensure charts resize smoothly across screen sizes
const onExplorerResize = debounce(() => {
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
    const search = document.getElementById('province-search');
    if (search) search.addEventListener('input', filterProvinces);
    const selectAll = document.getElementById('btn-select-all-provinces');
    if (selectAll) selectAll.addEventListener('click', selectAllProvinces);
    const clearAll = document.getElementById('btn-clear-all-provinces');
    if (clearAll) clearAll.addEventListener('click', clearAllProvinces);
}

function startExplorer() {
    if (applyChartDefaults()) registerExplorerChartPlugin();
    else showNotice('مشکل در بارگذاری نمودار.');
    bindExplorerChrome();

    loadExplorerData();
}

onReady(startExplorer);