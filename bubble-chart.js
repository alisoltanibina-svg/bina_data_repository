// File: bubble-chart.js
// Purpose: Implements the interactive bubble chart view for a selected topic/subtopic.
//   Manages data fetching, preprocessing (latest-per-province lookup), weight sliders,
//   chart rendering, and responsive behavior for high-DPI displays.
// Notes: Comments standardized to English; UI text (Persian) is preserved.

// -- Bubble chart initialization --

const urlParams = new URLSearchParams(window.location.search);
let urlTopic = urlParams.get('topic');
let urlSubtopic = urlParams.get('subtopic');
const urlSource = urlParams.get('source') || 'atlas';
let topicsHierarchy = {};
let topicsColorData = [];
let pickerReady = false;
let chartOpenedFromPicker = false; 

const API_BASE_URL = window.API_BASE_URL;
let rawData = [];
let indicators = [];
let indicatorWeights = {};
let chartObj = null;
let themeUpper = '#2563eb';
let themeLower = '#e2e8f0';
let uniqueProvinces = [];
let loadSeq = 0;

// Lightweight lookup: latest value per province+indicator for fast access
let latestByProvInd = {}; // { province: { indicator: { year, value } } }
function buildLatestLookup() {
    latestByProvInd = {};
    rawData.forEach(d => {
        const prov = d.province_name;
        const ind = d.indicator_name;
        const yr = Number(d.year);
        const val = Number(d.standard_value);
        if (!latestByProvInd[prov]) latestByProvInd[prov] = {};
        if (!latestByProvInd[prov][ind] || yr > latestByProvInd[prov][ind].year) {
            latestByProvInd[prov][ind] = { year: yr, value: val };
        }
    });
}

// Debounced chart updater used by sliders (reduces redraw frequency)
const debouncedUpdateChart = debounce(() => {
    if (!chartObj) return;
    chartObj.data.datasets[0].data = getChartData();
    chartObj.update();
}, 120);

async function fillSubtopicSelect() {
    const select = document.getElementById('subtopic-select');
    if (!select || !urlTopic) return;
    try {
        let hierarchy = topicsHierarchy;
        if (!hierarchy || !Object.keys(hierarchy).length) {
            const res = await fetch(`${API_BASE_URL}/api/explorer/init`);
            const data = await res.json();
            hierarchy = data.hierarchy || {};
        }
        let subs = Object.keys(hierarchy[urlTopic] || {});
        select.innerHTML = '';
        if (!subs.length && urlSubtopic) subs = [urlSubtopic];
        subs.forEach(sub => {
            const opt = document.createElement('option');
            opt.value = sub;
            opt.textContent = sub;
            if (sub === urlSubtopic) opt.selected = true;
            select.appendChild(opt);
        });
        select.onchange = () => {
            const sub = select.value;
            if (!sub || sub === urlSubtopic) return;
            loadBubbleData(sub, { pushUrl: true });
        };
    } catch (err) {
        console.error('Error loading subtopics', err);
        if (urlSubtopic) {
            const opt = document.createElement('option');
            opt.value = urlSubtopic;
            opt.textContent = urlSubtopic;
            opt.selected = true;
            select.appendChild(opt);
        }
    }
}

function pickerTopics() {
    return Object.keys(topicsHierarchy).filter(topic => {
        if (topic === 'شاخص جامع فرهنگی اجتماعی') return false;
        const subs = topicsHierarchy[topic];
        return subs && Object.keys(subs).length > 0;
    }).slice(0, 8);
}

function topicAccent(topic) {
    const row = topicsColorData.find(t => t.topic_name === topic);
    return (row && (row.master_color || row.upper_color)) || '#0078d7';
}

function firstSubtopic(topic) {
    return Object.keys(topicsHierarchy[topic] || {})[0] || '';
}

function resizeBubbleChart() {
    if (chartObj && typeof chartObj.resize === 'function') {
        try { chartObj.resize(); } catch (e) {}
    }
}

function showBubbleView(view, animate) {
    const deck = document.getElementById('bb-deck');
    if (!deck) return;
    const toChart = view === 'chart';
    const picker = document.getElementById('bb-picker');
    const workspace = document.querySelector('.bubble-workspace');
    if (picker) {
        picker.toggleAttribute('inert', toChart);
        picker.setAttribute('aria-hidden', toChart ? 'true' : 'false');
    }
    if (workspace) {
        workspace.toggleAttribute('inert', !toChart);
        workspace.setAttribute('aria-hidden', toChart ? 'false' : 'true');
    }
    if (!animate) deck.classList.add('is-instant');
    deck.classList.toggle('is-chart', toChart);
    if (!animate) {
        requestAnimationFrame(() => {
            deck.classList.remove('is-instant');
            if (toChart) resizeBubbleChart();
        });
        return;
    }
    let done = false;
    const finish = (event) => {
        if (done) return;
        if (event && event.propertyName && event.propertyName !== 'transform') return;
        done = true;
        if (workspace) workspace.removeEventListener('transitionend', finish);
        if (toChart) resizeBubbleChart();
    };
    if (workspace) workspace.addEventListener('transitionend', finish);
    setTimeout(finish, 1000);
}

function markPickerTopic(topic) {
    document.querySelectorAll('.bb-topic-card').forEach(card => {
        card.classList.toggle('is-current', card.dataset.topic === topic);
    });
}

async function selectPickerTopic(topic) {
    if (!topic) return;
    urlTopic = topic;
    urlSubtopic = firstSubtopic(topic);
    markPickerTopic(topic);
    applyBubbleTheme(topicsColorData.find(t => t.topic_name === topic));
    const explorerBtn = document.getElementById('btn-explorer');
    if (explorerBtn) {
        explorerBtn.href = `explorer.html?openTopic=${encodeURIComponent(urlTopic)}&source=${encodeURIComponent(urlSource)}`;
    }
    const subtitle = document.getElementById('page-subtitle');
    if (subtitle) subtitle.innerText = `حوزه: ${urlTopic}`;
    showBubbleView('chart', pickerReady);
    chartOpenedFromPicker = true;
    await fillSubtopicSelect();
    if (urlSubtopic) await loadBubbleData(urlSubtopic, { pushUrl: true });
    resizeBubbleChart();
}

function goBackToPicker() {
    if (chartOpenedFromPicker && history.state && history.state.view === 'chart') {
        chartOpenedFromPicker = false;
        history.back();
        return;
    }
    markPickerTopic('');
    showBubbleView('picker', true);
    const next = new URL(window.location.href);
    next.searchParams.delete('topic');
    next.searchParams.delete('subtopic');
    if (urlSource) next.searchParams.set('source', urlSource);
    history.replaceState({ view: 'picker' }, '', next);
}

function renderTopicStack() {
    const stack = document.getElementById('bb-topic-stack');
    if (!stack) return;
    stack.innerHTML = '';
    pickerTopics().forEach(topic => {
        const accent = topicAccent(topic);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bb-topic-card';
        btn.dataset.topic = topic;
        btn.style.setProperty('--topic-accent', accent);
        btn.innerHTML =
            '<span class="bb-topic-pearl" aria-hidden="true"></span>' +
            '<span class="bb-topic-name">' + escapeHtml(topic) + '</span>';
        btn.addEventListener('click', () => selectPickerTopic(topic));
        stack.appendChild(btn);
    });
}

const BUBBLE_PREVIEW = [
    { name: 'تهران', x: 30, y: 36, s: 148 },
    { name: 'مشهد', x: 54, y: 20, s: 122 },
    { name: 'اصفهان', x: 72, y: 40, s: 112 },
    { name: 'شیراز', x: 42, y: 60, s: 100 },
    { name: 'تبریز', x: 14, y: 50, s: 96 },
    { name: 'کرج', x: 36, y: 16, s: 78 },
    { name: 'اهواز', x: 84, y: 28, s: 88 },
    { name: 'قم', x: 58, y: 68, s: 72 },
    { name: 'رشت', x: 76, y: 62, s: 80 },
    { name: 'کرمان', x: 90, y: 50, s: 74 },
    { name: 'یزد', x: 66, y: 54, s: 70 },
    { name: 'ارومیه', x: 8, y: 26, s: 68 },
    { name: 'همدان', x: 22, y: 70, s: 66 },
    { name: 'کرمانشاه', x: 18, y: 40, s: 76 },
    { name: 'زاهدان', x: 92, y: 72, s: 64 },
    { name: 'بندرعباس', x: 80, y: 80, s: 68 },
    { name: 'ساری', x: 50, y: 46, s: 62 },
    { name: 'اردبیل', x: 6, y: 14, s: 60 },
    { name: 'زنجان', x: 26, y: 24, s: 58 },
    { name: 'اراک', x: 46, y: 80, s: 64 }
];

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

function initBubblePreview() {
    const stage = document.getElementById('bb-preview');
    if (!stage) return;
    BUBBLE_PREVIEW.forEach((b, i) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'bb-bubble';
        el.textContent = b.name;
        el.style.left = b.x + '%';
        el.style.top = b.y + '%';
        el.style.width = b.s + 'px';
        el.style.height = b.s + 'px';
        el.style.marginLeft = -(b.s / 2) + 'px';
        el.style.marginTop = -(b.s / 2) + 'px';
        el.style.fontSize = Math.max(11, Math.round(b.s * 0.13)) + 'px';
        el.style.animationDelay = (-i * 0.28) + 's';
        el.setAttribute('aria-label', b.name);
        stage.appendChild(el);
        bindBubbleDrag(el, stage);
    });
}

async function loadPickerCatalog() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/explorer/init`);
        const data = await res.json();
        topicsHierarchy = data.hierarchy || {};
        topicsColorData = data.colors || [];
    } catch (err) {
        console.error('Error loading bubble picker catalog', err);
    }
}

async function init() {
    await loadPickerCatalog();
    renderTopicStack();
    initBubblePreview();

    const backBtn = document.getElementById('btn-back-picker');
    if (backBtn) backBtn.addEventListener('click', goBackToPicker);

    const explorerBtn = document.getElementById('btn-explorer');
    if (explorerBtn) {
        explorerBtn.href = urlTopic
            ? `explorer.html?openTopic=${encodeURIComponent(urlTopic)}&source=${encodeURIComponent(urlSource)}`
            : `explorer.html?source=${encodeURIComponent(urlSource)}`;
    }

    if (urlTopic) markPickerTopic(urlTopic);
    showBubbleView('picker', false);
    pickerReady = true;
}

function applyBubbleTheme(colors) {
    if (!colors) return;
    if (colors.upper_color) themeUpper = colors.upper_color;
    if (colors.lower_color) themeLower = colors.lower_color;
    const bannerHex = colors.master_color || colors.upper_color || themeUpper;
    document.documentElement.style.setProperty('--banner-bg', bannerHex);
    document.documentElement.style.setProperty('--topic-accent', bannerHex);
    try {
        sessionStorage.setItem('themeBannerBg', bannerHex);
        sessionStorage.setItem('themeTopicAccent', bannerHex);
    } catch (e) {}
}

function syncBubbleUrl(replace) {
    const next = new URL(window.location.href);
    if (urlTopic) next.searchParams.set('topic', urlTopic);
    if (urlSubtopic) next.searchParams.set('subtopic', urlSubtopic);
    if (urlSource) next.searchParams.set('source', urlSource);
    const state = { view: 'chart', topic: urlTopic, subtopic: urlSubtopic };
    if (replace) history.replaceState(state, '', next);
    else history.pushState(state, '', next);
}

function refreshOrDrawChart() {
    if (!chartObj) {
        drawChart();
        return;
    }
    chartObj.data.datasets[0].data = getChartData();
    chartObj.data.datasets[0].backgroundColor = themeUpper + 'D9';
    chartObj.data.datasets[0].borderColor = themeUpper;
    if (chartObj.options.scales && chartObj.options.scales.x) {
        chartObj.options.scales.x.max = uniqueProvinces.length;
    }
    chartObj.update();
}

async function loadBubbleData(subtopic, opts) {
    opts = opts || {};
    const sub = subtopic || urlSubtopic;
    if (!urlTopic || !sub) return;
    const seq = ++loadSeq;
    const prevSub = urlSubtopic;
    try {
        const response = await fetch(`${API_BASE_URL}/api/bubble/init?topic=${encodeURIComponent(urlTopic)}&subtopic=${encodeURIComponent(sub)}`);
        if (seq !== loadSeq) return;
        if (!response.ok) throw new Error('bubble api ' + response.status);
        const data = await response.json();
        if (seq !== loadSeq) return;

        applyBubbleTheme(data.colors);
        rawData = Array.isArray(data.scores) ? data.scores : [];
        if (rawData.length === 0) {
            showNotice("داده‌ای برای این زیرحوزه یافت نشد.", "info");
            const select = document.getElementById('subtopic-select');
            if (select) select.value = prevSub || '';
            return;
        }

        urlSubtopic = sub;
        if (opts.pushUrl) syncBubbleUrl(false);
        else if (opts.replaceUrl) syncBubbleUrl(true);

        const select = document.getElementById('subtopic-select');
        if (select && select.value !== urlSubtopic) select.value = urlSubtopic;

        buildLatestLookup();
        uniqueProvinces = (data.provinces || []).slice().sort();
        indicators = data.indicators || [];
        indicatorWeights = {};
        indicators.forEach(ind => { indicatorWeights[ind] = 0; });
        buildSliders();
        refreshOrDrawChart();
    } catch (err) {
        if (seq !== loadSeq) return;
        console.error("Error Loading API Data:", err);
        showNotice("مشکل در ارتباط با سرور بک‌اند.");
        const select = document.getElementById('subtopic-select');
        if (select && prevSub) select.value = prevSub;
    }
}

function buildSliders() {
    const container = document.getElementById('indicators-list');
    container.replaceChildren();
    indicators.forEach(ind => {
        const div = document.createElement('div');
        div.className = 'bb-slider';

        const nameEl = document.createElement('span');
        nameEl.className = 'bb-slider-name';
        nameEl.title = ind;
        nameEl.textContent = ind;
        const valEl = document.createElement('span');
        valEl.className = 'bb-slider-val';
        valEl.textContent = String(indicatorWeights[ind]);
        const head = document.createElement('div');
        head.className = 'bb-slider-head';
        head.append(nameEl, valEl);

        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'slider-control';
        input.min = '-1';
        input.max = '1';
        input.step = '0.1';
        input.value = String(indicatorWeights[ind]);
        input.addEventListener('input', () => updateWeight(ind, input.value, valEl));

        const scale = document.createElement('div');
        scale.className = 'bb-slider-scale';
        ['۱−', '۰', '۱+'].forEach(label => {
            const span = document.createElement('span');
            span.textContent = label;
            scale.appendChild(span);
        });
        const track = document.createElement('div');
        track.className = 'bb-slider-track';
        track.append(input, scale);

        div.append(head, track);
        container.appendChild(div);
    });
}

function updateWeight(indName, value, valEl) {
    indicatorWeights[indName] = Number(value);
    if (valEl) valEl.textContent = value;
    debouncedUpdateChart();
}

function calculateSubtopicScore(prov) {
    const provLookup = latestByProvInd[prov] || {};
    let weightedLog = 0;
    let absWeightSum = 0;

    indicators.forEach(ind => {
        const weight = Number(indicatorWeights[ind]);
        if (!weight) return;

        const rec = provLookup[ind];
        if (!rec) return;

        const val = Number(rec.value);
        if (!Number.isFinite(val) || val <= 0) return;

        weightedLog += weight * Math.log(val);
        absWeightSum += Math.abs(weight);
    });

    if (absWeightSum === 0) return 0;
    return Math.exp(weightedLog / absWeightSum);
}

function getChartData() {
    let datasetsData = [];
    uniqueProvinces.forEach((prov, index) => {
        let score = calculateSubtopicScore(prov);
        datasetsData.push({
            x: index, 
            y: score, 
            r: 22, 
            provName: prov 
        });
    });
    return datasetsData;
}

function drawChart() {
    const ctx = document.getElementById('bubbleChart').getContext('2d');
    
    chartObj = new Chart(ctx, {
        type: 'bubble',
        data: {
            datasets: [{
                label: 'استان‌ها',
                data: getChartData(),
                backgroundColor: themeUpper + 'D9',
                borderColor: themeUpper,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            animation: { duration: 300, easing: 'easeOutQuad' },
            layout: { padding: { top: 28, right: 28, bottom: 16, left: 12 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.raw.provName} - امتیاز: ${ctx.raw.y.toFixed(2)}`
                    }
                },
                datalabels: {
                    color: '#ffffff',
                    align: 'center',
                    anchor: 'center',
                    textAlign: 'center',
                    font: { family: 'PeydaFaNumWeb', size: 9, weight: '600' },
                    formatter: (value) => {
                        let name = value.provName || '';
                        return name.includes(' ') ? name.split(' ') : name;
                    }
                }
            },
            scales: {
                x: {
                    display: false, 
                    min: -1, max: uniqueProvinces.length 
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.1)' },
                    title: { display: true, text: 'امتیاز زیرحوزه (محاسبه شده)', font: { size: 13, family: 'PeydaFaNumWeb', weight: '600' }, color: '#5c6570' }
                }
            }
        }
    });
}

// Resize handler: keep chart crisp and responsive across displays
const onResize = debounce(() => {
    if (chartObj && typeof chartObj.resize === 'function') chartObj.resize();
}, 150);
window.addEventListener('resize', onResize);

window.addEventListener('popstate', (event) => {
    const params = new URLSearchParams(window.location.search);
    const view = (event.state && event.state.view) || (params.get('topic') ? 'chart' : 'picker');
    if (view !== 'chart') {
        markPickerTopic('');
        showBubbleView('picker', true);
        return;
    }
    const topic = (event.state && event.state.topic) || params.get('topic');
    const sub = (event.state && event.state.subtopic) || params.get('subtopic');
    if (topic && topic !== urlTopic) {
        urlTopic = topic;
        markPickerTopic(topic);
        const subtitle = document.getElementById('page-subtitle');
        if (subtitle) subtitle.innerText = `حوزه: ${urlTopic}`;
        fillSubtopicSelect();
    }
    showBubbleView('chart', true);
    if (!sub || sub === urlSubtopic) {
        resizeBubbleChart();
        return;
    }
    const select = document.getElementById('subtopic-select');
    if (select) select.value = sub;
    loadBubbleData(sub);
});

function startBubble() {
    if (!applyChartDefaults()) showNotice('مشکل در بارگذاری نمودار.');
    init();
}

onReady(startBubble);