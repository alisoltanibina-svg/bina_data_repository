const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function page() {
    const elements = new Map(), calls = [];
    let fail = false, release;
    const el = id => {
        if (!elements.has(id)) elements.set(id, {
            dataset: {}, disabled: id === 'maintenance-toggle', attributes: {}, handlers: {},
            addEventListener(type, handler) { this.handlers[type] = handler; },
            setAttribute(name, value) { this.attributes[name] = value; },
        });
        return elements.get(id);
    };
    const context = {
        document: { getElementById: el, querySelectorAll: () => [], addEventListener() {} },
        window: { location: {} }, SITE: { page: value => value }, API_BASE_URL: '',
        onReady() {}, showNotice() {}, bindPhoneInput() {},
        apiFetch: async (path, options) => {
            calls.push({ path, body: JSON.parse(options.body) });
            await new Promise(resolve => { release = resolve; });
            if (fail) throw new Error('Connection failed');
            return { ok: true, status: 200, json: async () => ({ maintenance_enabled: JSON.parse(options.body).enabled }) };
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('js/admin.js', 'utf8'), context);
    vm.runInContext('showNotice = () => {}; bind(); renderMaintenance(false);', context);
    return { el, calls, click: () => el('maintenance-toggle').handlers.click(),
        release: () => release(), fail: () => { fail = true; } };
}

test('admin switch enables then disables maintenance using server responses', async () => {
    const p = page(), toggle = p.el('maintenance-toggle');
    assert.equal(toggle.attributes['aria-checked'], 'false');
    let click = p.click();
    assert.equal(toggle.disabled, true);
    assert.deepEqual(p.calls[0], { path: '/api/admin/ops/maintenance', body: { enabled: true } });
    await p.click();
    assert.equal(p.calls.length, 1);
    p.release(); await click;
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.attributes['aria-checked'], 'true');
    assert.match(p.el('maintenance-state').textContent, /فعال است/);
    click = p.click();
    assert.equal(p.calls[1].body.enabled, false);
    p.release(); await click;
    assert.equal(toggle.attributes['aria-checked'], 'false');
    assert.match(p.el('maintenance-state').textContent, /در دسترس/);
});

test('failed save retains the previous switch state and allows retry', async () => {
    const p = page(), toggle = p.el('maintenance-toggle');
    p.fail();
    const click = p.click();
    p.release(); await click;
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.attributes['aria-checked'], 'false');
    assert.equal(toggle.dataset.enabled, '0');
});
