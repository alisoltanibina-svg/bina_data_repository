// File: membership-store.js
// Purpose: Shared browser store for membership requests until auth APIs exist.
//   Used by register.js (submit) and admin.js (list / approve / reject).

(function (global) {
    const KEY = 'bina.membership.requests';

    function hoursAgo(hours) {
        return new Date(Date.now() - hours * 3600 * 1000).toISOString();
    }

    function seedRows() {
        return [
            { id: 'r1', first_name: 'سارا', last_name: 'محمدی', phone: '09121234567', role_title: 'پژوهشگر', organization: 'مرکز رصد فرهنگی', status: 'pending', created_at: hoursAgo(2), note: '' },
            { id: 'r2', first_name: 'حسین', last_name: 'رضایی', phone: '09139876543', role_title: 'کارشناس استان', organization: 'اداره کل تبلیغات اصفهان', status: 'pending', created_at: hoursAgo(8), note: '' },
            { id: 'r3', first_name: 'فاطمه', last_name: 'کریمی', phone: '09351230011', role_title: 'تحلیل‌گر داده', organization: 'دانشگاه تهران', status: 'pending', created_at: hoursAgo(26), note: '' },
            { id: 'r4', first_name: 'مهدی', last_name: 'نوری', phone: '09107770022', role_title: 'مدیر واحد', organization: 'سازمان تبلیغات اسلامی', status: 'approved', created_at: hoursAgo(50), note: '' },
            { id: 'r5', first_name: 'زهرا', last_name: 'احمدی', phone: '09215550123', role_title: 'دانشجو', organization: '', status: 'rejected', created_at: hoursAgo(70), note: 'عضویت برای این نقش در این مرحله فعال نیست.' }
        ];
    }

    function displayName(row) {
        const parts = [row && row.first_name, row && row.last_name].filter(Boolean);
        if (parts.length) return parts.join(' ');
        return String((row && row.full_name) || '').trim();
    }

    function normalizeRow(row) {
        if (!row) return row;
        if (row.first_name || row.last_name) {
            return { ...row, full_name: displayName(row) };
        }
        const parts = String(row.full_name || '').trim().split(/\s+/).filter(Boolean);
        const first_name = parts[0] || '';
        const last_name = parts.slice(1).join(' ');
        return { ...row, first_name, last_name, full_name: displayName({ first_name, last_name, full_name: row.full_name }) };
    }

    function clone(rows) {
        return (rows || []).map(row => normalizeRow({ ...row }));
    }

    function load() {
        try {
            const raw = localStorage.getItem(KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return parsed.map(normalizeRow);
            }
        } catch (e) {}
        const seed = seedRows();
        save(seed);
        return seed;
    }

    function save(rows) {
        localStorage.setItem(KEY, JSON.stringify(rows));
    }

    function fail(code) {
        const err = new Error(code);
        err.code = code;
        throw err;
    }

    function normalizePhone(raw) {
        let s = String(raw || '');
        s = s.replace(/[۰-۹]/g, d => '0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)]);
        s = s.replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)]);
        s = s.replace(/[\s-]/g, '');
        if (s.startsWith('+98')) s = '0' + s.slice(3);
        if (s.startsWith('0098')) s = '0' + s.slice(4);
        if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
        return s;
    }

    function isMobilePhone(phone) {
        return /^09\d{9}$/.test(phone);
    }

    function list() {
        return clone(load());
    }

    function submit(payload) {
        const first_name = String(payload.first_name || '').trim();
        const last_name = String(payload.last_name || '').trim();
        const role_title = String(payload.role_title || '').trim();
        const organization = String(payload.organization || '').trim();
        const phone = normalizePhone(payload.phone);
        if (first_name.length < 2) fail('first_name');
        if (last_name.length < 2) fail('last_name');
        if (!isMobilePhone(phone)) fail('phone');
        if (!role_title) fail('role');
        const rows = load();
        const existing = rows.find(row => row.phone === phone && (row.status === 'pending' || row.status === 'approved'));
        if (existing) fail(existing.status === 'pending' ? 'pending' : 'exists');
        const row = {
            id: 'r' + Date.now().toString(36),
            first_name,
            last_name,
            full_name: displayName({ first_name, last_name }),
            phone,
            role_title,
            organization,
            status: 'pending',
            created_at: new Date().toISOString(),
            note: ''
        };
        rows.unshift(row);
        save(rows);
        return { ...row };
    }

    function approve(id) {
        const rows = load();
        const row = rows.find(item => item.id === id);
        if (!row) fail('not-found');
        if (row.status !== 'pending') fail('not-pending');
        row.status = 'approved';
        row.reviewed_at = new Date().toISOString();
        save(rows);
        return { ...row };
    }

    function reject(id, note) {
        const rows = load();
        const row = rows.find(item => item.id === id);
        if (!row) fail('not-found');
        if (row.status !== 'pending') fail('not-pending');
        row.status = 'rejected';
        row.note = String(note || '').trim();
        row.reviewed_at = new Date().toISOString();
        save(rows);
        return { ...row };
    }

    global.MembershipStore = {
        list,
        submit,
        approve,
        reject,
        displayName,
        normalizePhone,
        isMobilePhone
    };
})(typeof window !== 'undefined' ? window : this);
