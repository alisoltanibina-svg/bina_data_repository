// File: problem.js
// Purpose: Province profile view scripts. Builds polar and doughnut charts,
//   normalizes province names, loads data for a selected province, and manages
//   page-level UI behaviors specific to the province profile view.
// Notes: All comments have been standardized to English; visible UI labels remain Persian.

Chart.defaults.font.family = "'PeydaFaNumWeb', sans-serif";
Chart.defaults.locale = 'fa-IR';
// Render charts sharply on high-DPI / Retina displays
Chart.defaults.devicePixelRatio = window.devicePixelRatio || 1;
if (Chart.defaults.animation === false) Chart.defaults.animation = {};
if (Chart.defaults.animation) Chart.defaults.animation.duration = 1000;

// Debounce helper for resize handling
function debounceProblem(fn, wait) {
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
const urlParams = new URLSearchParams(window.location.search);

const API_BASE_URL = window.API_BASE_URL || (window.location.protocol + '//' + window.location.hostname + ':8000');
// Always animate; ignore Windows/browser prefers-reduced-motion.
const prefersReducedMotion = false;
const ANIM_MS = prefersReducedMotion ? 0 : 750;
const CHART_ANIM = prefersReducedMotion
    ? { duration: 0 }
    : { duration: ANIM_MS, easing: 'easeOutQuart' };
const runningTweens = new WeakMap();
let dashboardReady = false;
let updateSeq = 0;

function hexToRgb(hex) {
    if (!hex) return { r: 37, g: 99, b: 235 };
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
    return {
        r: parseInt(h.substring(0, 2), 16) || 0,
        g: parseInt(h.substring(2, 4), 16) || 0,
        b: parseInt(h.substring(4, 6), 16) || 0
    };
}

function rgbaFromHex(hex, a) {
    const c = hexToRgb(hex);
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

function markDashboardReady() {
    if (dashboardReady) return;
    dashboardReady = true;
    requestAnimationFrame(() => {
        document.body.classList.add('dashboard-ready');
        requestAnimationFrame(() => {
            resizeChartSafely(polarChart);
            resizeChartSafely(doughnutChart);
            resizeChartSafely(scatterChart);
        });
    });
}

function resolveProvinceName(raw, provinces) {
    const list = Array.isArray(provinces) ? provinces : [];
    const wanted = normalizeText(raw || 'تهران');
    const exact = list.find(p => p === raw);
    if (exact) return exact;
    const byNorm = list.find(p => normalizeText(p) === wanted);
    if (byNorm) return byNorm;
    const tehran = list.find(p => normalizeText(p) === 'تهران' || normalizeText(p).includes('تهران'));
    if (tehran) return tehran;
    return raw || 'تهران';
}

function refreshChart(chart) {
    if (!chart) return;
    try { if (typeof chart.stop === 'function') chart.stop(); } catch (e) {}
    chart.update(prefersReducedMotion ? 'none' : undefined);
}

function chartOnCanvas(canvas) {
    if (!canvas || typeof Chart.getChart !== 'function') return null;
    return Chart.getChart(canvas) || null;
}

function destroyChartInstance(chart) {
    if (!chart) return;
    try { if (typeof chart.stop === 'function') chart.stop(); } catch (e) {}
    try { if (typeof chart.destroy === 'function') chart.destroy(); } catch (e) {}
}

function tweenNumber(el, toValue, formatter) {
    if (!el) return;
    const format = formatter || (n => String(n));
    if (toValue === null || toValue === undefined || toValue === '' || !isFinite(Number(toValue))) {
        el.textContent = '—';
        el.dataset.num = '';
        return;
    }
    const to = Number(toValue);
    const hasFrom = el.dataset.num !== undefined && el.dataset.num !== '';
    const from = hasFrom ? Number(el.dataset.num) : to;
    el.dataset.num = String(to);

    if (!dashboardReady || prefersReducedMotion || !hasFrom || from === to) {
        el.textContent = format(to);
        return;
    }

    const start = performance.now();
    const prev = runningTweens.get(el);
    if (prev) cancelAnimationFrame(prev);

    const frame = (now) => {
        const t = Math.min(1, (now - start) / ANIM_MS);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = format(from + (to - from) * eased);
        if (t < 1) {
            runningTweens.set(el, requestAnimationFrame(frame));
        } else {
            el.textContent = format(to);
            runningTweens.delete(el);
        }
    };
    runningTweens.set(el, requestAnimationFrame(frame));
}

function formatSignedScore(n) {
    const txt = formatFaNum(Math.abs(n));
    if (n > 0.005) return `+${txt}`;
    if (n < -0.005) return `−${txt}`;
    return txt;
}

function formatPlainScore(n) {
    return formatFaNum(n, 1);
}

function setIconClass(el, iconClass) {
    if (!el) return;
    el.className = `fa-solid ${iconClass}`;
}

function setChevronIcons(container, iconClass) {
    if (!container) return;
    container.querySelectorAll('i').forEach(icon => {
        icon.className = `fa-solid ${iconClass}`;
    });
}

function replaceToneClass(el, tone, palette) {
    if (!el) return;
    palette.forEach(name => el.classList.remove(name));
    if (tone) el.classList.add(tone);
}

// NormalizeText: helper to clean Persian text, remove invisible characters, and normalize common spelling variants
function normalizeText(str) {
    if (!str) return "";
    let cleaned = str.toString()
        .replace(/ي/g, "ی") 
        .replace(/ك/g, "ک") 
        .replace(/[\u200B-\u200D\uFEFF\r\n]/g, "") // Strips invisible characters
        .replace(/^استان\s+/i, "")
        .trim();
        
    // // Normalize known variants of 'Alborz' province name to the canonical form
    // if (cleaned.includes("لبرز") || cleaned.toLowerCase().includes("alborz")) {
    //     return "البرز";
    // }
    return cleaned;
}

let urlProvinceRaw = urlParams.get('province') || "تهران";
let urlProvince = normalizeText(urlProvinceRaw);
let currentTopic = normalizeText(urlParams.get('topic') || "");
let provinceLoadGen = 0;
let provinceAbort = null;
let provinceRequestKey = '';
let pyramidLoadedFor = '';
let provincePickerBound = false;

let provinceTrends = []; // Replaces trendScoreData fetching
let uniqueTopics = [];
let topicChanges = [];
let lastScatterData = [];
let polarChart = null;
let doughnutChart = null;

const polarCenterTextPlugin = {
    id: 'polarCenterText',
    // Draw the center circle after datasets but BEFORE the tooltip is rendered.
    // Using afterDatasetsDraw ensures the central white circle covers the chart segments
    // while allowing tooltips (drawn later) to appear above it.
    afterDatasetsDraw: function(chart, args, options) {
        if(chart.config.type !== 'polarArea') return;
        const radial = chart.scales && chart.scales.r;
        if (!radial || typeof radial.getDistanceFromCenterForValue !== 'function') return;
        let ctx = chart.ctx;
        let x = radial.xCenter;
        let y = radial.yCenter;
        if (!isFinite(x) || !isFinite(y)) return;
        
        let innerRadius = radial.getDistanceFromCenterForValue(0);
        if (!isFinite(innerRadius) || innerRadius < 0) innerRadius = 0;
        
        ctx.save();
        
        // Draw white filled circle to create the central badge area
        ctx.beginPath();
        ctx.arc(x, y, innerRadius, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(255, 255, 255, 1)";
        ctx.fill();
        
        // Thin stroke to separate the center from the rest
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#e5e7eb";
        ctx.stroke();

        // Draw the province name centered on top of the white circle
        ctx.font = "900 12px PeydaFaNumWeb";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillStyle = "#1f2937";
        ctx.fillText(urlProvinceRaw, x, y); // Draw the display name
        
        ctx.restore();
    }
};

function closeProvinceMenu() {
    const btn = document.getElementById('province-select-btn');
    const menu = document.getElementById('province-select-menu');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

function placeProvinceMenu() {
    const btn = document.getElementById('province-select-btn');
    const menu = document.getElementById('province-select-menu');
    if (!btn || !menu || menu.hidden) return;
    const r = btn.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    menu.style.left = 'auto';
    menu.style.minWidth = `${Math.round(r.width)}px`;
}

function setProvinceLabel(name) {
    const label = document.getElementById('province-select-label');
    if (label) label.textContent = name || 'استان';
    const menu = document.getElementById('province-select-menu');
    if (!menu) return;
    menu.querySelectorAll('.province-select-option').forEach(opt => {
        opt.classList.toggle('is-active', opt.dataset.value === name);
    });
}

function populateProvincePicker(provinces, selected) {
    const menu = document.getElementById('province-select-menu');
    if (!menu) return;
    menu.innerHTML = '';
    provinces.forEach(prov => {
        const li = document.createElement('li');
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'province-select-option';
        opt.setAttribute('role', 'option');
        opt.dataset.value = prov;
        opt.textContent = prov;
        if (prov === selected) opt.classList.add('is-active');
        opt.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeProvinceMenu();
            applyProvinceSelection(prov);
        });
        li.appendChild(opt);
        menu.appendChild(li);
    });
    setProvinceLabel(selected);
}

function bindProvincePicker() {
    const btn = document.getElementById('province-select-btn');
    const menu = document.getElementById('province-select-menu');
    if (!btn || !menu || provincePickerBound) return;
    provincePickerBound = true;

    btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const open = menu.hidden;
        if (open) {
            menu.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            placeProvinceMenu();
        } else {
            closeProvinceMenu();
        }
    });

    document.addEventListener('click', (event) => {
        if (!event.target.closest('#province-picker')) closeProvinceMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeProvinceMenu();
    });
    window.addEventListener('scroll', closeProvinceMenu, { passive: true });
    window.addEventListener('resize', closeProvinceMenu);
}

async function applyProvinceSelection(newProv) {
    const raw = (newProv || '').trim();
    if (!raw) return;
    const norm = normalizeText(raw);
    if (!norm || norm === provinceRequestKey) return;

    provinceRequestKey = norm;
    urlProvinceRaw = raw;
    urlProvince = norm;
    pyramidLoadedFor = '';
    setProvinceLabel(raw);

    const newUrl = `${window.location.pathname}?province=${encodeURIComponent(urlProvinceRaw)}&topic=${encodeURIComponent(currentTopic)}`;
    window.history.pushState({ path: newUrl }, '', newUrl);

    const gen = ++provinceLoadGen;
    if (provinceAbort) provinceAbort.abort();
    provinceAbort = new AbortController();

    try {
        const ajaxRes = await fetch(
            `${API_BASE_URL}/api/problem/init?province=${encodeURIComponent(urlProvince)}`,
            { signal: provinceAbort.signal }
        );
        if (gen !== provinceLoadGen) return;
        const ajaxData = await ajaxRes.json();
        if (gen !== provinceLoadGen) return;

        provinceTrends = ajaxData.trends;
        topicChanges = ajaxData.topic_changes || [];
        lastScatterData = ajaxData.scatter_data || [];

        updateDashboard(currentTopic);
        rebuildStoryMap();
        loadPyramidData();
        requestAnimationFrame(() => onProblemResize());
    } catch (err) {
        if (err && err.name === 'AbortError') return;
        provinceRequestKey = '';
        console.error("AJAX Error:", err);
    }
}

async function initDashboard() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/problem/init?province=${encodeURIComponent(urlProvince)}`);
        const data = await res.json();

        if (data.provinces && data.provinces.length) {
            urlProvinceRaw = resolveProvinceName(urlProvinceRaw, data.provinces);
            urlProvince = normalizeText(urlProvinceRaw);
            provinceRequestKey = urlProvince;
            populateProvincePicker(data.provinces, urlProvinceRaw);
            bindProvincePicker();
        }
        
        uniqueTopics = data.topics.map(t => ({ 
            name: normalizeText(t.topic_name), 
            color: t.master_color || '#3b82f6', 
            originalName: t.topic_name 
        }));
        
        provinceTrends = data.trends;
        topicChanges = data.topic_changes || [];
        lastScatterData = data.scatter_data || [];

        if(!currentTopic && uniqueTopics.length > 0) {
            currentTopic = uniqueTopics[0].name;
        }

        buildTopicBoxes();
        await updateDashboard(currentTopic);
        
    } catch(e) {
        console.error(e);
        alert("مشکل در دریافت داده‌ها از سرور");
    }
}

function buildTopicBoxes() {
    const container = document.getElementById('topics-container');
    container.innerHTML = '';
    
    uniqueTopics.forEach(t => {
        const btn = document.createElement('button');
        btn.className = `topic-btn ${t.name === currentTopic ? 'active' : ''}`;

        // Keep the image path with the original text exactly as it was
        let topicImgPath = `assets/images/تاپیک ${t.originalName}.webp`;

        // Strict match via normalized names
        let pTrends = provinceTrends.filter(tr => normalizeText(tr.topic_name) === t.name);
        pTrends.sort((a,b) => Number(a.year) - Number(b.year));
        let changeHtml = "";

        btn.dataset.topic = t.name;
        btn.innerHTML = `
            <div class="topic-btn-image lazy-bg bg-placeholder" data-bg="${topicImgPath}"></div>
            <span class="topic-title">${t.originalName}</span>
            ${changeHtml}
        `;

        btn.onclick = () => {
            if (t.name === currentTopic) return;
            currentTopic = t.name;
            document.querySelectorAll('.topic-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const newUrl = `${window.location.pathname}?province=${encodeURIComponent(urlProvinceRaw)}&topic=${encodeURIComponent(currentTopic)}`;
            window.history.pushState({path: newUrl}, '', newUrl);
            updateDashboard(t.name);
        };
        container.appendChild(btn);
    });

    // Initialize lazy background loader for topic buttons
    initLazyBackgrounds(container);
}

function applyTopicTheme(topicName) {
    const topicObj = uniqueTopics.find(t => t.name === topicName) || {};
    const baseHex = topicObj.color || '#2563eb';
    document.documentElement.style.setProperty('--banner-bg', baseHex);
    document.documentElement.style.setProperty('--topic-accent', baseHex);
    try {
        sessionStorage.setItem('themeBannerBg', baseHex);
        sessionStorage.setItem('themeTopicAccent', baseHex);
    } catch (e) {}
    const titleWrapper = document.getElementById('polar-title-wrapper');
    if (titleWrapper) titleWrapper.style.borderRightColor = baseHex;
    return { topicObj, baseHex };
}

function updateRankVisual(rank, baseHex) {
    const rankNum = Number(rank);
    const numberEl = document.getElementById('rank-number');
    const arcEl = document.getElementById('rank-ring-arc');
    const valid = !isNaN(rankNum) && isFinite(rankNum) && rankNum >= 1;
    const circ = 2 * Math.PI * 50;
    const progress = valid ? Math.max(0, Math.min(1, (32 - rankNum) / 31)) : 0;

    if (numberEl) {
        numberEl.textContent = valid ? formatFaNum(rankNum, 0) : '—';
        numberEl.style.color = baseHex || '#111827';
    }
    if (arcEl) {
        arcEl.style.stroke = baseHex || '#0078d7';
        arcEl.style.strokeDasharray = String(circ);
        arcEl.style.strokeDashoffset = String(circ * (1 - progress));
    }
}

async function updateDashboard(topicName) {
    const seq = ++updateSeq;
    const { baseHex } = applyTopicTheme(topicName);
    renderTopicChanges();
    drawScatterChart(lastScatterData);

    try {
        let displayTopicName = uniqueTopics.find(t => t.name === topicName)?.originalName || topicName;
        const response = await fetch(`${API_BASE_URL}/api/problem/data?province=${encodeURIComponent(urlProvince)}&topic=${encodeURIComponent(displayTopicName)}`);
        if (seq !== updateSeq) return;
        const data = await response.json();
        if (seq !== updateSeq) return;

        let score = Number(data.score) || 0;
        let rank = data.rank || "-";

        updateRankVisual(rank, baseHex);
        const scoreEl = document.getElementById('box-score');
        if (scoreEl) scoreEl.style.color = baseHex || '#111827';
        tweenNumber(scoreEl, score, formatPlainScore);
        drawDoughnut(score, baseHex);

        const subtopics = uniquePolarSubtopics(data.subtopics);
        const labels = subtopics.map(s => s.subtopic_name);
        const polarData = subtopics.map(s => Number(s.subtopic_score)).map(v => isFinite(v) ? v : 0);
        drawPolarChart(labels, polarData, topicName);
        markDashboardReady();
        requestAnimationFrame(() => {
            resizeChartSafely(polarChart);
            resizeChartSafely(doughnutChart);
        });
    } catch(err) {
        console.error("Error updating dashboard data:", err);
    }
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function formatFaNum(n, digits = 1) {
    if (n === null || n === undefined || n === '' || !isFinite(Number(n))) return '—';
    return Number(n).toLocaleString('fa-IR', {
        maximumFractionDigits: digits,
        minimumFractionDigits: 0
    });
}

function formatFaYear(year) {
    if (year === null || year === undefined || year === '') return '—';
    return Number(year).toLocaleString('fa-IR', { useGrouping: false });
}

function getScatterLimits(scatterData) {
    const pts = Array.isArray(scatterData) ? scatterData : [];
    const maxAbsX = Math.max(...pts.map(d => Math.abs(Number(d.x) || 0)), 1);
    const maxAbsY = Math.max(...pts.map(d => Math.abs(Number(d.y) || 0)), 1);
    return {
        limitX: Math.ceil(maxAbsX * 1.15),
        limitY: Math.ceil(maxAbsY * 1.15)
    };
}

function meterPercent(value, maxAbs) {
    const n = Number(value);
    if (!isFinite(n) || !maxAbs) return 50;
    return ((Math.max(-1, Math.min(1, n / maxAbs)) + 1) / 2) * 100;
}

function showIntuitionEmpty(message) {
    const card = document.getElementById('intuition-card');
    const empty = document.getElementById('intuition-empty');
    if (card) card.classList.remove('is-visible');
    if (empty) {
        empty.textContent = message;
        empty.classList.add('is-visible');
    }
}

function showIntuitionCard() {
    const card = document.getElementById('intuition-card');
    const empty = document.getElementById('intuition-empty');
    if (empty) empty.classList.remove('is-visible');
    if (card) card.classList.add('is-visible');
}

function applyIntuitionCard(item, maxChange, maxGap) {
    const card = document.getElementById('intuition-card');
    if (!card) return;

    showIntuitionCard();

    const direction = item.direction || 'na';
    const iconClass = direction === 'up'
        ? 'fa-caret-up'
        : (direction === 'down' ? 'fa-caret-down' : 'fa-minus');
    const directionLabel = direction === 'up'
        ? 'افزایش'
        : (direction === 'down' ? 'کاهش' : (direction === 'flat' ? 'پایدار' : 'نامشخص'));
    const gapDirection = item.gap_direction || 'na';
    const gapIconClass = gapDirection === 'above'
        ? 'fa-caret-up'
        : (gapDirection === 'below' ? 'fa-caret-down' : (gapDirection === 'even' ? 'fa-equals' : 'fa-minus'));
    const gapLabel = gapDirection === 'above'
        ? 'بالاتر از میانگین کشور'
        : (gapDirection === 'below' ? 'پایین‌تر از میانگین کشور' : (gapDirection === 'even' ? 'هم‌سطح میانگین کشور' : 'بدون داده ملی'));
    const prevYearText = item.previous_year != null ? formatFaYear(item.previous_year) : '—';
    const natYearText = item.national_year != null ? formatFaYear(item.national_year) : '—';
    const prevScoreText = item.previous_score == null ? '—' : formatFaNum(item.previous_score);
    const natScoreText = item.national_score == null ? '—' : formatFaNum(item.national_score);
    const pctText = item.change_pct == null ? '—' : `٪${formatFaNum(Math.abs(item.change_pct))} نسبت به دوره قبل`;
    const gapPctText = item.gap_pct == null ? '—' : `٪${formatFaNum(Math.abs(item.gap_pct))} فاصله از میانگین`;
    const gapTone = gapDirection === 'above' ? 'up' : (gapDirection === 'below' ? 'down' : 'flat');
    const dirTones = ['up', 'down', 'flat', 'na'];
    const gapTones = ['above', 'below', 'even', 'na', 'up', 'down', 'flat'];

    card.style.borderRightColor = item.color || '#3b82f6';
    const topicEl = document.getElementById('ic-topic');
    if (topicEl) topicEl.textContent = item.topic || '';

    replaceToneClass(document.getElementById('ic-dir-pill'), direction, dirTones);
    replaceToneClass(document.getElementById('ic-gap-pill'), gapDirection, gapTones);
    setIconClass(document.getElementById('ic-dir-icon'), iconClass);
    setIconClass(document.getElementById('ic-gap-icon'), gapIconClass);
    const dirText = document.getElementById('ic-dir-text');
    const gapTextEl = document.getElementById('ic-gap-text');
    if (dirText) dirText.textContent = directionLabel;
    if (gapTextEl) gapTextEl.textContent = gapLabel;

    replaceToneClass(document.getElementById('ic-change-lane'), direction, dirTones);
    replaceToneClass(document.getElementById('ic-change-hero'), direction, dirTones);
    setChevronIcons(document.getElementById('ic-change-chevrons'), iconClass);
    tweenNumber(document.getElementById('ic-change-num'), item.change, formatSignedScore);
    const changeMarker = document.getElementById('ic-change-marker');
    if (changeMarker) changeMarker.style.left = `${meterPercent(item.change, maxChange)}%`;
    const prevChip = document.getElementById('ic-change-prev-text');
    const pctChip = document.getElementById('ic-change-pct-text');
    if (prevChip) prevChip.textContent = `امتیاز دوره قبل ${prevScoreText} · سال ${prevYearText}`;
    if (pctChip) pctChip.textContent = pctText;

    replaceToneClass(document.getElementById('ic-gap-lane'), gapTone, gapTones);
    replaceToneClass(document.getElementById('ic-gap-hero'), gapTone, gapTones);
    setChevronIcons(document.getElementById('ic-gap-chevrons'), gapIconClass);
    tweenNumber(document.getElementById('ic-gap-num'), item.gap_from_national, formatSignedScore);
    const gapMarker = document.getElementById('ic-gap-marker');
    if (gapMarker) gapMarker.style.left = `${meterPercent(item.gap_from_national, maxGap)}%`;
    const natChip = document.getElementById('ic-gap-nat-text');
    const gapPctChip = document.getElementById('ic-gap-pct-text');
    if (natChip) natChip.textContent = `میانگین کشور ${natScoreText} · سال ${natYearText}`;
    if (gapPctChip) gapPctChip.textContent = gapPctText;
}

function renderTopicChanges(changes) {
    if (Array.isArray(changes)) topicChanges = changes;

    if (!topicChanges.length) {
        showIntuitionEmpty('داده‌ای برای نمایش تغییرات وجود ندارد');
        return;
    }

    const selected = topicChanges.find(item => normalizeText(item.topic) === currentTopic);
    if (!selected) {
        showIntuitionEmpty('داده‌ای برای موضوع انتخاب‌شده وجود ندارد');
        return;
    }

    const maxChange = Math.max(...topicChanges.map(item => Math.abs(Number(item.change) || 0)), 0.01);
    const maxGap = Math.max(...topicChanges.map(item => Math.abs(Number(item.gap_from_national) || 0)), 0.01);
    applyIntuitionCard(selected, maxChange, maxGap);
}

function uniquePolarSubtopics(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const seen = new Set();
    const out = [];
    list.forEach(row => {
        const name = row && row.subtopic_name != null ? String(row.subtopic_name) : '';
        if (!name || seen.has(name)) return;
        seen.add(name);
        out.push(row);
    });
    return out;
}

function polarSliceCount(chart) {
    const ds = chart && chart.data && Array.isArray(chart.data.datasets) ? chart.data.datasets[0] : null;
    return ds && Array.isArray(ds.data) ? ds.data.length : 0;
}

function polarLayoutChanged(chart, labels, values) {
    const prevLabels = (chart && chart.data && Array.isArray(chart.data.labels)) ? chart.data.labels : [];
    if (prevLabels.length !== labels.length || polarSliceCount(chart) !== values.length) return true;
    for (let i = 0; i < labels.length; i++) {
        if (prevLabels[i] !== labels[i]) return true;
    }
    return false;
}

function polarSliceColors(baseColor, count) {
    return Array.from({ length: count }, (_, i) => {
        let alpha = 0.9 - (i * 0.12);
        if (alpha < 0.35) alpha = 0.35;
        return baseColor + Math.round(alpha * 255).toString(16).padStart(2, '0');
    });
}

function polarTooltipLabel(context) {
    try {
        const dataIndex = context.dataIndex;
        const ds = context.dataset || {};
        let rawVal = undefined;

        if (Array.isArray(ds.data) && dataIndex != null) {
            rawVal = ds.data[dataIndex];
        } else if (context.parsed !== undefined) {
            rawVal = context.parsed;
        } else {
            rawVal = context.raw;
        }

        if (rawVal && typeof rawVal === 'object') {
            rawVal = rawVal.r ?? rawVal.y ?? rawVal.value ?? rawVal;
        }

        let num = Number(rawVal);
        if (!isFinite(num) || isNaN(num)) {
            const fallback = Array.isArray(ds.data) && dataIndex != null ? ds.data[dataIndex] : context.parsed || context.raw;
            num = Number(fallback);
        }

        if (!isFinite(num) || isNaN(num)) num = 0;
        return formatFaNum(num, 1);
    } catch (e) {
        return formatFaNum(0, 0);
    }
}

function drawDoughnut(score, colorHex = '#2563eb') {
    let safeScore = Math.max(0, Math.min(100, score));
    const canvas = document.getElementById('doughnutChart');
    if (!canvas) return;

    if (doughnutChart) {
        doughnutChart.data.datasets[0].data = [safeScore, 100 - safeScore];
        doughnutChart.data.datasets[0].backgroundColor = [colorHex, '#e5e7eb'];
        refreshChart(doughnutChart);
        return;
    }

    doughnutChart = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            datasets: [{
                data: [safeScore, 100 - safeScore],
                backgroundColor: [colorHex, '#e5e7eb'],
                borderWidth: 0,
                cutout: '75%'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: CHART_ANIM,
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        }
    });
}

function drawPolarChart(labels, data, topicName) {
    const canvas = document.getElementById('polarChart');
    if (!canvas) return;

    let topicObj = uniqueTopics.find(t => t.name === topicName);
    let baseColor = topicObj && topicObj.color ? topicObj.color : '#3b82f6';
    const colors = polarSliceColors(baseColor, data.length);
    const polarAnim = prefersReducedMotion
        ? { duration: 0 }
        : {
            duration: ANIM_MS,
            easing: 'easeOutQuart',
            // PolarArea animates start/end angles by default. If an update
            // (or a resize) lands while that rotation is still running, leftover
            // arcs stay on the canvas and the bars look duplicated.
            animateRotate: false,
            animateScale: true
        };

    const existing = polarChart || chartOnCanvas(canvas);
    // Same slice set: just retarget radii. Different topics have 3/4/5/8
    // subtopics — Chart.js polarArea cannot morph that without ghost arcs.
    if (existing && !polarLayoutChanged(existing, labels, data)) {
        try { existing.stop(); } catch (e) {}
        existing.data.labels = labels;
        existing.data.datasets[0].data = data;
        existing.data.datasets[0].backgroundColor = colors;
        polarChart = existing;
        existing.update(prefersReducedMotion ? 'none' : undefined);
        return;
    }

    destroyChartInstance(existing);
    polarChart = null;

    polarChart = new Chart(canvas.getContext('2d'), {
        type: 'polarArea',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: colors,
                borderColor: '#ffffff',
                borderWidth: 3,
                hoverBorderWidth: 5,
                spacing: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: polarAnim,
            scales: {
                r: {
                    min: -40,
                    max: 100,
                    ticks: { display: false },
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    pointLabels: {
                        display: true,
                        centerPointLabels: true,
                        font: {
                            family: "'PeydaFaNumWeb', sans-serif",
                            size: 11,
                            weight: 'bold'
                        },
                        color: '#4b5563'
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    titleFont: { family: 'PeydaFaNumWeb', size: 14 },
                    bodyFont: { family: 'PeydaFaNumWeb', size: 14 },
                    callbacks: {
                        title: function() { return ''; },
                        label: polarTooltipLabel
                    }
                }
            }
        },
        plugins: [polarCenterTextPlugin]
    });
}

let scatterChart = null;

function prepareScatterPayload(scatterData) {
    const pts = [...(Array.isArray(scatterData) ? scatterData : [])]
        .sort((a, b) => String(a.topic || '').localeCompare(String(b.topic || ''), 'fa'));
    return {
        data: pts.map(d => ({ x: Number(d.x), y: Number(d.y), topic: d.topic })),
        backgroundColor: pts.map(d => {
            const selected = normalizeText(d.topic) === currentTopic;
            return rgbaFromHex(d.color || '#3b82f6', selected ? 1 : 0.72);
        }),
        pointRadius: pts.map(d => normalizeText(d.topic) === currentTopic ? 18 : 11),
        pointHoverRadius: pts.map(d => normalizeText(d.topic) === currentTopic ? 21 : 15),
        borderWidth: pts.map(d => normalizeText(d.topic) === currentTopic ? 2.5 : 1.4)
    };
}

function drawScatterChart(scatterData) {
    const canvas = document.getElementById('scatterChart');
    if (!canvas) return;

    lastScatterData = Array.isArray(scatterData) ? scatterData : [];
    const { limitX, limitY } = getScatterLimits(lastScatterData);
    const payload = prepareScatterPayload(lastScatterData);

    if (scatterChart) {
        scatterChart.data.datasets[0].data = payload.data;
        scatterChart.data.datasets[0].backgroundColor = payload.backgroundColor;
        scatterChart.data.datasets[0].pointRadius = payload.pointRadius;
        scatterChart.data.datasets[0].pointHoverRadius = payload.pointHoverRadius;
        scatterChart.data.datasets[0].borderWidth = payload.borderWidth;
        scatterChart.options.scales.x.min = -limitX;
        scatterChart.options.scales.x.max = limitX;
        scatterChart.options.scales.y.min = -limitY;
        scatterChart.options.scales.y.max = limitY;
        refreshChart(scatterChart);
        return;
    }

    scatterChart = new Chart(canvas.getContext('2d'), {
        type: 'scatter',
        data: {
            datasets: [{
                data: payload.data,
                backgroundColor: payload.backgroundColor,
                borderColor: '#ffffff',
                borderWidth: payload.borderWidth,
                pointRadius: payload.pointRadius,
                pointHoverRadius: payload.pointHoverRadius
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: CHART_ANIM,
            rtl: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    titleFont: { family: 'PeydaFaNumWeb', size: 14 },
                    bodyFont: { family: 'PeydaFaNumWeb', size: 14 },
                    callbacks: {
                        label: function(context) {
                            const pt = context.raw;
                            return `${pt.topic}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    min: -limitX, max: limitX,
                    grid: {
                        color: ctx => ctx.tick.value === 0 ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.04)',
                        lineWidth: ctx => ctx.tick.value === 0 ? 2 : 1
                    },
                    ticks: {
                        font: { family: "'PeydaFaNumWeb', sans-serif" },
                        callback: (v) => formatFaNum(v, 1)
                    },
                    title: {
                        display: true,
                        text: 'تغییرات نسبت به دوره قبل',
                        font: { family: "'PeydaFaNumWeb', sans-serif", size: 12, weight: 'bold' },
                        color: '#4b5563',
                        padding: { top: 6 }
                    }
                },
                y: {
                    min: -limitY, max: limitY,
                    grid: {
                        color: ctx => ctx.tick.value === 0 ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.04)',
                        lineWidth: ctx => ctx.tick.value === 0 ? 2 : 1
                    },
                    ticks: {
                        font: { family: "'PeydaFaNumWeb', sans-serif" },
                        callback: (v) => formatFaNum(v, 1)
                    },
                    title: {
                        display: true,
                        text: 'فاصله از میانگین کل کشور',
                        font: { family: "'PeydaFaNumWeb', sans-serif", size: 12, weight: 'bold' },
                        color: '#4b5563',
                        padding: { bottom: 6 }
                    }
                }
            }
        }
    });
}



function resizeChartSafely(chart) {
    if (!chart || typeof chart.resize !== 'function') return;
    try {
        // Stop an in-flight polar animation, then paint at the current size.
        // A resize without update() left the first Tehran polar chart at scale 0.
        if (typeof chart.stop === 'function') chart.stop();
        chart.resize();
        if (typeof chart.update === 'function') chart.update('none');
    } catch (e) {}
}

// Ensure charts resize smoothly when window size changes
const onProblemResize = debounceProblem(() => {
    resizeChartSafely(polarChart);
    resizeChartSafely(doughnutChart);
    resizeChartSafely(scatterChart);
    resizeChartSafely(pyramidChart);
}, 150);

window.addEventListener('resize', onProblemResize);

const STORY_SIZE = 800;
const STORY_PAD = 36;
let iranFeatures = null;
let shahrFeatures = null;
let storyGeoPromise = null;
let storyOutlinePaths = [];
let storyCountyPaths = [];
let storyCounties = [];
let storyScrollRaf = 0;
let storyMapInteractive = false;
let selectedCountyIndex = -1;
let hoveredCountyIndex = -1;
let storyMapClicksBound = false;
const COUNTY_SUBTITLE_SELECTED = 'تقسیمات سیاسی این شهرستان';

function storyBBox(rings) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rings.forEach(ring => {
        ring.forEach(pt => {
            const x = pt[0], y = pt[1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        });
    });
    if (!isFinite(minX)) return [0, 0, 1, 1];
    const dx = maxX - minX || 1;
    const dy = maxY - minY || 1;
    const padX = dx * 0.06;
    const padY = dy * 0.06;
    return [minX - padX, minY - padY, maxX + padX, maxY + padY];
}

function projectLonLat(lon, lat, bbox) {
    const [minX, minY, maxX, maxY] = bbox;
    const dx = maxX - minX || 1;
    const dy = maxY - minY || 1;
    const inner = STORY_SIZE - STORY_PAD * 2;
    const scale = Math.min(inner / dx, inner / dy);
    const ox = (STORY_SIZE - dx * scale) / 2;
    const leftoverY = STORY_SIZE - dy * scale;
    const oy = leftoverY * 0.36;
    return [ox + (lon - minX) * scale, oy + (maxY - lat) * scale];
}

function geomExteriorRings(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return geom.coordinates[0] ? [geom.coordinates[0]] : [];
    if (geom.type === 'MultiPolygon') return geom.coordinates.map(poly => poly[0]).filter(Boolean);
    return [];
}

function simplifyRing(ring, maxPts = 320) {
    if (!ring || ring.length <= maxPts) return ring || [];
    const step = Math.ceil(ring.length / maxPts);
    const out = [];
    for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
    const last = ring[ring.length - 1];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== last[0] || prev[1] !== last[1]) out.push(last);
    return out;
}

function ringToPath(ring, bbox) {
    const pts = simplifyRing(ring);
    if (pts.length < 2) return '';
    let d = '';
    for (let i = 0; i < pts.length; i++) {
        const [x, y] = projectLonLat(pts[i][0], pts[i][1], bbox);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
    }
    d += 'Z';
    return d;
}

function ringCentroid(ring) {
    if (!ring || !ring.length) return null;
    let sx = 0, sy = 0;
    ring.forEach(pt => { sx += pt[0]; sy += pt[1]; });
    return [sx / ring.length, sy / ring.length];
}

function ringAreaCentroid(ring) {
    if (!ring || ring.length < 3) return ringCentroid(ring);
    let area2 = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const x0 = ring[j][0], y0 = ring[j][1];
        const x1 = ring[i][0], y1 = ring[i][1];
        const f = x0 * y1 - x1 * y0;
        area2 += f;
        cx += (x0 + x1) * f;
        cy += (y0 + y1) * f;
    }
    if (Math.abs(area2) < 1e-12) return ringCentroid(ring);
    return [cx / (3 * area2), cy / (3 * area2)];
}

function projectedRingSpan(ring, bbox) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ring.forEach(pt => {
        const [x, y] = projectLonLat(pt[0], pt[1], bbox);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    });
    return { w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function pointInGeom(lon, lat, geom) {
    if (!geom) return false;
    const polys = geom.type === 'Polygon' ? [geom.coordinates]
        : (geom.type === 'MultiPolygon' ? geom.coordinates : []);
    return polys.some(poly => {
        if (!poly || !poly[0]) return false;
        if (!pointInRing(lon, lat, poly[0])) return false;
        for (let h = 1; h < poly.length; h++) {
            if (pointInRing(lon, lat, poly[h])) return false;
        }
        return true;
    });
}

function featureAdm1Name(ft) {
    const p = (ft && ft.properties) || {};
    return normalizeText(p.ADM1_FA || p.ProvincNam || p.Name || "");
}

function isLakeCounty(name) {
    return normalizeText(name).includes('دریاچه');
}

function countyPropNumber(props, key) {
    if (!props) return null;
    const n = Number(props[key]);
    return isFinite(n) ? n : null;
}

function countyIndexFromEvent(event) {
    const el = event.target && event.target.closest
        ? event.target.closest('.story-county-fill, .story-county-label')
        : null;
    if (!el) return -1;
    const idx = Number(el.dataset.countyIndex);
    return isFinite(idx) ? idx : -1;
}

function countyTargetFromEvent(event) {
    const t = event && event.target;
    if (!t || typeof t.closest !== 'function') return null;
    return t.closest('.story-county-fill, .story-county-label');
}

function paintCountyMarks() {
    let frontLabel = null;
    storyCounties.forEach((county, i) => {
        const selected = i === selectedCountyIndex;
        const hovered = storyMapInteractive && i === hoveredCountyIndex;
        county.fillEls.forEach(el => {
            el.classList.toggle('is-selected', selected);
            el.classList.toggle('is-hover', hovered && !selected);
        });
        (county.pathEls || []).forEach(el => el.classList.toggle('is-selected', selected));
        if (county.labelEl) {
            county.labelEl.classList.toggle('is-selected', selected);
            county.labelEl.classList.toggle('is-hover', hovered);
            if (hovered) frontLabel = county.labelEl;
        }
    });
    if (frontLabel && frontLabel.parentNode) frontLabel.parentNode.appendChild(frontLabel);
}

function setCountyStatValue(el, value) {
    if (!el) return;
    if (value === null || value === undefined || !isFinite(Number(value))) {
        el.textContent = '—';
        el.dataset.num = '';
        return;
    }
    if (el.dataset.num === undefined || el.dataset.num === '') {
        el.dataset.num = '0';
    }
    tweenNumber(el, Number(value), n => formatFaNum(n, 0));
}

function hideCountyPanel() {
    const panel = document.getElementById('story-county-panel');
    if (panel) {
        panel.classList.remove('is-visible', 'has-county');
        panel.setAttribute('aria-hidden', 'true');
    }
}

function isCountyUiClick(target) {
    return !!(target && target.closest && target.closest('#story-county-panel, #county-chip-list'));
}

function isCountyShapeClick(target) {
    return !!(target && target.closest && target.closest('.story-county-fill, .story-county-label'));
}

function syncCountyChipState() {
    const list = document.getElementById('county-chip-list');
    if (!list) return;
    list.querySelectorAll('.story-county-chip').forEach(btn => {
        const on = Number(btn.dataset.countyIndex) === selectedCountyIndex;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
}

function populateCountyList() {
    const list = document.getElementById('county-chip-list');
    if (!list) return;
    list.innerHTML = '';
    const rows = storyCounties
        .map((county, index) => ({ index, name: county.name || '' }))
        .filter(row => row.name)
        .sort((a, b) => a.name.localeCompare(b.name, 'fa'));
    rows.forEach(row => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'story-county-chip';
        btn.setAttribute('role', 'option');
        btn.dataset.countyIndex = String(row.index);
        btn.textContent = row.name;
        list.appendChild(btn);
    });
    syncCountyChipState();
}

function bindCountyList() {
    const list = document.getElementById('county-chip-list');
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';

    list.addEventListener('click', (event) => {
        const btn = event.target.closest('.story-county-chip');
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        const idx = Number(btn.dataset.countyIndex);
        if (!isFinite(idx)) return;
        selectCounty(idx, { toggle: false });
    });
}

function syncCountyPanel() {
    const panel = document.getElementById('story-county-panel');
    const subtitle = document.getElementById('story-county-subtitle');
    const county = (storyMapInteractive && selectedCountyIndex >= 0)
        ? storyCounties[selectedCountyIndex]
        : null;
    if (!panel) return;

    const titleEl = document.getElementById('story-county-title');
    if (!county) {
        hideCountyPanel();
        if (titleEl) titleEl.textContent = '';
        setCountyStatValue(document.getElementById('stat-bakhsh'), null);
        setCountyStatValue(document.getElementById('stat-shahr'), null);
        setCountyStatValue(document.getElementById('stat-dehestan'), null);
        syncCountyChipState();
        return;
    }

    panel.classList.add('is-visible', 'has-county');
    panel.setAttribute('aria-hidden', 'false');
    if (titleEl) titleEl.textContent = county.name || '';
    if (subtitle) subtitle.textContent = COUNTY_SUBTITLE_SELECTED;
    setCountyStatValue(document.getElementById('stat-bakhsh'), county.bakhsh);
    setCountyStatValue(document.getElementById('stat-shahr'), county.shahr);
    setCountyStatValue(document.getElementById('stat-dehestan'), county.dehestan);
    syncCountyChipState();
}

function clearCountySelection() {
    selectedCountyIndex = -1;
    hoveredCountyIndex = -1;
    paintCountyMarks();
    syncCountyPanel();
}

function selectCounty(index, options) {
    const allowToggle = !(options && options.toggle === false);
    if (!storyMapInteractive || index < 0 || index >= storyCounties.length) {
        clearCountySelection();
        return;
    }
    if (allowToggle && selectedCountyIndex === index) {
        clearCountySelection();
        return;
    }
    selectedCountyIndex = index;
    hoveredCountyIndex = -1;
    paintCountyMarks();
    syncCountyPanel();
}

function setStoryMapInteractive(on) {
    const stage = document.getElementById('story-map-stage');
    const next = !!on;
    if (storyMapInteractive === next) return;
    storyMapInteractive = next;
    if (stage) stage.classList.toggle('is-interactive', storyMapInteractive);
    if (!storyMapInteractive) {
        hoveredCountyIndex = -1;
        selectedCountyIndex = -1;
        paintCountyMarks();
    }
    syncCountyPanel();
}

function bindStoryMapClicks() {
    const svg = document.getElementById('story-map-svg');
    const closeBtn = document.getElementById('story-county-close');
    if (storyMapClicksBound) return;
    storyMapClicksBound = true;
    bindCountyList();

    if (svg) {
        svg.addEventListener('click', (event) => {
            if (!storyMapInteractive) return;
            const idx = countyIndexFromEvent(event);
            if (idx >= 0) selectCounty(idx);
        });
        svg.addEventListener('pointerover', (event) => {
            if (!storyMapInteractive) return;
            const idx = countyIndexFromEvent(event);
            if (idx < 0 || idx === hoveredCountyIndex) return;
            hoveredCountyIndex = idx;
            paintCountyMarks();
        });
        svg.addEventListener('pointerout', (event) => {
            if (!storyMapInteractive) return;
            const leavingTo = countyTargetFromEvent({ target: event.relatedTarget });
            const next = leavingTo ? Number(leavingTo.dataset.countyIndex) : -1;
            hoveredCountyIndex = (isFinite(next) && next >= 0) ? next : -1;
            paintCountyMarks();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            clearCountySelection();
        });
    }

    document.addEventListener('click', (event) => {
        const t = event.target;
        if (!storyMapInteractive || selectedCountyIndex < 0) return;
        if (isCountyUiClick(t) || isCountyShapeClick(t)) return;
        clearCountySelection();
    }, true);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && selectedCountyIndex >= 0) clearCountySelection();
    });
}

function findProvinceFeature(name) {
    if (!iranFeatures || !iranFeatures.length) return null;
    const n = normalizeText(name);
    return iranFeatures.find(f => featureAdm1Name(f) === n)
        || iranFeatures.find(f => {
            const fa = featureAdm1Name(f);
            return fa.includes(n) || n.includes(fa);
        })
        || null;
}

function applyPathProgress(paths, t) {
    if (!paths.length) return;
    const total = paths.reduce((sum, p) => sum + p.length, 0) || 1;
    let remaining = Math.max(0, Math.min(1, t)) * total;
    paths.forEach(p => {
        const shown = Math.max(0, Math.min(p.length, remaining));
        p.el.style.strokeDasharray = String(p.length);
        p.el.style.strokeDashoffset = String(p.length - shown);
        remaining -= p.length;
    });
}

function applyCountyReveal(t) {
    const n = storyCounties.length;
    if (!n) return;
    const clamped = Math.max(0, Math.min(1, t));
    const scaled = clamped * n;
    storyCounties.forEach((county, i) => {
        const local = Math.max(0, Math.min(1, scaled - i));
        const shown = local <= 0 ? 0 : (local >= 1 ? 1 : 1 - Math.pow(1 - local, 2));
        county.fillEls.forEach(el => { el.style.opacity = String(shown); });
        if (county.labelEl) county.labelEl.style.opacity = String(shown);
    });
}

function rebuildStoryMap() {
    const outlineG = document.getElementById('story-province-outline');
    const countyG = document.getElementById('story-county-lines');
    const fillG = document.getElementById('story-county-fills');
    const labelG = document.getElementById('story-county-labels');
    const titleEl = document.getElementById('story-province-title');
    if (!outlineG || !countyG) return;

    if (titleEl) titleEl.textContent = urlProvinceRaw || '';

    outlineG.innerHTML = '';
    countyG.innerHTML = '';
    if (fillG) fillG.innerHTML = '';
    if (labelG) labelG.innerHTML = '';
    storyOutlinePaths = [];
    storyCountyPaths = [];
    storyCounties = [];
    selectedCountyIndex = -1;
    hoveredCountyIndex = -1;
    storyMapInteractive = false;
    const stage = document.getElementById('story-map-stage');
    if (stage) stage.classList.remove('is-interactive');
    hideCountyPanel();

    const feature = findProvinceFeature(urlProvince);
    if (!feature) {
        updateStoryProgress();
        return;
    }

    const outlineRings = geomExteriorRings(feature.geometry);
    const provinceKey = featureAdm1Name(feature);
    const counties = [];
    if (shahrFeatures && shahrFeatures.length && provinceKey) {
        shahrFeatures.forEach(ft => {
            if (featureAdm1Name(ft) !== provinceKey) return;
            const p = ft.properties || {};
            const name = p.CityName || p.cityname || '';
            if (isLakeCounty(name)) return;
            const rings = geomExteriorRings(ft.geometry);
            if (!rings.length) return;
            const c = ringAreaCentroid(rings[0]) || ringCentroid(rings[0]);
            if (!c) return;
            counties.push({
                rings,
                cy: c[1],
                cx: c[0],
                name: p['نام شهرستان'] || name,
                bakhsh: countyPropNumber(p, 'تعداد بخش'),
                shahr: countyPropNumber(p, 'تعداد شهر'),
                dehestan: countyPropNumber(p, 'تعداد دهستان')
            });
        });
    }
    const bboxRings = outlineRings.slice();
    counties.forEach(c => { c.rings.forEach(r => bboxRings.push(r)); });
    const bbox = storyBBox(bboxRings.length ? bboxRings : outlineRings);

    outlineRings.forEach(ring => {
        const d = ringToPath(ring, bbox);
        if (!d) return;
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        el.setAttribute('d', d);
        el.setAttribute('class', 'story-outline-path');
        outlineG.appendChild(el);
        const length = el.getTotalLength();
        el.style.strokeDasharray = String(length);
        el.style.strokeDashoffset = String(length);
        storyOutlinePaths.push({ el, length });
    });

    if (counties.length) {
        counties.sort((a, b) => b.cy - a.cy || a.cx - b.cx);
        counties.forEach(county => {
            const fillEls = [];
            const pathEls = [];
            const countyIndex = storyCounties.length;
            county.rings.forEach(ring => {
                const d = ringToPath(ring, bbox);
                if (!d) return;
                if (fillG) {
                    const fillEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    fillEl.setAttribute('d', d);
                    fillEl.setAttribute('class', 'story-county-fill');
                    fillEl.dataset.countyIndex = String(countyIndex);
                    fillEl.setAttribute('role', 'button');
                    if (county.name) {
                        fillEl.setAttribute('aria-label', county.name);
                        fillEl.setAttribute('title', county.name);
                    }
                    fillG.appendChild(fillEl);
                    fillEls.push(fillEl);
                }
                const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                el.setAttribute('d', d);
                el.setAttribute('class', 'story-county-path');
                countyG.appendChild(el);
                const length = el.getTotalLength();
                el.style.strokeDasharray = String(length);
                el.style.strokeDashoffset = String(length);
                storyCountyPaths.push({ el, length });
                pathEls.push(el);
            });

            let labelEl = null;
            if (labelG && county.name) {
                const mainRing = county.rings[0];
                const center = ringAreaCentroid(mainRing) || ringCentroid(mainRing);
                const [lx, ly] = projectLonLat(center[0], center[1], bbox);
                const span = projectedRingSpan(mainRing, bbox);
                const fontSize = Math.max(6, Math.min(9.5, Math.min(span.w, span.h) * 0.16));
                labelEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                labelEl.setAttribute('class', 'story-county-label');
                labelEl.setAttribute('x', lx.toFixed(2));
                labelEl.setAttribute('y', ly.toFixed(2));
                labelEl.setAttribute('font-size', fontSize.toFixed(1));
                labelEl.dataset.countyIndex = String(countyIndex);
                labelEl.textContent = county.name;
                labelG.appendChild(labelEl);
            }

            storyCounties.push({
                fillEls,
                pathEls,
                labelEl,
                name: county.name,
                bakhsh: county.bakhsh,
                shahr: county.shahr,
                dehestan: county.dehestan
            });
        });
    }

    populateCountyList();
    updateStoryProgress();
}

function storySectionProgress() {
    const more = document.getElementById('province-more');
    if (!more) return -1;
    const range = Math.max(1, more.offsetHeight - window.innerHeight);
    return -more.getBoundingClientRect().top / range;
}

function updateStoryProgress() {
    const nameEl = document.getElementById('story-province-name');
    const p = storySectionProgress();
    const active = p >= -0.02;

    if (nameEl) {
        const nameT = prefersReducedMotion ? (active ? 1 : 0) : Math.max(0, Math.min(1, p / 0.1));
        nameEl.style.opacity = String(nameT);
        nameEl.style.transform = `translateY(${(1 - nameT) * 14}px)`;
    }

    if (prefersReducedMotion) {
        applyPathProgress(storyOutlinePaths, active ? 1 : 0);
        applyPathProgress(storyCountyPaths, active ? 1 : 0);
        applyCountyReveal(active ? 1 : 0);
        setStoryMapInteractive(active);
        applyPyramidProgress(p, true);
        return;
    }

    const outlineT = Math.max(0, Math.min(1, (p - 0.04) / 0.14));
    const countyT = Math.max(0, Math.min(1, (p - 0.20) / 0.12));
    const revealT = Math.max(0, Math.min(1, (p - 0.34) / 0.07));
    applyPathProgress(storyOutlinePaths, outlineT);
    applyPathProgress(storyCountyPaths, countyT);
    applyCountyReveal(revealT);
    setStoryMapInteractive(revealT >= 1);
    applyPyramidProgress(p, false);
}

function updateBackToTopBtn() {
    const banner = document.getElementById('top-banner');
    const btn = document.getElementById('btn-back-to-top');
    if (!btn) return;
    const gone = banner ? banner.getBoundingClientRect().bottom < 12 : window.scrollY > 80;
    btn.classList.toggle('is-visible', gone);
}

function maybeLoadStoryGeo() {
    if (storyGeoPromise) return;
    const more = document.getElementById('province-more');
    if (!more) return;
    if (more.getBoundingClientRect().top < window.innerHeight * 0.8) {
        ensureStoryGeo();
    }
}

function onStoryScroll() {
    maybeLoadStoryGeo();
    if (storyScrollRaf) return;
    storyScrollRaf = requestAnimationFrame(() => {
        storyScrollRaf = 0;
        updateStoryProgress();
        updateBackToTopBtn();
    });
}

async function loadStoryGeo() {
    try {
        const [iranRes, shahrRes] = await Promise.all([
            fetch('data/iran.geojson?v=c1'),
            fetch('data/Shahrestan.geojson?v=c1')
        ]);
        if (!iranRes.ok || !shahrRes.ok) throw new Error('GeoJSON not found');
        const iran = await iranRes.json();
        const shahr = await shahrRes.json();
        iranFeatures = iran.features || [];
        shahrFeatures = shahr.features || [];
        rebuildStoryMap();
    } catch (err) {
        console.error('Error loading story map data:', err);
        storyGeoPromise = null;
    }
}

function ensureStoryGeo() {
    if (!storyGeoPromise) storyGeoPromise = loadStoryGeo();
    return storyGeoPromise;
}

function initStoryScroll() {
    bindStoryMapClicks();
    maybeLoadStoryGeo();
    window.addEventListener('scroll', onStoryScroll, { passive: true });
    window.addEventListener('resize', debounceProblem(() => {
        updateStoryProgress();
        updateBackToTopBtn();
    }, 120));
    const topBtn = document.getElementById('btn-back-to-top');
    if (topBtn) {
        topBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
        });
    }
    updateBackToTopBtn();
}

let pyramidChart = null;
let pyramidYears = [];
let pyramidAges = [];
let pyramidByYear = {};
let pyramidMax = 1;

function ageBandLabel(age) {
    const start = Number(age) || 0;
    return `${formatFaNum(start, 0)}–${formatFaNum(start + 4, 0)}`;
}

function pyramidLabels() {
    return [...pyramidAges].reverse().map(ageBandLabel);
}

function pyramidSeriesForYear(year) {
    const frame = pyramidByYear[String(year)] || { male: [], female: [] };
    const ageIndex = new Map(pyramidAges.map((age, i) => [age, i]));
    const male = [];
    const female = [];
    [...pyramidAges].reverse().forEach(age => {
        const i = ageIndex.get(age);
        male.push(-Math.abs(Number(frame.male[i]) || 0));
        female.push(Math.abs(Number(frame.female[i]) || 0));
    });
    return { male, female };
}

function interpolatedPyramidSeries(t) {
    if (!pyramidYears.length) return { year: null, male: [], female: [] };
    if (pyramidYears.length === 1) {
        const only = pyramidSeriesForYear(pyramidYears[0]);
        return { year: pyramidYears[0], male: only.male, female: only.female };
    }
    const x = Math.max(0, Math.min(1, t)) * (pyramidYears.length - 1);
    const i = Math.max(0, Math.min(pyramidYears.length - 2, Math.floor(x)));
    const f = x - i;
    const y0 = pyramidYears[i];
    const y1 = pyramidYears[i + 1];
    const a = pyramidSeriesForYear(y0);
    const b = pyramidSeriesForYear(y1);
    const male = a.male.map((v, k) => v + ((b.male[k] || 0) - v) * f);
    const female = a.female.map((v, k) => v + ((b.female[k] || 0) - v) * f);
    const year = pyramidYears[Math.min(pyramidYears.length - 1, Math.round(x))];
    return { year, male, female };
}

function ensurePyramidChart() {
    const canvas = document.getElementById('pyramidChart');
    if (!canvas || !pyramidYears.length) return null;
    const first = pyramidSeriesForYear(pyramidYears[0]);
    if (pyramidChart) {
        pyramidChart.data.labels = pyramidLabels();
        pyramidChart.data.datasets[0].data = first.male;
        pyramidChart.data.datasets[1].data = first.female;
        pyramidChart.options.scales.x.min = -pyramidMax;
        pyramidChart.options.scales.x.max = pyramidMax;
        pyramidChart.update('none');
        return pyramidChart;
    }
    pyramidChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: pyramidLabels(),
            datasets: [
                {
                    label: 'مردان',
                    data: first.male,
                    backgroundColor: 'rgba(37, 99, 235, 0.88)',
                    borderWidth: 0,
                    borderRadius: 3
                },
                {
                    label: 'زنان',
                    data: first.female,
                    backgroundColor: 'rgba(219, 39, 119, 0.88)',
                    borderWidth: 0,
                    borderRadius: 3
                }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            rtl: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    titleFont: { family: 'PeydaFaNumWeb', size: 12 },
                    bodyFont: { family: 'PeydaFaNumWeb', size: 12 },
                    callbacks: {
                        label: function(ctx) {
                            return `${ctx.dataset.label}: ${formatFaNum(Math.abs(ctx.raw), 0)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    min: -pyramidMax,
                    max: pyramidMax,
                    stacked: true,
                    ticks: {
                        font: { family: "'PeydaFaNumWeb', sans-serif", size: 10 },
                        callback: (v) => formatFaNum(Math.abs(v), 0)
                    },
                    grid: {
                        color: (ctx) => ctx.tick.value === 0 ? 'rgba(17,24,39,0.28)' : 'rgba(0,0,0,0.05)',
                        lineWidth: (ctx) => ctx.tick.value === 0 ? 1.4 : 1
                    },
                    title: {
                        display: true,
                        text: 'جمعیت',
                        font: { family: "'PeydaFaNumWeb', sans-serif", size: 11, weight: 'bold' },
                        color: '#6b7280'
                    }
                },
                y: {
                    stacked: true,
                    ticks: {
                        font: { family: "'PeydaFaNumWeb', sans-serif", size: 10, weight: '700' },
                        color: '#374151'
                    },
                    grid: { display: false }
                }
            }
        }
    });
    return pyramidChart;
}

function applyPyramidProgress(p, reduced) {
    const panel = document.getElementById('story-pyramid');
    const yearEl = document.getElementById('story-pyramid-year');
    const titleEl = document.getElementById('story-pyramid-title');
    const bodyEl = document.getElementById('story-pyramid-body');
    const fullTitle = `هرم سنی جمعیت استان ${urlProvinceRaw || ''}`.trim();
    if (!panel) return;

    if (!pyramidYears.length) {
        if (titleEl) titleEl.textContent = '';
        if (bodyEl) bodyEl.style.opacity = '0';
        panel.setAttribute('aria-hidden', 'true');
        return;
    }

    const titleT = reduced
        ? (p >= 0.42 ? 1 : 0)
        : Math.max(0, Math.min(1, (p - 0.42) / 0.06));
    const chartT = reduced
        ? (p >= 0.56 ? 1 : 0)
        : Math.max(0, Math.min(1, (p - 0.56) / 0.05));

    if (titleEl) {
        const chars = Math.round(titleT * fullTitle.length);
        titleEl.textContent = fullTitle.slice(0, chars);
    }
    if (bodyEl) {
        bodyEl.style.opacity = String(chartT);
        bodyEl.style.transform = `translateY(${(1 - chartT) * 12}px)`;
    }
    panel.setAttribute('aria-hidden', (titleT > 0.05 || chartT > 0.05) ? 'false' : 'true');
    if (chartT <= 0) return;

    const chart = ensurePyramidChart();
    if (!chart) return;

    const yearT = reduced ? 0 : Math.max(0, Math.min(1, (p - 0.62) / 0.34));
    const frame = interpolatedPyramidSeries(yearT);
    chart.data.datasets[0].data = frame.male;
    chart.data.datasets[1].data = frame.female;
    chart.update('none');
    if (yearEl && frame.year != null) yearEl.textContent = formatFaYear(frame.year);
}

async function loadPyramidData() {
    const key = urlProvince;
    if (key && pyramidLoadedFor === key) return;
    pyramidLoadedFor = key;
    try {
        const res = await fetch(`${API_BASE_URL}/api/problem/pyramid?province=${encodeURIComponent(urlProvince)}`);
        const data = await res.json();
        pyramidYears = Array.isArray(data.years) ? data.years.map(Number) : [];
        pyramidAges = Array.isArray(data.ages) ? data.ages.map(Number) : [];
        pyramidByYear = data.by_year || {};
        let maxAbs = 1;
        Object.values(pyramidByYear).forEach(frame => {
            (frame.male || []).forEach(v => { maxAbs = Math.max(maxAbs, Math.abs(Number(v) || 0)); });
            (frame.female || []).forEach(v => { maxAbs = Math.max(maxAbs, Math.abs(Number(v) || 0)); });
        });
        pyramidMax = Math.ceil(maxAbs * 1.08) || 1;
        if (pyramidChart) {
            pyramidChart.destroy();
            pyramidChart = null;
        }
        ensurePyramidChart();
        updateStoryProgress();
    } catch (err) {
        if (pyramidLoadedFor === key) pyramidLoadedFor = '';
        console.error('Error loading pyramid data:', err);
        pyramidYears = [];
        pyramidByYear = {};
        updateStoryProgress();
    }
}

window.onload = function() {
    initStoryScroll();
    loadPyramidData();
    initDashboard();
};