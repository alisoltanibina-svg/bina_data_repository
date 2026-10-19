// Account ticket history uses authenticated owner-scoped APIs; conversation text is never HTML.
(() => {
    'use strict';
    const $ = id => document.getElementById('my-ticket-' + id);
    const labels = {open:'باز',in_progress:'در حال بررسی',awaiting_user:'منتظر پاسخ شما',closed:'بسته شده'};
    const summary = ticket => Object.fromEntries(['reference','subject','category','status','created_at','updated_at'].map(key => [key,ticket[key]]));
    let rows = [], cursor = null, selected = '', draftReference = '', listVersion = 0, detailVersion = 0;
    let loading = false, reading = false, creating = false, sending = false, redirecting = false;
    const waits = new Map();
    let view = 'empty';
    let ticketClosed = false;
    function setView(next) {
        view = next;
        $('create').hidden = next !== 'create';
        $('detail').hidden = next !== 'detail';
        $('placeholder').hidden = !['empty', 'loading'].includes(next);
        $('submit').hidden = next !== 'create';
        $('send').hidden = next !== 'detail' || ticketClosed;
        $('new').classList.toggle('is-selected', next === 'create');
        $('new').setAttribute('aria-pressed', String(next === 'create'));
    }
    function openCreate() {
        if (creating || sending || !allowSwitch()) return;
        ++detailVersion;
        reading = false;
        $('reply').value = '';
        clearError();
        setView('create');
        renderList();
        $('subject').focus();
    }

    function clearError() { $('error').hidden = true; }
    function error(err) { $('error').hidden = false; $('error').textContent = (err.message || 'ارتباط با سامانه ممکن نشد. دوباره تلاش کنید.') + (err.reference ? ' · کد خطا: ' + err.reference : ''); }
    async function request(path, options = {}) {
        const method = options.method || 'GET';
        const key = method + ':' + path.split('?')[0];
        const remaining = Math.ceil(((waits.get(key) || 0) - Date.now()) / 1000);
        if (remaining > 0) throw new Error('برای این اقدام ' + remaining + ' ثانیه صبر کنید.');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        let response;
        try {
            response = await fetch(API_BASE_URL + path,{method,credentials:'include',cache:'no-store',signal:controller.signal,
                headers:options.body ? {'Content-Type':'application/json'} : {},body:options.body ? JSON.stringify(options.body) : undefined});
        } catch (_) { throw new Error('ارتباط برقرار نشد. اطلاعات فرم حفظ شده است؛ دوباره تلاش کنید.'); }
        finally { clearTimeout(timer); }
        const data = await response.json().catch(() => ({}));
        if (response.status === 401 && !redirecting) {
            redirecting = true; setAuthNext({page:'tickets'}); location.replace(authLoginUrl());
            throw new Error('برای مشاهده تیکت‌ها وارد حساب شوید.');
        }
        if (!response.ok) {
            const detail = data.detail || {};
            const err = new Error(typeof detail === 'string' ? detail : detail.message || 'انجام این اقدام ممکن نشد. دوباره تلاش کنید.');
            err.code = detail.code; err.reference = response.headers.get('X-Request-ID') || detail.reference || '';
            const seconds = Number(response.headers.get('Retry-After') || detail.retry_after || data.retry_after || 0);
            if (seconds > 0) waits.set(key,Date.now()+seconds*1000);
            throw err;
        }
        return data;
    }
    function badge(status) {
        const item = document.createElement('span'); item.className = 'support-badge'; item.dataset.status = status;
        item.textContent = labels[status] || status; return item;
    }
    function renderList() {
        $('list').replaceChildren(); $('empty').hidden = rows.length !== 0 || loading;
        rows.forEach(ticket => {
            const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button';
            button.classList.toggle('is-selected',ticket.reference === selected && view !== 'create'); button.setAttribute('aria-pressed',String(ticket.reference === selected && view !== 'create'));
            const title = document.createElement('strong'); title.textContent = ticket.subject;
            const when = document.createElement('small'); when.textContent = new Date(ticket.updated_at).toLocaleString('fa-IR');
            button.append(title,when,badge(ticket.status)); button.onclick = () => select(ticket.reference);
            item.append(button); $('list').append(item);
        });
    }
    function upsert(ticket) {
        const index = rows.findIndex(row => row.reference === ticket.reference);
        if (index < 0) rows.unshift(summary(ticket)); else rows[index] = summary(ticket);
        rows.sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at)); renderList();
    }
    function setReplyClosed(closed) {
        ticketClosed = closed;
        $('reply-form').hidden = closed;
        $('reply').disabled = closed;
        $('closed').hidden = !closed;
        $('send').hidden = closed || view !== 'detail';
        $('send').disabled = closed || sending || reading;
    }
    function renderTicket(ticket) {
        setReplyClosed(ticket.status === 'closed');
        setView('detail');
        $('title').textContent = ticket.subject;
        $('status').textContent = labels[ticket.status] || ticket.status; $('status').dataset.status = ticket.status;
        $('messages').replaceChildren();
        (ticket.messages || []).forEach(message => {
            const item = document.createElement('article'); item.className = 'support-message' + (message.author === 'support' ? ' is-support' : '');
            const who = document.createElement('small'); who.textContent = (message.author === 'support' ? 'پشتیبانی' : 'شما') + ' · ' + new Date(message.created_at).toLocaleString('fa-IR');
            const body = document.createElement('p'); body.textContent = message.body;
            item.append(who,body); $('messages').append(item);
        });
        $('messages').scrollTop = $('messages').scrollHeight;
    }
    async function load(more = false) {
        if (more && (loading || !cursor)) return;
        const version = ++listVersion; loading = true; $('loading').hidden = false; $('refresh').disabled = true; $('more').disabled = true; clearError();
        try {
            const data = await request('/api/account/tickets' + (more ? '?cursor=' + encodeURIComponent(cursor) : ''));
            if (version !== listVersion) return;
            rows = more ? rows.concat(data.tickets.filter(ticket => !rows.some(row => row.reference === ticket.reference))) : data.tickets;
            cursor = data.next_cursor; $('more').hidden = !cursor; renderList();
            if (view === 'empty' && !selected) {
                if (rows.length) await select(rows[0].reference);
                else openCreate();
            }
        } catch (err) { if (version === listVersion) error(err); }
        finally {
            if (version === listVersion) { loading = false; $('loading').hidden = true; $('refresh').disabled = false; $('more').disabled = false; renderList(); }
        }
    }
    function allowSwitch() { return !$('reply').value.trim() || window.confirm('پاسخ نوشته‌شده هنوز ارسال نشده است. ادامه می‌دهید؟'); }
    async function select(reference) {
        if (creating || sending || (reference !== selected && !allowSwitch())) return;
        const version = ++detailVersion;
        if (reference !== selected || view !== 'detail') {
            $('reply').value = ''; setView('loading');
            $('placeholder-text').textContent = 'در حال دریافت گفتگو…';
        }
        selected = reference; reading = true; $('send').disabled = true; clearError(); renderList();
        try {
            const ticket = await request('/api/account/tickets/' + encodeURIComponent(reference));
            if (version !== detailVersion) return;
            renderTicket(ticket); upsert(ticket);
            if (window.matchMedia('(max-width:800px)').matches) $('detail').scrollIntoView({block:'start',behavior:'smooth'});
        } catch (err) { if (version === detailVersion) error(err); }
        finally { if (version === detailVersion) { reading = false; $('send').disabled = ticketClosed; } }
    }
    $('new').onclick = openCreate;
    $('cancel').onclick = () => {
        if (creating) return;
        if (selected) select(selected);
        else {
            setView('empty');
            $('placeholder-text').textContent = 'برای مشاهده گفتگو، یک تیکت را انتخاب کنید.';
            renderList();
        }
    };
    $('refresh').onclick = () => load();
    $('more').onclick = () => load(true);
    $('create-form').onsubmit = async event => {
        event.preventDefault(); if (creating || sending || !$('create-form').reportValidity()) return;
        creating = true; $('submit').disabled = true; clearError(); draftReference ||= newTicketReference();
        try {
            const ticket = await request('/api/account/tickets',{method:'POST',body:{reference:draftReference,category:$('category').value,subject:$('subject').value.trim(),message:$('message').value.trim()}});
            draftReference = ''; $('create-form').reset(); $('create').hidden = true;
            selected = ticket.reference; ++detailVersion; reading = false; $('send').disabled = ticketClosed; renderTicket(ticket); upsert(ticket); await load();
            $('detail').scrollIntoView({block:'start',behavior:'smooth'});
        } catch (err) { if (err.code === 'reference-conflict') draftReference = ''; error(err); }
        finally { creating = false; $('submit').disabled = false; }
    };
    $('reply-form').onsubmit = async event => {
        event.preventDefault(); if (!selected || ticketClosed || creating || sending || reading || !$('reply-form').reportValidity()) return;
        const reference = selected; sending = true; $('send').disabled = true; clearError();
        try {
            const ticket = await request('/api/account/tickets/' + encodeURIComponent(reference) + '/reply',{method:'POST',body:{message:$('reply').value.trim()}});
            $('reply').value = ''; renderTicket(ticket); upsert(ticket);
        } catch (err) {
            if (err.code === 'ticket-closed') {
                setReplyClosed(true);
                $('status').textContent = labels.closed; $('status').dataset.status = 'closed';
                const row = rows.find(ticket => ticket.reference === reference);
                if (row) { row.status = 'closed'; renderList(); }
            }
            error(err);
        }
        finally { sending = false; $('send').disabled = ticketClosed; }
    };
    setInterval(() => {
        const seconds = Math.max(0,...Array.from(waits.values(),until => Math.ceil((until-Date.now())/1000)));
        $('wait').hidden = !seconds; $('wait').textContent = seconds ? 'محدودیت موقت برخی اقدامات: ' + seconds + ' ثانیه تا تلاش بعدی.' : '';
    },1000);
    setView('empty');
    load();
})();
