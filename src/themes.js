/**
 * pi-studio theme system — one light and one dark palette.
 */

const LEGACY_THEME_MAP = {
  night: 'dark',
  dawn: 'dark',
  midnight: 'dark',
  clean: 'light',
  terracotta: 'light',
  sage: 'light',
};

export const themes = {
  dark: {
    name: '深色',
    dark: true,
    colors: ['#0f1115', '#171a21', '#6d7cff', '#43d39e'],
  },
  light: {
    name: '浅色',
    dark: false,
    colors: ['#f6f7f9', '#ffffff', '#5968e8', '#43b889'],
  },
};

function normalizeTheme(themeId) {
  return LEGACY_THEME_MAP[themeId] || (themes[themeId] ? themeId : null);
}

function updateThemeColor(themeId) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = themeId === 'light' ? '#f6f7f9' : '#0f1115';
}

export function applyTheme(themeId, { persist = true } = {}) {
  const normalized = normalizeTheme(themeId) || 'dark';
  document.documentElement.setAttribute('data-theme', normalized);
  if (persist) localStorage.setItem('tau-theme', normalized);
  updateThemeColor(normalized);
  return normalized;
}

export function getCurrentTheme() {
  const saved = localStorage.getItem('tau-theme');
  const normalized = normalizeTheme(saved);
  if (normalized) {
    if (saved !== normalized) localStorage.setItem('tau-theme', normalized);
    return normalized;
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

if (!localStorage.getItem('tau-theme')) {
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', (event) => {
    if (localStorage.getItem('tau-theme')) return;
    const themeId = event.matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', themeId);
    updateThemeColor(themeId);
  });
}
