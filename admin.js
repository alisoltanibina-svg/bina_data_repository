// File: admin.js
// Purpose: Membership-request inbox for the admin control panel.
//   AdminApi wraps MembershipStore. Replace its methods with fetch() when auth APIs exist.

const STATUS = {
    pending: { label: 'در انتظار', emptyTitle: 'درخواست معلقی نیست', emptyText: 'وقتی کسی فرم عضویت را بفرستد، اینجا دیده می‌شود.' },
    approved: { label: 'پذیرفته', emptyTitle: 'پذیرش ثبت‌شده‌ای نیست', emptyText: 'پس از پذیرش، حساب در این فهرست می‌ماند.' },
    rejected: { label: 'رد شده', emptyTitle: 'رد ثبت‌شده‌ای نیست', emptyText: 'درخواست‌های ردشده برای سابقه اینجا می‌مانند.' },
    all: { label: 'همه', emptyTitle: 'درخواستی نیست', emptyText: 'هنوز پرونده‌ای برای بررسی نیامده است.' }
};

function later(fn) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            try { resolve(fn()); } catch (err) { reject(err); }
        }, 220);
    });
}

const AdminApi = {
    list() {
        return later(() => MembershipStore.list());
    },
    approve(id) {
        return later(() => MembershipStore.approve(id));
    },
    reject(id, note) {
        return later(() => MembershipStore.reject(id, note));
    }
}

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
    const needle = MembershipStore.normalizePhone(query);
    const hay = MembershipStore.normalizePhone(value);
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
    return state.rows.find(row => row.id === state.selectedId) || null;
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
        if (row.id === state.selectedId) tr.classList.add('is-selected');
        tr.innerHTML =
            '<td><div class="admin-name">' + escapeHtml(MembershipStore.displayName(row)) + '</div></td>' +
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
    document.getElementById('detail-name').textContent = MembershipStore.displayName(row);
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
    if (state.selectedId && !state.rows.some(row => row.id === state.selectedId)) {
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
        text.textContent = 'با پذیرش، حساب «' + MembershipStore.displayName(row) + '» ساخته می‌شود و این فرد می‌تواند وارد بخش‌های نیازمند عضویت شود.';
        noteWrap.hidden = true;
        confirm.textContent = 'تأیید پذیرش';
        confirm.className = 'admin-btn admin-btn-primary';
    } else {
        title.textContent = 'رد درخواست';
        text.textContent = 'درخواست «' + MembershipStore.displayName(row) + '» رد می‌شود و حسابی ساخته نمی‌شود.';
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
    const confirm = document.getElementById('dialog-confirm');
    state.busy = true;
    confirm.disabled = true;
    try {
        if (kind === 'approve') {
            const row = await AdminApi.approve(id);
            const idx = state.rows.findIndex(item => item.id === id);
            if (idx >= 0) state.rows[idx] = row;
            showNotice('حساب ساخته شد و درخواست پذیرفته شد.', 'ok');
        } else {
            const row = await AdminApi.reject(id, note);
            const idx = state.rows.findIndex(item => item.id === id);
            if (idx >= 0) state.rows[idx] = row;
            showNotice('درخواست رد شد.', 'ok');
        }
        closeDialog();
        refresh();
    } catch (err) {
        showNotice('انجام این اقدام ممکن نشد.');
    } finally {
        state.busy = false;
        confirm.disabled = false;
    }
}

function bind() {
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
            const row = state.rows.find(item => item.id === act.dataset.id);
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
        const row = state.rows.find(item => item.id === act.dataset.id);
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
}

onReady(async () => {
    bind();
    try {
        await loadRows();
    } catch (err) {
        showNotice('بارگذاری فهرست ممکن نشد.');
    }
});
