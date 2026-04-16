'use strict';

/**
 * Synchronous theme bootstrap — runs before the stylesheet paints
 * the first frame so the window never flashes the wrong theme.
 *
 * The main `initTheme()` in `index.js` normally does this, but by
 * the time it runs the rest of the init sequence (i18n resources,
 * preflight, component factories…) the browser has already painted
 * at least one frame with the CSS defaults.  CSS defaults to **dark**
 * (dark mode is the "no attribute" state; light mode is
 * `[data-theme="light"]`), so a user who prefers light mode sees a
 * visible dark flash every boot — especially pronounced on Windows
 * where the init sequence is slower due to Python path scanning.
 *
 * This file is tiny, plain JS, classic-script loaded in the `<head>`
 * via a regular `<script src="theme-boot.js">` tag.  It runs
 * synchronously before the document body parses and before the
 * first paint, so whichever attribute it writes is in place by the
 * time the stylesheet is applied.
 *
 * Duplicated-logic note: the same precedence is also implemented in
 * `initTheme()` in `index.js` so the two stay in sync.  Keep the
 * logic here minimal — anything more complex (event listeners, icon
 * swapping, toggle buttons) belongs in `initTheme()`, not here.
 */
(function bootTheme() {
  try {
    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (_) { /* private mode */ }

    var prefersDark = false;
    try {
      prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (_) { /* matchMedia unsupported */ }

    var isDark = saved ? saved === 'dark' : prefersDark;
    if (!isDark) {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (_) {
    // Last-resort no-op — never let theme bootstrap crash the app.
  }
})();
