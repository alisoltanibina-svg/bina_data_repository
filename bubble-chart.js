// File: bubble-chart.js
// Purpose: Implements the interactive bubble chart view for a selected topic/subtopic.
//   Manages data fetching, preprocessing (latest-per-province lookup), weight sliders,
//   chart rendering, and responsive behavior for high-DPI displays.
// Notes: Comments standardized to English; UI text (Persian) is preserved.

// -- Bubble chart initialization --
Chart.register(ChartDataLabels);
Chart.defaults.font.family = "'PeydaFaNumWeb', sans-serif";
// Ensure charts render crisply on high-DPI / Retina displays
Chart.defaults.devicePixelRatio = window.devicePixelRatio || 1;
if (Chart.defaults.animation === false) Chart.defaults.animation = {};
if (Chart.defaults.animation) Chart.defaults.animation.duration = 1000;

const urlParams = new URLSearchParams(window.location.search);
let urlTopic = urlParams.get('topic');
let urlSubtopic = urlParams.get('subtopic');
const urlSource = urlParams.get('source') || 'atlas'; 

function brightenColor(hex, percent) {
    hex = hex.replace('#', '');
    if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('');
    }
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    
    r = Math.round(r + (255 - r) * percent);
    g = Math.round(g + (255 - g) * percent);
    b = Math.round(b + (255 - b) * percent);
    
    const toHex = (n) => {
        const hexVal = n.toString(16);
        return hexVal.length === 1 ? '0' + hexVal : hexVal;
    };
    
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}


const API_BASE_URL = window.API_BASE_URL || (window.location.protocol + '//' + window.location.hostname + ':8000');
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

// Simple debounce helper for UI responsiveness
function debounce(fn, wait) {
    let t;
    return function(...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
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
        const res = await fetch(`${API_BASE_URL}/api/explorer/init`);
        const data = await res.json();
        const subs = Object.keys((data.hierarchy && data.hierarchy[urlTopic]) || {});
        select.innerHTML = '';
        if (!subs.length && urlSubtopic) subs.push(urlSubtopic);
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

async function resolveBubbleTopic() {
    if (urlTopic && urlSubtopic) return;
    try {
        const res = await fetch(`${API_BASE_URL}/api/explorer/init`);
        const data = await res.json();
        const hierarchy = data.hierarchy || {};
        if (!urlTopic) {
            urlTopic = Object.keys(hierarchy).find(t => hierarchy[t] && Object.keys(hierarchy[t]).length) || '';
        }
        if (urlTopic && !urlSubtopic) {
            urlSubtopic = Object.keys(hierarchy[urlTopic] || {})[0] || '';
        }
        if (urlTopic && urlSubtopic) {
            const next = new URL(window.location.href);
            next.searchParams.set('topic', urlTopic);
            next.searchParams.set('subtopic', urlSubtopic);
            history.replaceState({}, '', next);
        }
    } catch (err) {
        console.error('Error resolving bubble chart topic', err);
    }
}

async function init() {
    await resolveBubbleTopic();
    if(!urlTopic || !urlSubtopic) {
        alert("پارامترهای صفحه نامعتبر است!");
        return;
    }
    document.getElementById('page-subtitle').innerText = `حوزه: ${urlTopic}`;
    await fillSubtopicSelect();

    const explorerHref = urlTopic
        ? `explorer.html?openTopic=${encodeURIComponent(urlTopic)}&source=${encodeURIComponent(urlSource)}`
        : `explorer.html?source=${encodeURIComponent(urlSource)}`;
    const backLink = document.getElementById('btn-back-explorer');
    const explorerBtn = document.getElementById('btn-explorer');
    if (backLink) backLink.href = explorerHref;
    if (explorerBtn) explorerBtn.href = explorerHref;

    await loadBubbleData(urlSubtopic, { replaceUrl: true });
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
    const state = { topic: urlTopic, subtopic: urlSubtopic };
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
            alert("داده‌ای برای این زیرحوزه یافت نشد.");
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
        alert("مشکل در ارتباط با سرور بک‌اند.");
        const select = document.getElementById('subtopic-select');
        if (select && prevSub) select.value = prevSub;
    }
}

function buildSliders() {
    const container = document.getElementById('indicators-list');
    container.innerHTML = '';
    indicators.forEach(ind => {
        const div = document.createElement('div');
        div.className = 'bb-slider';
        const safeId = 'val-' + ind;
        div.innerHTML =
            '<div class="bb-slider-head">' +
                '<span class="bb-slider-name" title="' + ind.replace(/"/g, '&quot;') + '">' + ind + '</span>' +
                '<span class="bb-slider-val" id="' + safeId + '">' + indicatorWeights[ind] + '</span>' +
            '</div>' +
            '<div class="bb-slider-track">' +
                '<input type="range" class="slider-control" min="-1" max="1" step="0.1" value="' + indicatorWeights[ind] + '" oninput="updateWeight(\'' + ind.replace(/'/g, "\\'") + '\', this.value)">' +
                '<div class="bb-slider-scale"><span>۱−</span><span>۰</span><span>۱+</span></div>' +
            '</div>';
        container.appendChild(div);
    });
}

function updateWeight(indName, value) {
    indicatorWeights[indName] = Number(value);
    document.getElementById(`val-${indName}`).innerText = value;
    // Use debounced update to avoid excessive redraws while dragging sliders
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

function updateChartData() {
    if(!chartObj) return;
    chartObj.data.datasets[0].data = getChartData();
    chartObj.update();
}

// Debounce helper (if not already defined globally)
function debounceLocal(fn, wait) {
    let t;
    return function(...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

// Resize handler: keep chart crisp and responsive across displays
const onResize = debounceLocal(() => {
    if (chartObj && typeof chartObj.resize === 'function') chartObj.resize();
}, 150);
window.addEventListener('resize', onResize);

window.addEventListener('popstate', (event) => {
    const params = new URLSearchParams(window.location.search);
    const sub = (event.state && event.state.subtopic) || params.get('subtopic');
    if (!sub || sub === urlSubtopic) return;
    const select = document.getElementById('subtopic-select');
    if (select) select.value = sub;
    loadBubbleData(sub);
});

window.onload = init;