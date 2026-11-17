import {readPreference} from './identity.ts';
export type ThemeMode = 'dark' | 'light';

const preferenceKey = 'allview.theme';
const modeFrom = (value: unknown): ThemeMode => value === 'dark' ? 'dark' : 'light';

// Preserve explicit choices; old System, missing and invalid preferences use Light.
export function initializeTheme() {
  const root = document.documentElement;
  let mode: ThemeMode = 'light';
  try { mode = modeFrom(readPreference(localStorage,preferenceKey)); } catch { /* Storage may be unavailable. */ }
  const apply = () => {
    root.dataset.themeMode = mode;
    if (root.dataset.theme !== mode) {
      root.dataset.theme = mode;
      document.dispatchEvent(new CustomEvent('theme-changed', { detail: mode }));
    }
  };
  apply();
  return {
    get mode() { return mode; },
    set(value: unknown) {
      mode = modeFrom(value);
      apply();
      try { localStorage.setItem(preferenceKey, mode); return true; } catch { return false; }
    },
  };
}
