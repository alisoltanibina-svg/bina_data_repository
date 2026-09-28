const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function page() {
    const elements = new Map();
    const calls = [];
    const storage = new Map();
    const proof = 'a'.repeat(43);
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', hidden: true, disabled: false, tagName: 'INPUT', handlers: {},
            focus() {}, setAttribute() {}, removeAttribute() {},
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            addEventListener(name, callback) { this.handlers[name] = callback; }
        });
        return elements.get(id);
    };
    const context = vm.createContext({
        document: {
            getElementById: element, querySelectorAll: () => [], addEventListener() {},
            documentElement: element('documentElement')
        },
        window: {
            location: { hash: '', pathname: '/index', search: '' },
            matchMedia: () => ({ matches: false }),
            setTimeout: fn => fn(), clearInterval() {}, setInterval: () => 1, dispatchEvent() {}
        },
        sessionStorage: {
            getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        },
        onReady: fn => fn(), bindPhoneInput() {}, bindOtpInput() {}, quietMobileField() {},
        normalizeOtpCode: code => code, readBannerProfile: () => null, showNotice() {},
        writeBannerProfile() {}, takeAuthNext: () => null, AUTH_NEXT_KEY: 'next',
        history: { replaceState() {} }, Event: class {}, API_BASE_URL: '',
        fetch: async (url, options) => {
            calls.push({ url, body: JSON.parse(options.body) });
            const payload = url.endsWith('/otp/verify') ? { verification_token: proof }
                : url.endsWith('/otp/send') ? { resend_seconds: 60 } : { id: 1 };
            return { ok: true, json: async () => payload };
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/auth-page.js'), 'utf8'), context);
    vm.runInContext("currentPhone = '09120000001'; otpPurpose = 'reset';", context);
    element('otp-code').value = '654321';
    element('reset-password').value = 'replacement-password';
    element('reset-password-confirm').value = 'replacement-password';
    return {
        context, calls, storage, proof,
        submit: id => element(id).handlers.submit({ preventDefault() {}, currentTarget: element(id) })
    };
}

test('reset sends the proof from OTP verification, without storing it', async () => {
    const p = page();
    await p.submit('otp-form');
    await p.submit('reset-form');
    const reset = p.calls.find(call => call.url.endsWith('/password/reset'));
    assert.equal(reset.body.verification_token, p.proof);
    assert.equal(reset.body.phone, '09120000001');
    assert.equal([...p.storage.values()].some(value => value.includes(p.proof)), false);
});

test('registration sends the proof too', async () => {
    const p = page();
    vm.runInContext("otpPurpose = 'register'; pendingRegister = { first_name: 'Test', last_name: 'User', role_title: 'Researcher', password: 'new-password' };", p.context);
    await p.submit('otp-form');
    const registration = p.calls.find(call => call.url.endsWith('/auth/register'));
    assert.equal(registration.body.verification_token, p.proof);
});

test('reset without verification never submits a password change', async () => {
    const p = page();
    await p.submit('reset-form');
    assert.equal(p.calls.length, 0);
});

test('changing the phone or requesting another code discards the proof', async () => {
    for (const action of ["applyPhone('09120000002')", "sendOtp('reset')", 'backToGate()']) {
        const p = page();
        await p.submit('otp-form');
        await vm.runInContext(action, p.context);
        await p.submit('reset-form');
        assert.equal(p.calls.some(call => call.url.endsWith('/password/reset')), false);
    }
});

test('late verification response cannot authorize a changed phone', async () => {
    const p = page();
    let respond;
    p.context.fetch = () => new Promise(resolve => { respond = resolve; });
    const pending = p.submit('otp-form');
    vm.runInContext("applyPhone('09120000002')", p.context);
    respond({ ok: true, json: async () => ({ verification_token: p.proof }) });
    await pending;
    assert.equal(vm.runInContext('otpVerification', p.context), null);
});
