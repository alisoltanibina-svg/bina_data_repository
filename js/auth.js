// File: auth.js
// Purpose: Banner user-menu, session profile, and logout through /api/auth.

(function initUserLogoutMenu() {
    function apiBase() {
        return typeof API_BASE_URL === 'string' ? API_BASE_URL : '';
    }

    function pageFile(url) {
        try {
            let path = new URL(url, location.href).pathname || '';
            path = path.replace(/\/+$/, '');
            let name = (path.split('/').pop() || '').toLowerCase();
            if (!name || name === 'index' || name === 'index.html') return 'index.html';
            if (name.slice(-5) !== '.html') name += '.html';
            return name;
        } catch (e) {
            return '';
        }
    }

    function currentPageName() {
        const banner = document.getElementById('top-banner');
        const fromBanner = banner && banner.getAttribute('data-page');
        if (fromBanner) return fromBanner;
        return pageFile(location.href).replace(/\.html$/, '') || 'index';
    }

    function isHomeFile(url) {
        return pageFile(url) === 'index.html';
    }

    function isProfileFile(url) {
        return pageFile(url) === 'profile.html';
    }

    function shouldMorphAccount(fromUrl, toUrl) {
        return (isHomeFile(fromUrl) && isProfileFile(toUrl)) || (isProfileFile(fromUrl) && isHomeFile(toUrl));
    }

    function isHomeCurtain() {
        if (!document.getElementById('entry-dock') || !document.getElementById('entry-auth-shell')) return false;
        if (document.documentElement.classList.contains('atlas-view')) return false;
        const curtain = document.getElementById('entry-view-curtain');
        if (curtain && curtain.classList.contains('curtain-up')) return false;
        return true;
    }

    function canMpaViewTransition() {
        if (window.matchMedia('(max-width: 767px)').matches) return false;
        return typeof document.startViewTransition === 'function' && 'onpageswap' in window;
    }

    window.addEventListener('pageswap', function (event) {
        if (!event.viewTransition) return;
        if (window.matchMedia('(max-width: 767px)').matches) {
            event.viewTransition.skipTransition();
            return;
        }
        const dest = event.activation && event.activation.entry && event.activation.entry.url;
        if (!dest || !shouldMorphAccount(location.href, dest) || (isHomeFile(location.href) && !isHomeCurtain()) || (isProfileFile(location.href) && isHomeFile(dest))) {
            event.viewTransition.skipTransition();
            return;
        }
        try { event.viewTransition.types.add('profile-morph'); } catch (e) {}
    });

    window.addEventListener('pagereveal', function (event) {
        if (!event.viewTransition) return;
        if (window.matchMedia('(max-width: 767px)').matches) {
            event.viewTransition.skipTransition();
            return;
        }
        try { event.viewTransition.types.add('profile-morph'); } catch (e) {}
    });

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
    const authReadyWaiters = [];

    function notifyAuthReady() {
        profileReady = true;
        const waiters = authReadyWaiters.splice(0);
        for (let i = 0; i < waiters.length; i++) {
            try { waiters[i](signedIn); } catch (e) {}
        }
    }

    window.binaWhenAuthReady = function (cb) {
        if (typeof cb !== 'function') return;
        if (profileReady) {
            cb(signedIn);
            return;
        }
        authReadyWaiters.push(cb);
    };
    window.binaIsSignedIn = function () {
        return signedIn;
    };

    function gatedAppPage() {
        const page = currentPageName();
        if (page === 'explorer') return 'explorer';
        if (page === 'bubble') return 'bubble';
        return '';
    }

    function sendToLogin(spec) {
        if (spec) setAuthNext(spec);
        if (typeof window.openCurtainAuth === 'function' && isIndexPage()) {
            window.openCurtainAuth();
            return;
        }
        window.location.replace(authLoginUrl());
    }

    function enforceGatedPage(profile) {
        const page = gatedAppPage();
        if (!page) {
            document.documentElement.classList.remove('auth-pending');
            return;
        }
        if (profile) {
            document.documentElement.classList.remove('auth-pending');
            return;
        }
        setAuthNext({ page: page, search: window.location.search || '' });
        window.location.replace(authLoginUrl());
    }

    function applyProfile(profile) {
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
            if (typeof window.closeCurtainAuth === 'function' && document.documentElement.classList.contains('curtain-auth') && profileReady) {
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
            .then(function (profile) {
                applyProfile(profile);
                if (profile && typeof window.closeCurtainAuth === 'function' && document.documentElement.classList.contains('curtain-auth')) {
                    window.closeCurtainAuth();
                }
                enforceGatedPage(profile);
                notifyAuthReady();
            })
            .catch(function () {
                applyProfile(null);
                enforceGatedPage(null);
                notifyAuthReady();
            });
    }

    function clearLocalSession() {
        writeBannerProfile(null);
        try { sessionStorage.removeItem(AUTH_NEXT_KEY); } catch (e) {}
        sessionStorage.removeItem('atlasSelectedTopic');
        sessionStorage.removeItem('atlasSelectedProvince');
        sessionStorage.removeItem('welcomeShown');
        sessionStorage.removeItem('themeBannerBg');
        sessionStorage.removeItem('themeTopicAccent');
        sessionStorage.removeItem('atlasThemeBannerBg');
        sessionStorage.removeItem('atlasThemeTopicAccent');
    }

    function logout() {
        fetch(apiBase() + '/api/auth/logout', { method: 'POST', credentials: 'include' })
            .catch(function () {})
            .finally(function () {
                clearLocalSession();
                window.location.replace(SITE.page('index.html'));
            });
    }

    function isIndexPage() {
        return currentPageName() === 'index';
    }

    function isProfilePage() {
        return currentPageName() === 'profile' || isProfileFile(location.href);
    }

    function homeHref() {
        const path = location.pathname || '';
        if (!/\.html$/i.test(path) && !/\/html\//i.test(path)) return '/';
        return SITE.page('index.html');
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

    function goHomeFromProfile() {
        try { sessionStorage.setItem('bina-profile-return', '1'); } catch (e) {}
        window.location.href = homeHref();
    }

    function setupLogoHome() {
        const logo = document.getElementById('logo-img');
        if (!logo || isIndexPage()) return;
        logo.addEventListener('click', function () {
            snapshotAppTheme();
            if (isProfilePage()) {
                goHomeFromProfile();
                return;
            }
            window.location.href = SITE.page('index.html?curtain=1');
        });
    }

    function playProfileReturn() {
        if (!document.documentElement.classList.contains('curtain-to-profile')) return;
        if (!document.getElementById('entry-dock')) return;
        requestAnimationFrame(function () {
            document.documentElement.classList.remove('curtain-to-profile-instant');
            requestAnimationFrame(function () {
                document.documentElement.classList.remove('curtain-to-profile');
            });
        });
    }

    function setup() {
        setupLogoHome();
        playProfileReturn();
        if (isProfilePage()) {
            document.querySelectorAll('a.auth-back-fab[href]').forEach(function (el) {
                el.addEventListener('click', function (event) {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    goHomeFromProfile();
                });
            });
        }
        applyProfile(readBannerProfile());
        loadProfile();
        window.addEventListener('pageshow', function () {
            loadProfile();
        });
        window.addEventListener('bina-session-changed', loadProfile);
        bindGatedNav();
        placeMobilePageNav();
        window.addEventListener('resize', debounce(placeMobilePageNav, 150));
        const btn = document.getElementById('user-menu-btn');
        const menu = document.getElementById('user-menu-dropdown');
        const logoutBtn = document.getElementById('btn-logout');
        if (!btn || !menu || !logoutBtn) return;

        function closeMenu() {
            menu.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
            btn.classList.remove('is-open');
        }

        function placeMenu() {
            const rect = btn.getBoundingClientRect();
            menu.style.top = Math.round(rect.bottom + 10) + 'px';
            const width = Math.max(menu.offsetWidth, 200);
            let left = Math.round(rect.left);
            left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
            menu.style.left = left + 'px';
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
                placeMenu();
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
        window.addEventListener('resize', function () {
            if (!menu.hidden) placeMenu();
        });
        window.addEventListener('scroll', function () {
            if (!menu.hidden) placeMenu();
        }, true);

        function bindAccountMorph() {
            function onAccountClick(event) {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
                closeMenu();
                if (window.matchMedia('(max-width: 767px)').matches) return;
                if (!isHomeCurtain()) return;
                if (canMpaViewTransition()) return;
                const link = event.currentTarget;
                const href = link.getAttribute('href');
                if (!href) return;
                event.preventDefault();
                if (document.documentElement.classList.contains('curtain-to-profile')) return;
                document.documentElement.classList.add('curtain-to-profile');
                window.setTimeout(function () {
                    window.location.href = href;
                }, 680);
            }
            const profileLink = document.getElementById('btn-profile');
            const openProfile = document.getElementById('btn-open-profile');
            if (profileLink) profileLink.addEventListener('click', onAccountClick);
            if (openProfile) openProfile.addEventListener('click', onAccountClick);
        }
        bindAccountMorph();
    }

    function bindGatedNav() {
        function explorerSearch(href) {
            try {
                return new URL(href, window.location.href).search || '';
            } catch (e) {
                return '';
            }
        }
        function onExplorerClick(event) {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
            const link = event.currentTarget;
            const href = link.getAttribute('href') || SITE.page('explorer.html');
            if (!profileReady) {
                event.preventDefault();
                window.binaWhenAuthReady(function (ok) {
                    if (ok) {
                        window.location.href = href;
                        return;
                    }
                    sendToLogin({ page: 'explorer', search: explorerSearch(href) });
                });
                return;
            }
            if (signedIn) return;
            event.preventDefault();
            sendToLogin({ page: 'explorer', search: explorerSearch(href) });
        }
        document.querySelectorAll('a[href*="explorer.html"]').forEach(function (el) {
            el.addEventListener('click', onExplorerClick);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
})();
