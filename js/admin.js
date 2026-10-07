// File: admin.js
// Purpose: Membership-request inbox for the admin control panel.
//   AdminApi talks to /api/admin/requests.

const STATUS = {
    pending: { label: 'در انتظار', emptyTitle: 'درخواست معلقی نیست', emptyText: 'وقتی کسی فرم عضویت را بفرستد، اینجا دیده می‌شود.' },
    approved: { label: 'پذیرفته', emptyTitle: 'پذیرش ثبت‌شده‌ای نیست', emptyText: 'پس از پذیرش، حساب در این فهرست می‌ماند.' },
    rejected: { label: 'رد شده', emptyTitle: 'رد ثبت‌شده‌ای نیست', emptyText: 'درخواست‌های ردشده برای سابقه اینجا می‌مانند.' },
    all: { label: 'همه', emptyTitle: 'درخواستی نیست', emptyText: 'هنوز پرونده‌ای برای بررسی نیامده است.' }
};

function sameId(a, b) {
    return String(a) === String(b);
}

function displayName(row) {
    const parts = [row && row.first_name, row && row.last_name].filter(Boolean);
    return parts.join(' ') || '';
}

function normalizePhone(raw) {
    return digitsOnlyPhone(raw);
}

async function adminFetch(path, options) {
    const response = await fetch(`${API_BASE_URL}${path}`, Object.assign({ credentials: 'include' }, options || {}));
    if (response.status === 401 || response.status === 403) {
        window.location.href = SITE.page('index.html') + '#auth';
        throw new Error('auth');
    }
    let data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok) {
        const detail = data && data.detail;
        const message = (detail && detail.message) || (typeof detail === 'string' ? detail : 'انجام این اقدام ممکن نشد.');
        const err = new Error(message);
        err.detail = detail;
        throw err;
    }
    return data;
}

const AdminApi = {
    list() {
        return adminFetch('/api/admin/requests');
    },
    approve(id) {
        return adminFetch('/api/admin/requests/' + encodeURIComponent(id) + '/approve', { method: 'POST' });
    },
    reject(id, note) {
        return adminFetch('/api/admin/requests/' + encodeURIComponent(id) + '/reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: note || '' })
        });
    },
    users() {
        return adminFetch('/api/admin/users');
    },
    user(id) {
        return adminFetch('/api/admin/users/' + encodeURIComponent(id));
    },
    removeAvatar(id) {
        return adminFetch('/api/admin/users/' + encodeURIComponent(id) + '/avatar', { method: 'DELETE' });
    },
    removeUser(id) {
        return adminFetch('/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    setUserActive(id, active) {
        return adminFetch('/api/admin/users/' + encodeURIComponent(id) + '/active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: !!active })
        });
    },
    ops() {
        return adminFetch('/api/admin/ops');
    },
    setRegistration(open) {
        return adminFetch('/api/admin/ops/registration', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ open: !!open })
        });
    },
    async exportRequests() {
        const response = await fetch(`${API_BASE_URL}/api/admin/requests/export`, { credentials: 'include' });
        if (response.status === 401 || response.status === 403) {
            window.location.href = SITE.page('index.html') + '#auth';
            throw new Error('auth');
        }
        if (!response.ok) throw new Error('دانلود اکسل ممکن نشد.');
        return response.blob();
    }
}

const CHANGE_LABELS = {
    first_name: 'نام',
    last_name: 'نام خانوادگی',
    role_title: 'سمت',
    organization: 'سازمان',
    birth_date: 'تاریخ تولد',
    email: 'ایمیل',
    address: 'نشانی',
    avatar_path: 'عکس'
};

const opsState = { range: 'weekly', trend: {}, chart: null };

const usersState = {
    rows: [],
    selectedId: null,
    detail: null,
    filters: { first_name: '', last_name: '', phone: '' }
};

const state = {
    filter: 'pending',
    filters: {
        first_name: '',
        last_name: '',
        phone: '',
        role_title: '',
        organization: ''
    },
    selectedId: null,
    rows: [],
    busy: false
};

function formatWhen(iso) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '—';
    const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (minutes < 1) return 'همین الان';
    if (minutes < 60) return toFa(minutes) + ' دقیقه پیش';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return toFa(hours) + ' ساعت پیش';
    const days = Math.round(hours / 24);
    return toFa(days) + ' روز پیش';
}

function counts(rows) {
    return rows.reduce((acc, row) => {
        acc[row.status] += 1;
        return acc;
    }, { pending: 0, approved: 0, rejected: 0 });
}

function hasFieldFilters() {
    return Object.values(state.filters).some(value => String(value || '').trim());
}

function includesText(value, query) {
    if (!query) return true;
    return String(value || '').includes(query);
}

function includesPhone(value, query) {
    if (!query) return true;
    const needle = normalizePhone(query);
    const hay = normalizePhone(value);
    if (needle && hay.includes(needle)) return true;
    return String(value || '').includes(query);
}

function visibleRows() {
    const f = state.filters;
    return state.rows.filter(row => {
        if (state.filter !== 'all' && row.status !== state.filter) return false;
        if (!includesText(row.first_name, f.first_name)) return false;
        if (!includesText(row.last_name, f.last_name)) return false;
        if (!includesPhone(row.phone, f.phone)) return false;
        if (!includesText(row.role_title, f.role_title)) return false;
        if (!includesText(row.organization, f.organization)) return false;
        return true;
    });
}

function selectedRow() {
    return state.rows.find(row => sameId(row.id, state.selectedId)) || null;
}

function badgeHtml(status) {
    const meta = STATUS[status] || STATUS.pending;
    return '<span class="admin-badge is-' + status + '">' + escapeHtml(meta.label) + '</span>';
}

function renderStats() {
    const c = counts(state.rows);
    document.getElementById('stat-pending').textContent = toFa(c.pending);
    document.getElementById('stat-approved').textContent = toFa(c.approved);
    document.getElementById('stat-rejected').textContent = toFa(c.rejected);
}

function renderTable() {
    const tbody = document.getElementById('admin-tbody');
    const empty = document.getElementById('admin-empty');
    const rows = visibleRows();
    tbody.replaceChildren();

    if (!rows.length) {
        if (hasFieldFilters()) {
            document.getElementById('admin-empty-title').textContent = 'نتیجه‌ای پیدا نشد';
            document.getElementById('admin-empty-text').textContent = 'فیلترها را تغییر دهید یا پاک کنید.';
        } else {
            const meta = STATUS[state.filter] || STATUS.all;
            document.getElementById('admin-empty-title').textContent = meta.emptyTitle;
            document.getElementById('admin-empty-text').textContent = meta.emptyText;
        }
        empty.hidden = false;
        return;
    }

    empty.hidden = true;
    const frag = document.createDocumentFragment();
    rows.forEach(row => {
        const tr = document.createElement('tr');
        tr.dataset.id = row.id;
        if (sameId(row.id, state.selectedId)) tr.classList.add('is-selected');
        tr.innerHTML =
            '<td><div class="admin-name">' + escapeHtml(displayName(row)) + '</div></td>' +
            '<td><span class="admin-phone">' + escapeHtml(row.phone) + '</span></td>' +
            '<td>' + escapeHtml(row.role_title || '—') + '</td>' +
            '<td>' + escapeHtml(formatWhen(row.created_at)) + '</td>' +
            '<td>' + badgeHtml(row.status) + '</td>' +
            '<td class="admin-row-actions">' + rowActionsHtml(row) + '</td>';
        frag.appendChild(tr);
    });
    tbody.appendChild(frag);
}

function rowActionsHtml(row) {
    if (row.status === 'rejected') {
        return '<button type="button" class="admin-btn admin-btn-primary" data-act="approve" data-id="' + escapeHtml(row.id) + '">پذیرش</button>';
    }
    if (row.status !== 'pending') return '';
    return (
        '<button type="button" class="admin-btn admin-btn-primary" data-act="approve" data-id="' + escapeHtml(row.id) + '">پذیرش</button>' +
        '<button type="button" class="admin-btn admin-btn-danger" data-act="reject" data-id="' + escapeHtml(row.id) + '">رد</button>'
    );
}

function renderDetail() {
    const pane = document.getElementById('admin-detail');
    const row = selectedRow();
    if (!row) {
        pane.hidden = true;
        return;
    }
    pane.hidden = false;
    document.getElementById('detail-name').textContent = displayName(row);
    document.getElementById('detail-first').textContent = row.first_name || '—';
    document.getElementById('detail-last').textContent = row.last_name || '—';
    document.getElementById('detail-status-wrap').innerHTML = badgeHtml(row.status);
    document.getElementById('detail-phone').textContent = row.phone;
    document.getElementById('detail-role').textContent = row.role_title || '—';
    document.getElementById('detail-org').textContent = row.organization || '—';
    document.getElementById('detail-when').textContent = formatWhen(row.created_at);
    const noteRow = document.getElementById('detail-note-row');
    if (row.note) {
        noteRow.hidden = false;
        document.getElementById('detail-note').textContent = row.note;
    } else {
        noteRow.hidden = true;
        document.getElementById('detail-note').textContent = '';
    }
    const actions = document.getElementById('detail-actions');
    actions.innerHTML = (row.status === 'pending' || row.status === 'rejected') ? rowActionsHtml(row) : '';
}

function renderFilterClear() {
    const btn = document.getElementById('admin-filters-clear');
    if (btn) btn.hidden = !hasFieldFilters();
}

function refresh() {
    renderStats();
    renderFilterClear();
    renderTable();
    renderDetail();
}

async function loadRows() {
    state.rows = await AdminApi.list();
    if (state.selectedId && !state.rows.some(row => sameId(row.id, state.selectedId))) {
        state.selectedId = null;
    }
    refresh();
}

function setFilter(filter) {
    state.filter = filter;
    document.querySelectorAll('.admin-tab').forEach(btn => {
        const on = btn.dataset.filter === filter;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    refresh();
}

function openDialog(kind, row) {
    const root = document.getElementById('admin-dialog-root');
    const title = document.getElementById('dialog-title');
    const text = document.getElementById('dialog-text');
    const noteWrap = document.getElementById('dialog-note-wrap');
    const note = document.getElementById('dialog-note');
    const confirm = document.getElementById('dialog-confirm');
    root.dataset.kind = kind;
    root.dataset.id = row.id;
    note.value = '';
    if (kind === 'approve') {
        title.textContent = row.status === 'rejected' ? 'پذیرش درخواست ردشده' : 'پذیرش درخواست';
        text.textContent = row.status === 'rejected'
            ? 'این پرونده قبلاً رد شده است. با پذیرش، حساب «' + displayName(row) + '» ساخته می‌شود و می‌تواند وارد شود.'
            : 'با پذیرش، حساب «' + displayName(row) + '» ساخته می‌شود و این فرد می‌تواند وارد بخش‌های نیازمند عضویت شود.';
        noteWrap.hidden = true;
        confirm.textContent = 'تأیید پذیرش';
        confirm.className = 'admin-btn admin-btn-primary';
    } else if (kind === 'deactivate') {
        title.textContent = 'غیرفعال کردن حساب';
        text.textContent = 'حساب «' + displayName(row) + '» موقتاً بسته می‌شود. ورود قطع می‌شود و بعداً می‌توان دوباره فعالش کرد.';
        noteWrap.hidden = true;
        confirm.textContent = 'غیرفعال کردن';
        confirm.className = 'admin-btn admin-btn-danger';
    } else if (kind === 'activate') {
        title.textContent = 'فعال کردن حساب';
        text.textContent = 'حساب «' + displayName(row) + '» دوباره فعال می‌شود و می‌تواند وارد شود.';
        noteWrap.hidden = true;
        confirm.textContent = 'فعال کردن';
        confirm.className = 'admin-btn admin-btn-primary';
    } else if (kind === 'remove-avatar') {
        title.textContent = 'حذف عکس';
        text.textContent = 'عکس حساب «' + displayName(row) + '» از پرونده و از پوشهٔ عکس‌ها حذف می‌شود.';
        noteWrap.hidden = true;
        confirm.textContent = 'حذف عکس';
        confirm.className = 'admin-btn admin-btn-danger';
    } else if (kind === 'remove-user') {
        title.textContent = 'حذف حساب';
        text.textContent = 'حساب «' + displayName(row) + '» برای همیشه حذف می‌شود: ورود، عکس، سابقهٔ ویرایش و درخواست‌های این شماره.';
        noteWrap.hidden = true;
        confirm.textContent = 'حذف حساب';
        confirm.className = 'admin-btn admin-btn-danger';
    } else {
        title.textContent = 'رد درخواست';
        text.textContent = 'درخواست «' + displayName(row) + '» رد می‌شود و حسابی ساخته نمی‌شود.';
        noteWrap.hidden = false;
        confirm.textContent = 'تأیید رد';
        confirm.className = 'admin-btn admin-btn-danger';
    }
    root.hidden = false;
    confirm.focus();
}

function closeDialog() {
    const root = document.getElementById('admin-dialog-root');
    root.hidden = true;
    root.dataset.kind = '';
    root.dataset.id = '';
}

async function confirmDialog() {
    if (state.busy) return;
    const root = document.getElementById('admin-dialog-root');
    const id = root.dataset.id;
    const kind = root.dataset.kind;
    const note = document.getElementById('dialog-note').value;
    if (kind === 'reject' && plainTextError(note)) {
        showNotice(plainTextError(note));
        return;
    }
    const confirm = document.getElementById('dialog-confirm');
    state.busy = true;
    confirm.disabled = true;
    try {
        if (kind === 'approve') {
            const row = await AdminApi.approve(id);
            const idx = state.rows.findIndex(item => sameId(item.id, id));
            if (idx >= 0) state.rows[idx] = row;
            showNotice('حساب ساخته شد و درخواست پذیرفته شد.', 'ok');
        } else if (kind === 'remove-avatar') {
            const profile = await AdminApi.removeAvatar(id);
            const idx = usersState.rows.findIndex(item => sameId(item.id, id));
            if (idx >= 0) usersState.rows[idx] = Object.assign({}, usersState.rows[idx], profile);
            if (usersState.detail && sameId(usersState.detail.id, id)) {
                usersState.detail = await AdminApi.user(id);
            }
            showNotice('عکس حذف شد.', 'ok');
            renderUsers();
        } else if (kind === 'deactivate' || kind === 'activate') {
            const profile = await AdminApi.setUserActive(id, kind === 'activate');
            const idx = usersState.rows.findIndex(item => sameId(item.id, id));
            if (idx >= 0) usersState.rows[idx] = Object.assign({}, usersState.rows[idx], profile);
            if (usersState.detail && sameId(usersState.detail.id, id)) {
                usersState.detail = Object.assign({}, usersState.detail, profile);
            }
            showNotice(kind === 'activate' ? 'حساب فعال شد.' : 'حساب غیرفعال شد.', 'ok');
            renderUsers();
        } else if (kind === 'remove-user') {
            await AdminApi.removeUser(id);
            usersState.rows = usersState.rows.filter(item => !sameId(item.id, id));
            usersState.selectedId = null;
            usersState.detail = null;
            showNotice('حساب حذف شد.', 'ok');
            renderUsers();
        } else if (kind === 'reject') {
            const row = await AdminApi.reject(id, note);
            const idx = state.rows.findIndex(item => sameId(item.id, id));
            if (idx >= 0) state.rows[idx] = row;
            showNotice('درخواست رد شد.', 'ok');
        } else {
            throw new Error('اقدام نامعتبر است.');
        }
        closeDialog();
        if (kind === 'approve' || kind === 'reject') refresh();
    } catch (err) {
        showNotice((err && err.message && err.message !== 'auth') ? err.message : 'انجام این اقدام ممکن نشد.');
    } finally {
        state.busy = false;
        confirm.disabled = false;
    }
}

function visibleUsers() {
    const f = usersState.filters;
    return usersState.rows.filter(row => {
        if (!includesText(row.first_name, f.first_name)) return false;
        if (!includesText(row.last_name, f.last_name)) return false;
        if (!includesPhone(row.phone, f.phone)) return false;
        return true;
    });
}

function hasUserFilters() {
    return Object.values(usersState.filters).some(value => String(value || '').trim());
}

function userThumbHtml(row) {
    if (row.avatar_url) {
        return '<img class="admin-avatar" src="' + escapeHtml(avatarSrc(row.avatar_url)) + '" alt="">';
    }
    return '<span class="admin-avatar is-empty">—</span>';
}

function renderUsersTable() {
    const tbody = document.getElementById('users-tbody');
    const empty = document.getElementById('users-empty');
    if (!tbody) return;
    const rows = visibleUsers();
    tbody.replaceChildren();
    if (!rows.length) {
        document.getElementById('users-empty-title').textContent = hasUserFilters() ? 'نتیجه‌ای پیدا نشد' : 'حسابی نیست';
        document.getElementById('users-empty-text').textContent = hasUserFilters()
            ? 'فیلترها را تغییر دهید یا پاک کنید.'
            : 'پس از پذیرش عضویت، حساب‌ها اینجا دیده می‌شوند.';
        empty.hidden = false;
        return;
    }
    empty.hidden = true;
    const frag = document.createDocumentFragment();
    rows.forEach(row => {
        const tr = document.createElement('tr');
        tr.dataset.userId = row.id;
        if (sameId(row.id, usersState.selectedId)) tr.classList.add('is-selected');
        tr.innerHTML =
            '<td class="admin-avatar-cell">' + userThumbHtml(row) + '</td>' +
            '<td><div class="admin-name">' + escapeHtml(displayName(row)) + '</div></td>' +
            '<td><span class="admin-phone">' + escapeHtml(row.phone || '') + '</span></td>' +
            '<td>' + escapeHtml(row.role_title || '—') + '</td>' +
            '<td>' + (row.is_active === false
                ? '<span class="admin-badge is-rejected">غیرفعال</span>'
                : '<span class="admin-badge is-approved">فعال</span>') + '</td>' +
            '<td>' + (row.avatar_url ? 'دارد' : 'ندارد') + '</td>';
        frag.appendChild(tr);
    });
    tbody.appendChild(frag);
}

function revisionLine(rev) {
    const keys = Object.keys(rev.changes || {});
    const labels = keys.map(key => CHANGE_LABELS[key] || key);
    const who = rev.source === 'admin' ? (rev.actor_name ? 'مدیر — ' + rev.actor_name : 'مدیر') : (rev.actor_name || 'خود کاربر');
    return who + ' · ' + (labels.join('، ') || 'ویرایش');
}

function renderUserDetail() {
    const pane = document.getElementById('user-detail');
    const row = usersState.detail;
    if (!pane) return;
    if (!row) {
        pane.hidden = true;
        return;
    }
    pane.hidden = false;
    document.getElementById('user-detail-name').textContent = displayName(row);
    const statusWrap = document.getElementById('user-detail-status');
    if (statusWrap) {
        statusWrap.innerHTML = row.is_active === false
            ? '<span class="admin-badge is-rejected">غیرفعال</span>'
            : '<span class="admin-badge is-approved">فعال</span>';
    }
    const activeBtn = document.getElementById('user-active-btn');
    if (activeBtn) {
        const inactive = row.is_active === false;
        activeBtn.textContent = inactive ? 'فعال کردن حساب' : 'غیرفعال کردن حساب';
        activeBtn.className = inactive ? 'admin-btn admin-btn-primary' : 'admin-btn admin-btn-danger';
        activeBtn.dataset.act = inactive ? 'activate' : 'deactivate';
    }
    document.getElementById('user-detail-phone').textContent = row.phone || '—';
    document.getElementById('user-detail-role').textContent = row.role_title || '—';
    document.getElementById('user-detail-org').textContent = row.organization || '—';
    const img = document.getElementById('user-photo');
    const empty = document.getElementById('user-photo-empty');
    if (row.avatar_url) {
        img.src = avatarSrc(row.avatar_url);
        img.hidden = false;
        empty.hidden = true;
    } else {
        img.removeAttribute('src');
        img.hidden = true;
        empty.hidden = false;
    }
    const actions = document.getElementById('user-photo-actions');
    actions.replaceChildren();
    if (row.avatar_url) {
        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'admin-btn admin-btn-ghost';
        down.textContent = 'دانلود عکس';
        down.dataset.act = 'download-avatar';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'admin-btn admin-btn-danger';
        remove.textContent = 'حذف عکس';
        remove.dataset.act = 'remove-avatar';
        actions.append(down, remove);
    }
    const list = document.getElementById('user-revisions');
    list.replaceChildren();
    const revisions = row.revisions || [];
    if (!revisions.length) {
        const li = document.createElement('li');
        li.textContent = 'هنوز ویرایشی ثبت نشده است.';
        list.appendChild(li);
        return;
    }
    revisions.forEach(rev => {
        const li = document.createElement('li');
        const when = document.createElement('p');
        when.className = 'admin-revision-when';
        when.textContent = formatWhen(rev.created_at);
        const fields = document.createElement('p');
        fields.className = 'admin-revision-fields';
        fields.textContent = revisionLine(rev);
        li.append(when, fields);
        list.appendChild(li);
    });
}

function renderUsers() {
    const clear = document.getElementById('user-filters-clear');
    if (clear) clear.hidden = !hasUserFilters();
    renderUsersTable();
    renderUserDetail();
}

async function loadUsers() {
    usersState.rows = await AdminApi.users();
    if (usersState.selectedId) {
        try {
            usersState.detail = await AdminApi.user(usersState.selectedId);
        } catch (err) {
            usersState.selectedId = null;
            usersState.detail = null;
        }
    }
    renderUsers();
}

async function selectUser(id) {
    usersState.selectedId = id;
    usersState.detail = await AdminApi.user(id);
    renderUsers();
}

function setAdminView(view) {
    document.getElementById('view-requests').hidden = view !== 'requests';
    document.getElementById('view-users').hidden = view !== 'users';
    const ops = document.getElementById('view-ops');
    if (ops) ops.hidden = view !== 'ops';
    const titles = {
        requests: 'درخواست‌های عضویت',
        users: 'حساب‌ها و عکس‌ها',
        ops: 'وضعیت سامانه'
    };
    const leads = {
        requests: 'درخواست‌های ثبت‌نام را بررسی کنید. پذیرش، حساب را می‌سازد؛ رد را می‌توان بعداً به پذیرش برگرداند.',
        users: 'حساب را موقتاً غیرفعال کنید، یا در صورت نیاز حذف کنید. عکس و سابقهٔ ویرایش هم اینجاست.',
        ops: 'ثبت‌نام عمومی، تعداد کدهای امروز، و خلاصهٔ ورودهای ناموفق.'
    };
    document.getElementById('admin-title').textContent = titles[view] || titles.requests;
    document.getElementById('admin-lead').textContent = leads[view] || leads.requests;
    document.querySelectorAll('.admin-view-tab').forEach(btn => {
        const on = btn.dataset.view === view;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
}

function renderOps(data) {
    if (!data) return;
    const open = data.registration_open !== false;
    const stateEl = document.getElementById('reg-state');
    const toggle = document.getElementById('reg-toggle');
    if (stateEl) stateEl.textContent = open ? 'ثبت‌نام عمومی باز است.' : 'ثبت‌نام عمومی بسته است.';
    if (toggle) {
        toggle.textContent = open ? 'بستن ثبت‌نام' : 'باز کردن ثبت‌نام';
        toggle.className = open ? 'admin-btn admin-btn-danger' : 'admin-btn admin-btn-primary';
        toggle.dataset.open = open ? '1' : '0';
    }
    const otp = document.getElementById('otp-today');
    if (otp) otp.textContent = toFa(data.otp_sent_today || 0);
    const fails = data.login_failures || {};
    const statsUnavailable = document.getElementById('login-stats-unavailable');
    if (statsUnavailable) statsUnavailable.hidden = data.login_stats_available !== false;
    const today = document.getElementById('fail-today');
    const week = document.getElementById('fail-week');
    if (today) today.textContent = toFa(fails.today || 0);
    if (week) week.textContent = toFa(fails.last_7_days || 0);
    const tbody = document.getElementById('fail-tbody');
    const empty = document.getElementById('fail-empty');
    const recent = fails.recent || [];
    if (tbody) {
        tbody.replaceChildren();
        recent.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(formatWhen(row.when)) + '</td>' +
                '<td><span class="admin-phone">' + escapeHtml(row.phone_mask || '') + '</span></td>' +
                '<td>' + escapeHtml(row.reason || '—') + '</td>';
            tbody.appendChild(tr);
        });
    }
    if (empty) empty.hidden = recent.length > 0;
    opsState.trend = data.login_trend || {};
    renderLoginTrend();
}

function renderLoginTrend() {
    const canvas = document.getElementById('login-trend-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const pack = (opsState.trend && opsState.trend[opsState.range]) || { labels: [], total: [], success: [], fail: [] };
    const labels = (pack.labels || []).map(toFa);
    const totals = pack.total && pack.total.length
        ? pack.total
        : (pack.success || []).map((n, i) => Number(n || 0) + Number((pack.fail || [])[i] || 0));
    const maxVal = totals.reduce((m, n) => Math.max(m, Number(n) || 0), 0);
    const payload = {
        labels: labels,
        datasets: [
            {
                label: 'ورود',
                data: totals,
                backgroundColor: '#515811',
                borderColor: '#515811',
                borderRadius: 4,
                maxBarThickness: 28
            }
        ]
    };
    const yScale = {
        beginAtZero: true,
        suggestedMax: Math.max(4, maxVal),
        ticks: { precision: 0, stepSize: 1, font: { family: 'PeydaFaNumWeb', size: 11 } },
        title: { display: true, text: 'تعداد ورود', font: { family: 'PeydaFaNumWeb', size: 12 } }
    };
    const xScale = {
        ticks: { font: { family: 'PeydaFaNumWeb', size: 11 }, maxRotation: 0 },
        grid: { display: false },
        title: { display: true, text: 'زمان', font: { family: 'PeydaFaNumWeb', size: 12 } }
    };
    if (opsState.chart) {
        opsState.chart.data = payload;
        opsState.chart.options.scales.y.suggestedMax = yScale.suggestedMax;
        opsState.chart.update();
        requestAnimationFrame(() => { try { opsState.chart.resize(); } catch (e) {} });
        return;
    }
    opsState.chart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: payload,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: { x: xScale, y: yScale }
        }
    });
    requestAnimationFrame(() => { try { opsState.chart.resize(); } catch (e) {} });
}

async function loadOps() {
    const data = await AdminApi.ops();
    renderOps(data);
    return data;
}

async function downloadUserAvatar(row) {
    const response = await fetch(`${API_BASE_URL}/api/admin/users/${encodeURIComponent(row.id)}/avatar`, {
        credentials: 'include'
    });
    if (!response.ok) {
        showNotice('دانلود عکس ممکن نشد.');
        return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (displayName(row) || 'avatar') + '.webp';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function bind() {
    bindPhoneInput(document.getElementById('filter-phone'));
    bindPhoneInput(document.getElementById('user-filter-phone'));
    document.querySelectorAll('#view-requests .admin-tab').forEach(btn => {
        btn.addEventListener('click', () => setFilter(btn.dataset.filter));
    });
    const exportBtn = document.getElementById('requests-export');
    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            try {
                const blob = await AdminApi.exportRequests();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'membership-requests.xlsx';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (err) {
                if (err.message !== 'auth') showNotice(err.message || 'دانلود اکسل ممکن نشد.');
            }
        });
    }
    document.querySelectorAll('#view-ops [data-trend]').forEach(btn => {
        btn.addEventListener('click', () => {
            opsState.range = btn.dataset.trend || 'weekly';
            document.querySelectorAll('#view-ops [data-trend]').forEach(item => {
                const on = item.dataset.trend === opsState.range;
                item.classList.toggle('is-active', on);
            });
            renderLoginTrend();
        });
    });

    document.getElementById('admin-filters').addEventListener('input', event => {
        const field = event.target.dataset.filterField;
        if (!field || !(field in state.filters)) return;
        state.filters[field] = event.target.value.trim();
        refresh();
    });

    document.getElementById('admin-filters-clear').addEventListener('click', () => {
        Object.keys(state.filters).forEach(key => {
            state.filters[key] = '';
            const input = document.getElementById('filter-' + key);
            if (input) input.value = '';
        });
        refresh();
    });

    document.getElementById('admin-tbody').addEventListener('click', event => {
        const act = event.target.closest('[data-act]');
        if (act) {
            event.stopPropagation();
            const row = state.rows.find(item => sameId(item.id, act.dataset.id));
            if (row) openDialog(act.dataset.act, row);
            return;
        }
        const tr = event.target.closest('tr[data-id]');
        if (!tr) return;
        state.selectedId = tr.dataset.id;
        refresh();
    });

    document.getElementById('detail-actions').addEventListener('click', event => {
        const act = event.target.closest('[data-act]');
        if (!act) return;
        const row = state.rows.find(item => sameId(item.id, act.dataset.id));
        if (row) openDialog(act.dataset.act, row);
    });

    document.getElementById('admin-detail-close').addEventListener('click', () => {
        state.selectedId = null;
        refresh();
    });

    document.getElementById('dialog-cancel').addEventListener('click', closeDialog);
    document.getElementById('dialog-confirm').addEventListener('click', confirmDialog);
    document.getElementById('admin-dialog-root').addEventListener('click', event => {
        if (event.target.hasAttribute('data-dialog-dismiss')) closeDialog();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeDialog();
    });

    document.querySelectorAll('.admin-view-tab').forEach(btn => {
        btn.addEventListener('click', async () => {
            setAdminView(btn.dataset.view);
            if (btn.dataset.view === 'users' && !usersState.rows.length) {
                try { await loadUsers(); } catch (err) { showNotice('بارگذاری حساب‌ها ممکن نشد.'); }
            }
            if (btn.dataset.view === 'ops') {
                try {
                    await loadOps();
                    requestAnimationFrame(() => renderLoginTrend());
                } catch (err) { showNotice('بارگذاری وضعیت سامانه ممکن نشد.'); }
            }
        });
    });

    document.getElementById('user-filters').addEventListener('input', event => {
        const field = event.target.dataset.userFilter;
        if (!field || !(field in usersState.filters)) return;
        usersState.filters[field] = event.target.value.trim();
        renderUsers();
    });
    document.getElementById('user-filters-clear').addEventListener('click', () => {
        Object.keys(usersState.filters).forEach(key => {
            usersState.filters[key] = '';
            const input = document.getElementById('user-filter-' + key);
            if (input) input.value = '';
        });
        renderUsers();
    });
    document.getElementById('users-tbody').addEventListener('click', async event => {
        const tr = event.target.closest('tr[data-user-id]');
        if (!tr) return;
        try { await selectUser(tr.dataset.userId); } catch (err) { showNotice('بارگذاری پرونده ممکن نشد.'); }
    });
    document.getElementById('user-detail-close').addEventListener('click', () => {
        usersState.selectedId = null;
        usersState.detail = null;
        renderUsers();
    });
    document.getElementById('user-photo-actions').addEventListener('click', event => {
        const act = event.target.closest('[data-act]');
        if (!act || !usersState.detail) return;
        if (act.dataset.act === 'download-avatar') {
            downloadUserAvatar(usersState.detail);
            return;
        }
        if (act.dataset.act === 'remove-avatar') {
            openDialog('remove-avatar', usersState.detail);
        }
    });
    const activeBtn = document.getElementById('user-active-btn');
    if (activeBtn) {
        activeBtn.addEventListener('click', () => {
            if (!usersState.detail) return;
            openDialog(usersState.detail.is_active === false ? 'activate' : 'deactivate', usersState.detail);
        });
    }
    const deleteBtn = document.getElementById('user-delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            if (usersState.detail) openDialog('remove-user', usersState.detail);
        });
    }
    const regToggle = document.getElementById('reg-toggle');
    if (regToggle) {
        regToggle.addEventListener('click', async () => {
            const currentlyOpen = regToggle.dataset.open !== '0';
            try {
                const data = await AdminApi.setRegistration(!currentlyOpen);
                const ops = await AdminApi.ops();
                renderOps(Object.assign({}, ops, data));
                showNotice(currentlyOpen ? 'ثبت‌نام بسته شد.' : 'ثبت‌نام باز شد.', 'ok');
            } catch (err) {
                showNotice((err && err.message) || 'تغییر وضعیت ثبت‌نام ممکن نشد.');
            }
        });
    }
}

onReady(async () => {
    bind();
    try {
        await loadRows();
    } catch (err) {
        showNotice('بارگذاری فهرست ممکن نشد.');
    }
});
