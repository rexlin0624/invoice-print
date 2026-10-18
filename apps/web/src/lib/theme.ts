/**
 * 主题：外壳只负责把当前主题写成 `<html data-theme="light|dark">`，
 * 颜色全在 CSS 里。默认跟随系统；用户手动选定后写进 localStorage。
 *
 * 为什么不用 `@media (prefers-color-scheme: dark)` 直接写深色：
 * 那样「跟随系统」和「手动指定」会互相打架，而且没法单独验证浅色。
 */

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'auto';

const KEY = 'invoice-tool.theme.v1';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function systemTheme(): Theme {
  return media.matches ? 'dark' : 'light';
}

export function themePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved;
  } catch {
    /* 隐私模式读不到，忽略 */
  }
  return 'auto';
}

/** 主题在这里落成 DOM 属性。首帧之前调用，避免闪一下白/黑。 */
export function applyTheme(preference: ThemePreference = themePreference()): void {
  document.documentElement.dataset.theme = preference === 'auto' ? systemTheme() : preference;
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(KEY, preference);
  } catch {
    /* 忽略 */
  }
  applyTheme(preference);
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** 选「跟随系统」时才需要监听系统切换 */
export function watchSystemTheme(): void {
  media.addEventListener('change', () => {
    if (themePreference() === 'auto') applyTheme('auto');
  });
}
