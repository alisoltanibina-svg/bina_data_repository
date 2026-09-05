// File: index.js
// Purpose: Main front-end controller for the interactive map dashboard.
//   Handles UI initialization, map rendering, topic/topic-color management, caching of map scores,
//   lazy-loading of background images, and responsive behavior for charts and map layers.
// Notes: All inline comments in this project were standardized to clear English. UI labels and text
//   remain in Persian and are intentionally left unchanged. This header was added to improve
//   maintainability and readability.

// -- Typology focus animation configuration --
const typologyFocusConfig = {
    animationDuration: '1.6s',  
    transitionEasing: 'cubic-bezier(0.25, 1, 0.5, 1)',
    focusScale: 1.15,           
    neighborGap: 25,            
    focusOffset: 0.35
};

function initCurtainReveal() {
    const root = document.getElementById('entry-view-curtain');
    if (!root) return;
    const items = root.querySelectorAll('.entry-reveal');
    if (!items.length) return;
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-inview');
                entry.target.classList.remove('is-leave');
            } else {
                entry.target.classList.remove('is-inview');
                entry.target.classList.add('is-leave');
            }
        });
    }, { root, threshold: 0.2, rootMargin: '0px 0px -6% 0px' });
    items.forEach(el => observer.observe(el));
}

function initPerspectiveGrid() {
    const plane = document.getElementById('perspective-grid-plane');
    if (!plane || plane.childElementCount > 0) return;
    const size = Number(getComputedStyle(plane).getPropertyValue('--grid-size')) || 28;
    const count = size * size;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
        const tile = document.createElement('div');
        tile.className = 'perspective-grid-tile';
        frag.appendChild(tile);
    }
    plane.appendChild(frag);
}

function isCompactMap() {
    return window.matchMedia('(max-width: 767px)').matches;
}

function setMapSheet(sheet) {
    const allowed = ['map', 'details', 'topics', 'groups'];
    if (!allowed.includes(sheet)) sheet = 'map';
    document.body.classList.remove('map-sheet-map', 'map-sheet-details', 'map-sheet-topics', 'map-sheet-groups');
    if (!isCompactMap()) return;
    document.body.classList.add('map-sheet-' + sheet);
    document.querySelectorAll('#map-panel-dock .map-dock-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.sheet === sheet);
    });
    requestAnimationFrame(() => {
        try { if (map && typeof map.invalidateSize === 'function') map.invalidateSize(true); } catch (e) {}
        try { refitMapView({ animate: false }); } catch (e) {}
    });
}

function mapOverlayPadding() {
    const mapEl = document.getElementById('map');
    if (!mapEl) return { paddingTopLeft: [20, 80], paddingBottomRight: [20, 160] };
    const mapRect = mapEl.getBoundingClientRect();

    const inset = (el, side) => {
        if (!el || el.hidden) return 0;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return 0;
        const box = el.getBoundingClientRect();
        if (box.width < 4 || box.height < 4) return 0;
        const overlaps = !(box.right < mapRect.left || box.left > mapRect.right || box.bottom < mapRect.top || box.top > mapRect.bottom);
        if (!overlaps) return 0;
        if (side === 'top') return Math.max(0, box.bottom - mapRect.top);
        if (side === 'bottom') return Math.max(0, mapRect.bottom - box.top);
        if (side === 'left') return Math.max(0, box.right - mapRect.left);
        if (side === 'right') return Math.max(0, mapRect.right - box.left);
        return 0;
    };

    let top = inset(document.getElementById('top-banner'), 'top');
    let bottom = Math.max(
        inset(document.getElementById('bottom-panel'), 'bottom'),
        inset(document.getElementById('map-legend'), 'bottom'),
        inset(document.getElementById('map-panel-dock'), 'bottom')
    );
    let left = 0;
    let right = 0;

    if (isCompactMap()) {
        if (document.body.classList.contains('map-sheet-details')) {
            bottom = Math.max(bottom, inset(document.getElementById('right-panel'), 'bottom'));
        }
        if (document.body.classList.contains('map-sheet-topics')) {
            bottom = Math.max(bottom, inset(document.getElementById('left-popup-panel'), 'bottom'));
        }
        if (document.body.classList.contains('map-sheet-groups')) {
            bottom = Math.max(bottom, inset(document.getElementById('floating-group-container'), 'bottom'));
        }
    } else {
        left = inset(document.getElementById('left-popup-panel'), 'left');
        const rp = document.getElementById('right-panel');
        if (rp && rp.classList.contains('show-panel')) right = Math.max(right, inset(rp, 'right'));
        const fg = document.getElementById('floating-group-container');
        if (fg && fg.classList.contains('show-float')) right = Math.max(right, inset(fg, 'right'));
    }

    const maxX = Math.max(24, mapRect.width * 0.4);
    const maxY = Math.max(24, mapRect.height * 0.4);
    top = Math.min(Math.round(top + 8), maxY);
    bottom = Math.min(Math.round(bottom + 8), maxY);
    left = Math.min(Math.round(left + 8), maxX);
    right = Math.min(Math.round(right + 8), maxX);

    return {
        paddingTopLeft: [left, top],
        paddingBottomRight: [right, bottom]
    };
}

function iranLayerBounds() {
    if (geojsonLayer && typeof geojsonLayer.getBounds === 'function') {
        const bounds = geojsonLayer.getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) return bounds;
    }
    return L.latLngBounds([[25.05, 44.05], [39.78, 63.33]]);
}

function selectedProvinceBounds() {
    if (!selectedProvince || !geojsonLayer) return null;
    let found = null;
    geojsonLayer.eachLayer(layer => {
        if (found) return;
        if (layer.feature && layer.feature.properties.ProvincNam === selectedProvince) {
            found = layer.getBounds();
        }
    });
    return found && found.isValid() ? found : null;
}

function similarGroupBounds() {
    if (!geojsonLayer || !similarProvinces.length) return null;
    const group = L.latLngBounds();
    geojsonLayer.eachLayer(layer => {
        const name = layer.feature && layer.feature.properties.ProvincNam;
        if (similarProvinces.includes(name)) group.extend(layer.getBounds());
    });
    return group.isValid() ? group : null;
}

const MAP_HOME_CENTER = [31.4279, 55.6880];
const MAP_HOME_ZOOM = 4.8;
const MAP_MAX_ZOOM = 5.2;

function showIranView({ animate = false } = {}) {
    if (!map) return;
    map.invalidateSize(true);
    if (isCompactMap()) {
        fitMapTo(iranLayerBounds(), { animate, maxZoom: MAP_HOME_ZOOM, duration: 1.2 });
        return;
    }
    if (animate) map.flyTo(MAP_HOME_CENTER, MAP_HOME_ZOOM, { duration: 1.6 });
    else map.setView(MAP_HOME_CENTER, MAP_HOME_ZOOM, { animate: false });
}

function fitMapTo(bounds, { animate = false, maxZoom = MAP_MAX_ZOOM, duration = 1.6 } = {}) {
    if (!map || !bounds) return;
    map.invalidateSize(true);
    const opts = { ...mapOverlayPadding(), maxZoom: Math.min(maxZoom, MAP_MAX_ZOOM) };
    if (animate) map.flyToBounds(bounds, { ...opts, duration });
    else map.fitBounds(bounds, opts);
}

function refitMapView({ animate = false } = {}) {
    if (!map) return;
    if (document.body.classList.contains('immersive-mode')) {
        map.invalidateSize(true);
        if (isCompactMap()) {
            const group = similarGroupBounds();
            if (group) fitMapTo(group, { animate, maxZoom: MAP_MAX_ZOOM });
            else showIranView({ animate });
            return;
        }
        if (animate) map.flyTo([32.4279, 62.6880], 5.5, { duration: 1.6 });
        else map.setView([32.4279, 62.6880], Math.min(5.5, MAP_MAX_ZOOM), { animate: false });
        return;
    }
    const province = selectedProvinceBounds();
    if (province) {
        fitMapTo(province, { animate, maxZoom: MAP_MAX_ZOOM });
        return;
    }
    showIranView({ animate });
}

function bindMapPanelDock() {
    const dock = document.getElementById('map-panel-dock');
    if (!dock || dock.dataset.bound) return;
    dock.dataset.bound = '1';
    dock.addEventListener('click', (event) => {
        const btn = event.target.closest('.map-dock-btn');
        if (!btn || btn.hidden) return;
        setMapSheet(btn.dataset.sheet);
    });
    const syncDock = () => {
        if (!isCompactMap()) {
            dock.hidden = true;
            document.body.classList.remove('map-sheet-map', 'map-sheet-details', 'map-sheet-topics', 'map-sheet-groups');
            return;
        }
        dock.hidden = false;
        if (![...document.body.classList].some(name => name.startsWith('map-sheet-'))) setMapSheet('map');
    };
    window.addEventListener('resize', debounce(syncDock, 150));
    syncDock();
}

window.addEventListener('DOMContentLoaded', () => {
    initPerspectiveGrid();
    initCurtainReveal();
    bindMapPanelDock();
    if (!sessionStorage.getItem('welcomeShown')) {
        const overlay = document.getElementById('welcome-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
        }
        sessionStorage.setItem('welcomeShown', 'true');
    }
});

Chart.defaults.color = '#333333'; 
Chart.defaults.font.family = "'Vazirmatn', Tahoma, sans-serif";
// Render crisp on high DPI displays
Chart.defaults.devicePixelRatio = window.devicePixelRatio || 1;
if (Chart.defaults.animation === false) Chart.defaults.animation = {};
if (Chart.defaults.animation) Chart.defaults.animation.duration = 1000;

// Simple debounce utility for resize/throttle
function debounce(fn, wait) {
    let t;
    return function(...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

// Lazy-background loader: defer setting background-image until element near viewport
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
        // Fallback: eagerly load all
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

const API_BASE_URL = 'http://127.0.0.1:8000';

function persistAppTheme(banner, accent) {
    try {
        if (banner) sessionStorage.setItem('themeBannerBg', banner);
        if (accent) sessionStorage.setItem('themeTopicAccent', accent);
    } catch (e) {}
}

function hexToRgb(hex) {
    let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : {r:0, g:120, b:215};
}

function shadeRGB(colorObj, percent) {
    let r = parseInt(colorObj.r * (100 + percent) / 100);
    let g = parseInt(colorObj.g * (100 + percent) / 100);
    let b = parseInt(colorObj.b * (100 + percent) / 100);
    r = r < 255 ? r : 255; g = g < 255 ? g : 255; b = b < 255 ? b : 255;
    r = r > 0 ? r : 0; g = g > 0 ? g : 0; b = b > 0 ? b : 0;
    return `rgb(${r}, ${g}, ${b})`;
}

function interpolateColor(c1, c2, factor) {
    let r = Math.round(c1.r + factor * (c2.r - c1.r));
    let g = Math.round(c1.g + factor * (c2.g - c1.g));
    let b = Math.round(c1.b + factor * (c2.b - c1.b));
    return `rgb(${r}, ${g}, ${b})`;
}

const heatStages = 7;
let currentLowerRgb = {r:230, g:240, b:255}; 
let currentUpperRgb = {r:0, g:120, b:215};
let hoveredStageIndex = null;

function initLegend() {
    const bar = document.getElementById('legend-bar');
    const pointer = document.getElementById('score-pointer');
    bar.innerHTML = '';
    bar.appendChild(pointer);

    for(let i=0; i<heatStages; i++) {
        let scoreVal = (i / (heatStages - 1)) * 100;
        let seg = document.createElement('div');
        seg.className = 'legend-segment';
        seg.style.backgroundColor = getHeatmapColor(scoreVal);
        
        seg.addEventListener('mouseenter', () => { hoveredStageIndex = i; updateMapStyles(); });
        seg.addEventListener('mouseleave', () => { hoveredStageIndex = null; updateMapStyles(); });
        bar.appendChild(seg);
    }
    document.getElementById('legend-title-text').innerText = `${currentIndex}`;
}

let topicsData = []; let trendScoreData = []; let clustersData = []; 

// Latest-year trend_score rows, used wherever the map previously read map_scores
let mapScoresLookup = {}; // mapScoresLookup[province_name] = { [topic_name]: row }
let mapScoresByTopic = {}; // mapScoresByTopic[topic_name] = [ rows ]
let mapProvincePop = {}; // mapProvincePop[province_name] = latest province_pop

let currentIndex = "";
let map, geojsonLayer;
let rankingBarChart = null;
let trendChartInstance = null;
let groupChartsInstances = [];
let loadedGeoJSON = null;
let selectedProvince = null;
let similarProvinces = []; 
let leftPanelInitialized = false;
let currentGroupChartMode = 'trend';

function latestYearByKey(rows, keyName) {
    const latest = {};
    (rows || []).forEach(row => {
        const key = row[keyName];
        const year = Number(row.year);
        if (!key || !Number.isFinite(year)) return;
        if (latest[key] === undefined || year > latest[key]) latest[key] = year;
    });
    return latest;
}

function buildMapScoresLookup() {
    mapScoresLookup = {};
    mapScoresByTopic = {};
    if (!Array.isArray(trendScoreData)) return;

    const latestYearByTopic = latestYearByKey(trendScoreData, 'topic_name');
    trendScoreData.forEach(row => {
        const topic = row.topic_name;
        if (Number(row.year) !== latestYearByTopic[topic]) return;

        const prov = row.province_name;
        if (!prov || prov === 'کل کشور') return;
        if (!mapScoresLookup[prov]) mapScoresLookup[prov] = {};
        mapScoresLookup[prov][topic] = row;

        if (!mapScoresByTopic[topic]) mapScoresByTopic[topic] = [];
        mapScoresByTopic[topic].push(row);
    });
}

function buildProvincePopLookup(rows) {
    mapProvincePop = {};
    const latestYearByProv = latestYearByKey(rows, 'province_name');
    (rows || []).forEach(row => {
        const prov = row.province_name;
        if (!prov) return;
        if (row.year != null && Number(row.year) !== latestYearByProv[prov]) return;
        if (row.province_pop == null) return;
        mapProvincePop[prov] = Number(row.province_pop);
    });
}

function initIndicatorSearch() {
    fetch(`${API_BASE_URL}/api/explorer/init`)
        .then(r => r.json())
        .then(data => {
            let allIndicatorsList = [];
            for (let topic in data.hierarchy) {
                for (let subtopic in data.hierarchy[topic]) {
                    data.hierarchy[topic][subtopic].forEach(ind => {
                        allIndicatorsList.push({ title: ind, topic: topic });
                    });
                }
            }
            
            const searchInput = document.getElementById('indicator-search');
            const suggestionsBox = document.getElementById('search-suggestions');
            
            if(searchInput && suggestionsBox) {
                searchInput.addEventListener('input', function() {
                    const query = this.value.trim();
                    suggestionsBox.innerHTML = '';
                    
                    if (query.length === 0) {
                        suggestionsBox.style.display = 'none';
                        return;
                    }

                    const matches = allIndicatorsList.filter(ind => ind.title.includes(query));
                    
                    if (matches.length === 0) {
                        const li = document.createElement('li');
                        li.textContent = 'نتیجه‌ای پیدا نشد';
                        li.style.color = '#888';
                        li.style.cursor = 'default';
                        suggestionsBox.appendChild(li);
                    } else {
                        matches.forEach(match => {
                            const li = document.createElement('li');
                            const regex = new RegExp(`(${query})`, "gi");
                            li.innerHTML = match.title.replace(regex, "<strong style='color:#0078d7'>$1</strong>");
                            
                            li.addEventListener('click', () => {
                                window.location.href = `explorer.html?indicator=${encodeURIComponent(match.title)}&topic=${encodeURIComponent(match.topic)}&source=search`;
                            });
                            
                            suggestionsBox.appendChild(li);
                        });
                    }
                    suggestionsBox.style.display = 'block';
                });

                document.addEventListener('click', function(e) {
                    if (!searchInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
                        suggestionsBox.style.display = 'none';
                    }
                });
            }
        })
        .catch(err => console.error("Error loading indicator search data", err));
}

async function loadAllData() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/init-atlas`);
        if (!response.ok) throw new Error(`API error: ${response.statusText}`);
        
        const data = await response.json();
        topicsData = data.topics || [];
        trendScoreData = data.trend_score || [];
        clustersData = data.clusters || [];

        // Latest year per topic from trend_score; latest year per province from province_pop
        buildMapScoresLookup();
        buildProvincePopLookup(data.province_pop);

        // Map state can restore the last Atlas topic, but home banner/overlay must
        // keep the topic color from the page the user left via Logo.
        const onHome = window.location.hash !== '#atlas';
        const homeBg = sessionStorage.getItem('themeBannerBg');
        const homeAc = sessionStorage.getItem('themeTopicAccent');
        const keepHomeTheme = onHome && !!homeBg;

        let savedTopic = sessionStorage.getItem('atlasSelectedTopic');
        const savedTopicObj = savedTopic && topicsData.find(t => t.topic_name === savedTopic);
        if (savedTopicObj) {
            currentIndex = savedTopic;
            updateTopicColors(savedTopicObj, { skipChrome: keepHomeTheme });
        } else if (topicsData.length > 0) {
            currentIndex = topicsData[0].topic_name;
            updateTopicColors(topicsData[0], { skipChrome: keepHomeTheme });
        }

        if (keepHomeTheme) {
            document.documentElement.style.setProperty('--banner-bg', homeBg);
            if (homeAc) document.documentElement.style.setProperty('--topic-accent', homeAc);
        }
        
        initUI();
        initLegend();
        initMap();

        const geoRes = await fetch('data/iran.geojson');
        if (!geoRes.ok) throw new Error("GeoJSON not found");
        renderMapData(await geoRes.json());

        initIndicatorSearch();

    } catch (err) {
        console.error("Error connecting to FastAPI backend:", err);
        alert("خطا در ارتباط با سرور بک‌اند.");
    }
}

function updateTopicColors(tObj, options = {}) {
    if(tObj && tObj.lower_color && tObj.upper_color) {
        currentLowerRgb = hexToRgb(tObj.lower_color);
        currentUpperRgb = hexToRgb(tObj.upper_color);
    } else {
        currentLowerRgb = {r:230, g:240, b:255}; 
        currentUpperRgb = {r:0, g:120, b:215};
    }

    if (options && options.skipChrome) return;
    
    // Define banner color using master_color (falling back to upper_color if missing)
    const bannerHex = (tObj && tObj.master_color) ? tObj.master_color : (tObj && tObj.upper_color) ? tObj.upper_color : '#0078d7';
    const bannerRgb = hexToRgb(bannerHex);
    
    // Generate the gradient using the new master_color
    let darkerRgb = shadeRGB(bannerRgb, -40);
    let bannerStr = `rgb(${bannerRgb.r}, ${bannerRgb.g}, ${bannerRgb.b})`;
    const gradient = `linear-gradient(90deg, ${darkerRgb}, ${bannerStr})`;
    
    // Apply gradient to banner inline style for immediate effect
    // document.getElementById('top-banner').style.background = gradient;
    // Also update the CSS variable so elements using var(--banner-bg) (entry curtain) match dynamically
    document.documentElement.style.setProperty('--banner-bg', gradient);

    // Inject the topic's master_color into the nav icons' bottom border
    const accentHex = (tObj && tObj.master_color) ? tObj.master_color : (tObj && tObj.upper_color) ? tObj.upper_color : '#0078d7';
    document.documentElement.style.setProperty('--topic-accent', accentHex);
    persistAppTheme(gradient, accentHex);

    // Update back control to use the topic's upper color (if available)
    try {
        const upperHex = (tObj && (tObj.upper_color || tObj.color)) || '#0078d7';
        function hexToRgba(hex, a) { const c = hexToRgb(hex); return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`; }
        const btnEntry = document.getElementById('btn-back-entry');
        if (btnEntry) {
            btnEntry.style.background = upperHex;
            btnEntry.style.borderColor = hexToRgba(upperHex, 0.85);
            btnEntry.style.color = '#ffffff';
        }
    } catch(e) { /* fail silently */ }
}

function getHeatmapColor(score) {
    let factor = Number(score) / 100;
    if (factor > 1) factor = 1; if (factor < 0) factor = 0;
    return interpolateColor(currentLowerRgb, currentUpperRgb, factor);
}

function initUI() {
    const list = document.getElementById('index-list');
    list.innerHTML = '';
    
    topicsData.forEach(t => {
        const li = document.createElement('li');
        li.className = 'index-item' + (t.topic_name === currentIndex ? ' active' : '');
        
        let topicImgPath = `assets/images/تاپیک ${t.topic_name}.webp`;
        // Defer background images via data-bg so we can lazy-load them with IntersectionObserver
        li.innerHTML = `
            <div class="index-item-img lazy-bg bg-placeholder" data-bg="${topicImgPath}"></div>
            <span class="index-item-text">${t.topic_name}</span>
        `;

        li.onclick = () => {
            document.querySelectorAll('.index-item').forEach(el => el.classList.remove('active'));
            li.classList.add('active');
            currentIndex = t.topic_name;
            
            // Save active topic context for seamless returns
            sessionStorage.setItem('atlasSelectedTopic', currentIndex);
            
            updateTopicColors(t);
            similarProvinces = [];
            updateMapStyles();
            initLegend();
            updatePointer();
            
            document.getElementById('right-panel').classList.add('show-panel');

            if (selectedProvince) updateRightPanel(selectedProvince);
            else updateDefaultPanel();
            if (isCompactMap()) setMapSheet(selectedProvince ? 'details' : 'map');
        };
        list.appendChild(li);
    });

    // Initialize lazy background loader for any newly added elements
    initLazyBackgrounds(list);

    // Requirement 7: Refresh Button reloads the page
    document.getElementById('btn-exit-focus').addEventListener('click', exitFocusMode);

    document.getElementById('btn-problem').addEventListener('click', function(e) {
        const province = selectedProvince || 'تهران';
        if(currentIndex) {
            window.location.href = `problem.html?province=${encodeURIComponent(province)}&topic=${encodeURIComponent(currentIndex)}`;
        } else {
            window.location.href = `problem.html?province=${encodeURIComponent(province)}`;
        }
    });

    // SIMILAR PROVINCES - RIGHT PANEL & SWITCHER
    document.getElementById('btn-similar').addEventListener('click', function(e) {
        if (!selectedProvince || !loadedGeoJSON) {
            e.preventDefault(); alert("لطفاً ابتدا یک استان را از روی نقشه انتخاب کنید."); return;
        }

        document.body.classList.add('immersive-mode');
        document.getElementById('top-banner').classList.add('fade-out-collapse');
        document.getElementById('bottom-panel').classList.add('fade-out-collapse');
        
        document.getElementById('left-popup-panel').classList.add('fade-out');
        document.getElementById('map-legend').classList.add('fade-out');
        document.getElementById('right-panel').classList.remove('show-panel');
        document.getElementById('right-panel').classList.add('fade-out');

        map.scrollWheelZoom.disable();
        map.doubleClickZoom.disable();
        map.touchZoom.disable();
        map.boxZoom.disable();
        map.keyboard.disable();

        let topicClusters = clustersData.filter(c => c.topic_name === currentIndex);
        let provMap = {};
        topicClusters.forEach(row => {
            if(!provMap[row.province_name]) provMap[row.province_name] = { cluster_group: row.cluster_group, subtopics: {} };
            provMap[row.province_name].subtopics[row.subtopic_name] = Number(row.subtopic_score);
        });

        let allProvs = [];
        Object.keys(provMap).forEach(pName => {
            let scores = Object.values(provMap[pName].subtopics);
            let avgScore = scores.length > 0 ? scores.reduce((a,b)=>a+b, 0) / scores.length : 0;
            allProvs.push({ name: pName, cluster: provMap[pName].cluster_group, subtopics: provMap[pName].subtopics, score: avgScore });
        });

        const selProvData = allProvs.find(p => p.name === selectedProvince);
        const selectedClusterGroup = selProvData ? selProvData.cluster : null;
        const targetProvinces = allProvs.filter(p => p.cluster === selectedClusterGroup);
        similarProvinces = targetProvinces.map(p => p.name);
        
        geojsonLayer.eachLayer(layer => {
            let pName = layer.feature.properties.ProvincNam;
            if(similarProvinces.includes(pName)) layer.bringToFront();
        });
        map.flyTo([32.4279, 62.6880], 5.5, { duration: 1.6 });

        updateMapStyles();

        let subtopicKeys = collectClusterSubtopics(targetProvinces);

        let htmlContent = `
            <table class="heat-table">
                <thead><tr><th style="width: 25%;">استان</th>
        `;
        subtopicKeys.forEach(sk => htmlContent += `<th>${sk}</th>`);
        htmlContent += `</tr></thead><tbody>`;
        
        targetProvinces.forEach(p => {
            htmlContent += `<tr><td>${p.name} ${p.name === selectedProvince ? '★' : ''}</td>`;
            subtopicKeys.forEach(sk => {
                let val = p.subtopics[sk] !== undefined ? p.subtopics[sk] : 0;
                let cellColor = getHeatmapColor(val);
                let factor = val/100;
                let textColor = '#222222';
                htmlContent += `<td style="background: ${cellColor}; color: ${textColor};">${val}</td>`;
            });
            htmlContent += `</tr>`;
        });
        htmlContent += `</tbody></table>`;
        
        document.getElementById('group-table-container').innerHTML = htmlContent;

        switchGroupChartType('trend');

        let groupContainer = document.getElementById('floating-group-container');
        groupContainer.style.display = 'flex';
        setTimeout(() => { groupContainer.classList.add('show-float'); }, 50);
        const groupsBtn = document.getElementById('map-dock-groups');
        if (groupsBtn) groupsBtn.hidden = false;
        if (isCompactMap()) setMapSheet('groups');
    });
}

function switchGroupChartType(mode) {
    currentGroupChartMode = mode;
    document.getElementById('btn-tab-trend').classList.toggle('active', mode === 'trend');
    document.getElementById('btn-tab-spider').classList.toggle('active', mode === 'spider');
    document.getElementById('btn-tab-table').classList.toggle('active', mode === 'table');
    
    const chartsBox = document.getElementById('group-charts-container');
    const tableBox = document.getElementById('group-table-container');

    if (mode === 'table') {
        chartsBox.style.display = 'none';
        tableBox.style.display = 'block';
    } else {
        chartsBox.style.display = 'block';
        tableBox.style.display = 'none';
        
        let topicClusters = clustersData.filter(c => c.topic_name === currentIndex);
        let provMap = {};
        topicClusters.forEach(row => {
            if(!provMap[row.province_name]) provMap[row.province_name] = { cluster_group: row.cluster_group, subtopics: {} };
            provMap[row.province_name].subtopics[row.subtopic_name] = Number(row.subtopic_score);
        });
        let allProvs = [];
        Object.keys(provMap).forEach(pName => {
            let scores = Object.values(provMap[pName].subtopics);
            let avgScore = scores.length > 0 ? scores.reduce((a,b)=>a+b, 0) / scores.length : 0;
            allProvs.push({ name: pName, cluster: provMap[pName].cluster_group, subtopics: provMap[pName].subtopics });
        });
        const selProvData = allProvs.find(p => p.name === selectedProvince);
        const targetProvinces = allProvs.filter(p => p.cluster === (selProvData ? selProvData.cluster : null));
        
        renderGroupCharts(targetProvinces);
    }
}

function collectClusterSubtopics(provinces) {
    const keys = [];
    (provinces || []).forEach(prov => {
        Object.keys(prov.subtopics || {}).forEach(sk => {
            if (!keys.includes(sk)) keys.push(sk);
        });
    });
    return keys;
}

function renderGroupCharts(targetProvinces) {
    groupChartsInstances.forEach(c => c.destroy());
    groupChartsInstances = [];

    let container = document.getElementById('group-charts-container');
    container.innerHTML = '';
    const spiderLabels = currentGroupChartMode === 'spider' ? collectClusterSubtopics(targetProvinces) : [];

    targetProvinces.forEach(p => {
        const mapDataRow = (mapScoresLookup[p.name] && mapScoresLookup[p.name][currentIndex]) ? mapScoresLookup[p.name][currentIndex] : null;
        let rank = mapDataRow ? mapDataRow.province_rank : "-";
        
        let pTrends = trendScoreData.filter(tr => tr.province_name === p.name && tr.topic_name === currentIndex);
        pTrends.sort((a, b) => Number(a.year) - Number(b.year));
        
        let changeHtml = '<span style="color:#666;">-</span>';
        if(pTrends.length >= 2) {
            let currentScore = Number(pTrends[pTrends.length-1].index_score);
            let prevScore = Number(pTrends[pTrends.length-2].index_score);
            if(prevScore !== 0) {
                let pct = ((currentScore - prevScore) / prevScore) * 100;
                let color = pct > 0 ? '#059669' : (pct < 0 ? '#dc2626' : '#4b5563'); 
                let iconSpan = pct > 0 ? '▲' : (pct < 0 ? '▼' : '−');
                changeHtml = `<span style="color:${color}; font-weight:bold;" dir="ltr">${Math.abs(pct).toFixed(1)}% ${iconSpan}</span>`;
            }
        }

        let card = document.createElement('div');
        card.className = 'prov-card';
        card.innerHTML = `
            <div class="prov-card-header">
                <span class="prov-card-title">${p.name} ${p.name === selectedProvince ? '★' : ''}</span>
                <span class="prov-card-meta">رتبه: ${rank} | تغییرات گذشته: ${changeHtml}</span>
            </div>
            <div class="prov-chart-wrap">
                <canvas id="group-chart-${p.name}"></canvas>
            </div>
        `;
        container.appendChild(card);

        const ctx = document.getElementById(`group-chart-${p.name}`).getContext('2d');
        let upperStr = `rgba(${currentUpperRgb.r}, ${currentUpperRgb.g}, ${currentUpperRgb.b}`;

        if (currentGroupChartMode === 'trend') {
            let chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: pTrends.map(tr => tr.year),
                    datasets: [{
                        data: pTrends.map(tr => Number(tr.index_score)),
                        borderColor: p.name === selectedProvince ? '#e11d48' : upperStr + ', 1)',
                        backgroundColor: p.name === selectedProvince ? 'rgba(225, 29, 72, 0.15)' : upperStr + ', 0.15)',
                        borderWidth: 2, fill: true, pointRadius: 3, tension: 0.3
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: { enabled: false } },
                    scales: { 
                        x: { ticks: { font: { size: 9 }, color: '#555' }, grid: { display: false } }, 
                        y: { display: true, min: 0, max: 100, ticks: { font: { size: 8 }, stepSize: 50 } } 
                    }
                }
            });
            groupChartsInstances.push(chart);
        } else {
            const spiderData = spiderLabels.map(sk => {
                const raw = p.subtopics && p.subtopics[sk];
                const num = Number(raw);
                return isFinite(num) ? num : 0;
            });
            const topicRow = topicsData.find(t => t.topic_name === currentIndex);
            const pointColor = (topicRow && topicRow.upper_color) ? topicRow.upper_color : `rgba(${currentUpperRgb.r}, ${currentUpperRgb.g}, ${currentUpperRgb.b}, 1)`;

            let chart = new Chart(ctx, {
                type: 'radar',
                data: {
                    labels: spiderLabels,
                    datasets: [{
                        data: spiderData,
                        pointBackgroundColor: pointColor,
                        pointBorderColor: '#fff',
                        pointRadius: 2,
                        backgroundColor: p.name === selectedProvince ? 'rgba(225, 29, 72, 0.2)' : 'rgba(0, 120, 215, 0.2)',
                        borderColor: p.name === selectedProvince ? '#e11d48' : 'rgba(0, 120, 215, 0.7)',
                        borderWidth: 1.5
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    scales: {
                        r: {
                            min: 0, max: 100,
                            ticks: { display: false },
                            pointLabels: { display: true, font: { size: 8 }, color: '#333' },
                            grid: { color: 'rgba(0,0,0,0.1)' },
                            angleLines: { color: 'rgba(0,0,0,0.1)' }
                        }
                    },
                    plugins: { legend: { display: false }, tooltip: { enabled: false } }
                }
            });
            groupChartsInstances.push(chart);
        }
    });
}

// Global helper: smoothly restore and highlight a province using consistent animation options
function restoreSelectedProvince(provName) {
    if (!provName || !geojsonLayer) return;
    selectedProvince = provName;
    try { sessionStorage.setItem('atlasSelectedProvince', provName); } catch(e) {}

    geojsonLayer.eachLayer(layer => {
        if (layer.feature.properties.ProvincNam === provName) {
            try { map.invalidateSize(true); } catch (e) {}
            fitMapTo(layer.getBounds(), { animate: true, maxZoom: MAP_MAX_ZOOM, duration: 1.6 });

            const rp = document.getElementById('right-panel');
            if (rp) rp.classList.add('show-panel');
            updateRightPanel(provName);
            renderLeftFloatingPanel(provName);
            if (isCompactMap()) setMapSheet('details');
        }
    });
    updateMapStyles();
    updatePointer();
}

function exitFocusMode() {
    // Detect whether we are exiting Typology (immersive-mode) so we can apply the province-recovery animation
    const wasImmersive = document.body.classList.contains('immersive-mode');

    document.body.classList.remove('immersive-mode');
    
    document.getElementById('top-banner').classList.remove('fade-out-collapse', 'fade-out');
    document.getElementById('bottom-panel').classList.remove('fade-out-collapse', 'fade-out-bottom', 'fade-out');
    
    document.getElementById('map-legend').classList.remove('fade-out');
    document.getElementById('right-panel').classList.remove('fade-out');
    if (selectedProvince) {
        document.getElementById('right-panel').classList.add('show-panel');
        document.getElementById('left-popup-panel').classList.remove('fade-out');
        document.getElementById('left-popup-panel').style.display = 'flex';
    }
    const groupsBtn = document.getElementById('map-dock-groups');
    if (groupsBtn) groupsBtn.hidden = true;
    if (isCompactMap()) setMapSheet(selectedProvince ? 'details' : 'map');
    
    let groupContainer = document.getElementById('floating-group-container');
    groupContainer.classList.remove('show-float');
    setTimeout(() => { groupContainer.style.display = 'none'; }, 500);
    
    groupChartsInstances.forEach(c => c.destroy());
    groupChartsInstances = [];
    similarProvinces = [];
    updateMapStyles();

    map.scrollWheelZoom.enable();
    map.doubleClickZoom.enable();
    map.touchZoom.enable();
    map.boxZoom.enable();
    map.keyboard.enable();

    // If we were in immersive typology mode, restore the selected province using the shared smooth recovery
    if (wasImmersive && selectedProvince) {
        restoreSelectedProvince(selectedProvince);
    } else if(selectedProvince && geojsonLayer) {
        // Fallback: existing behavior for non-typology exits (slightly closer zoom)
        geojsonLayer.eachLayer(layer => {
            if(layer.feature.properties.ProvincNam === selectedProvince) {
                fitMapTo(layer.getBounds(), { animate: true, maxZoom: MAP_MAX_ZOOM, duration: 1.6 });
            }
        });
    } else {
        refitMapView({ animate: true });
    }
}

function updatePointer() {
    const pointer = document.getElementById('score-pointer');
    const pointerLabel = document.getElementById('pointer-label');
    if (selectedProvince && currentIndex) {
        let score = getProvinceScore(selectedProvince, currentIndex);
        pointer.style.display = 'flex'; // Changed to 'flex' for the new circle UI
        pointer.style.left = score + '%'; 
        pointerLabel.innerText = Math.round(score);
    } else {
        pointer.style.display = 'none';
    }
}

function getProvinceScore(provName, topicName) {
    if (!provName || !topicName) return 0;
    const provObj = mapScoresLookup[provName];
    if (provObj && provObj[topicName]) return Number(provObj[topicName].index_score || 0);
    return 0;
}

function getProvincePop(provName) {
    if (!provName) return 2000000;
    if (mapProvincePop[provName]) return mapProvincePop[provName];
    return 2000000;
}

function renderLeftFloatingPanel(provinceName) {
    const panel = document.getElementById('left-popup-panel');
    if(!provinceName) { panel.style.display = 'none'; return; }
    
    const container = document.getElementById('left-chart-markers');
    document.getElementById('left-popup-title').innerText = `شاخص‌های ${provinceName}`;
    
    if (!leftPanelInitialized) {
        container.innerHTML = '';
        topicsData.forEach((t, index) => {
            let isLeft = index < 4;
            let markerId = 'left-marker-' + t.topic_name.replace(/\s+/g, '-');
            let imgPath = `assets/images/تاپیک ${t.topic_name}.webp`;
            
            let marker = document.createElement('div');
            marker.className = 'topic-marker ' + (isLeft ? 'left-side' : 'right-side');
            marker.id = markerId;
            marker.style.bottom = `0%`; 
            marker.style.zIndex = 0;
            
            marker.innerHTML = `
                <div class="topic-marker-dot" style="background: ${t.upper_color || '#0078d7'};"></div>
                <div class="topic-marker-content" data-topic-name="${t.topic_name}">
                    <img src="${imgPath}" alt="${t.topic_name}" onerror="this.style.display='none'" loading="lazy">
                    <span class="marker-score-value">0</span>
                </div>
            `;
            container.appendChild(marker);
        });
        leftPanelInitialized = true;
    }

    setTimeout(() => {
        let leftItems = [];
        let rightItems = [];
        
        topicsData.forEach((t, index) => {
            let score = getProvinceScore(provinceName, t.topic_name);
            let item = { index, score: score, adjustedScore: score, t };
            if (index < 4) leftItems.push(item);
            else rightItems.push(item);
        });

        function resolveOverlaps(items) {
            items.sort((a,b) => a.score - b.score);
            const minGap = 6; 
            
            for(let i=1; i<items.length; i++) {
                if (items[i].adjustedScore - items[i-1].adjustedScore < minGap) {
                    items[i].adjustedScore = items[i-1].adjustedScore + minGap;
                }
            }
            
            let overflow = items[items.length-1]?.adjustedScore - 100;
            if (overflow > 0) {
                for(let i=items.length-1; i>=0; i--) {
                    items[i].adjustedScore -= overflow;
                    if (i > 0 && items[i].adjustedScore - items[i-1].adjustedScore < minGap) {
                        overflow = minGap - (items[i].adjustedScore - items[i-1].adjustedScore);
                    } else {
                        break;
                    }
                }
            }
            return items;
        }

        resolveOverlaps(leftItems);
        resolveOverlaps(rightItems);
        
        let allItems = [...leftItems, ...rightItems];

        allItems.forEach(item => {
            let markerId = 'left-marker-' + item.t.topic_name.replace(/\s+/g, '-');
            let marker = document.getElementById(markerId);
            if (marker) {
                marker.style.bottom = `${item.adjustedScore}%`;
                marker.style.zIndex = Math.round(item.score);
                marker.querySelector('.marker-score-value').innerText = Math.round(item.score);
            }
        });
    }, 50);
    
    panel.style.display = 'flex';
}

// CHANGE 2: Explicitly clears sessionStorage when fully exiting Atlas to start over
function clearSelection() {
    sessionStorage.removeItem('atlasSelectedProvince');
    if (!selectedProvince) return;
    selectedProvince = null;
    similarProvinces = [];
    
    updateMapStyles();
    map.closePopup();
    document.getElementById('left-popup-panel').style.display = 'none';
    if (isCompactMap()) setMapSheet('map');

    setTimeout(() => {
        refitMapView({ animate: true }); 
    }, 100);

    document.getElementById('province-details').style.display = 'block';
    updateDefaultPanel();
}

function initMap() {
    map = L.map('map', { zoomSnap: 0.5, maxZoom: MAP_MAX_ZOOM, zoomControl: false }).setView(MAP_HOME_CENTER, MAP_HOME_ZOOM);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(map);

    map.on('click', clearSelection);
}

function updateMapStyles() {
    if (!geojsonLayer) return;
    let isImmersive = document.body.classList.contains('immersive-mode');

    geojsonLayer.eachLayer(function (layer) {
        const provName = layer.feature.properties.ProvincNam || "استان ناشناخته";
        let score = getProvinceScore(provName, currentIndex);
        
        layer.setTooltipContent(`<strong>${provName}</strong><br/><span style="color:#0078d7; font-weight:bold;">امتیاز: ${score}</span>`);

        let fColor = getHeatmapColor(score);
        let fOpac = 0.85, bColor = "#ffffff", bWeight = 1.5;
        let customClass = '';

        if (isImmersive) {
            if (similarProvinces.includes(provName)) {
                customClass = 'detached-province';
                fOpac = 0.95;
                if (provName === selectedProvince) { fColor = "#e11d48"; bColor = "#9f1239"; bWeight = 2.5; } 
                else { fColor = "#ffb74d"; bColor = "#ff9800"; bWeight = 2; }
            } else {
                customClass = 'hidden-province';
                fOpac = 0.1; bWeight = 1.2; bColor = "#888888"; 
            }
        } else {
            if (hoveredStageIndex !== null) {
                let stageSize = 100 / (heatStages - 1);
                let lowerBound = hoveredStageIndex * stageSize - (hoveredStageIndex === 0 ? 1 : 0.01);
                let upperBound = (hoveredStageIndex + 1) * stageSize;
                if (hoveredStageIndex === heatStages - 1) upperBound = 100.1;
                if (score >= lowerBound && score <= upperBound) { fOpac = 0.95; bColor = "#000"; bWeight = 2.5; } 
                else { fOpac = 0.15; bColor = "#ccc"; bWeight = 1; }
            }

            if (provName === selectedProvince) { fColor = "#e11d48"; fOpac = 0.9; } 
        }

        layer.setStyle({ color: bColor, weight: bWeight, fillColor: fColor, fillOpacity: fOpac, className: customClass });
    });
}

function renderMapData(geojsonData) {
    loadedGeoJSON = geojsonData;
    geojsonLayer = L.geoJSON(geojsonData, {
        onEachFeature: function (feature, layer) {
            const provName = feature.properties.ProvincNam || "استان ناشناخته";
            
            layer.bindTooltip("", { sticky: true, className: 'custom-tooltip' });
            
            layer.on('mouseover', (e) => {
                if (document.body.classList.contains('immersive-mode')) return;
                e.target.setStyle({ fillOpacity: 0.95 }).bringToFront();
            });
            layer.on('mouseout', () => { updateMapStyles(); });
            layer.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                const pathEl = (e.target && typeof e.target.getElement === 'function' && e.target.getElement())
                    || (e.originalEvent && e.originalEvent.target);
                if (pathEl && typeof pathEl.blur === 'function') pathEl.blur();
                
                selectedProvince = provName;
                
                // CHANGE 2: Immediately persist choice to browser memory for returning
                sessionStorage.setItem('atlasSelectedProvince', provName);

                updateMapStyles();
                updatePointer();
                
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        exitFocusMode(); 
                        selectedProvince = provName; 
                        
                        document.getElementById('right-panel').classList.add('show-panel');

                        map.invalidateSize(true);
                        const bounds = layer.getBounds();
                        fitMapTo(bounds, { animate: true, maxZoom: MAP_MAX_ZOOM, duration: 1.6 });

                        updateRightPanel(provName);
                        renderLeftFloatingPanel(provName);
                        if (isCompactMap()) setMapSheet('details'); 
                    }, 15);
                });
            });
        }
    }).addTo(map);
    
    updateMapStyles(); 
    updateDefaultPanel();

    // CHANGE 2: Automatic restoration upon returning from problem.html via #atlas route
    if (window.location.hash === '#atlas') {
        let savedProv = sessionStorage.getItem('atlasSelectedProvince');
        if (savedProv) {
            restoreSelectedProvince(savedProv);
        } else {
            refitMapView({ animate: false });
        }
    } else {
        refitMapView({ animate: false });
    }
}

function updateDefaultPanel() {
    let tObj = topicsData.find(t => t.topic_name === currentIndex);
    let desc = tObj ? tObj.topic_description : "";

    document.getElementById('province-details').innerHTML = `
        <p style="margin-top: 0; font-size: 0.75em; color: #666666; font-weight: bold;">شاخص: ${currentIndex}</p>
        <div class="index-description-text">${desc}</div>
    `;

    document.getElementById('chart-wrapper').style.display = 'none';
    document.getElementById('trend-wrapper').style.display = 'none';

    // ADD THIS LINE: Hide the entire bottom card
    const bottomCard = document.querySelector('.right-card-bottom');
    if (bottomCard) bottomCard.style.display = 'none';
    
    if (rankingBarChart) { rankingBarChart.destroy(); rankingBarChart = null; }
    if (trendChartInstance) { trendChartInstance.destroy(); trendChartInstance = null; }
    updatePointer();
}

function updateRightPanel(provinceName) {
    document.getElementById('right-panel').classList.add('show-panel');

    // ADD THIS LINE: Show the bottom card (using 'flex' because of our CSS rules)
    const bottomCard = document.querySelector('.right-card-bottom');
    if (bottomCard) bottomCard.style.display = 'flex';

    let tObj = topicsData.find(t => t.topic_name === currentIndex);
    let desc = tObj ? tObj.topic_description : "";
    let score = getProvinceScore(provinceName, currentIndex);
    let pop = getProvincePop(provinceName);

    // 1. Top Panel: Only show the description (Identical to default panel, removing the "امتیاز" text entirely)
    document.getElementById('province-details').innerHTML = `
        <p style="margin-top: 0; font-size: 0.75rem; color: #666666; font-weight: bold;">شاخص: ${currentIndex}</p>
        <div class="index-description-text">${desc}</div>
    `;

    // 2. Bottom Panel Header: Province Name + Population in one compact row (using flexbox space-between)
    document.getElementById('bottom-prov-header').innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; border-bottom: 1px solid var(--border-color); padding-bottom: 10px; margin-bottom: 15px;">
            <h3 style="margin: 0; color: #333333; font-size: 0.75rem; font-weight: bold;">استان ${provinceName}</h3>
            <div style="display:inline-flex; align-items:center; background:#f4f7f6; border:1px solid #c1d5e0; padding:4px 10px; border-radius:15px; color:#0078d7; font-size:0.75rem; font-weight:bold; box-shadow:0 2px 6px rgba(0,0,0,0.06);">
                <svg style="width:14px;height:14px;margin-left:4px;fill:#0078d7;" viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                جمعیت: ${pop.toLocaleString('fa-IR')}
            </div>
        </div>
    `;

    document.getElementById('chart-wrapper').style.display = 'block';
    document.getElementById('trend-wrapper').style.display = 'block';

    const topicRows = mapScoresByTopic[currentIndex] || [];
    let sortedProvs = topicRows.map(m => ({ name: m.province_name, score: Number(m.index_score) }));
    sortedProvs.sort((a, b) => b.score - a.score);
    let rgbUpperStr = `rgba(${currentUpperRgb.r}, ${currentUpperRgb.g}, ${currentUpperRgb.b}`;

    if (rankingBarChart) { rankingBarChart.destroy(); }
    const canvasRank = document.getElementById('rankingBarChart');
    
    rankingBarChart = new Chart(canvasRank, {
        type: 'bar',
        data: {
            labels: sortedProvs.map(p => p.name),
            datasets: [{
                label: 'امتیاز', data: sortedProvs.map(p => p.score),
                backgroundColor: sortedProvs.map(p => p.name === provinceName ? '#e11d48' : getHeatmapColor(p.score)),
                borderColor: sortedProvs.map(p => p.name === provinceName ? '#9f1239' : rgbUpperStr + ', 1)'),
                borderWidth: 1, borderRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { font: { size: 9 }, color: '#333', maxRotation: 90, minRotation: 45 }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { font: { size: 9 }, color: '#333' } }
            }
        }
    });

    let pTrends = trendScoreData.filter(tr => tr.province_name === provinceName && tr.topic_name === currentIndex);
    pTrends.sort((a, b) => Number(a.year) - Number(b.year));

    if (trendChartInstance) { trendChartInstance.destroy(); }
    const tCanvas = document.getElementById('trendChartPanel');

    trendChartInstance = new Chart(tCanvas, {
        type: 'line',
        data: {
            labels: pTrends.map(tr => tr.year),
            datasets: [{
                label: 'روند زمانی',
                data: pTrends.map(tr => Number(tr.index_score)),
                borderColor: '#e11d48',
                backgroundColor: 'rgba(225, 29, 72, 0.1)',
                borderWidth: 2, fill: true,
                pointBackgroundColor: '#e11d48', pointRadius: 4, tension: 0.3
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            animation: false, 
            plugins: { 
                legend: { display: false }, 
                title: { display: true, text: 'روند زمانی', font: { family: 'Vazirmatn' }, color: '#333' } 
            },
            scales: {
                x: { ticks: { font: { size: 10 }, color: '#555' }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { font: { size: 10 }, color: '#555', stepSize: 25 }, grid: { color: 'rgba(0,0,0,0.08)' } }
            }
        }
    });
}

// Responsive resize handling: keep maps and charts sized correctly across displays
const onGlobalResize = debounce(() => {
    try { if (map && typeof map.invalidateSize === 'function') map.invalidateSize(true); } catch (e) {}
    try { refitMapView({ animate: false }); } catch (e) {}
    try { if (rankingBarChart && typeof rankingBarChart.resize === 'function') rankingBarChart.resize(); } catch (e) {}
    try { if (trendChartInstance && typeof trendChartInstance.resize === 'function') trendChartInstance.resize(); } catch (e) {}
    try { if (groupChartsInstances && Array.isArray(groupChartsInstances)) groupChartsInstances.forEach(c => c && typeof c.resize === 'function' && c.resize()); } catch (e) {}
}, 150);
window.addEventListener('resize', onGlobalResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onGlobalResize);

loadAllData();