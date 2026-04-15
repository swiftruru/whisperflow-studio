'use strict';

/**
 * About tab controller.
 *
 * The About page is 95% static HTML driven by `data-i18n`, so this
 * module only has to do two small jobs:
 *
 *   1. Fill the version badge in the hero block from
 *      `app.getVersion()` via IPC, so each release automatically
 *      shows the right version number without touching this file.
 *   2. Bind every element with a `data-about-link="https://..."`
 *      attribute to `window.electronAPI.openExternal`, so the
 *      author/credits buttons open URLs in the system browser
 *      through the existing sandboxed IPC (http/https only).
 *
 * Future work (tracked here so the next contributor sees it):
 *   - Check for updates: poll GitHub releases API, compare tag_name
 *     against the current version, surface an "Update available"
 *     chip in the hero.  Deferred because it needs network, rate
 *     limit, and offline fallback handling.
 *   - Real author avatar: drop an `<img>` inside `.author-avatar`
 *     and the monogram gradient is automatically covered.
 */

import { showToast } from './toast.js';
import { t } from '../lib/i18n.js';

async function initAboutPanel() {
  await fillVersionBadge();
  bindExternalLinks();
}

async function fillVersionBadge() {
  const badge = document.getElementById('about-version-badge');
  if (!badge) return;
  try {
    const version = await window.electronAPI.getAppVersion();
    badge.textContent = `v${version}`;
  } catch (err) {
    // Main-process IPC shouldn't fail, but if it does fall back to
    // hiding the badge rather than showing a broken placeholder.
    badge.hidden = true;
    console.error('[about] Failed to read app version:', err);
  }
}

function bindExternalLinks() {
  const buttons = document.querySelectorAll('#tab-about [data-about-link]');
  for (const btn of buttons) {
    btn.addEventListener('click', () => handleLinkClick(btn));
  }
}

async function handleLinkClick(btn) {
  const url = btn.dataset.aboutLink;
  if (!url) return;
  try {
    await window.electronAPI.openExternal(url);
  } catch (err) {
    showToast(
      t('about:toast.openLinkFailed', { error: err?.message || String(err) }),
      'error',
      4000,
    );
  }
}

export { initAboutPanel };
