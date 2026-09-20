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
        showNotice("مشکل در ارتباط با سرور.");
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
    if (!topic) return;
    const accent = topicAccent(topic);
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

function firstBubbleHref() {
    const topics = mosaicTopics();
    for (const topic of topics) {
        const subs = Object.keys(topicsHierarchy[topic] || {});
        if (subs.length) return bubbleUrl(topic, subs[0]);
    }
    return `bubble-chart.html?source=${encodeURIComponent(window.explorerSource || 'atlas')}`;
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
    if (w < 900) return { cols: 2 };
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

function attachSmoothWheel(scroller) {
    if (!scroller || scroller === window || scroller.dataset.smoothScroll === '1') return;
    scroller.dataset.smoothScroll = '1';

    let current = scroller.scrollTop;
    let target = scroller.scrollTop;
    let raf = 0;
    const ease = 0.16;

    function maxScroll() {
        return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }

    function tick() {
        current += (target - current) * ease;
        if (Math.abs(target - current) < 0.5) {
            current = target;
            scroller.scrollTop = current;
            raf = 0;
            return;
        }
        scroller.scrollTop = current;
        raf = requestAnimationFrame(tick);
    }

    function run() {
        if (!raf) raf = requestAnimationFrame(tick);
    }

    function clamp(y) {
        return Math.max(0, Math.min(maxScroll(), y));
    }

    scroller.__smoothScrollTo = function (y) {
        current = scroller.scrollTop;
        target = clamp(y);
        run();
    };
    scroller.__smoothJump = function (y) {
        current = target = clamp(y);
        scroller.scrollTop = current;
        if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
        }
    };

    scroller.addEventListener('wheel', function (e) {
        if (e.ctrlKey || e.defaultPrevented) return;
        const nested = e.target.closest('.ex-room-sheet, .ex-prov-list, aside, [data-no-smooth-scroll]');
        if (nested && nested !== scroller && nested.scrollHeight > nested.clientHeight + 2) {
            const atTop = nested.scrollTop <= 0 && e.deltaY < 0;
            const atBottom = nested.scrollTop + nested.clientHeight >= nested.scrollHeight - 2 && e.deltaY > 0;
            if (!atTop && !atBottom) return;
        }
        e.preventDefault();
        current = scroller.scrollTop;
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 28;
        else if (e.deltaMode === 2) dy *= scroller.clientHeight * 0.85;
        target = clamp(target + dy);
        run();
    }, { passive: false });

    scroller.addEventListener('scroll', function () {
        if (raf) return;
        current = scroller.scrollTop;
        target = scroller.scrollTop;
    }, { passive: true });
}

function initExplorerSmoothScroll() {
    attachSmoothWheel(document.getElementById('view-landing'));
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
    root.querySelectorAll('.ex-room-visual').forEach(el => {
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

function indexEmptyHtml() {
    return `
        <div class="ex-panel-empty">
            <p class="ex-kicker">شاخص‌ها</p>
            <p>موضوعی را از بالا انتخاب کنید</p>
        </div>
    `;
}

function topicBackHtml(topic) {
    const subtopics = topicsHierarchy[topic] || {};
    const listHtml = Object.keys(subtopics).map(sub => `
        <div class="ex-sub">
            <span class="ex-sub-name">${escapeHtml(sub)}</span>
            <div class="ex-inds">
            ${subtopics[sub].map(ind => `
                <button type="button" class="mosaic-ind" data-indicator="${escapeHtml(ind)}" data-topic="${escapeHtml(topic)}">
                    <span class="mosaic-ind-dot"></span>
                    <span>${escapeHtml(ind)}</span>
                </button>
            `).join('')}
            </div>
        </div>
    `).join('');
    return `
        <div class="ex-sheet-head">
            <h3>${escapeHtml(topic)}</h3>
            <button type="button" class="ex-sheet-close" aria-label="بستن">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        ${listHtml}
    `;
}

function topicFlipHtml(topic, index, cols) {
    const src = topicTileSrc(topic);
    const accent = topicAccent(topic);
    const col = index % cols;
    const open = flippedTopic === topic ? ' is-open' : '';
    const n = countTopicIndicators(topic);
    return `
        <article class="ex-room${open}" data-col="${col}" data-topic="${escapeHtml(topic)}" style="--topic-accent:${accent}">
            <button type="button" class="ex-room-face" aria-expanded="${open ? 'true' : 'false'}" aria-label="${escapeHtml(topic)}">
                <div class="ex-room-visual" style="background-image: url('${src}')">
                    <div class="ex-room-veil"></div>
                </div>
                <div class="ex-room-copy">
                    <h2>${escapeHtml(topic)}</h2>
                    <div class="ex-room-meta">
                        <span class="ex-room-pearl" aria-hidden="true"></span>
                        <span>${toFa(n)} شاخص</span>
                    </div>
                </div>
            </button>
        </article>
    `;
}

function bubblePreviewHtml() {
    return `
        <section class="ex-panel ex-bubble-panel">
            <div class="ex-panel-grain" aria-hidden="true"></div>
            <div class="ex-bubbles" id="ex-bubbles">
                <span class="ex-bubble-axis ex-bubble-axis-x"></span>
                <span class="ex-bubble-axis ex-bubble-axis-y"></span>
            </div>
            <div class="ex-panel-copy">
                <h3>نمودار حبابی</h3>
                <p>وزن شاخص‌ها را عوض کنید و ببینید استان‌ها چطور جابه‌جا می‌شوند</p>
                <a class="ex-build bubble-build-bar" href="${escapeHtml(firstBubbleHref())}">شاخص خودت را بساز</a>
            </div>
        </section>
    `;
}

const BUBBLE_PREVIEW = [
    { name: 'تهران', x: 26, y: 40, s: 92 },
    { name: 'مشهد', x: 48, y: 28, s: 70 },
    { name: 'اصفهان', x: 66, y: 52, s: 62 },
    { name: 'شیراز', x: 38, y: 66, s: 52 },
    { name: 'تبریز', x: 16, y: 58, s: 48 },
    { name: 'اهواز', x: 78, y: 36, s: 44 },
    { name: 'قم', x: 56, y: 74, s: 36 },
    { name: 'رشت', x: 72, y: 68, s: 40 }
];

function initBubblePreview(root) {
    const stage = root.querySelector('#ex-bubbles');
    if (!stage) return;
    BUBBLE_PREVIEW.forEach((b, i) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'ex-bubble';
        el.textContent = b.name;
        el.style.left = b.x + '%';
        el.style.top = b.y + '%';
        el.style.width = b.s + 'px';
        el.style.height = b.s + 'px';
        el.style.marginLeft = -(b.s / 2) + 'px';
        el.style.marginTop = -(b.s / 2) + 'px';
        el.style.animationDelay = (-i * 0.4) + 's';
        el.setAttribute('aria-label', b.name);
        stage.appendChild(el);
        bindBubbleDrag(el, stage);
    });
}

function bindBubbleDrag(el, stage) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    el.addEventListener('pointerdown', (e) => {
        dragging = true;
        el.setPointerCapture(e.pointerId);
        el.style.animationPlayState = 'paused';
        el.style.zIndex = '8';
        const rect = stage.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        origLeft = ((box.left + box.width / 2) - rect.left) / rect.width * 100;
        origTop = ((box.top + box.height / 2) - rect.top) / rect.height * 100;
    });
    el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const rect = stage.getBoundingClientRect();
        const dx = (e.clientX - startX) / rect.width * 100;
        const dy = (e.clientY - startY) / rect.height * 100;
        const left = Math.max(8, Math.min(92, origLeft + dx));
        const top = Math.max(10, Math.min(86, origTop + dy));
        el.style.left = left + '%';
        el.style.top = top + '%';
    });
    const stop = () => {
        if (!dragging) return;
        dragging = false;
        el.style.animationPlayState = '';
        el.style.zIndex = '';
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
}

function fillIndexPanel(topic) {
    const body = document.getElementById('ex-index-body');
    if (!body) return;
    if (!topic) {
        body.innerHTML = indexEmptyHtml();
        return;
    }
    body.innerHTML = topicBackHtml(topic);
    const closeBtn = body.querySelector('.ex-sheet-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => setTopicFlipped(topic, false));
    }
    body.querySelectorAll('.mosaic-ind').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            loadIndicator(btn.dataset.indicator, btn.dataset.topic);
        });
    });
}

function setTopicFlipped(topic, on) {
    const cards = document.querySelectorAll('.ex-room');
    cards.forEach(card => {
        const match = on && card.dataset.topic === topic;
        card.classList.toggle('is-open', match);
        const face = card.querySelector('.ex-room-face');
        if (face) face.setAttribute('aria-expanded', match ? 'true' : 'false');
    });
    flippedTopic = on ? topic : null;
    if (on && topic) applyExplorerTheme(topic);
    fillIndexPanel(on ? topic : null);
}

function bindMosaicInteractions(container) {
    container.querySelectorAll('.ex-room').forEach(card => {
        const topic = card.dataset.topic;
        const face = card.querySelector('.ex-room-face');
        card.addEventListener('mouseenter', () => applyExplorerTheme(topic));
        card.addEventListener('mouseleave', () => {
            if (flippedTopic) applyExplorerTheme(flippedTopic);
        });
        if (face) {
            face.addEventListener('click', () => {
                const opening = !card.classList.contains('is-open');
                setTopicFlipped(topic, opening);
            });
        }
    });
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
    const firstTopic = topics[0];
    if (firstTopic) applyExplorerTheme(flippedTopic && topics.includes(flippedTopic) ? flippedTopic : firstTopic);

    const topicCards = topics.map((topic, i) => topicFlipHtml(topic, i, layout.cols)).join('');

    container.className = 'ex-stage is-pending';
    container.innerHTML = `
        <section class="ex-hero">
            <h1 class="ex-title">کاوشگر داده</h1>
            <p class="ex-lead">برای دیدن شاخص‌ها یکی از زیرحوزه‌ها را انتخاب کنید</p>
        </section>
        <section class="ex-bento">
            <div class="ex-topics">${topicCards}</div>
            <section class="ex-panel ex-index-panel" id="ex-index-panel">
                <div class="ex-panel-grain" aria-hidden="true"></div>
                <div class="ex-panel-body" id="ex-index-body">${indexEmptyHtml()}</div>
            </section>
            ${bubblePreviewHtml()}
        </section>
    `;

    bindMosaicInteractions(container);
    initBubblePreview(container);
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
    const match = Array.from(container.querySelectorAll('.ex-room')).find(el => el.dataset.topic === topic);
    if (!match) return;
    const scroller = landingScroller();
    if (scroller && typeof scroller.__smoothScrollTo === 'function') {
        const top = match.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientHeight * 0.22;
        scroller.__smoothScrollTo(top);
    } else {
        match.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
}

async function loadIndicator(indicatorName, topicName) {
    activeIndicatorGlob = indicatorName;
    if (topicName) activeTopicGlob = topicName;
    if (activeTopicGlob) applyExplorerTheme(activeTopicGlob);
    
    killMosaicAnimations();
    document.getElementById('view-landing').style.display = 'none';
    document.getElementById('view-dashboard').classList.remove('hidden');
    document.getElementById('indicator-title').innerText = indicatorName;
    const topicKicker = document.getElementById('dash-topic-kicker');
    if (topicKicker) topicKicker.textContent = topicName || activeTopicGlob || '';

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
    document.getElementById('main-header').classList.add('hidden');
    const landing = document.getElementById('view-landing');
    landing.style.display = '';
    landing.classList.remove('hidden');
    flippedTopic = null;
    if (typeof landing.__smoothJump === 'function') landing.__smoothJump(0);
    else landing.scrollTop = 0;
    renderMosaicMenu();
    if (typeof landing.__smoothJump === 'function') landing.__smoothJump(0);
    else landing.scrollTop = 0;
    requestAnimationFrame(() => {
        if (typeof landing.__smoothJump === 'function') landing.__smoothJump(0);
        else landing.scrollTop = 0;
    });
}

function goBackToSubtopics() {
    goBackToLanding();
}

function renderProvincesList() {
    const container = document.getElementById('provinces-list');
    container.innerHTML = '';
    provincesList.forEach(prov => {
        const div = document.createElement('div');
        div.className = 'province-item';
        
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
    const aside = document.querySelector('#view-dashboard aside, .ex-prov-rail');
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
    initExplorerSmoothScroll();
    loadExplorerData();
}

onReady(startExplorer);