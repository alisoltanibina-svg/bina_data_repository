// Pure, session-only discovery state. No storage, network calls, or map objects.
const LocationDiscovery = (() => {
    const EARTH = 6371000, WORLD = 40075016.686;
    const defaults = {requests_per_view: 2, session_request_limit: 120,
        memory_places: 5000, cell_ttl_ms: 900000, inactive_ttl_ms: 3600000, max_cells: 512};
    function distance(a, b) {
        const rad = Math.PI / 180, dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
        const value = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
        return EARTH * 2 * Math.asin(Math.min(1, Math.sqrt(value)));
    }
    function project(latitude, longitude, level) {
        const scale = 2 ** level, sine = Math.sin(latitude * Math.PI / 180);
        return {x: (longitude + 180) / 360 * scale,
            y: (.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale};
    }
    function unproject(x, y, level) {
        const scale = 2 ** level;
        return {latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI,
            longitude: x / scale * 360 - 180};
    }
    function inside(place, bounds) {
        return !!bounds && place.latitude >= bounds.south && place.latitude <= bounds.north
            && place.longitude >= bounds.west && place.longitude <= bounds.east;
    }
    function candidates(plan, budget = 2) {
        const level = Math.max(0, Math.min(24, Math.ceil(Math.log2(
            WORLD * Math.cos(plan.latitude * Math.PI / 180) / (plan.radius * .45)))));
        const origin = project(plan.latitude, plan.longitude, level), cells = [];
        for (let dx = -2; dx <= 2; ++dx) for (let dy = -2; dy <= 2; ++dy) {
            const x = Math.floor(origin.x) + dx, y = Math.floor(origin.y) + dy;
            const center = unproject(x + .5, y + .5, level);
            if (center.latitude < 24 || center.latitude > 41 || center.longitude < 43 || center.longitude > 64) continue;
            const corners = [[x,y],[x+1,y],[x,y+1],[x+1,y+1]].map(([a,b]) => unproject(a,b,level));
            const radius = Math.max(10, Math.ceil(Math.max(...corners.map(corner => distance(center, corner))) * 1.03));
            const offset = distance(center, plan);
            // Every provider request remains wholly inside the active search area.
            if (offset + radius > plan.radius) continue;
            cells.push({...center, radius, zoom: plan.zoom, category: plan.category,
                key: `${plan.category}/${level}/${x}/${y}`, offset});
        }
        // Select a small stable neighborhood first, then reuse its loaded cells.
        if (!cells.length) return [{...plan, key: `${plan.category}/local/${plan.latitude.toFixed(6)}/${plan.longitude.toFixed(6)}/${plan.radius}`}];
        return cells.sort((a,b) => a.offset - b.offset || a.key.localeCompare(b.key))
            .slice(0, Math.min(budget, plan.zoom < 12 ? 1 : budget));
    }
    function groups(records, bounds, zoom) {
        const pixels = zoom < 9 ? 128 : zoom < 12 ? 96 : zoom < 15 ? 64 : zoom < 17 ? 40 : 0;
        const buckets = new Map();
        for (const record of records) {
            if (!inside(record.place, bounds)) continue;
            const pixel = project(record.place.latitude, record.place.longitude, Math.floor(zoom));
            const key = pixels ? `cluster/${Math.floor(zoom)}/${Math.floor(pixel.x * 256 / pixels)}/${Math.floor(pixel.y * 256 / pixels)}` : record.key;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(record);
        }
        return [...buckets].map(([key, items]) => ({key, items,
            latitude: items.reduce((sum,item) => sum + item.place.latitude, 0) / items.length,
            longitude: items.reduce((sum,item) => sum + item.place.longitude, 0) / items.length,
            signature: JSON.stringify(items.map(item => [item.key, item.place.name, item.place.latitude, item.place.longitude]).sort())}));
    }
    class Store {
        constructor(config = {}, now = () => Date.now()) {
            this.config = {...defaults, ...config}; this.now = now;
            this.points = new Map(); this.cells = new Map();
            this.metrics = {requests: 0, successes: 0, failures: 0, reused: 0, evicted: 0};
        }
        eligible(cell) {
            const old = this.cells.get(cell.key), now = this.now();
            if (!old || old.status === 'not_requested' || old.status === 'partial') return true;
            if (old.status === 'loading') return false;
            if (old.status === 'failed' || old.status === 'unavailable') return now >= old.retryAt;
            return now - old.time >= this.config.cell_ttl_ms;
        }
        plan(region) {
            const cells = candidates(region, this.config.requests_per_view);
            const available = cells.filter(cell => this.eligible(cell)
                || ['failed', 'unavailable'].includes(this.cells.get(cell.key)?.status));
            this.metrics.reused += cells.length - available.length;
            return available.slice(0, Math.max(0, this.config.session_request_limit - this.metrics.requests));
        }
        begin(cell) {
            if (!this.eligible(cell) || this.metrics.requests >= this.config.session_request_limit) return false;
            ++this.metrics.requests;
            this.cells.set(cell.key, {status: 'loading', time: this.now(), keys: new Set()});
            return true;
        }
        finish(cell, payload, protectedPoint = () => false) {
            const keys = new Set();
            for (let place of payload.places) {
                if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)
                    || place.latitude < 24 || place.latitude > 41 || place.longitude < 43 || place.longitude > 64
                    || typeof place.name !== 'string' || distance(place, cell) > cell.radius) continue;
                let identity = typeof place.id === 'string' && place.id ? place.id
                    : JSON.stringify([place.latitude, place.longitude, place.name]);
                let key = `${cell.category}/${identity}`;
                let old = this.points.get(key);
                if (place.identity_scheme === 'neshan-prefix32-v1' && old &&
                    (old.place.name !== place.name || distance(old.place, place) > 2) && place.lookup_id) {
                    // Preserve both points when observed data contradicts the
                    // experimental identity rule; never silently merge them.
                    place = {...place, id:place.lookup_id};delete place.identity_scheme;
                    identity=place.id;key=`${cell.category}/${identity}`;old=this.points.get(key);
                }
                this.points.set(key, {key, category: cell.category, place, seen: this.now(), used: old ? old.used : this.now()});
                keys.add(key);
            }
            ++this.metrics.successes;
            this.cells.set(cell.key, {status: payload.possibly_truncated ? 'potentially_truncated'
                : keys.size ? 'loaded' : 'empty_response', time: this.now(), keys});
            this.prune(protectedPoint);
        }
        fail(cell, status, delay = 1000) {
            ++this.metrics.failures;
            this.cells.set(cell.key, {status, time: this.now(), retryAt: this.now() + delay, keys: new Set()});
        }
        abandon(cell) {
            if (this.cells.get(cell.key)?.status === 'loading') this.cells.delete(cell.key);
        }
        records(category) { return [...this.points.values()].filter(point => point.category === category); }
        prune(protectedPoint = () => false) {
            const now = this.now(), removed = new Set();
            for (const point of this.points.values()) {
                if (protectedPoint(point)) point.used = now;
                else if (now - point.used > this.config.inactive_ttl_ms) removed.add(point.key);
            }
            for (const key of removed) this.points.delete(key);
            if (this.points.size > this.config.memory_places) {
                const ordered = [...this.points.values()].sort((a,b) => Number(protectedPoint(a)) - Number(protectedPoint(b)) || a.used - b.used);
                for (const point of ordered.slice(0, this.points.size - this.config.memory_places)) {
                    removed.add(point.key); this.points.delete(point.key);
                }
            }
            this.metrics.evicted += removed.size;
            if (removed.size) for (const entry of this.cells.values()) {
                if ([...entry.keys].some(key => removed.has(key))) entry.status = 'partial';
            }
            while (this.cells.size > this.config.max_cells) {
                const entry = [...this.cells].filter(([,cell]) => cell.status !== 'loading').sort((a,b) => a[1].time - b[1].time)[0];
                if (!entry) break;
                this.cells.delete(entry[0]);
            }
        }
    }
    return {Store, candidates, groups, inside, distance, defaults};
})();
