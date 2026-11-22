// Location Information: stored province totals plus transient, viewport-driven Nearby results.
function locationMarkerSize(count, maximum) {
    return count == null ? 28 : Math.round(24 + 40 * Math.sqrt(Math.max(0, count) / Math.max(1, maximum)));
}

function locationNearbyPlan(category, center, zoom, config, bounds) {
    zoom = Math.floor(zoom);
    if (!category || !Number.isFinite(zoom) || zoom < config.min_zoom || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)
        || center.lat < 24 || center.lat > 41 || center.lng < 43 || center.lng > 64) return null;
    let radius = Number(config.radius_by_zoom[Math.min(19, zoom)]);
    if (bounds) {
        const origin = {latitude: center.lat, longitude: center.lng};
        const corners = [bounds.getNorthEast(), bounds.getSouthWest(), bounds.getNorthWest(), bounds.getSouthEast()];
        const visibleRadius = Math.max(...corners.map(point => locationDistance(origin,
            {latitude: point.lat, longitude: point.lng})));
        radius = Math.min(100000, Math.max(radius, Math.ceil(visibleRadius * 1.2 / 100) * 100));
    }
    return {category, latitude: center.lat, longitude: center.lng, zoom: Math.min(19, zoom), radius};
}

function locationDistance(previous, next) {
    const toRad = value => value * Math.PI / 180;
    const dLat = toRad(next.latitude - previous.latitude), dLon = toRad(next.longitude - previous.longitude);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(previous.latitude)) * Math.cos(toRad(next.latitude)) * Math.sin(dLon / 2) ** 2;
    const distance = 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    return distance;
}

function locationSearchChanged(previous, next) {
    return !previous || previous.category !== next.category || previous.radius !== next.radius
        || locationDistance(previous, next) > next.radius * .35;
}

(function () {
    const state = {map: null, categories: [], selected: null, summary: null, counts: null,
        live: null, circle: null, config: null, timer: null, frame: null, controller: null, countController: null,
        generation: 0, categoryGeneration: 0, nextAllowed: 0, lastPlan: null, points: new Map(), searches: [], initialized: false};
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
        ++state.generation;
        clearTimeout(state.timer);
        state.timer = null;
        if (state.frame != null) cancelAnimationFrame(state.frame);
        state.frame = null;
        if (state.controller) state.controller.abort();
        state.controller = null;
    }
    function clearLive() {
        if (state.live) state.live.clearLayers();
        if (state.circle) { state.circle.remove(); state.circle = null; }
        state.lastPlan = null;
        state.points.clear(); state.searches = [];
    }
    // Short-lived page memory only: no browser storage or persistent provider cache.
    const memoryAge = 15 * 60000, memoryLimit = 2000, searchLimit = 24;
    function pruneMemory(plan) {
        const cutoff = Date.now() - memoryAge;
        const retentionRadius = Math.max(50000, plan.radius * 3);
        for (const [key, point] of state.points) {
            if (point.seen < cutoff || locationDistance(point.place, plan) > retentionRadius) {
                state.live.removeLayer(point.marker); state.points.delete(key);
                state.searches = [];
            }
        }
        state.searches = state.searches.filter(search => search.time >= cutoff
            && locationDistance(search.plan, plan) <= retentionRadius);
    }
    function trimMemory() {
        while (state.points.size > memoryLimit) {
            const key = state.points.keys().next().value;
            state.live.removeLayer(state.points.get(key).marker); state.points.delete(key);
            state.searches = [];
        }
    }
    function memoryStatus() {
        setStatus(`${number.format(state.points.size)} مکان در محدوده‌های اخیر؛ نتایج ممکن است کامل نباشند.`);
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
        if (state.selected && state.selected.category === category.category && state.counts) { scheduleViewport(); return; }
        const generation = ++state.categoryGeneration;
        cancelLive(); clearLive(); clearError();
        if (state.countController) state.countController.abort();
        state.countController = new AbortController();
        state.selected = category; state.counts = null;
        state.summary.clearLayers(); renderCategories();
        element('locations-current-category').textContent = category.title;
        setStatus('در حال خواندن آمار استانی…');
        try {
            const response = await fetch(api(`/api/poi-explore/counts?category=${encodeURIComponent(category.category)}`),
                {credentials: 'include', cache: 'no-store', signal: state.countController.signal});
            const payload = await readResponse(response);
            if (generation !== state.categoryGeneration) return;
            state.counts = payload;
            renderSummary(payload);
            scheduleViewport();
        } catch (error) {
            if (error.name === 'AbortError' || generation !== state.categoryGeneration) return;
            showError(error.message);
            setStatus('آمار استانی دریافت نشد.');
        }
    }
    function scheduleViewport() {
        cancelLive();
        if (!state.map || !state.selected || !state.counts || document.hidden) return;
        const zoom = state.map.getZoom();
        const detailed = zoom >= state.config.min_zoom;
        element('locations-mode').textContent = detailed ? 'مکان‌های نزدیک' : 'آمار استانی';
        element('locations-explanation').textContent = detailed ? 'نتایج زنده در محدودهٔ دایره نمایش داده می‌شوند و ممکن است شامل همهٔ مکان‌ها نباشند.' :
            'اندازهٔ نمادها متناسب با تعداد مکان‌های ثبت‌شده است. نبود داده با «نامشخص» نمایش داده می‌شود.';
        if (!detailed) {
            if (state.map.hasLayer(state.live)) state.map.removeLayer(state.live);
            if (state.circle) { state.circle.remove(); state.circle = null; }
            if (!state.map.hasLayer(state.summary)) state.summary.addTo(state.map);
            const missing = state.counts.provinces.filter(province => province.count == null).length;
            setStatus(`آمار ثبت‌شدهٔ استانی${missing ? `؛ ${number.format(missing)} استان با وضعیت نامشخص` : ''}${state.counts.unassigned_count ? `؛ ${number.format(state.counts.unassigned_count)} مکان بدون استان مشخص` : ''}`);
            return;
        }
        if (state.map.hasLayer(state.summary)) state.map.removeLayer(state.summary);
        const plan = locationNearbyPlan(state.selected.category, state.map.getCenter(), zoom, state.config, state.map.getBounds());
        if (!plan) { clearLive(); setStatus('برای جستجوی مکان‌های نزدیک، نقشه را داخل محدودهٔ ایران جابه‌جا کنید.'); return; }
        if (!state.map.hasLayer(state.live)) state.live.addTo(state.map);
        pruneMemory(plan);
        if (state.searches.some(search => !locationSearchChanged(search.plan, plan))) {
            if (state.circle) { state.circle.remove(); state.circle = null; }
            clearError(); memoryStatus(); return;
        }
        const wait = Math.max(state.config.debounce_ms, state.nextAllowed - Date.now());
        setStatus('در حال جستجوی مکان‌های نزدیک…');
        const generation = state.generation;
        state.timer = setTimeout(() => requestNearby(plan, generation), wait);
    }
    async function requestNearby(plan, generation) {
        if (generation !== state.generation || document.hidden) return;
        const controller = new AbortController();
        state.controller = controller;
        const timeout = setTimeout(() => controller.abort(), 8000);
        state.nextAllowed = Date.now() + state.config.interval_ms;
        const {radius, ...body} = plan;
        body.radius_m = radius;
        try {
            const response = await fetch(api('/api/poi-explore/nearby'), {method: 'POST', credentials: 'include',
                cache: 'no-store', signal: controller.signal, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
            if (generation !== state.generation) return;
            if (response.status === 429) {
                const seconds = Number(response.headers.get('Retry-After'));
                state.nextAllowed = Math.max(state.nextAllowed, Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000));
                setStatus(seconds > 2 ? 'جستجو موقتاً محدود است؛ پس از مکث کوتاه دوباره انجام می‌شود.' : 'در حال جستجوی مکان‌های نزدیک…');
                state.timer = setTimeout(scheduleViewport, Math.max(1000, state.nextAllowed - Date.now()));
                return;
            }
            const payload = await readResponse(response);
            if (generation !== state.generation) return;
            clearError();
            if (state.circle) state.circle.remove();
            state.circle = L.circle([payload.center.latitude, payload.center.longitude], {radius: payload.radius_m,
                renderer: state.renderer, color: '#596315', weight: 1.5, dashArray: '5 5', fillColor: '#596315', fillOpacity: .04,
                interactive: false}).addTo(state.map);
            let offset = 0;
            const places = payload.places;
            const icon = L.icon({iconUrl: state.selected.icon_url, iconSize: [30, 30],
                iconAnchor: [15, 15], popupAnchor: [0, -16], className: 'locations-live-icon'});
            function drawBatch() {
                state.frame = null;
                if (generation !== state.generation || document.hidden) return;
                for (const place of places.slice(offset, offset + 50)) {
                    const key = JSON.stringify([place.latitude, place.longitude, place.name]);
                    const existing = state.points.get(key);
                    if (existing) {
                        existing.seen = Date.now();
                        state.points.delete(key); state.points.set(key, existing);
                        continue;
                    }
                    const marker = L.marker([place.latitude, place.longitude], {icon, title: place.name, keyboard: true})
                        .bindPopup(() => {
                            const label = document.createElement('div'); label.className = 'locations-live-popup';
                            label.textContent = place.name; return label;
                        }).addTo(state.live);
                    state.points.set(key, {place, marker, seen: Date.now()});
                }
                trimMemory();
                offset += 50;
                if (offset < places.length) state.frame = requestAnimationFrame(drawBatch);
                else {
                    state.lastPlan = plan;
                    state.searches.push({plan, time: Date.now()});
                    state.searches = state.searches.slice(-searchLimit);
                    memoryStatus();
                }
            }
            state.frame = requestAnimationFrame(drawBatch);
        } catch (error) {
            if (generation !== state.generation) return;
            showError(error.name === 'AbortError' ? 'زمان پاسخ‌گویی سرویس طولانی شد. دوباره تلاش کنید.' : error.message);
            setStatus('مکان‌های نزدیک دریافت نشدند.');
        } finally { clearTimeout(timeout); }
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
            state.config = init.live; state.categories = init.categories;
            state.map = new L.Map('locations-map', {key: mapConfig.key, maptype: mapConfig.maptype,
                minZoom: 4, maxZoom: 19, zoomControl: true, preferCanvas: true}).setView([32, 53.5], 5);
            state.map.attributionControl.setPrefix(false);
            state.renderer = L.canvas({padding: .2, tolerance: 8});
            state.summary = L.layerGroup().addTo(state.map);
            state.live = L.layerGroup().addTo(state.map);
            state.map.on('movestart', cancelLive);
            state.map.on('moveend', scheduleViewport);
            state.map.on('zoomend', scheduleViewport);
            state.map.on('resize', scheduleViewport);
            renderCategories();
            setStatus(state.categories.length ? 'نوع مکان را از فهرست انتخاب کنید.' : 'هنوز نوع مکانی برای نمایش منتشر نشده است.');
            clearError();
        } catch (error) { state.initialized = false; showError(error.message); setStatus('راه‌اندازی اطلاعات مکانی انجام نشد.'); }
    }
    function start() {
        element('location-category-search').addEventListener('input', renderCategories);
        element('locations-home').addEventListener('click', () => state.map && state.map.setView([32, 53.5], 5));
        element('locations-retry').addEventListener('click', () => {
            clearError();
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
            if (document.hidden) { cancelLive(); clearLive(); }
            else scheduleViewport();
        });
        window.addEventListener('pagehide', () => { cancelLive(); clearLive(); });
        window.addEventListener('pageshow', () => { if (state.map) scheduleViewport(); });
        if (typeof window.binaWhenAuthReady === 'function') window.binaWhenAuthReady(ok => { if (ok) initialize(); });
        else initialize();
    }
    onReady(start);
})();
