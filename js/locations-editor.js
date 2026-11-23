// Manual entry is independent of ephemeral Nearby results and never copies them.
function LocationEditor({map, categories, canEdit, onModeChange, onSaved, onCount = () => {}}) {
    const el = id => document.getElementById(id);
    const fields = ['name', 'category', 'latitude', 'longitude'];
    const input = name => el(`locations-place-${name}`);
    const layer = L.layerGroup().addTo(map);
    let editing = false, dirty = false, saving = false, picking = false, record = null;
    let selected = null, controller = null, timer = null, generation = 0, draftMarker = null;
    const feedback = (text, error = false) => {
        el('locations-editor-feedback').textContent = text;
        el('locations-editor-feedback').classList.toggle('is-error', error);
    };
    function confirmDiscard() {
        return !dirty || window.confirm('تغییرات ذخیره نشده‌اند. از آن‌ها صرف‌نظر می‌کنید؟');
    }
    function pick(on) {
        picking = on;
        document.body.classList.toggle('is-picking', on);
        el('locations-pick-point').setAttribute('aria-pressed', String(on));
        el('locations-pick-point').textContent = on ? 'نقطهٔ مورد نظر را روی نقشه بزنید' : 'انتخاب نقطه روی نقشه';
    }
    function showDraft() {
        if (draftMarker) { draftMarker.remove(); draftMarker = null; }
        const latitude = Number(input('latitude').value), longitude = Number(input('longitude').value);
        if (!editing || !input('latitude').value || !input('longitude').value ||
            latitude < 24 || latitude > 41 || longitude < 43 || longitude > 64 ||
            !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        const category = categories.find(item => item.category === input('category').value);
        const icon = category ? L.icon({iconUrl: category.icon_url, iconSize: [36, 36], iconAnchor: [18, 18],
            className: 'locations-live-icon locations-manual-icon'}) : undefined;
        draftMarker = L.marker([latitude, longitude], {icon, title: 'نقطهٔ انتخاب‌شده', keyboard: false}).addTo(map);
    }
    function fill(row = null) {
        record = row;
        fields.forEach(name => { input(name).value = row ? row[name] : name === 'category' ? (selected?.category || categories[0]?.category || '') : ''; });
        dirty = false; pick(false); showDraft(); feedback('');
        el('locations-editor-title').textContent = row ? 'ویرایش مکان' : 'ثبت مکان';
        el('locations-save-place').textContent = row ? 'ذخیره تغییرات' : 'ذخیره مکان';
    }
    function setMode(mode) {
        if (!canEdit || saving || (mode !== 'edit' && !confirmDiscard())) return;
        editing = mode === 'edit';
        document.body.classList.toggle('is-editing', editing);
        el('locations-editor').hidden = !editing;
        el('locations-view-mode').setAttribute('aria-pressed', String(!editing));
        el('locations-edit-mode').setAttribute('aria-pressed', String(editing));
        if (!editing) fill();
        onModeChange(editing);
        map.invalidateSize();
        schedule();
    }
    async function read(response) {
        const payload = await response.json();
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) setMode('view');
            throw new Error(typeof payload.detail === 'string' ? payload.detail : 'دریافت یا ذخیرهٔ مکان انجام نشد.');
        }
        return payload;
    }
    function open(row) {
        if (!editing || saving || !confirmDiscard()) return;
        fill(row);
        map.setView([row.latitude, row.longitude], Math.max(15, map.getZoom()));
        input('name').focus();
    }
    async function refresh() {
        if (controller) controller.abort();
        const version = ++generation;
        el('locations-manual-list').replaceChildren();
        if (!selected || document.hidden) return;
        if (map.getZoom() < 8 && !editing) { layer.clearLayers(); onCount(0); return; }
        controller = new AbortController();
        const bounds = map.getBounds(), ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
        const south = Math.max(24, sw.lat), north = Math.min(41, ne.lat), west = Math.max(43, sw.lng), east = Math.min(64, ne.lng);
        if (south > north || west > east) return;
        const query = new URLSearchParams({category: selected.category, south, north, west, east});
        el('locations-manual-status').textContent = 'در حال دریافت مکان‌ها…';
        try {
            const payload = await read(await fetch(`${window.API_BASE_URL || ''}/api/poi-explore/manual-places?${query}`,
                {credentials: 'include', cache: 'no-store', signal: controller.signal}));
            if (version !== generation) return;
            layer.clearLayers();
            for (const row of payload.places) {
                const icon = L.icon({iconUrl: selected.icon_url, iconSize: [30, 30], iconAnchor: [15, 15],
                    className: 'locations-live-icon locations-manual-icon'});
                const marker = L.marker([row.latitude, row.longitude], {icon, title: `${row.name} · ثبت سامانه`});
                marker.bindPopup(() => {
                    const node = document.createElement('div'); node.className = 'locations-live-popup';
                    const name = document.createElement('strong'); name.textContent = row.name;
                    const source = document.createElement('p'); source.textContent = 'ثبت سامانه'; node.append(name, source);
                    if (canEdit && editing) {
                        const button = document.createElement('button'); button.type = 'button'; button.textContent = 'ویرایش مکان';
                        button.addEventListener('click', () => open(row)); node.append(button);
                    }
                    return node;
                }).addTo(layer);
                const button = document.createElement('button'); button.type = 'button'; button.textContent = row.name;
                button.addEventListener('click', () => open(row)); el('locations-manual-list').append(button);
            }
            el('locations-manual-status').textContent = payload.has_more ? '۲۰۰ مکان نمایش داده شد؛ نقشه را بزرگ‌تر کنید.' :
                payload.places.length ? `${new Intl.NumberFormat('fa-IR').format(payload.places.length)} مکان ثبت‌شده` : 'در این محدوده مکانی ثبت نشده است.';
            onCount(payload.places.length);
        } catch (error) {
            if (error.name !== 'AbortError' && version === generation) el('locations-manual-status').textContent = error.message;
        }
    }
    function schedule(category = selected) {
        if (selected?.category !== category?.category) { layer.clearLayers(); onCount(0); }
        selected = category;
        ++generation;
        if (controller) controller.abort();
        clearTimeout(timer);
        timer = setTimeout(refresh, 250);
    }
    for (const category of categories) {
        const option = document.createElement('option'); option.value = category.category; option.textContent = category.title;
        input('category').append(option);
    }
    el('locations-mode-switch').hidden = !canEdit;
    el('locations-view-mode').addEventListener('click', () => setMode('view'));
    el('locations-edit-mode').addEventListener('click', () => setMode('edit'));
    el('locations-new-place').addEventListener('click', () => { if (!saving && confirmDiscard()) fill(); });
    el('locations-cancel-place').addEventListener('click', () => { if (!saving && confirmDiscard()) fill(); });
    el('locations-refresh-places').addEventListener('click', refresh);
    fields.forEach(name => input(name).addEventListener('input', () => { dirty = true; if (name !== 'name') showDraft(); }));
    el('locations-pick-point').addEventListener('click', () => { if (!saving) pick(!picking); });
    map.on('click', event => {
        if (!editing || !picking || saving) return;
        input('latitude').value = event.latlng.lat.toFixed(6);
        input('longitude').value = event.latlng.lng.toFixed(6);
        dirty = true; pick(false); showDraft();
    });
    window.addEventListener('beforeunload', event => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('pagehide', () => { clearTimeout(timer); if (controller) controller.abort(); });
    el('locations-place-form').addEventListener('submit', async event => {
        event.preventDefault();
        if (!canEdit || !editing || saving || !el('locations-place-form').reportValidity()) return;
        const body = {name: input('name').value.trim(), category: input('category').value,
            latitude: Number(input('latitude').value), longitude: Number(input('longitude').value)};
        if (record) body.version = record.version;
        saving = true; feedback('در حال ذخیره…');
        const controls = [...fields.map(input), ...['locations-save-place', 'locations-new-place', 'locations-cancel-place', 'locations-pick-point'].map(el)];
        controls.forEach(control => { control.disabled = true; });
        try {
            const saved = await read(await fetch(`${window.API_BASE_URL || ''}/api/poi-explore/manual-places${record ? '/' + encodeURIComponent(record.id) : ''}`,
                {method: record ? 'PATCH' : 'POST', credentials: 'include', headers: {'Content-Type': 'application/json', 'X-CSRF-Protection': '1'}, body: JSON.stringify(body)}));
            fill(saved); feedback('مکان ذخیره شد.');
            await onSaved(saved); schedule();
        } catch (error) { feedback(error.message, true); }
        finally { saving = false; controls.forEach(control => { control.disabled = false; }); }
    });
    fill();
    return {schedule};
}
