// File: bubble-chart.js
// Purpose: Implements the interactive bubble chart view for a selected topic/subtopic.
//   Manages data fetching, preprocessing (latest-per-province lookup), weight sliders,
//   chart rendering, and responsive behavior for high-DPI displays.
// Notes: Comments standardized to English; UI text (Persian) is preserved.

// -- Bubble chart initialization --
Chart.register(ChartDataLabels);
Chart.defaults.font.family = "'Vazirmatn', sans-serif";
// Ensure charts render crisply on high-DPI / Retina displays
Chart.defaults.devicePixelRatio = window.devicePixelRatio || 1;
if (Chart.defaults.animation === false) Chart.defaults.animation = {};
if (Chart.defaults.animation) Chart.defaults.animation.duration = 1000;

// --- Authentication Check ---
if (!sessionStorage.getItem('dashboard_auth_token')) {
    window.location.replace('log_in.html');
}

const urlParams = new URLSearchParams(window.location.search);
const urlTopic = urlParams.get('topic');
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
            window.location.href = `bubble-chart.html?topic=${encodeURIComponent(urlTopic)}&subtopic=${encodeURIComponent(sub)}&source=${encodeURIComponent(urlSource)}`;
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

async function init() {
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

    try {
        const response = await fetch(`${API_BASE_URL}/api/bubble/init?topic=${encodeURIComponent(urlTopic)}&subtopic=${encodeURIComponent(urlSubtopic)}`);
        const data = await response.json();
        
        if(data.colors) {
            if(data.colors.upper_color) themeUpper = data.colors.upper_color;
            if(data.colors.lower_color) themeLower = data.colors.lower_color;
            const bannerHex = data.colors.master_color || data.colors.upper_color || themeUpper;
            document.documentElement.style.setProperty('--banner-bg', bannerHex);
            document.documentElement.style.setProperty('--topic-accent', bannerHex);
            try {
                sessionStorage.setItem('themeBannerBg', bannerHex);
                sessionStorage.setItem('themeTopicAccent', bannerHex);
            } catch (e) {}
        }
        
        document.getElementById('plot-wrapper').style.backgroundColor = brightenColor(themeLower, 0.3); 

        rawData = data.scores;
        
        if(rawData.length === 0) {
            alert("داده‌ای برای این زیرحوزه یافت نشد.");
            return;
        }

        // Precompute latest values so score calculation is fast in UI
        buildLatestLookup();

        uniqueProvinces = data.provinces.sort();
        indicators = data.indicators;

        indicators.forEach(ind => {
            indicatorWeights[ind] = 0; 
        });

        buildSliders();
        drawChart();

    } catch (err) {
        console.error("Error Loading API Data:", err);
        alert("مشکل در ارتباط با سرور بک‌اند.");
    }
}

function buildSliders() {
    const container = document.getElementById('indicators-list');
    container.innerHTML = '';
    indicators.forEach(ind => {
        const div = document.createElement('div');
        div.className = "flex flex-col";
        div.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <span class="text-sm font-bold text-gray-700 truncate max-w-[200px]" title="${ind}">${ind}</span>
                <span class="text-xs font-mono bg-white border border-gray-200 px-2 py-1 rounded w-10 text-center" id="val-${ind}">${indicatorWeights[ind]}</span>
            </div>
            <div class="relative w-full" dir="ltr">
                <div class="absolute left-1/2 top-[14px] bottom-0 w-px h-2 bg-gray-400 -translate-x-1/2 z-0"></div>
                <input type="range" class="slider-control relative z-10" min="-1" max="1" step="0.1" value="${indicatorWeights[ind]}" 
                        oninput="updateWeight('${ind}', this.value)">
                <div class="flex justify-between text-[11px] text-gray-400 mt-1 px-1 font-mono font-bold">
                    <span>-1</span>
                    <span>0</span>
                    <span>1</span>
                </div>
            </div>
        `;
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
    let product = 1;
    let activeCount = 0;

    // Use prebuilt lookup for O(1) access instead of filtering the whole array repeatedly
    const provLookup = latestByProvInd[prov] || {};

    indicators.forEach(ind => {
        let weight = indicatorWeights[ind];
        if (weight === 0) return;

        const rec = provLookup[ind];
        if (!rec) return;

        let val = rec.value !== undefined ? Number(rec.value) : 1;

        product *= (val * weight);
        activeCount++;
    });

    if (activeCount === 0) return 0;
    let sign = product < 0 ? -1 : 1;
    return sign * Math.pow(Math.abs(product), 1 / activeCount);
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
                    font: { family: 'Vazirmatn', size: 9, weight: 'bold' },
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
                    title: { display: true, text: 'امتیاز زیرحوزه (محاسبه شده)', font: { size: 14, family: 'Vazirmatn' } }
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

window.onload = init;