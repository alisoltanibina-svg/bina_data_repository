// Location Information: stored province totals plus transient, viewport-driven Nearby results.
function locationMarkerSize(count, maximum) {
    return count == null ? 28 : Math.round(24 + 40 * Math.sqrt(Math.max(0, count) / Math.max(1, maximum)));
}

function locationCategoryIcon(category) {
    // The Nearby layer is formal_school, but Neshan publishes its icon as school.
    if (category.category === 'formal_school' && (!category.icon_url ||
        /^https:\/\/static\.neshanmap\.ir\/poi\/(32|64|128)\/formal_school\.png$/.test(category.icon_url))) {
        return 'https://static.neshanmap.ir/poi/64/school.png';
    }
    return category.icon_url;
}

function locationNearbyPlan(category, center, zoom, config, bounds) {
    zoom = Math.floor(zoom);
    if (!category || !Number.isFinite(zoom) || zoom < config.min_zoom || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)
        || center.lat < 24 || center.lat > 41 || center.lng < 43 || center.lng > 64) return null;
    let radius = Number(config.radius_by_zoom[Math.min(19, zoom)]);
    if (bounds) {
        const origin = {latitude: center.lat, longitude: center.lng};
        const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
        const edgeDistances = [
            {latitude: ne.lat, longitude: center.lng}, {latitude: sw.lat, longitude: center.lng},
            {latitude: center.lat, longitude: ne.lng}, {latitude: center.lat, longitude: sw.lng}
        ].map(point => locationDistance(origin, point));
        const shortestEdge = Math.min(...edgeDistances);
        if (Number.isFinite(shortestEdge) && shortestEdge > 0) {
            // Fit inside the viewport, rather than covering its diagonal. Do not
            // impose a zoom-table floor that keeps an oversized circle on screen.
            radius = Math.min(100000, Math.max(10, Math.floor(shortestEdge * .85)));
        }
    }
    return {category, latitude: center.lat, longitude: center.lng, zoom: Math.min(19, zoom), radius};
}

function locationDistance(a, b) { return LocationDiscovery.distance(a, b); }

(function () {
    const state = {map: null, categories: [], selected: null, summary: null, counts: null,
        live: null, circle: null, config: null, store: null, timer: null, frame: null,
        rendered: new Map(), countsCache: new Map(), renderGeneration: 0, categoryGeneration: 0,
        countController: null, inflight: null, nextAllowed: 0, queue: [], moving: false,
        region: null, viewKey: '', viewCredits: 0, visibleCount: 0, showCoverage: false, initialized: false};
    const number = new Intl.NumberFormat('fa-IR');
    const element = id => document.getElementById(id);
    const api = path => `${window.API_BASE_URL || ''}${path}`;
    const setStatus = message => { element('locations-status').textContent = message; };
    function showError(message) {
        element('locations-error-text').textContent = message;
        element('locations-error').hidden = false;
    }
    function clearError() { element('locations-error').hidden = true; }
    function cancelLive() {
        clearTimeout(state.timer); state.timer = null; state.queue = [];
        ++state.renderGeneration;
        if (state.frame != null) cancelAnimationFrame(state.frame);
        state.frame = null;
        // A dispatched request may already cost quota. Keep its valid result for
        // its original cell instead of throwing it away on every map movement.
    }
    function clearLive() {
        if (state.live) state.live.clearLayers();
        state.rendered.clear(); state.visibleCount = 0;
        if (state.circle) { state.circle.remove(); state.circle = null; }
    }
    function viewBounds(padding = 0) {
        const ne = state.map.getBounds().getNorthEast(), sw = state.map.getBounds().getSouthWest();
        const height = ne.lat - sw.lat, width = ne.lng - sw.lng;
        return {south: sw.lat - height * padding, north: ne.lat + height * padding,
            west: sw.lng - width * padding, east: ne.lng + width * padding};
    }
    function protectedPoint(point) {
        return state.selected && point.category === state.selected.category
            && LocationDiscovery.inside(point.place, viewBounds(.12));
    }
    function updateCircle() {
        if (state.circle) { state.circle.remove(); state.circle = null; }
        if (!state.showCoverage || !state.region || state.map.getZoom() < state.config.min_zoom) return;
        state.circle = L.circle([state.region.latitude, state.region.longitude], {radius: state.region.radius,
            renderer: state.renderer, color: '#596315', weight: 1.5, dashArray: '5 5', fillOpacity: .02,
            interactive: false}).addTo(state.map);
    }
    function memoryStatus() {
        if (state.map && state.map.getZoom() < state.config.min_zoom) { setStatus('آمار استانی'); return; }
        const loading = state.queue.length || (state.inflight && state.selected
            && state.inflight.cell.category === state.selected.category);
        setStatus(`${number.format(state.visibleCount)} مکان${loading ? ' · در حال جستجو…' : ''}`);
    }
    function placeMarker(place) {
        const icon = L.icon({iconUrl: state.selected.icon_url, iconSize: [30, 30],
            iconAnchor: [15, 15], popupAnchor: [0, -16], className: 'locations-live-icon'});
        return L.marker([place.latitude, place.longitude], {icon, title: place.name, keyboard: true})
            .bindPopup(() => {
                const label = document.createElement('div'); label.className = 'locations-live-popup';
                label.textContent = place.name; return label;
            });
    }
    function groupMarker(group) {
        if (group.items.length === 1) return placeMarker(group.items[0].place);
        const node = document.createElement('div'); node.className = 'locations-cluster';
        const icon = document.createElement('img'); icon.src = state.selected.icon_url; icon.alt = '';
        const count = document.createElement('strong'); count.textContent = number.format(group.items.length);
        node.append(icon, count);
        return L.marker([group.latitude, group.longitude], {icon: L.divIcon({html: node,
            className: 'locations-cluster-marker', iconSize: [48, 48], iconAnchor: [24, 24]}),
            title: `${count.textContent} مکان یافت‌شده`, keyboard: true})
            .on('click', () => {
                const latitudes = group.items.map(item => item.place.latitude), longitudes = group.items.map(item => item.place.longitude);
                const south = Math.min(...latitudes), north = Math.max(...latitudes), west = Math.min(...longitudes), east = Math.max(...longitudes);
                if (south === north && west === east) state.map.setView([south, west], Math.min(19, state.map.getZoom() + 2));
                else state.map.fitBounds([[south, west], [north, east]], {padding: [40, 40], maxZoom: Math.min(19, state.map.getZoom() + 3)});
            });
    }
    function syncVisiblePoints() {
        if (!state.selected || !state.store) return;
        state.store.prune(protectedPoint);
        const groups = LocationDiscovery.groups(state.store.records(state.selected.category), viewBounds(.08), state.map.getZoom());
        const desired = new Map(groups.map(group => [group.key, group]));
        state.visibleCount = groups.reduce((sum, group) => sum + group.items.length, 0);
        const pending = groups.filter(group => state.rendered.get(group.key)?.signature !== group.signature);
        const generation = ++state.renderGeneration;
        if (state.frame != null) cancelAnimationFrame(state.frame);
        let offset = 0;
        function drawBatch() {
            state.frame = null;
            if (generation !== state.renderGeneration || document.hidden) return;
            for (const group of pending.slice(offset, offset + 50)) {
                const old = state.rendered.get(group.key);
                const marker = groupMarker(group).addTo(state.live);
                if (old) state.live.removeLayer(old.marker);
                state.rendered.set(group.key, {marker, signature: group.signature});
            }
            offset += 50;
            if (offset < pending.length) state.frame = requestAnimationFrame(drawBatch);
            else {
                for (const [key, entry] of state.rendered) if (!desired.has(key)) {
                    state.live.removeLayer(entry.marker); state.rendered.delete(key);
                }
            }
        }
        // Keep current markers until the replacement scene has been drawn.
        state.frame = requestAnimationFrame(drawBatch);
        memoryStatus();
    }
    async function readResponse(response) {
        if (response.status === 401 || response.status === 403) {
            if (typeof setAuthNext === 'function') setAuthNext({page: 'locations', search: ''});
            window.location.assign(authLoginUrl());
            throw new Error('ورود به حساب کاربری لازم است.');
        }
        const payload = await response.json();
        if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'دریافت اطلاعات انجام نشد.');
        return payload;
    }
    function renderCategories() {
        const root = element('location-categories');
        root.replaceChildren();
        const query = element('location-category-search').value.trim();
        for (const category of state.categories.filter(item => item.title.includes(query) || item.category.includes(query))) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'locations-category';
            button.classList.toggle('is-active', state.selected && category.category === state.selected.category);
            button.setAttribute('aria-pressed', String(!!state.selected && category.category === state.selected.category));
            const icon = document.createElement('img');
            icon.src = category.icon_url; icon.alt = ''; icon.loading = 'lazy';
            icon.addEventListener('error', () => { icon.hidden = true; });
            const label = document.createElement('span'); label.textContent = category.title;
            button.append(icon, label);
            button.addEventListener('click', () => selectCategory(category));
            root.append(button);
        }
        if (!root.childElementCount) {
            const message = document.createElement('p');
            message.textContent = state.categories.length ? 'نوع مکانی با این نام پیدا نشد.' : 'هنوز نوع مکانی برای نمایش منتشر نشده است.';
            root.append(message);
        }
    }
    function renderSummary(payload) {
        state.summary.clearLayers();
        const maximum = Math.max(1, ...payload.provinces.map(province => province.count || 0));
        for (const province of payload.provinces) {
            const size = locationMarkerSize(province.count, maximum);
            const node = document.createElement('div');
            node.className = 'locations-summary-marker' + (province.count == null ? ' is-unknown' : '');
            const icon = document.createElement('img');
            icon.src = state.selected.icon_url; icon.alt = ''; icon.width = size; icon.height = size;
            const count = document.createElement('strong');
            count.textContent = province.count == null ? 'نامشخص' : number.format(province.count);
            const name = document.createElement('small'); name.textContent = province.province;
            node.append(icon, count, name);
            L.marker([province.latitude, province.longitude], {icon: L.divIcon({html: node, className: '',
                iconSize: [100, size + 52], iconAnchor: [50, size / 2]}),
                title: `${province.province}؛ ${count.textContent}`})
                .on('click', () => state.map.setView([province.latitude, province.longitude], state.config.min_zoom))
                .addTo(state.summary);
        }
    }
    async function selectCategory(category) {
        if (state.selected?.category === category.category && state.counts) { scheduleViewport(); return; }
        const generation = ++state.categoryGeneration;
        cancelLive(); clearLive(); clearError();
        if (state.countController) state.countController.abort();
        state.countController = new AbortController();
        state.selected = category; state.counts = null;
        state.summary.clearLayers(); renderCategories();
        element('locations-current-category').textContent = category.title;
        const cached = state.countsCache.get(category.category);
        if (cached && Date.now() - cached.time < 60000) {
            state.counts = cached.payload; renderSummary(cached.payload); scheduleViewport(); return;
        }
        // Nearby discovery and retained markers do not depend on local count loading.
        scheduleViewport();
        try {
            const response = await fetch(api(`/api/poi-explore/counts?category=${encodeURIComponent(category.category)}`),
                {credentials: 'include', cache: 'no-store', signal: state.countController.signal});
            const payload = await readResponse(response);
            state.countsCache.set(category.category, {payload, time: Date.now()});
            if (generation !== state.categoryGeneration) return;
            state.counts = payload; renderSummary(payload); scheduleViewport();
        } catch (error) {
            if (error.name === 'AbortError' || generation !== state.categoryGeneration) return;
            showError(error.message);
        }
    }
    function scheduleViewport() {
        cancelLive(); state.moving = false;
        if (!state.map || !state.selected || document.hidden) return;
        const zoom = state.map.getZoom(), detailed = zoom >= state.config.min_zoom;
        element('locations-mode').textContent = detailed ? (zoom < 17 ? 'نمای کلی' : 'مکان‌های نزدیک') : 'آمار استانی';
        element('locations-explanation').textContent = detailed ? 'عدد هر گروه، تعداد مکان‌های یافت‌شده است. برای جزئیات، روی آن بزنید.' : 'آمار مکان‌های ثبت‌شده؛ نبود داده با «نامشخص» نمایش داده می‌شود.';
        if (!detailed) {
            if (state.map.hasLayer(state.live)) state.map.removeLayer(state.live);
            if (!state.map.hasLayer(state.summary)) state.summary.addTo(state.map);
            updateCircle(); setStatus('آمار استانی'); return;
        }
        if (state.map.hasLayer(state.summary)) state.map.removeLayer(state.summary);
        if (!state.map.hasLayer(state.live)) state.live.addTo(state.map);
        state.region = locationNearbyPlan(state.selected.category, state.map.getCenter(), zoom, state.config, state.map.getBounds());
        syncVisiblePoints(); updateCircle();
        if (!state.region) { setStatus('محدودهٔ ایران را انتخاب کنید.'); return; }
        const focused = LocationDiscovery.candidates(state.region, state.store.config.requests_per_view);
        const viewKey = focused.map(cell => cell.key).join('|') + '/' + Math.floor(Date.now() / state.store.config.cell_ttl_ms);
        if (viewKey !== state.viewKey) {
            state.viewKey = viewKey; state.viewCredits = state.store.config.requests_per_view;
        }
        state.queue = state.store.plan(state.region).slice(0, state.viewCredits);
        if (!state.queue.length) { memoryStatus(); return; }
        requestNext();
    }
    function requestNext() {
        clearTimeout(state.timer); state.timer = null;
        if (state.inflight || document.hidden || state.moving || !state.selected || !state.viewCredits) return;
        state.queue = state.queue.filter(cell => cell.category === state.selected.category
            && (state.store.eligible(cell) || ['failed', 'unavailable'].includes(state.store.cells.get(cell.key)?.status)));
        if (!state.queue.length) { memoryStatus(); return; }
        const cell = state.queue[0], record = state.store.cells.get(cell.key);
        const wait = Math.max(state.config.debounce_ms, state.nextAllowed - Date.now(), (record?.retryAt || 0) - Date.now());
        state.timer = setTimeout(() => {
            state.timer = null;
            if (document.hidden || state.moving || state.inflight) return;
            const next = state.queue.shift();
            if (next && state.store.begin(next)) { --state.viewCredits; requestNearby(next); }
        }, wait);
        memoryStatus();
    }
    async function requestNearby(cell) {
        const controller = new AbortController(), token = {controller, cell};
        state.inflight = token;
        const timeout = setTimeout(() => controller.abort(), 8000);
        state.nextAllowed = Date.now() + state.config.interval_ms;
        let status = 0;
        try {
            const response = await fetch(api('/api/poi-explore/nearby'), {method: 'POST', credentials: 'include', cache: 'no-store',
                signal: controller.signal, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
                    category: cell.category, latitude: cell.latitude, longitude: cell.longitude, zoom: cell.zoom, radius_m: cell.radius})});
            if (state.inflight !== token) return;
            status = response.status;
            if (status === 429) {
                const seconds = Number(response.headers.get('Retry-After'));
                const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000;
                state.nextAllowed = Math.max(state.nextAllowed, Date.now() + delay);
                state.store.fail(cell, 'unavailable', delay);
                if (state.viewCredits && state.selected?.category === cell.category) state.queue.unshift(cell);
                setStatus('کمی صبر کنید…'); return;
            }
            const payload = await readResponse(response);
            if (state.inflight !== token) return;
            state.store.finish(cell, payload, protectedPoint);
            if (!document.hidden && !state.moving && state.map.getZoom() >= state.config.min_zoom && state.selected?.category === cell.category) {
                clearError(); syncVisiblePoints();
            }
        } catch (error) {
            if (state.inflight !== token) return;
            const delay = 1500 + Math.floor(Math.random() * 500);
            state.store.fail(cell, 'failed', delay);
            if ((!status || status >= 500) && !cell.retried && state.viewCredits && state.selected?.category === cell.category) {
                state.queue.push({...cell, retried: true});
            } else if (!document.hidden && state.selected?.category === cell.category) {
                showError('جستجو انجام نشد. دوباره تلاش کنید.');
            }
        } finally {
            clearTimeout(timeout);
            if (state.inflight === token) { state.inflight = null; requestNext(); }
        }
    }
    async function initialize() {
        if (state.initialized) return;
        state.initialized = true;
        try {
            const [configResponse, initResponse] = await Promise.all([
                fetch(api('/api/maps/config'), {credentials: 'include', cache: 'no-store'}),
                fetch(api('/api/poi-explore/init'), {credentials: 'include', cache: 'no-store'})]);
            const [mapConfig, init] = await Promise.all([readResponse(configResponse), readResponse(initResponse)]);
            if (typeof L === 'undefined') throw new Error('بارگذاری نقشهٔ نشان انجام نشد.');
            state.config = init.live;
            state.categories = init.categories.map(category => ({...category, icon_url: locationCategoryIcon(category)}));
            state.store = new LocationDiscovery.Store(init.live.discovery);
            state.map = new L.Map('locations-map', {key: mapConfig.key, maptype: mapConfig.maptype,
                minZoom: 4, maxZoom: 19, zoomControl: true, preferCanvas: true}).setView([32, 53.5], 5);
            state.map.attributionControl.setPrefix(false);
            state.renderer = L.canvas({padding: .2, tolerance: 8});
            state.summary = L.layerGroup().addTo(state.map);
            state.live = L.layerGroup().addTo(state.map);
            state.map.on('movestart', () => { state.moving = true; cancelLive(); });
            state.map.on('moveend', scheduleViewport);
            state.map.on('zoomend', scheduleViewport);
            state.map.on('resize', scheduleViewport);
            renderCategories();
            setStatus(state.categories.length ? 'نوع مکان را انتخاب کنید.' : 'نوع مکانی موجود نیست.');
            clearError();
        } catch (error) { state.initialized = false; showError(error.message); setStatus('راه‌اندازی اطلاعات مکانی انجام نشد.'); }
    }
    function start() {
        element('location-category-search').addEventListener('input', renderCategories);
        element('locations-coverage').addEventListener('click', () => {
            state.showCoverage = !state.showCoverage;
            element('locations-coverage').setAttribute('aria-pressed', String(state.showCoverage));
            updateCircle();
        });
        element('locations-home').addEventListener('click', () => state.map && state.map.setView([32, 53.5], 5));
        element('locations-retry').addEventListener('click', () => {
            clearError();
            state.viewKey = '';
            if (!state.map) initialize();
            else if (state.selected && !state.counts) selectCategory(state.selected);
            else scheduleViewport();
        });
        element('locations-geolocate').addEventListener('click', () => {
            if (!navigator.geolocation || !state.map) { showError('موقعیت‌یابی در این مرورگر در دسترس نیست.'); return; }
            navigator.geolocation.getCurrentPosition(position => {
                const {latitude, longitude} = position.coords;
                if (latitude < 24 || latitude > 41 || longitude < 43 || longitude > 64) { showError('موقعیت شما خارج از محدودهٔ ایران است.'); return; }
                state.map.setView([latitude, longitude], 15);
            }, () => showError('دسترسی به موقعیت فراهم نشد؛ نقشه را به محل مورد نظر ببرید.'), {timeout: 7000, maximumAge: 0});
        });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) cancelLive();
            else { state.viewKey = ''; scheduleViewport(); }
        });
        window.addEventListener('pagehide', () => {
            cancelLive();
            if (state.inflight) {
                state.inflight.controller.abort(); state.store.abandon(state.inflight.cell); state.inflight = null;
            }
        });
        window.addEventListener('pageshow', () => { if (state.map) { state.viewKey = ''; scheduleViewport(); } });
        if (typeof window.binaWhenAuthReady === 'function') window.binaWhenAuthReady(ok => { if (ok) initialize(); });
        else initialize();
    }
    onReady(start);
})();
