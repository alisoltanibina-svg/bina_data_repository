// File: auth.js
// Purpose: Banner user-menu, session profile, and logout through /api/auth.

(function initUserLogoutMenu() {
    function apiBase() {
        return typeof API_BASE_URL === 'string' ? API_BASE_URL : '';
    }

    function displayName(profile) {
        return [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
    }

    function roleLine(profile) {
        const role = (profile.role_title || (profile.is_admin ? 'مدیر' : '')).trim();
        const org = (profile.organization || '').trim();
        if (role && org) return role + ' ' + org;
        return role || org;
    }

    let signedIn = false;
    let profileReady = false;

    function applyProfile(profile) {
        profileReady = true;
        signedIn = !!profile;
        const authBtn = document.getElementById('banner-auth-btn');
        const texts = document.getElementById('user-texts');
        const nameEl = document.querySelector('.user-name');
        const roleEl = document.querySelector('.user-role');
        const box = document.getElementById('user-box') || document.querySelector('.user-box');
        const adminLink = document.getElementById('btn-admin-panel');
        if (adminLink) adminLink.hidden = !(profile && profile.is_admin === true);
        writeBannerProfile(profile || null);
        const loginBtn = document.getElementById('btn-open-login');
        const profileBtn = document.getElementById('btn-open-profile');
        if (loginBtn) loginBtn.hidden = !!profile;
        if (profileBtn) profileBtn.hidden = !profile;
        if (profile) {
            if (authBtn) authBtn.hidden = true;
            if (texts) texts.hidden = false;
            if (box) box.classList.add('is-signed-in');
            const name = displayName(profile);
            if (nameEl) nameEl.textContent = name;
            if (roleEl) roleEl.textContent = roleLine(profile);
            applyBannerAvatar(profile.avatar_url);
            if (
                typeof window.closeCurtainAuth === 'function'
                && document.documentElement.classList.contains('curtain-auth')
                && !document.documentElement.classList.contains('curtain-profile')
            ) {
                window.closeCurtainAuth();
            }
            return;
        }
        if (authBtn) authBtn.hidden = false;
        if (texts) texts.hidden = true;
        if (box) box.classList.remove('is-signed-in');
        if (nameEl) nameEl.textContent = '';
        if (roleEl) roleEl.textContent = '';
        applyBannerAvatar('');
    }

    function loadProfile() {
        fetch(apiBase() + '/api/auth/me', { credentials: 'include' })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (profile) { applyProfile(profile); })
            .catch(function () { applyProfile(null); });
    }

    function clearLocalSession() {
        writeBannerProfile(null);
        sessionStorage.removeItem('atlasSelectedTopic');
        sessionStorage.removeItem('atlasSelectedProvince');
        sessionStorage.removeItem('welcomeShown');
        sessionStorage.removeItem('themeBannerBg');
        sessionStorage.removeItem('themeTopicAccent');
        sessionStorage.removeItem('atlasThemeBannerBg');
        sessionStorage.removeItem('atlasThemeTopicAccent');
    }

    function logout() {
        const done = function () {
            clearLocalSession();
            window.location.replace(SITE.page('index.html'));
        };
        fetch(apiBase() + '/api/auth/logout', { method: 'POST', credentials: 'include' })
            .catch(function () {})
            .then(done);
    }

    function isIndexPage() {
        const name = (window.location.pathname.split('/').pop() || '').toLowerCase();
        return name === '' || name === 'index.html';
    }

    function snapshotAppTheme() {
        try {
            const root = document.documentElement;
            const inlineAc = root.style.getPropertyValue('--topic-accent').trim();
            const cs = getComputedStyle(root);
            const ac = inlineAc || cs.getPropertyValue('--topic-accent').trim();
            if (ac) sessionStorage.setItem('themeTopicAccent', ac);
        } catch (e) {}
    }

    function setupLogoHome() {
        const logo = document.getElementById('logo-img');
        if (!logo || isIndexPage()) return;
        logo.addEventListener('click', function () {
            snapshotAppTheme();
            window.location.href = SITE.page('index.html?curtain=1');
        });
    }

    function setup() {
        setupLogoHome();
        applyProfile(readBannerProfile());
        loadProfile();
        window.addEventListener('pageshow', function () {
            loadProfile();
        });
        window.addEventListener('bina-session-changed', loadProfile);
        const btn = document.getElementById('user-menu-btn');
        const menu = document.getElementById('user-menu-dropdown');
        const logoutBtn = document.getElementById('btn-logout');
        if (!btn || !menu || !logoutBtn) return;

        function closeMenu() {
            menu.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
            btn.classList.remove('is-open');
        }

        function toggleMenu(event) {
            event.stopPropagation();
            if (!profileReady) return;
            if (!signedIn) {
                if (typeof window.openCurtainAuth === 'function' && isIndexPage()) {
                    if (document.documentElement.classList.contains('atlas-view') && typeof window.setAtlasView === 'function') {
                        window.setAtlasView(false);
                    }
                    window.openCurtainAuth();
                    return;
                }
                window.location.href = SITE.page('index.html') + '#auth';
                return;
            }
            if (menu.hidden) {
                menu.hidden = false;
                btn.setAttribute('aria-expanded', 'true');
                btn.classList.add('is-open');
            } else {
                closeMenu();
            }
        }

        btn.addEventListener('click', toggleMenu);
        logoutBtn.addEventListener('click', function (event) {
            event.stopPropagation();
            logout();
        });
        document.addEventListener('click', closeMenu);
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') closeMenu();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
})();
