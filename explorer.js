// File: explorer.js
// Purpose: JavaScript for the Explorer (landing & subtopics) page.
//   Provides UI logic for the diagonal landing, subtopic cards, indicator charts,
//   lazy-loading of large background images, and search suggestions.
// Notes: Comments standardized to English; Persian UI strings are not modified.

// -- Explorer page initialization --
if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);
Chart.defaults.font.family = "'Vazirmatn', sans-serif";
// Ensure crisp rendering on high-DPI devices
Chart.defaults.devicePixelRatio = window.devicePixelRatio || 1;

// Debounce utility (local) for resize handling
function debounceLocal(fn, wait) {
    let t;
    return function(...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

// Lazy-background loader for this page
function initLazyBackgrounds(root = document) {
    const lazyEls = Array.from(root.querySelectorAll('[data-bg]'));
    if (lazyEls.length === 0) return;

    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const el = entry.target;
                const url = el.dataset.bg;
                if (url) {
                    el.style.backgroundImage = `url('${url}')`;
                    el.removeAttribute('data-bg');
                    el.classList.remove('bg-placeholder');
                }
                obs.unobserve(el);
            });
        }, { rootMargin: '200px 0px' });

        lazyEls.forEach(el => io.observe(el));
    } else {
        lazyEls.forEach(el => {
            const url = el.dataset.bg;
            if (url) {
                el.style.backgroundImage = `url('${url}')`;
                el.removeAttribute('data-bg');
                el.classList.remove('bg-placeholder');
            }
        });
    }
}

// --- Authentication Check ---
if (!sessionStorage.getItem('dashboard_auth_token')) {
    window.location.replace('log_in.html');
}

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

let ktopicsData = [];
let kdescData = [];
let kscoreData = [];
let topicsColorData = []; 
let topicsHierarchy = {};

let activeDatasets = []; 
let provincesList = [];
let chartInstance = null;
let scatterProvinceChart = null;
let activeIndicatorGlob = null;
let activeTopicGlob = null;
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

function toFa(num) {
    if (num === null || num === undefined) return '';
    return num.toString().replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

function toFaFixed(num, digits = 2) {
    if (num === null || num === undefined || num === '' || !isFinite(Number(num))) return '';
    return toFa(Number(num).toFixed(digits));
}

const API_BASE_URL = 'http://127.0.0.1:8000';

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
            setTimeout(() => expandMosaicTopic(queryOpenTopic), 50);
        }

    } catch (err) {
        console.error("Error Loading API Data", err);
        alert("مشکل در ارتباط با سرور.");
    }
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function topicAccent(topic) {
    const row = topicsColorData.find(t => t.topic_name === topic);
    return (row && (row.master_color || row.upper_color)) || '#0078d7';
}

function applyExplorerTheme(topic) {
    const accent = topicAccent(topic);
    document.documentElement.style.setProperty('--banner-bg', accent);
    document.documentElement.style.setProperty('--topic-accent', accent);
}

function bubbleUrl(topic, subtopic) {
    return `bubble-chart.html?topic=${encodeURIComponent(topic)}&subtopic=${encodeURIComponent(subtopic)}&source=${encodeURIComponent(window.explorerSource || 'atlas')}`;
}

function countTopicIndicators(topic) {
    return Object.values(topicsHierarchy[topic] || {}).reduce((n, list) => n + (list ? list.length : 0), 0);
}

function renderMosaicMenu() {
    const container = document.getElementById('mosaic-menu');
    if (!container) return;
    container.innerHTML = '';

    Object.keys(topicsHierarchy).forEach((topic) => {
        const accent = topicAccent(topic);
        const subtopics = topicsHierarchy[topic] || {};
        const firstSub = Object.keys(subtopics)[0] || '';
        const indCount = countTopicIndicators(topic);

        const tile = document.createElement('article');
        tile.className = 'mosaic-tile';
        tile.dataset.topic = topic;
        tile.style.setProperty('--topic-accent', accent);

        const listHtml = Object.keys(subtopics).map(sub => `
            <div class="mosaic-sub">
                <div class="mosaic-sub-head">
                    <span class="mosaic-sub-name">${escapeHtml(sub)}</span>
                </div>
                ${subtopics[sub].map(ind => `
                    <button type="button" class="mosaic-ind" data-indicator="${escapeHtml(ind)}" data-topic="${escapeHtml(topic)}">
                        <span class="mosaic-ind-dot"></span>
                        <span>${escapeHtml(ind)}</span>
                    </button>
                `).join('')}
            </div>
        `).join('');

        const tileImg = encodeURI(`assets/images/${topic}-tile.webp`);

        tile.innerHTML = `
            <div class="mosaic-photo" style="background-image: url('${tileImg}')"></div>
            <div class="mosaic-face">
                <h2 class="mosaic-title">${escapeHtml(topic)}</h2>
                <p class="mosaic-meta">${toFa(indCount)} شاخص</p>
                <a class="mosaic-bubble-btn" href="${bubbleUrl(topic, firstSub)}">
                    <i class="fa-solid fa-chart-pie"></i>
                    ورود به نمودار حبابی
                </a>
            </div>
            <div class="mosaic-list">
                <div class="mosaic-list-scroll custom-scrollbar">${listHtml}</div>
            </div>
        `;

        tile.addEventListener('mouseenter', () => applyExplorerTheme(topic));
        tile.querySelectorAll('.mosaic-ind').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                loadIndicator(btn.dataset.indicator, btn.dataset.topic);
            });
        });

        container.appendChild(tile);
    });

    const firstTopic = Object.keys(topicsHierarchy)[0];
    if (firstTopic) applyExplorerTheme(firstTopic);
}

function expandMosaicTopic(topic) {
    const container = document.getElementById('mosaic-menu');
    if (!container) return;
    const tile = Array.from(container.querySelectorAll('.mosaic-tile'))
        .find(el => el.dataset.topic === topic);
    if (tile) {
        applyExplorerTheme(topic);
        tile.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
}

function openSubtopics(topic) {
    activeTopicGlob = topic;
    document.getElementById('view-landing').style.display = 'none'; // Ensure explicit hide
    document.getElementById('view-subtopics').classList.remove('hidden');
    
    let tcRow = topicsColorData.find(t => t.topic_name === topic);
    let accentColor = tcRow && tcRow.upper_color ? tcRow.upper_color : '#0078d7';

    applyExplorerTheme(topic);
    document.getElementById('subtopics-header').innerText = topic;
    document.getElementById('subtopics-header').style.borderColor = accentColor;
    
    const container = document.getElementById('subtopics-container');
    container.innerHTML = '';

    Object.keys(topicsHierarchy[topic]).forEach(sub => {
        // Appends the current active source so the Bubble Chart can carry it forward accurately
        const targetUrl = `bubble-chart.html?topic=${encodeURIComponent(topic)}&subtopic=${encodeURIComponent(sub)}&source=${encodeURIComponent(window.explorerSource || 'atlas')}`;
        const imagePath = `assets/images/${sub}.webp`;

        const wrapper = document.createElement('div');
        wrapper.className = 'flex flex-col items-center shrink-0 w-72';

        const card = document.createElement('div');
        card.className = 'subtopic-card w-full h-[60vh] min-h-[400px] rounded-2xl shadow-lg relative flex flex-col justify-end group transition-transform hover:scale-105 border-4 border-transparent dynamic-topic-card overflow-hidden';
        // Defer heavy background images until in view
        card.dataset.bg = imagePath;
        card.classList.add('lazy-bg', 'bg-placeholder');
        card.style.setProperty('--topic-color', accentColor);
        
        card.innerHTML = `
            <div class="subtopic-overlay absolute inset-0 transition-opacity group-hover:opacity-80 dynamic-topic-overlay"></div>
            <a href="${targetUrl}" class="absolute inset-0 z-0 flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <div class="text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2 mb-20 shadow-lg border border-white/20 dynamic-topic-btn">
                    <i class="fa-solid fa-chart-scatter"></i> ورود به نمودار حبابی
                </div>
            </a>
        `;

        const whiteBox = document.createElement('div');
        whiteBox.className = 'w-full mt-[-1in] bg-white/95 backdrop-blur rounded-xl p-4 shadow-xl border border-gray-100 transition-transform hover:-translate-y-2 relative z-10';
        whiteBox.innerHTML = `
            <h4 class="font-black text-center text-gray-800 text-lg mb-3 border-b pb-2" style="border-color:${accentColor}">${sub}</h4>
            <div class="flex flex-col gap-2 text-sm text-gray-600 max-h-40 overflow-y-auto custom-scrollbar pr-2">
                ${topicsHierarchy[topic][sub].map(ind => `
                    <button onclick="loadIndicator('${ind}', '${topic}')" class="w-full text-right flex items-center gap-2 hover:bg-gray-100 px-2 py-1.5 rounded transition">
                        <div class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${accentColor}"></div>
                        <span class="font-medium text-right w-full">${ind}</span>
                    </button>
                `).join('')}
            </div>
        `;

        wrapper.appendChild(card);
        wrapper.appendChild(whiteBox);
        container.appendChild(wrapper);
    });

    // After adding cards, initialize lazy loader for backgrounds inside the subtopics container
    initLazyBackgrounds(container);
}

async function loadIndicator(indicatorName, topicName) {
    activeIndicatorGlob = indicatorName;
    if (topicName) activeTopicGlob = topicName;
    if (activeTopicGlob) applyExplorerTheme(activeTopicGlob);
    
    document.getElementById('view-landing').style.display = 'none'; // Force hide landing completely
    document.getElementById('view-subtopics').classList.add('hidden');
    document.getElementById('view-dashboard').classList.remove('hidden');
    document.getElementById('indicator-title').innerText = indicatorName;

    try {
        const response = await fetch(`${API_BASE_URL}/api/explorer/indicator?name=${encodeURIComponent(indicatorName)}`);
        const data = await response.json();

        let srcName = data.description && data.description.source_name ? data.description.source_name : "مرکز آمار و مراجع رسمی";
        let narrative = data.description && data.description.description ? data.description.description : "توضیحات تکمیلی برای این شاخص در دسترس نیست.";
        
        document.getElementById('indicator-source').innerHTML = ` منبع: ${srcName}`;
        document.getElementById('insight-text').innerText = narrative;

        kscoreData = data.scores;
        latestYearGlob = data.latest_year != null ? Number(data.latest_year) : null;
        latestScoresGlob = Array.isArray(data.latest_scores) ? data.latest_scores : [];
        
        let uniqueYears = [...new Set(kscoreData.map(d => Number(d.year)))].sort((a,b)=>a-b);
        currentChartYears = uniqueYears;
        if (latestYearGlob == null && uniqueYears.length) latestYearGlob = uniqueYears[uniqueYears.length - 1];

        if(uniqueYears.length > 0) {
            document.getElementById('indicator-period').innerHTML = ` دوره: ${toFa(uniqueYears[0])} - ${toFa(uniqueYears[uniqueYears.length-1])}`;
        } else {
            document.getElementById('indicator-period').innerHTML = ` دوره: نامشخص`;
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
    document.getElementById('view-subtopics').classList.add('hidden');
    document.getElementById('view-landing').style.display = ''; // Restore explicitly hidden inline style
    document.getElementById('view-landing').classList.remove('hidden');
}

function goBackToSubtopics() {
    document.getElementById('view-dashboard').classList.add('hidden');
    document.getElementById('main-header').classList.add('hidden');
    document.getElementById('view-subtopics').classList.add('hidden');
    document.getElementById('view-landing').style.display = '';
    document.getElementById('view-landing').classList.remove('hidden');
    if (activeTopicGlob) expandMosaicTopic(activeTopicGlob);
}

function renderProvincesList() {
    const container = document.getElementById('provinces-list');
    container.innerHTML = '';
    provincesList.forEach(prov => {
        const div = document.createElement('div');
        div.className = 'province-item flex items-center mb-2 px-2 py-2 rounded-lg hover:bg-blue-50 transition border border-transparent hover:border-blue-100';
        
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.id = `prov-${prov}`;
        cb.className = 'w-5 h-5 rounded border-gray-300 focus:ring-0 cursor-pointer province-checkbox transition-colors';
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
    const aside = document.querySelector('#view-dashboard aside');
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
            title.innerHTML = `<i class="fa-solid fa-circle-dot text-blue-600"></i> مقایسه استانی آخرین سال${yearTxt}`;
        } else {
            title.innerHTML = `<i class="fa-solid fa-chart-line text-blue-600"></i> روند تغییرات زمانی شاخص`;
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
                    font: { family: 'Vazirmatn', size: 8, weight: 'bold' },
                    formatter: (value) => {
                        const name = (value && value.province) || '';
                        return name.includes(' ') ? name.split(' ') : name;
                    }
                },
                tooltip: {
                    rtl: true,
                    titleFont: { family: 'Vazirmatn', size: 13 },
                    bodyFont: { family: 'Vazirmatn', size: 13, weight: 'bold' },
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
                        font: { family: 'Vazirmatn', size: 12, weight: 'bold' },
                        color: '#4b5563'
                    }
                },
                y: {
                    ticks: {
                        font: { family: 'Vazirmatn' },
                        color: '#64748b',
                        callback: (v) => toFaFixed(v, 2)
                    },
                    grid: { color: '#e2e8f0', drawBorder: false },
                    title: {
                        display: true,
                        text: 'امتیاز',
                        font: { family: 'Vazirmatn', size: 12, weight: 'bold' },
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
                    font: { family: 'Vazirmatn', size: 13 }, 
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
                titleFont: { family: 'Vazirmatn', size: 14 }, bodyFont: { family: 'Vazirmatn', size: 13, weight: 'bold' }, rtl: true,
                backgroundColor: 'rgba(255, 255, 255, 0.95)', titleColor: '#1f2937', bodyColor: '#1f2937',
                borderColor: '#e5e7eb', borderWidth: 1, padding: 12, boxPadding: 6,
                displayColors: true
            }
        },
        scales: {
            x: { ticks: { font: { family: 'Vazirmatn' }, color: '#64748b' }, grid: { display: false } },
            y: { ticks: { font: { family: 'Vazirmatn' }, color: '#64748b' }, grid: { color: '#e2e8f0', drawBorder: false }, border: { dash: [4, 4] } }
        }
    };
}

// Ensure charts resize smoothly across screen sizes
const onExplorerResize = debounceLocal(() => {
    try { if (chartInstance && typeof chartInstance.resize === 'function') chartInstance.resize(); } catch (e) {}
    try { if (scatterProvinceChart && typeof scatterProvinceChart.resize === 'function') scatterProvinceChart.resize(); } catch (e) {}
}, 150);
window.addEventListener('resize', onExplorerResize);

window.onload = () => { loadExplorerData(); };