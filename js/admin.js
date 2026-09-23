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
    actions.innerHTML = row.status === 'pending' ? rowActionsHtml(row) : '';
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
        title.textContent = 'پذیرش درخواست';
        text.textContent = 'با پذیرش، حساب «' + displayName(row) + '» ساخته می‌شود و این فرد می‌تواند وارد بخش‌های نیازمند عضویت شود.';
        noteWrap.hidden = true;
        confirm.textContent = 'تأیید پذیرش';
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
        } else if (kind === 'remove-user') {
            await AdminApi.removeUser(id);
            usersState.rows = usersState.rows.filter(item => !sameId(item.id, id));
            usersState.selectedId = null;
            usersState.detail = null;
            showNotice('حساب حذف شد.', 'ok');
            renderUsers();
        } else {
            const row = await AdminApi.reject(id, note);
            const idx = state.rows.findIndex(item => sameId(item.id, id));
            if (idx >= 0) state.rows[idx] = row;
            showNotice('درخواست رد شد.', 'ok');
        }
        closeDialog();
        refresh();
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
    const requests = view === 'requests';
    document.getElementById('view-requests').hidden = !requests;
    document.getElementById('view-users').hidden = requests;
    document.getElementById('admin-title').textContent = requests ? 'درخواست‌های عضویت' : 'حساب‌ها و عکس‌ها';
    document.getElementById('admin-lead').textContent = requests
        ? 'درخواست‌های ثبت‌نام را بررسی کنید. پذیرش، حساب را می‌سازد؛ رد، فقط پرونده را می‌بندد.'
        : 'عکس هر حساب را ببینید، دانلود کنید یا حذف کنید. سابقهٔ ویرایش پروفایل هم اینجاست.';
    document.querySelectorAll('.admin-view-tab').forEach(btn => {
        const on = btn.dataset.view === view;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
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
    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.addEventListener('click', () => setFilter(btn.dataset.filter));
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
    document.getElementById('user-delete-btn').addEventListener('click', () => {
        if (usersState.detail) openDialog('remove-user', usersState.detail);
    });
}

onReady(async () => {
    bind();
    try {
        await loadRows();
    } catch (err) {
        showNotice('بارگذاری فهرست ممکن نشد.');
    }
});
