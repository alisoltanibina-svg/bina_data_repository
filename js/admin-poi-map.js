/* Admin-only display of committed Neshan Details on the supplied county layer. */
(function () {
    'use strict';
    const ns = 'http://www.w3.org/2000/svg';
    // Equirectangular projection centred on Iran, with room for the full county layer.
    const project = (lon, lat) => [140 + (lon - 44) * 37.4, 710 - (lat - 25) * 44];
    let boundariesReady = false;
    let loading = null;

    function element(tag, attributes) {
        const node = document.createElementNS(ns, tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
        return node;
    }

    async function load() {
        if (loading) return loading;
        loading = (async () => {
            const status = document.getElementById('poi-map-status');
            status.textContent = 'در حال خواندن مکان‌های ذخیره‌شده…';
            try {
                if (!boundariesReady) {
                    const layer = await adminFetch('/api/admin/poi/map/boundaries');
                    const fragment = document.createDocumentFragment();
                    for (const feature of layer.features) {
                        const geometry = feature.geometry;
                        const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
                        const d = polygons.map(polygon => polygon.map(ring => ring.map((p, i) => {
                            const [x, y] = project(p[0], p[1]);
                            return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
                        }).join(' ') + 'Z').join(' ')).join(' ');
                        fragment.append(element('path', { d, 'fill-rule': 'evenodd' }));
                    }
                    document.getElementById('poi-map-counties').replaceChildren(fragment);
                    boundariesReady = true;
                }
                const fragment = document.createDocumentFragment();
                let after = null;
                let count = 0;
                do {
                    const page = await adminFetch('/api/admin/poi/map/places' + (after ? '?after=' + encodeURIComponent(after) : ''));
                    for (const place of page.places) {
                        const [cx, cy] = project(place.longitude, place.latitude);
                        const dot = element('circle', { cx, cy, r: 2.5 });
                        const title = element('title', {});
                        title.textContent = place.name;
                        dot.append(title);
                        fragment.append(dot);
                        count++;
                    }
                    after = page.next;
                } while (after);
                document.getElementById('poi-map-places').replaceChildren(fragment);
                status.textContent = count ? `${count.toLocaleString('fa-IR')} مکان ذخیره‌شده` : 'هنوز مکانی ذخیره نشده است.';
            } catch (error) {
                status.textContent = 'خواندن نقشه ممکن نشد. دوباره تازه‌سازی کنید.';
            } finally {
                loading = null;
            }
        })();
        return loading;
    }
    window.AdminPoiMap = { load };
})();
