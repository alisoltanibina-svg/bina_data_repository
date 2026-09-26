// Shared top banner markup. Pages keep an empty #top-banner[data-page] and this fills it.
(function renderTopBanner() {
    const root = document.getElementById('top-banner');
    if (!root) return;

    const page = root.getAttribute('data-page') || '';
    const hashAtlas = window.location.hash === '#atlas';
    let explorerHref = SITE.page('explorer.html');
    if (page === 'index') {
        explorerHref = hashAtlas ? SITE.page('explorer.html?source=atlas') : SITE.page('explorer.html?source=start');
    }

    const atlasCurrent = page === 'index' && hashAtlas ? ' is-current' : '';
    const explorerCurrent = (page === 'explorer' || page === 'bubble') ? ' is-current' : '';

    root.innerHTML =
        '<div class="banner-right">' +
            '<div class="institution">' +
                '<img id="logo-img" src="' + SITE.asset('images/Logo.webp') + '" alt="مرکز رصد بینا">' +
            '</div>' +
            '<div class="banner-divider" aria-hidden="true"></div>' +
            '<div class="project-texts">' +
                '<div class="project-main">سامانه دیده‌بان فرهنگ</div>' +
                '<div class="project-sub">راهبری زیست‌بوم فرهنگی تبلیغی ایران</div>' +
            '</div>' +
            '<nav class="top-nav banner-seg" role="navigation" aria-label="ناوبری اصلی">' +
                '<a href="' + SITE.page('index.html#atlas') + '" id="btn-atlas" class="banner-seg-btn' + atlasCurrent + '"' + (atlasCurrent ? ' aria-current="page"' : '') + '>اطلس</a>' +
                '<a href="' + explorerHref + '" id="btn-explorer" class="banner-seg-btn' + explorerCurrent + '"' + (explorerCurrent ? ' aria-current="page"' : '') + '>کاوشگر</a>' +
                '<span class="banner-seg-btn" aria-disabled="true">نمایه</span>' +
                '<span class="banner-seg-btn" aria-disabled="true">گونه‌شناسی</span>' +
            '</nav>' +
        '</div>' +
        '<div class="banner-left">' +
            '<div class="user-box">' +
                '<div class="user-menu">' +
                    '<button type="button" class="user-circle" id="user-menu-btn" aria-haspopup="true" aria-expanded="false" aria-controls="user-menu-dropdown" title="حساب کاربری">' +
                        '<img id="user-avatar-img" alt="" hidden>' +
                        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                            '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>' +
                            '<circle cx="12" cy="7" r="4"></circle>' +
                        '</svg>' +
                    '</button>' +
                    '<div class="user-menu-dropdown" id="user-menu-dropdown" hidden>' +
                        '<a href="' + SITE.page('profile.html') + '" class="user-menu-link' + (page === 'profile' && window.location.hash !== '#password' ? ' is-current' : '') + '" id="btn-profile">حساب من</a>' +
                        '<a href="' + SITE.page('profile.html') + '#password" class="user-menu-link' + (page === 'profile' && window.location.hash === '#password' ? ' is-current' : '') + '" id="btn-password">تغییر رمز عبور</a>' +
                        '<a href="' + SITE.page('admin.html') + '" class="user-menu-link' + (page === 'admin' ? ' is-current' : '') + '" id="btn-admin-panel" hidden>پنل مدیریت</a>' +
                        '<button type="button" class="user-exit-btn" id="btn-logout">' +
                            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                                '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>' +
                                '<polyline points="16 17 21 12 16 7"></polyline>' +
                                '<line x1="21" y1="12" x2="9" y2="12"></line>' +
                            '</svg>' +
                            '<span>خروج</span>' +
                        '</button>' +
                    '</div>' +
                '</div>' +
                '<a href="' + SITE.page('index.html') + '#auth" class="banner-auth-btn" id="banner-auth-btn">ورود | ثبت نام</a>' +
                '<div class="user-texts" id="user-texts" hidden>' +
                    '<div class="user-name"></div>' +
                    '<div class="user-role"></div>' +
                '</div>' +
            '</div>' +
        '</div>';
})();
