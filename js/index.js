// File: index.js
// Purpose: Main front-end controller for the interactive map dashboard.
//   Handles UI initialization, map rendering, topic/topic-color management, caching of map scores,
//   lazy-loading of background images, and responsive behavior for charts and map layers.
// Notes: All inline comments in this project were standardized to clear English. UI labels and text
//   remain in Persian and are intentionally left unchanged. This header was added to improve
//   maintainability and readability.

function curtainScroller() {
    const curtain = document.getElementById('entry-view-curtain');
    return (curtain && curtain.querySelector('.entry-scroll')) || curtain;
}

function initCurtainBannerOffset() {
    const curtain = document.getElementById('entry-view-curtain');
    const banner = document.getElementById('top-banner');
    const dock = document.getElementById('entry-dock');
    if (!curtain || !banner) return;
    const sync = () => {
        curtain.style.setProperty('--curtain-banner-h', `${banner.offsetHeight}px`);
        if (dock) curtain.style.setProperty('--curtain-dock-h', `${dock.offsetHeight}px`);
    };
    sync();
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(sync);
        ro.observe(banner);
        if (dock) ro.observe(dock);
    } else {
        window.addEventListener('resize', sync);
    }
}

function initCurtainReveal() {
    const root = curtainScroller();
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

function isCompactMap() {
    return window.matchMedia('(max-width: 767px)').matches;
}

function setMapSheet(sheet) {
    const allowed = ['map', 'details', 'topics'];
    if (!allowed.includes(sheet)) sheet = 'map';
    document.body.classList.remove('map-sheet-map', 'map-sheet-details', 'map-sheet-topics');
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
    } else {
        left = inset(document.getElementById('left-popup-panel'), 'left');
        const rp = document.getElementById('right-panel');
        if (rp && rp.classList.contains('show-panel')) right = Math.max(right, inset(rp, 'right'));
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

const MAP_HOME_CENTER = [31.4279, 55.6880];
const MAP_HOME_ZOOM = 4.8;
const MAP_MAX_ZOOM = 5.2;

function mapContainerHasSize() {
    if (!map) return false;
    const el = map.getContainer();
    return !!(el && el.clientWidth > 2 && el.clientHeight > 2);
}

function syncMapToContainer({ animate = false } = {}) {
    if (!map || !mapContainerHasSize()) return false;
    map.invalidateSize({ animate: false, pan: false });
    refitMapView({ animate });
    return true;
}

function scheduleMapSync({ animate = false } = {}) {
    let tries = 24;
    const tick = () => {
        if (syncMapToContainer({ animate })) return;
        if (--tries <= 0) return;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

function showIranView({ animate = false } = {}) {
    if (!map) return;
    if (isCompactMap()) {
        fitMapTo(iranLayerBounds(), { animate, maxZoom: MAP_HOME_ZOOM, duration: 1.2 });
        return;
    }
    if (animate) map.flyTo(MAP_HOME_CENTER, MAP_HOME_ZOOM, { duration: 1.6 });
    else map.setView(MAP_HOME_CENTER, MAP_HOME_ZOOM, { animate: false });
}

function fitMapTo(bounds, { animate = false, maxZoom = MAP_MAX_ZOOM, duration = 1.6 } = {}) {
    if (!map || !bounds) return;
    const opts = { ...mapOverlayPadding(), maxZoom: Math.min(maxZoom, MAP_MAX_ZOOM) };
    if (animate) map.flyToBounds(bounds, { ...opts, duration });
    else map.fitBounds(bounds, opts);
}

function refitMapView({ animate = false } = {}) {
    if (!map) return;
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
            document.body.classList.remove('map-sheet-map', 'map-sheet-details', 'map-sheet-topics');
            return;
        }
        dock.hidden = false;
        if (![...document.body.classList].some(name => name.startsWith('map-sheet-'))) setMapSheet('map');
    };
    window.addEventListener('resize', debounce(syncDock, 150));
    syncDock();
}

window.addEventListener('DOMContentLoaded', () => {
    initCurtainBannerOffset();
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

applyChartDefaults();

const API_BASE_URL = window.API_BASE_URL;

const atlasTrendCache = {};
let trendPanelFetchGen = 0;

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response.json();
}

async function fetchAtlasTrend(province, topic) {
    const key = `${province}::${topic}`;
    if (atlasTrendCache[key]) return atlasTrendCache[key];
    const data = await fetchJson(
        `${API_BASE_URL}/api/atlas/trend?province=${encodeURIComponent(province)}&topic=${encodeURIComponent(topic)}`
    );
    const series = data.series || [];
    atlasTrendCache[key] = series;
    return series;
}

function persistAppTheme(accent) {
    try {
        if (accent) sessionStorage.setItem('themeTopicAccent', accent);
    } catch (e) {}
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

let topicsData = []; let trendScoreData = []; 

// Latest-year trend_score rows, used wherever the map previously read map_scores
let mapScoresLookup = {}; // mapScoresLookup[province_name] = { [topic_name]: row }
let mapScoresByTopic = {}; // mapScoresByTopic[topic_name] = [ rows ]
let mapProvincePop = {}; // mapProvincePop[province_name] = latest province_pop

let currentIndex = "";
let map, geojsonLayer;
let rankingBarChart = null;
let trendChartInstance = null;
let loadedGeoJSON = null;
let selectedProvince = null;
let leftPanelInitialized = false;

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

function normalizeFaSearch(s) {
    return String(s || '')
        .replace(/ي/g, 'ی')
        .replace(/ى/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/[\u200c\s]+/g, '')
        .trim();
}

function appendHighlightedName(el, title, query) {
    const idx = title.indexOf(query);
    if (idx < 0) {
        el.textContent = title;
        return;
    }
    el.appendChild(document.createTextNode(title.slice(0, idx)));
    const mark = document.createElement('strong');
    mark.textContent = title.slice(idx, idx + query.length);
    el.appendChild(mark);
    el.appendChild(document.createTextNode(title.slice(idx + query.length)));
}

function initIndicatorSearch() {
    fetch(`${API_BASE_URL}/api/explorer/init`)
        .then(r => r.json())
        .then(data => {
            let allIndicatorsList = [];
            for (let topic in data.hierarchy) {
                for (let subtopic in data.hierarchy[topic]) {
                    data.hierarchy[topic][subtopic].forEach(ind => {
                        allIndicatorsList.push({
                            title: ind,
                            topic: topic,
                            key: normalizeFaSearch(ind),
                        });
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

                    const queryKey = normalizeFaSearch(query);
                    const matches = allIndicatorsList.filter(ind =>
                        (queryKey && ind.key.includes(queryKey)) || ind.title.includes(query)
                    );
                    
                    if (matches.length === 0) {
                        const li = document.createElement('li');
                        li.textContent = 'نتیجه‌ای پیدا نشد';
                        li.style.color = '#888';
                        li.style.cursor = 'default';
                        suggestionsBox.appendChild(li);
                    } else {
                        matches.forEach(match => {
                            const li = document.createElement('li');
                            appendHighlightedName(li, match.title, query);
                            
                            li.addEventListener('click', () => {
                                window.location.href = SITE.page(`explorer.html?indicator=${encodeURIComponent(match.title)}&topic=${encodeURIComponent(match.topic)}&source=search`);
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

        buildMapScoresLookup();
        buildProvincePopLookup(data.province_pop);

        // Map state can restore the last Atlas topic, but home chrome must
        // keep the topic accent from the page the user left via Logo.
        const onHome = window.location.hash !== '#atlas';
        const homeAc = sessionStorage.getItem('themeTopicAccent');
        const keepHomeTheme = onHome && !!homeAc;

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
            setTopicChrome(homeAc);
        }
        
        initUI();
        initLegend();
        renderLeftFloatingPanel(null);
        initMap();

        const geoRes = await fetch('data/iran.geojson');
        if (!geoRes.ok) throw new Error("GeoJSON not found");
        renderMapData(await geoRes.json());
        if (map && typeof map.whenReady === 'function') {
            map.whenReady(() => scheduleMapSync({ animate: false }));
        } else {
            scheduleMapSync({ animate: false });
        }

        initIndicatorSearch();

    } catch (err) {
        console.error("Error connecting to FastAPI backend:", err);
        showNotice("خطا در ارتباط با سرور بک‌اند.");
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

    const accentHex = (tObj && tObj.master_color) ? tObj.master_color : (tObj && tObj.upper_color) ? tObj.upper_color : '#0078d7';
    setTopicChrome(accentHex);
    persistAppTheme(accentHex);

    // Update back control to use the topic's upper color (if available)
    const upperHex = (tObj && (tObj.upper_color || tObj.color)) || '#0078d7';
    const btnEntry = document.getElementById('btn-back-entry');
    if (btnEntry) {
        btnEntry.style.background = upperHex;
        btnEntry.style.borderColor = rgbaFromHex(upperHex, 0.85);
        btnEntry.style.color = '#ffffff';
    }
}

function getHeatmapColor(score) {
    let factor = Number(score) / 100;
    if (factor > 1) factor = 1; if (factor < 0) factor = 0;
    return interpolateColor(currentLowerRgb, currentUpperRgb, factor);
}

function initUI() {
    const list = document.getElementById('index-list');
    list.innerHTML = '';
    const count = Math.max(1, topicsData.length);
    list.style.setProperty('--topic-count', String(count));
    
    topicsData.forEach(t => {
        const li = document.createElement('li');
        li.className = 'index-item' + (t.topic_name === currentIndex ? ' active' : '');
        
        const img = document.createElement('div');
        img.className = 'index-item-img lazy-bg bg-placeholder';
        img.dataset.bg = SITE.asset(`images/تاپیک ${t.topic_name}.webp`);
        const label = document.createElement('span');
        label.className = 'index-item-text';
        label.textContent = t.topic_name;
        li.append(img, label);

        if (list.childElementCount) {
            const divider = document.createElement('li');
            divider.className = 'index-divider';
            divider.setAttribute('aria-hidden', 'true');
            list.appendChild(divider);
        }

        li.addEventListener('click', () => {
            document.querySelectorAll('.index-item').forEach(el => el.classList.remove('active'));
            li.classList.add('active');
            currentIndex = t.topic_name;
            
            // Save active topic context for seamless returns
            sessionStorage.setItem('atlasSelectedTopic', currentIndex);
            
            updateTopicColors(t);
            updateMapStyles();
            initLegend();
            updatePointer();
            
            document.getElementById('right-panel').classList.add('show-panel');

            if (selectedProvince) updateRightPanel(selectedProvince);
            else updateDefaultPanel();
            if (isCompactMap()) setMapSheet(selectedProvince ? 'details' : 'map');
        });
        list.appendChild(li);
    });

    initLazyBackgrounds(list);
}

function restoreSelectedProvince(provName) {
    if (!provName || !geojsonLayer) return;
    selectedProvince = provName;
    try { sessionStorage.setItem('atlasSelectedProvince', provName); } catch(e) {}

    geojsonLayer.eachLayer(layer => {
        if (layer.feature.properties.ProvincNam === provName) {
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
    const hint = document.getElementById('left-province-hint');
    const container = document.getElementById('left-chart-markers');
    if (!panel) return;
    if (!provinceName) {
        panel.classList.remove('is-open');
        if (hint) hint.hidden = false;
        document.getElementById('left-popup-title').innerText = 'شاخص‌ها';
        return;
    }
    panel.classList.add('is-open');
    if (hint) hint.hidden = true;
    document.getElementById('left-popup-title').innerText = `شاخص‌های ${provinceName}`;
    
    if (!leftPanelInitialized) {
        container.innerHTML = '';
        topicsData.forEach((t, index) => {
            let isLeft = index < 4;
            let markerId = 'left-marker-' + t.topic_name.replace(/\s+/g, '-');
            let imgPath = SITE.asset(`images/تاپیک ${t.topic_name}.webp`);
            
            const marker = document.createElement('div');
            marker.className = 'topic-marker ' + (isLeft ? 'left-side' : 'right-side');
            marker.id = markerId;
            marker.style.bottom = '0%';
            marker.style.zIndex = 0;

            const dot = document.createElement('div');
            dot.className = 'topic-marker-dot';
            dot.style.background = t.upper_color || '#0078d7';
            const content = document.createElement('div');
            content.className = 'topic-marker-content';
            content.dataset.topicName = t.topic_name;
            const img = document.createElement('img');
            img.src = imgPath;
            img.alt = t.topic_name;
            img.loading = 'lazy';
            img.addEventListener('error', () => { img.hidden = true; });
            const score = document.createElement('span');
            score.className = 'marker-score-value';
            score.textContent = '0';
            content.append(img, score);
            marker.append(dot, content);
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
    
}

// CHANGE 2: Explicitly clears sessionStorage when fully exiting Atlas to start over
function clearSelection() {
    sessionStorage.removeItem('atlasSelectedProvince');
    if (!selectedProvince) return;
    selectedProvince = null;

    updateMapStyles();
    map.closePopup();
    renderLeftFloatingPanel(null);
    if (isCompactMap()) setMapSheet('map');

    setTimeout(() => {
        refitMapView({ animate: true }); 
    }, 100);

    document.getElementById('province-details').style.display = 'block';
    updateDefaultPanel();
}

function initMap() {
    map = L.map('map', { zoomSnap: 0.5, maxZoom: MAP_MAX_ZOOM, zoomControl: false }).setView(MAP_HOME_CENTER, MAP_HOME_ZOOM);
    // OSM tiles are often blocked in Iran. Google roadmap (Persian labels) is the stand-in.
    // Transparent fallback so a missed tile does not show Leaflet's broken-image icon.
    L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=fa&x={x}&y={y}&z={z}', {
        subdomains: ['0', '1', '2', '3'],
        attribution: '&copy; Google',
        maxZoom: 19,
        errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    }).addTo(map);

    map.on('click', clearSelection);
    requestAnimationFrame(() => {
        if (map && mapContainerHasSize()) {
            map.invalidateSize({ animate: false, pan: false });
        }
    });

    const el = map.getContainer();
    if (el && typeof ResizeObserver !== 'undefined') {
        let lastW = el.clientWidth;
        let lastH = el.clientHeight;
        const ro = new ResizeObserver(() => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            if (w < 2 || h < 2 || (w === lastW && h === lastH)) return;
            lastW = w;
            lastH = h;
            map.invalidateSize({ animate: false, pan: false });
            refitMapView({ animate: false });
        });
        ro.observe(el);
    }
}

function updateMapStyles() {
    if (!geojsonLayer) return;

    geojsonLayer.eachLayer(function (layer) {
        const provName = layer.feature.properties.ProvincNam || "استان ناشناخته";
        let score = getProvinceScore(provName, currentIndex);
        
        layer.setTooltipContent(`<strong>${provName}</strong><br/><span style="color:#0078d7; font-weight:bold;">امتیاز: ${score}</span>`);

        let fColor = getHeatmapColor(score);
        let fOpac = 0.85, bColor = "#ffffff", bWeight = 1.5;

        if (hoveredStageIndex !== null) {
            let stageSize = 100 / (heatStages - 1);
            let lowerBound = hoveredStageIndex * stageSize - (hoveredStageIndex === 0 ? 1 : 0.01);
            let upperBound = (hoveredStageIndex + 1) * stageSize;
            if (hoveredStageIndex === heatStages - 1) upperBound = 100.1;
            if (score >= lowerBound && score <= upperBound) { fOpac = 0.95; bColor = "#000"; bWeight = 2.5; } 
            else { fOpac = 0.15; bColor = "#ccc"; bWeight = 1; }
        }

        if (provName === selectedProvince) { fColor = "#e11d48"; fOpac = 0.9; }

        layer.setStyle({ color: bColor, weight: bWeight, fillColor: fColor, fillOpacity: fOpac });
    });
}

function renderMapData(geojsonData) {
    loadedGeoJSON = geojsonData;
    geojsonLayer = L.geoJSON(geojsonData, {
        onEachFeature: function (feature, layer) {
            const provName = feature.properties.ProvincNam || "استان ناشناخته";
            
            layer.bindTooltip("", { sticky: true, className: 'custom-tooltip' });
            
            layer.on('mouseover', (e) => {
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
                
                document.getElementById('right-panel').classList.add('show-panel');
                updateRightPanel(provName);
                renderLeftFloatingPanel(provName);
                if (isCompactMap()) setMapSheet('details');
                const bounds = layer.getBounds();
                requestAnimationFrame(() => {
                    fitMapTo(bounds, { animate: true, maxZoom: MAP_MAX_ZOOM, duration: 1.6 });
                });
            });
        }
    }).addTo(map);
    
    updateMapStyles(); 
    updateDefaultPanel();

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

function renderTopicDetails(desc) {
    const host = document.getElementById('province-details');
    if (!host) return;
    host.replaceChildren();
    const kicker = document.createElement('p');
    kicker.className = 'index-kicker';
    kicker.textContent = 'شاخص: ' + (currentIndex || '');
    const box = document.createElement('div');
    box.className = 'index-description-text';
    box.textContent = desc || '';
    host.append(kicker, box);
}

function updateDefaultPanel() {
    const tObj = topicsData.find(t => t.topic_name === currentIndex);
    renderTopicDetails(tObj ? tObj.topic_description : '');

    document.getElementById('chart-wrapper').style.display = 'none';
    document.getElementById('trend-wrapper').style.display = 'none';

    const bottomCard = document.querySelector('.right-card-bottom');
    if (bottomCard) bottomCard.style.display = 'flex';
    const hint = document.getElementById('province-pick-hint');
    if (hint) hint.hidden = false;
    const header = document.getElementById('bottom-prov-header');
    if (header) header.replaceChildren();

    if (rankingBarChart) { rankingBarChart.destroy(); rankingBarChart = null; }
    if (trendChartInstance) { trendChartInstance.destroy(); trendChartInstance = null; }
    updatePointer();
}

function updateRightPanel(provinceName) {
    document.getElementById('right-panel').classList.add('show-panel');

    const bottomCard = document.querySelector('.right-card-bottom');
    if (bottomCard) bottomCard.style.display = 'flex';
    const hint = document.getElementById('province-pick-hint');
    if (hint) hint.hidden = true;

    const tObj = topicsData.find(t => t.topic_name === currentIndex);
    renderTopicDetails(tObj ? tObj.topic_description : '');
    const pop = getProvincePop(provinceName);

    const header = document.getElementById('bottom-prov-header');
    header.replaceChildren();
    const row = document.createElement('div');
    row.className = 'prov-head-row';
    const heading = document.createElement('h3');
    heading.textContent = 'استان ' + provinceName;
    const pill = document.createElement('div');
    pill.className = 'prov-pop-pill';
    pill.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';
    pill.append(' جمعیت: ' + pop.toLocaleString('fa-IR'));
    row.append(heading, pill);
    header.appendChild(row);

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

    if (trendChartInstance) { trendChartInstance.destroy(); trendChartInstance = null; }
    const tCanvas = document.getElementById('trendChartPanel');
    const panelGen = ++trendPanelFetchGen;
    fetchAtlasTrend(provinceName, currentIndex).then(series => {
        if (panelGen !== trendPanelFetchGen) return;
        if (selectedProvince !== provinceName || currentIndex === "") return;
        const pTrends = (series || []).slice().sort((a, b) => Number(a.year) - Number(b.year));
        if (trendChartInstance) { trendChartInstance.destroy(); }
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
                    title: { display: true, text: 'روند زمانی', font: { family: 'PeydaFaNumWeb' }, color: '#333' }
                },
                scales: {
                    x: { ticks: { font: { size: 10 }, color: '#555' }, grid: { display: false } },
                    y: { min: 0, max: 100, ticks: { font: { size: 10 }, color: '#555', stepSize: 25 }, grid: { color: 'rgba(0,0,0,0.08)' } }
                }
            }
        });
    }).catch(err => console.error('Error loading atlas trend', err));
}

// Responsive resize handling: keep maps and charts sized correctly across displays
const onGlobalResize = debounce(() => {
    try { if (map && typeof map.invalidateSize === 'function') map.invalidateSize(true); } catch (e) {}
    try { refitMapView({ animate: false }); } catch (e) {}
    try { if (rankingBarChart && typeof rankingBarChart.resize === 'function') rankingBarChart.resize(); } catch (e) {}
    try { if (trendChartInstance && typeof trendChartInstance.resize === 'function') trendChartInstance.resize(); } catch (e) {}
}, 150);
window.addEventListener('resize', onGlobalResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onGlobalResize);

loadAllData();