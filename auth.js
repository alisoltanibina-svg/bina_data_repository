// File: auth.js
// Purpose: Banner user-menu toggle and logout. Login is not required; خروج
//   clears local session keys and returns to the curtain home.

(function initUserLogoutMenu() {
    function logout() {
        sessionStorage.removeItem('atlasSelectedTopic');
        sessionStorage.removeItem('atlasSelectedProvince');
        sessionStorage.removeItem('welcomeShown');
        sessionStorage.removeItem('themeBannerBg');
        sessionStorage.removeItem('themeTopicAccent');
        sessionStorage.removeItem('atlasThemeBannerBg');
        sessionStorage.removeItem('atlasThemeTopicAccent');
        window.location.replace('index.html');
    }

    function isIndexPage() {
        const name = (window.location.pathname.split('/').pop() || '').toLowerCase();
        return name === '' || name === 'index.html';
    }

    function snapshotAppTheme() {
        try {
            const root = document.documentElement;
            const inlineBg = root.style.getPropertyValue('--banner-bg').trim();
            const inlineAc = root.style.getPropertyValue('--topic-accent').trim();
            const cs = getComputedStyle(root);
            const bg = inlineBg || cs.getPropertyValue('--banner-bg').trim();
            const ac = inlineAc || cs.getPropertyValue('--topic-accent').trim();
            if (bg) sessionStorage.setItem('themeBannerBg', bg);
            if (ac) sessionStorage.setItem('themeTopicAccent', ac);
        } catch (e) {}
    }

    function setupLogoHome() {
        const logo = document.getElementById('logo-img');
        if (!logo || isIndexPage()) return;
        logo.addEventListener('click', function () {
            snapshotAppTheme();
            window.location.href = 'index.html?curtain=1';
        });
    }

    function setup() {
        setupLogoHome();
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
