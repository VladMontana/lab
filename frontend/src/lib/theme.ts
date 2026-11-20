import { writable, derived } from 'svelte/store';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'labnotes-theme';

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (saved === 'light' || saved === 'dark' || saved === 'system') {
    return saved;
  }
  return 'system';
}

function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

const themeSetting = writable<Theme>(getInitialTheme());

// Resolved boolean indicating if dark mode is active
const isDarkStore = derived(themeSetting, ($theme) => {
  if ($theme === 'dark') return true;
  if ($theme === 'light') return false;
  return getSystemPrefersDark();
});

function applyTheme(resolvedDark: boolean) {
  if (typeof document === 'undefined') return;
  const theme = resolvedDark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

// Initialize listener and sync
if (typeof window !== 'undefined') {
  // Update HTML whenever themeSetting changes
  isDarkStore.subscribe((resolvedDark) => {
    applyTheme(resolvedDark);
  });

  // Listen for OS scheme changes
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', (e) => {
    themeSetting.update((current) => {
      if (current === 'system') {
        applyTheme(e.matches);
      }
      return current;
    });
  });
}

export const theme = {
  subscribe: themeSetting.subscribe,
  set: (newTheme: Theme) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, newTheme);
    }
    themeSetting.set(newTheme);
  },
  toggle: () => {
    themeSetting.update((current) => {
      let next: Theme;
      if (current === 'system') {
        // If current is system, toggle to the opposite of current system setting
        next = getSystemPrefersDark() ? 'light' : 'dark';
      } else if (current === 'light') {
        next = 'dark';
      } else {
        next = 'light';
      }
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, next);
      }
      return next;
    });
  },
};

export const isDark = isDarkStore;
