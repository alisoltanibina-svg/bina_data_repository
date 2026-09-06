// File: explorer.js
// Purpose: JavaScript for the Explorer (landing & subtopics) page.
//   Provides UI logic for the staggered mosaic landing, subtopic cards, indicator charts,
//   lazy-loading of large background images, and search suggestions.
// Notes: Comments standardized to English; Persian UI strings are not modified.

// -- Explorer page initialization --
if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);
Chart.defaults.font.family = "'Vazirmatn', sans-serif";
// Ensure crisp rendering on high-DPI devices
Chart.defaults.devicePixelRatio = window.devicePixelRatio || 1;
if (Chart.defaults.animation === false) Chart.defaults.animation = {};
if (Chart.defaults.animation) Chart.defaults.animation.duration = 1000;

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

const API_BASE_URL = window.API_BASE_URL || (window.location.protocol + '//' + window.location.hostname + ':8000');

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

const BUBBLE_BUILD_CARD = '__build_index__';

function applyExplorerTheme(topic) {
    if (!topic) return;
    const accent = topic === BUBBLE_BUILD_CARD ? '#2176FF' : topicAccent(topic);
    document.documentElement.style.setProperty('--banner-bg', accent);
    document.documentElement.style.setProperty('--topic-accent', accent);
    try {
        sessionStorage.setItem('themeBannerBg', accent);
        sessionStorage.setItem('themeTopicAccent', accent);
    } catch (e) {}
}

function bubbleUrl(topic, subtopic) {
    return `bubble-chart.html?topic=${encodeURIComponent(topic)}&subtopic=${encodeURIComponent(subtopic)}&source=${encodeURIComponent(window.explorerSource || 'atlas')}`;
}

function countTopicIndicators(topic) {
    return Object.values(topicsHierarchy[topic] || {}).reduce((n, list) => n + (list ? list.length : 0), 0);
}

const TOPIC_ICONS = {
    'معنویت و ارزش‌های دینی': 'fa-solid fa-mosque',
    'زندگی خانوادگی': 'fa-solid fa-house-user',
    'مصرف فرهنگی و رسانه‌ای': 'fa-solid fa-tv',
    'همبستگی و سرمایه اجتماعی': 'fa-solid fa-handshake',
    'دانش و سرمایه انسانی': 'fa-solid fa-graduation-cap',
    'معیشت و فرهنگ اقتصادی': 'fa-solid fa-store',
    'رفاه و عدالت اجتماعی': 'fa-solid fa-scale-balanced',
    'مسائل اجتماعی': 'fa-solid fa-users',
    'شاخص جامع فرهنگی اجتماعی': 'fa-solid fa-chart-pie'
};

let mosaicAnimCtx = null;
let mosaicRenderGen = 0;
let mosaicLayoutKey = '';
let flippedTopic = null;

function mosaicTopics() {
    return Object.keys(topicsHierarchy).filter(topic => {
        const subs = topicsHierarchy[topic];
        return subs && Object.keys(subs).length > 0;
    });
}

function topicTileSrc(topic) {
    return encodeURI(`assets/images/${topic}-tile.webp`);
}

function topicIconClass(topic) {
    return TOPIC_ICONS[topic] || 'fa-solid fa-layer-group';
}

function mosaicLayout() {
    const w = window.innerWidth;
    if (w < 720) return { cols: 2 };
    if (w < 1100) return { cols: 3 };
    return { cols: 4 };
}

function flipTextHtml(text, duration = 2.2, delay = 0, loop = true) {
    const words = String(text).trim().split(/\s+/).filter(Boolean);
    const total = Math.max(words.length, 1);
    return `<div class="flip-text-wrapper" style="perspective:1000px">${words.map((word, i) => {
        const sineValue = Math.sin((i / total) * (Math.PI / 2));
        const calculatedDelay = sineValue * (duration * 0.25) + delay;
        const safe = escapeHtml(word);
        return `<span class="flip-char" data-char="${safe}" style="--flip-duration:${duration}s;--flip-delay:${calculatedDelay}s;--flip-iteration:${loop ? 'infinite' : '1'};transform-style:preserve-3d">${safe}</span>`;
    }).join('')}</div>`;
}

function landingScroller() {
    return document.getElementById('view-landing') || window;
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
    root.querySelectorAll('.grid__item-img').forEach(el => {
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

function topicBackHtml(topic) {
    const subtopics = topicsHierarchy[topic] || {};
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
    return `
        <div class="flip-back-head">
            <h2>${escapeHtml(topic)}</h2>
            <button type="button" class="flip-back-close" aria-label="بازگشت">
                <i class="fa-solid fa-rotate-left"></i>
            </button>
        </div>
        <div class="flip-back-list custom-scrollbar">${listHtml}</div>
    `;
}

function topicFlipHtml(topic, index, cols) {
    const icon = topicIconClass(topic);
    const src = topicTileSrc(topic);
    const accent = topicAccent(topic);
    const col = index % cols;
    const flipped = flippedTopic === topic ? ' is-flipped' : '';
    return `
        <article class="grid__item topic-flip${flipped}" data-col="${col}" data-topic="${escapeHtml(topic)}" role="button" tabindex="0" aria-expanded="${flipped ? 'true' : 'false'}" aria-label="${escapeHtml(topic)}" style="--topic-accent:${accent}">
            <div class="topic-flip-inner">
                <div class="topic-flip-front">
                    <div class="grid__item-img" style="background-image: url('${src}')">
                        <div class="grid__item-veil"></div>
                        <div class="grid__item-copy">
                            <i class="${icon} grid__item-icon" aria-hidden="true"></i>
                            <span class="grid__item-name">${escapeHtml(topic)}</span>
                        </div>
                    </div>
                </div>
                <div class="topic-flip-back">${topicBackHtml(topic)}</div>
            </div>
        </article>
    `;
}

function bubbleBuildCardHtml(index, cols) {
    const col = index % cols;
    const flipped = flippedTopic === BUBBLE_BUILD_CARD ? ' is-flipped' : '';
    const accent = '#2176FF';
    return `
        <article class="grid__item topic-flip bubble-build-card${flipped}" data-col="${col}" data-topic="${BUBBLE_BUILD_CARD}" role="button" tabindex="0" aria-expanded="${flipped ? 'true' : 'false'}" aria-label="شاخص خودت را بساز" style="--topic-accent:${accent}">
            <div class="topic-flip-inner">
                <div class="topic-flip-front">
                    <div class="grid__item-img" style="background-image: url('assets/images/bubble-chart-tile.jpg')">
                        <div class="grid__item-veil"></div>
                        <div class="grid__item-copy">
                            <i class="fa-solid fa-chart-pie grid__item-icon" aria-hidden="true"></i>
                            <span class="grid__item-name">شاخص خودت را بساز</span>
                        </div>
                    </div>
                </div>
                <div class="topic-flip-back">
                    <div class="flip-back-head">
                        <h2>شاخص خودت را بساز</h2>
                        <button type="button" class="flip-back-close" aria-label="بازگشت">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="flip-back-list bubble-build-back">
                        <p class="bubble-build-caption">شاخص خودت را بساز</p>
                    </div>
                </div>
            </div>
        </article>
    `;
}

function setTopicFlipped(topic, on) {
    const cards = document.querySelectorAll('.topic-flip');
    cards.forEach(card => {
        const match = on && card.dataset.topic === topic;
        card.classList.toggle('is-flipped', match);
        card.setAttribute('aria-expanded', match ? 'true' : 'false');
    });
    flippedTopic = on ? topic : null;
    if (on && topic) applyExplorerTheme(topic);
}

function bindMosaicInteractions(container) {
    container.querySelectorAll('.topic-flip').forEach(card => {
        const topic = card.dataset.topic;
        const flip = () => {
            const opening = !card.classList.contains('is-flipped');
            setTopicFlipped(topic, opening);
        };
        card.addEventListener('mouseenter', () => applyExplorerTheme(topic));
        card.addEventListener('click', (e) => {
            if (e.target.closest('.mosaic-ind') || e.target.closest('.flip-back-close')) return;
            flip();
        });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                flip();
            }
        });
        const closeBtn = card.querySelector('.flip-back-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                setTopicFlipped(topic, false);
            });
        }
        card.querySelectorAll('.mosaic-ind').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                loadIndicator(btn.dataset.indicator, btn.dataset.topic);
            });
        });
    });
}

function initStaggeredAnimations(container) {
    killMosaicAnimations();
    if (typeof gsap === 'undefined' || !isLandingVisible()) {
        container.classList.remove('is-pending');
        return;
    }

    const scroller = landingScroller();
    const gridItems = container.querySelectorAll('.grid__item');

    if (typeof gsap.registerPlugin === 'function' && typeof ScrollTrigger !== 'undefined') {
        gsap.registerPlugin(ScrollTrigger);
    }

    mosaicAnimCtx = gsap.context(() => {
        gsap.set(gridItems, { yPercent: 450, autoAlpha: 0, force3d: true });
        container.classList.remove('is-pending');

        if (!gridItems.length) return;

        const colCount = mosaicLayout().cols;
        const middle = Math.floor(colCount / 2);
        const columns = Array.from({ length: colCount }, () => []);
        gridItems.forEach(item => {
            const colAttr = item.getAttribute('data-col');
            let columnIndex = colAttr !== null ? parseInt(colAttr, 10) : 0;
            if (!Number.isFinite(columnIndex) || columnIndex < 0 || columnIndex >= colCount) {
                columnIndex = 0;
            }
            columns[columnIndex].push(item);
        });

        const canScrub = typeof ScrollTrigger !== 'undefined';
        const triggerEl = container.querySelector('.grid--full') || container;
        columns.forEach((columnItems, columnIndex) => {
            if (!columnItems.length) return;
            const delayFactor = Math.abs(columnIndex - middle) * 0.2;
            if (canScrub) {
                gsap.timeline({
                    scrollTrigger: {
                        trigger: triggerEl,
                        scroller,
                        start: 'top bottom',
                        end: 'center center',
                        scrub: 1.5,
                        invalidateOnRefresh: true
                    }
                }).fromTo(columnItems, {
                    yPercent: 450,
                    autoAlpha: 0
                }, {
                    yPercent: 0,
                    autoAlpha: 1,
                    delay: delayFactor,
                    ease: 'sine.out',
                    force3d: true
                });
            } else {
                gsap.to(columnItems, {
                    yPercent: 0,
                    autoAlpha: 1,
                    delay: delayFactor,
                    duration: 1.2,
                    ease: 'sine.out',
                    force3d: true
                });
            }
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
    const firstTopic = topics[0];
    if (firstTopic) applyExplorerTheme(flippedTopic && topics.includes(flippedTopic) ? flippedTopic : firstTopic);

    const topicCards = topics.map((topic, i) => topicFlipHtml(topic, i, layout.cols)).join('');
    const buildCard = bubbleBuildCardHtml(topics.length, layout.cols);

    container.className = 'staggered-stage is-pending';
    container.innerHTML = `
        <section class="stagger-hero">
            <div class="stagger-title">${flipTextHtml('کاوشگر داده')}</div>
            <div class="scroll-cue" aria-hidden="true">
                <span class="scroll-cue-beam"></span>
                <span class="scroll-cue-glow"></span>
                <i class="fa-solid fa-chevron-down"></i>
            </div>
        </section>
        <section class="w-full relative">
            <div class="grid--full">${topicCards}${buildCard}</div>
        </section>
    `;

    bindMosaicInteractions(container);
    if (flippedTopic) setTopicFlipped(flippedTopic, true);

    Promise.race([
        waitForMosaicImages(container),
        new Promise(resolve => setTimeout(resolve, 2500))
    ]).then(() => {
        if (gen !== mosaicRenderGen) return;
        initStaggeredAnimations(container);
    });
}

function expandMosaicTopic(topic) {
    const container = document.getElementById('mosaic-menu');
    if (!container) return;
    applyExplorerTheme(topic);
    setTopicFlipped(topic, true);
    const match = Array.from(container.querySelectorAll('.topic-flip')).find(el => el.dataset.topic === topic);
    if (match) match.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function loadIndicator(indicatorName, topicName) {
    activeIndicatorGlob = indicatorName;
    if (topicName) activeTopicGlob = topicName;
    if (activeTopicGlob) applyExplorerTheme(activeTopicGlob);
    
    killMosaicAnimations();
    document.getElementById('view-landing').style.display = 'none';
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
    document.getElementById('view-dashboard').classList.add('hidden');
    document.getElementById('main-header').classList.add('hidden');
    const landing = document.getElementById('view-landing');
    landing.style.display = '';
    landing.classList.remove('hidden');
    flippedTopic = null;
    landing.scrollTop = 0;
    renderMosaicMenu();
    landing.scrollTop = 0;
    requestAnimationFrame(() => { landing.scrollTop = 0; });
}

function goBackToSubtopics() {
    goBackToLanding();
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

window.onload = () => { loadExplorerData(); };