// Administrator-only ticket inbox. Never render submitted text as HTML.
(() => {
    const $ = id => document.getElementById(id);
    const labels = {open:'باز',in_progress:'در حال بررسی',awaiting_user:'منتظر کاربر',closed:'بسته شده'};
    const categories = {login:'ورود',register:'ثبت‌نام',reset:'بازیابی رمز',otp:'کد پیامک',account:'حساب',other:'سایر'};
    let rows = [], next = 0, selected = '', selection = 0, loading = false, saving = false;
    function error(err) { $('tickets-error').hidden = false; $('tickets-error').textContent = err.message || 'دریافت تیکت ممکن نشد.'; }
    function renderList() {
        $('tickets-list').replaceChildren();
        $('tickets-empty').hidden = rows.length !== 0;
        rows.forEach(ticket => {
            const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button';
            button.classList.toggle('is-selected',ticket.reference === selected);
            const title = document.createElement('strong'); title.textContent = ticket.subject;
            const meta = document.createElement('small'); meta.textContent = ticket.reference + ' · ' + labels[ticket.status] + ' · ' + new Date(ticket.updated_at).toLocaleString('fa-IR');
            button.append(title,meta); button.onclick = () => select(ticket.reference); item.append(button); $('tickets-list').append(item);
        });
    }
    function render(ticket) {
        $('ticket-detail').hidden = false;
        $('ticket-subject').textContent = ticket.subject;
        $('ticket-context').textContent = [ticket.reference,'موضوع: ' + (categories[ticket.category] || ticket.category), 'نام: ' + (ticket.name || 'ثبت نشده'), 'شماره اعلامی: ' + (ticket.phone || 'ثبت نشده'), 'مرحله: ' + (ticket.stage || '—'), 'کد خطا: ' + (ticket.error_code || '—'), 'مرجع خطا: ' + (ticket.error_reference || '—')].join('\n');
        $('ticket-status').value = ticket.status;
        $('ticket-messages').replaceChildren();
        (ticket.messages || []).forEach(message => {
            const item = document.createElement('article'); item.className = 'support-message ' + (message.author === 'support' ? 'is-support' : '');
            const header = document.createElement('small'); header.textContent = (message.author === 'support' ? 'پشتیبانی' : 'کاربر') + ' · ' + new Date(message.created_at).toLocaleString('fa-IR');
            const body = document.createElement('p'); body.textContent = message.body; item.append(header,body); $('ticket-messages').append(item);
        });
        $('ticket-history').replaceChildren();
        (ticket.status_history || []).forEach(event => {
            const item = document.createElement('li'); item.textContent = new Date(event.created_at).toLocaleString('fa-IR') + ' · ' + (labels[event.from] || '—') + ' ← ' + labels[event.to] + ' · ' + (event.actor_id ? 'مدیر ' + event.actor_id : 'کاربر'); $('ticket-history').append(item);
        });
    }
    async function select(reference) {
        if (saving) return;
        if ($('ticket-reply').value.trim() && reference !== selected && !window.confirm('پاسخ نوشته‌شده هنوز ارسال نشده است. تیکت دیگری باز شود؟')) return;
        const version = ++selection; selected = reference; $('ticket-detail').hidden = true; renderList();
        $('ticket-reply').value = ''; $('tickets-error').hidden = true;
        try { const ticket = await adminFetch('/api/admin/support/tickets/' + encodeURIComponent(reference)); if (version === selection) render(ticket); }
        catch (err) { if (version === selection) error(err); }
    }
    async function load(more = false) {
        if (loading || saving) return;
        loading = true; $('tickets-refresh').disabled = true; $('tickets-more').disabled = true; $('tickets-error').hidden = true;
        try {
            const data = await adminFetch('/api/admin/support/tickets?status=' + encodeURIComponent($('tickets-filter').value) + '&offset=' + (more ? next : 0));
            rows = more ? rows.concat(data.tickets.filter(ticket => !rows.some(row => row.reference === ticket.reference))) : data.tickets;
            next = data.next_offset; $('tickets-more').hidden = !data.has_more; renderList();
        } catch (err) { error(err); }
        finally { loading = false; $('tickets-refresh').disabled = false; $('tickets-more').disabled = false; }
    }
    function bind() {
        $('tickets-refresh').onclick = () => load();
        $('tickets-more').onclick = () => load(true);
        $('tickets-filter').onchange = () => load();
        $('ticket-update-form').onsubmit = async event => {
            event.preventDefault(); if (!selected || saving) return;
            saving = true; $('ticket-save').disabled = true; $('tickets-error').hidden = true;
            try {
                const ticket = await adminFetch('/api/admin/support/tickets/' + encodeURIComponent(selected),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:$('ticket-status').value,message:$('ticket-reply').value.trim()})});
                render(ticket); $('ticket-reply').value = '';
                const index = rows.findIndex(row => row.reference === selected); if (index >= 0) rows[index] = ticket; renderList();
            } catch (err) { error(err); }
            finally { saving = false; $('ticket-save').disabled = false; }
        };
    }
    window.AdminSupport = {bind,load};
})();
