// The tracking code stays in page memory and the user's receipt, never in URLs.
(() => {
    'use strict';
    const $ = id => document.getElementById('support-' + id);
    const statuses = {open:'باز', in_progress:'در حال بررسی', awaiting_user:'منتظر پاسخ شما', closed:'بسته شده'};
    const nameInput = $('name');
    function validateName() {
        const valid = !!nameInput.value.trim();
        nameInput.setCustomValidity(valid ? '' : 'نام را وارد کنید.');
        return valid;
    }
    ['input', 'blur', 'invalid'].forEach(event => nameInput.addEventListener(event, validateName));
    const phoneInput = $('phone');
    bindPhoneInput(phoneInput);
    function validatePhone() {
        phoneInput.value = digitsOnlyPhone(phoneInput.value);
        const valid = /^09\d{9}$/.test(phoneInput.value);
        phoneInput.setCustomValidity(valid ? '' : 'شماره تلفن باید ۱۱ رقم و با ۰۹ شروع شود.');
        return valid;
    }
    ['input', 'blur', 'paste'].forEach(event => phoneInput.addEventListener(event, validatePhone));
    phoneInput.addEventListener('invalid', validatePhone);
    let captchaId = '', access = null, draftAccess = null, receipt = null, busy = false;
    const waits = new Map();
    const params = new URLSearchParams(location.search);
    const context = {};
    for (const key of ['stage','error_code','error_reference']) {
        const value = params.get(key) || '';
        if (/^[a-zA-Z0-9_-]{1,48}$/.test(value)) context[key] = value.slice(0, key === 'stage' || key === 'error_reference' ? 32 : 48);
    }
    if (context.error_code === 'inactive' || context.error_code === 'account-review') $('category').value = 'account';
    else if (['pending','rejected','closed'].includes(context.error_code)) $('category').value = 'register';
    else if (context.stage) $('category').value = context.stage.includes('register') ? 'register' : context.stage.includes('otp') ? 'otp' : context.stage.includes('reset') ? 'reset' : 'login';
    function error(err) {
        $('error').hidden = false;
        $('error').textContent = (err.message || 'ارتباط با سامانه ممکن نشد. دوباره تلاش کنید.') + (err.reference ? ' · کد خطا: ' + err.reference : '');
    }
    function clearError() { $('error').hidden = true; }
    function tab(track) {
        $('create-panel').hidden = track;
        $('track-panel').hidden = !track;
        if (!track) $('conversation').hidden = true;
        for (const [id,on] of [['create-tab',!track],['track-tab',track]]) {
            $(id).setAttribute('aria-selected', String(on));
            $(id).classList.toggle('secondary', !on);
        }
        clearError();
    }
    async function request(path, body) {
        const remaining = Math.ceil(((waits.get(path) || 0) - Date.now()) / 1000);
        if (remaining > 0) throw new Error('برای این اقدام ' + remaining + ' ثانیه صبر کنید.');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        let response;
        try {
            response = await fetch(API_BASE_URL + path, {method:'POST', headers:{'Content-Type':'application/json'}, cache:'no-store', signal:controller.signal, body:JSON.stringify(body || {})});
        } catch (_) { throw new Error('ارتباط برقرار نشد. اطلاعات شما در فرم باقی مانده است؛ دوباره تلاش کنید.'); }
        finally { clearTimeout(timer); }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = data.detail || {};
            const err = new Error(typeof detail === 'string' ? detail : detail.message || 'اطلاعات فرم را بررسی کنید و دوباره تلاش کنید.');
            err.code = detail.code;
            err.status = response.status;
            err.reference = response.headers.get('X-Request-ID') || detail.reference || '';
            const seconds = Number(response.headers.get('Retry-After') || detail.retry_after || data.retry_after || 0);
            if (seconds > 0) waits.set(path, Date.now() + seconds * 1000);
            throw err;
        }
        return data;
    }
    setInterval(() => {
        const seconds = Math.max(0, ...Array.from(waits.values(), until => Math.ceil((until - Date.now()) / 1000)));
        $('wait').hidden = !seconds;
        $('wait').textContent = seconds ? 'محدودیت موقت برای بعضی اقدامات: ' + seconds + ' ثانیه تا تلاش بعدی.' : '';
    }, 1000);
    function latinDigits(value) { return value.replace(/[۰-۹٠-٩]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.includes(digit) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))); }
    function newReceipt() { return {reference:newTicketReference()}; }
    async function refreshCaptcha() {
        captchaId = '';
        const data = await request('/api/support/captcha', {});
        captchaId = data.captcha_id;
        $('captcha-image').src = API_BASE_URL + '/api/support/captcha/' + encodeURIComponent(captchaId) + '/image';
        $('captcha-answer').value = '';
    }
    function render(ticket) {
        $('conversation').hidden = false;
        $('ticket-subject').textContent = ticket.subject;
        $('ticket-status').textContent = statuses[ticket.status] || ticket.status;
        $('messages').replaceChildren();
        for (const message of ticket.messages || []) {
            const box = document.createElement('article');
            box.className = 'support-message ' + (message.author === 'support' ? 'is-support' : 'is-user');
            const who = document.createElement('small');
            who.textContent = (message.author === 'support' ? 'پشتیبانی' : 'شما') + ' · ' + new Date(message.created_at).toLocaleString('fa-IR');
            const text = document.createElement('p'); text.textContent = message.body;
            box.append(who,text); $('messages').append(box);
        }
    }
    function showReceipt(value) {
        receipt = value;
        $('receipt').hidden = false;
        $('receipt-reference').textContent = value.reference;
        $('reference').value = value.reference;
    }
    function receiptText() { return 'رسید تیکت پشتیبانی\nکد پیگیری: ' + receipt.reference + '\n' + location.origin + location.pathname; }
    async function run(button, action) {
        if (busy) return;
        busy = true; button.disabled = true; clearError();
        try { await action(); } catch (err) { error(err); }
        finally { busy = false; button.disabled = false; }
    }
    $('create-tab').onclick = () => tab(false);
    $('track-tab').onclick = () => { tab(true); if (access) $('conversation').hidden = false; };
    $('captcha-refresh').onclick = () => run($('captcha-refresh'), refreshCaptcha);
    $('create-form').onsubmit = event => {
        event.preventDefault();
        if (!validateName()) { nameInput.reportValidity(); return; }
        if (!validatePhone()) { phoneInput.reportValidity(); return; }
        run($('create-submit'), async () => {
            if (!captchaId) { await refreshCaptcha(); throw new Error('کد امنیتی تازه را وارد کنید.'); }
            draftAccess ||= newReceipt();
            // Keep a receipt even if the network fails after the server saves the ticket.
            const payload = Object.fromEntries(['name','phone','category','subject','message'].map(key => [key,$(key).value.trim()]));
            try {
                const ticket = await request('/api/support/tickets', {...payload,...context,...draftAccess,captcha_id:captchaId,captcha_answer:$('captcha-answer').value.trim()});
                access = {...draftAccess}; tab(true); showReceipt(access);
                $('receipt-note').textContent = 'کد پیگیری را برای پیگیری تیکت ذخیره کنید.';
                render(ticket);
                draftAccess = null; $('create-form').reset(); captchaId = '';
            } catch (err) {
                if (err.code === 'reference-conflict') { draftAccess = null; throw err; }
                showReceipt(draftAccess);
                $('receipt-note').textContent = 'اگر ثبت تیکت در سرور انجام شده باشد، با این رسید می‌توانید آن را پیگیری کنید. اطلاعات فرم حفظ شده است. برای اطمینان، دوباره ثبت را بزنید.';
                if (err.status >= 400 && err.status < 500 && err.status !== 429) await refreshCaptcha().catch(() => {});
                throw err;
            }
        });
    };
    $('track-form').onsubmit = event => {
        event.preventDefault();
        run($('track-submit'), async () => {
            const candidate = {reference:latinDigits($('reference').value.trim()).toUpperCase()};
            $('conversation').hidden = true;
            const ticket = await request('/api/support/tickets/lookup',candidate);
            access = candidate; render(ticket);
        });
    };
    $('refresh-ticket').onclick = () => run($('refresh-ticket'), async () => render(await request('/api/support/tickets/lookup',access)));
    $('reply-form').onsubmit = event => {
        event.preventDefault();
        run($('reply-submit'), async () => {
            render(await request('/api/support/tickets/reply',{...access,message:$('reply').value.trim()}));
            $('reply').value = '';
        });
    };
    $('download-receipt').onclick = () => {
        if (!receipt) return;
        const url = URL.createObjectURL(new Blob(['\ufeff' + receiptText()],{type:'text/plain;charset=utf-8'}));
        const link = document.createElement('a'); link.href = url; link.download = receipt.reference + '.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    };
    $('copy-receipt').onclick = async () => {
        try { await navigator.clipboard.writeText(receiptText()); $('copy-receipt').textContent = 'کپی شد'; }
        catch (_) { error(new Error('کپی خودکار ممکن نشد؛ فایل رسید را دریافت کنید.')); }
    };
    refreshCaptcha().catch(error);
})();
