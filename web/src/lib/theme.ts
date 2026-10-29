// Light, dark or system theme. The choice is saved in the settings and kept in
// this window's storage too, so the page opens in the right theme at once.

export type Theme = "system" | "light" | "dark";

const KEY = "orbit.theme";

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // the theme still applies for this session
  }
}

/** The theme shown right now, the system's when nothing is forced. */
export function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  return forced === "dark" || (!forced && window.matchMedia("(prefers-color-scheme: dark)").matches);
}
