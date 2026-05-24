(function () {
    const THEME_KEY = 'aimaster_theme';
    const THEMES = ['light', 'dark'];

    function normalizeTheme(value) {
        return THEMES.includes(value) ? value : 'dark';
    }

    try {
        const theme = normalizeTheme(localStorage.getItem(THEME_KEY));
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
    } catch (error) {
        document.documentElement.dataset.theme = 'dark';
        document.documentElement.style.colorScheme = 'dark';
    }
})();
