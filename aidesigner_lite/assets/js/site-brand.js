(function () {
    const DEFAULT_SITE_NAME = 'AI Designer';
    const CACHE_KEY = 'aimaster_site_name';
    const THEME_KEY = 'aimaster_theme';
    const THEME_STYLE_ID = 'aimaster-theme-stylesheet';
    const THEMES = ['light', 'dark'];
    const scriptSrc = document.currentScript && document.currentScript.src;
    const originalTitle = document.title || '';
    let currentAppliedSiteName = '';

    function apiUrl(path) {
        const base = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
        return base + path;
    }

    function assetUrl(path) {
        try {
            return scriptSrc ? new URL(path, scriptSrc).href : new URL(path.replace(/^\.\.\//, 'assets/'), window.location.href).href;
        } catch (error) {
            return path;
        }
    }

    function normalizeTheme(value) {
        return THEMES.includes(value) ? value : 'dark';
    }

    function readTheme() {
        try {
            return normalizeTheme(localStorage.getItem(THEME_KEY));
        } catch (error) {
            return 'dark';
        }
    }

    function saveTheme(theme) {
        try {
            localStorage.setItem(THEME_KEY, theme);
        } catch (error) {
            console.warn('保存主题失败:', error.message);
        }
    }

    function ensureThemeStylesheet() {
        if (document.getElementById(THEME_STYLE_ID)) return;
        const link = document.createElement('link');
        link.id = THEME_STYLE_ID;
        link.rel = 'stylesheet';
        link.href = assetUrl('../css/theme.css');
        document.head.appendChild(link);
    }

    function themeIcon(theme) {
        if (theme === 'dark') {
            return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56"></path></svg>';
        }
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M21 12.7A8.5 8.5 0 0 1 11.3 3 6.8 6.8 0 1 0 21 12.7Z"></path></svg>';
    }

    function updateThemeToggles(theme) {
        const nextTheme = theme === 'dark' ? 'light' : 'dark';
        const label = nextTheme === 'light' ? '白天' : '夜间';
        document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
            button.dataset.nextTheme = nextTheme;
            button.setAttribute('aria-label', '切换到' + label + '模式');
            button.setAttribute('title', '切换到' + label + '模式');
            button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
            const icon = button.querySelector('.aim-theme-toggle-icon');
            const text = button.querySelector('.aim-theme-toggle-label');
            if (icon) icon.innerHTML = themeIcon(theme);
            if (text) text.textContent = label;
        });
    }

    function applyTheme(theme, options) {
        const normalized = normalizeTheme(theme);
        document.documentElement.dataset.theme = normalized;
        document.documentElement.style.colorScheme = normalized;
        updateThemeToggles(normalized);
        if (!options || options.persist !== false) saveTheme(normalized);
    }

    function createThemeToggle() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'aim-theme-toggle';
        button.dataset.themeToggle = 'true';
        button.innerHTML = '<span class="aim-theme-toggle-icon" aria-hidden="true"></span><span class="aim-theme-toggle-label"></span>';
        button.addEventListener('click', () => applyTheme(button.dataset.nextTheme || 'light'));
        updateThemeToggles(document.documentElement.dataset.theme || readTheme());
        return button;
    }

    function addThemeToggleTo(container, mode) {
        if (!container || container.querySelector('[data-theme-toggle]')) return false;
        const button = createThemeToggle();
        if (mode === 'prepend') {
            container.insertBefore(button, container.firstChild);
        } else if (mode && mode.before) {
            const before = container.querySelector(mode.before);
            container.insertBefore(button, before || null);
        } else {
            container.appendChild(button);
        }
        updateThemeToggles(document.documentElement.dataset.theme || readTheme());
        return true;
    }

    function initThemeToggle() {
        if (document.body?.dataset.disableThemeToggle === 'true' || document.documentElement.dataset.disableThemeToggle === 'true') {
            return;
        }
        const placements = [
            { selector: '.nav-actions', mode: { before: '#loginBtn, .btn-login, .user-dropdown' } },
            { selector: '.mobile-nav-actions', mode: 'prepend' },
            { selector: '.tool-header', mode: { before: '.user-dropdown' } },
            { selector: '.dashboard-header', mode: { before: '.user-dropdown' } },
            { selector: '.admin-header .header-right', mode: 'prepend' },
            { selector: '.account-workspace .top-actions', mode: 'prepend' },
        ];

        let inserted = false;
        placements.forEach(({ selector, mode }) => {
            document.querySelectorAll(selector).forEach((container) => {
                inserted = addThemeToggleTo(container, mode) || inserted;
            });
        });

        if (!inserted && !document.querySelector('[data-theme-toggle].aim-theme-toggle-floating')) {
            const floating = createThemeToggle();
            floating.classList.add('aim-theme-toggle-floating');
            document.body.appendChild(floating);
        }
    }

    function normalizedSiteName(value) {
        return String(value || '').trim();
    }

    function applySiteBrand(siteName) {
        const name = normalizedSiteName(siteName);
        if (!name) return;

        document.querySelectorAll('.logo-text, .header-logo-text, #accountBrandName, [data-site-name]').forEach((element) => {
            element.textContent = name;
        });

        document.querySelectorAll('img[alt="AI Designer 标志"]').forEach((image) => {
            image.alt = name + ' 标志';
        });

        if (originalTitle && originalTitle.includes(DEFAULT_SITE_NAME)) {
            document.title = originalTitle.replaceAll(DEFAULT_SITE_NAME, name);
        } else if (currentAppliedSiteName && document.title.includes(currentAppliedSiteName)) {
            document.title = document.title.replaceAll(currentAppliedSiteName, name);
        }
        currentAppliedSiteName = name;
    }

    function saveSiteBrand(siteName) {
        const name = normalizedSiteName(siteName);
        if (!name) return;
        localStorage.setItem(CACHE_KEY, name);
        applySiteBrand(name);
    }

    async function loadSiteBrand() {
        const cachedName = normalizedSiteName(localStorage.getItem(CACHE_KEY));
        if (cachedName) applySiteBrand(cachedName);

        try {
            const response = await fetch(apiUrl('/api/config'), { headers: { 'Accept': 'application/json' } });
            if (!response.ok) return;
            const data = await response.json();
            saveSiteBrand(data?.site?.name);
        } catch (error) {
            console.warn('加载网站名称失败:', error.message);
        }
    }

    window.applySiteBrand = applySiteBrand;
    window.saveSiteBrand = saveSiteBrand;
    window.loadSiteBrand = loadSiteBrand;
    window.applySiteTheme = applyTheme;
    window.getSiteTheme = () => document.documentElement.dataset.theme || readTheme();

    ensureThemeStylesheet();
    applyTheme(readTheme(), { persist: false });

    window.addEventListener('storage', (event) => {
        if (event.key === CACHE_KEY && event.newValue) {
            applySiteBrand(event.newValue);
        }
        if (event.key === THEME_KEY && event.newValue) {
            applyTheme(event.newValue, { persist: false });
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            loadSiteBrand();
            initThemeToggle();
        });
    } else {
        loadSiteBrand();
        initThemeToggle();
    }
})();
