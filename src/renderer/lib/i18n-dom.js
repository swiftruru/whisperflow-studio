'use strict';

/**
 * Thin data-attribute-driven DOM translator.
 *
 * The renderer is vanilla JS — no React, no template engine — so we
 * need a way for static HTML to participate in language switches
 * without each element needing a JS owner that calls `t()` manually.
 *
 * The approach: annotate DOM nodes with data attributes that name the
 * translation key to apply.  On boot and on every language change,
 * `applyTranslations()` walks the tree and rewrites textContent /
 * attributes in place.
 *
 * Usage from HTML
 * ---------------
 *   <button data-i18n="common:actions.save">Save</button>
 *   <input  data-i18n-attr="placeholder=queue:search.placeholder">
 *   <h2     data-i18n="preflight:panel.title"
 *           data-i18n-params='{"count": 5}'></h2>
 *
 * Attribute syntax
 * ----------------
 *  data-i18n="ns:path.to.key"
 *      → el.textContent = t(key, params)
 *  data-i18n-html="ns:key"
 *      → el.innerHTML = t(key, params)   (use sparingly, must trust source)
 *  data-i18n-attr="attrA=ns:keyA; attrB=ns:keyB"
 *      → setAttribute(attrA, t(keyA));   setAttribute(attrB, t(keyB))
 *  data-i18n-params='{"name":"Foo"}'
 *      → extra interpolation params, applied to all keys on the same element
 *
 * Fallback text in HTML stays as-is when `_ready` is false, so the
 * window doesn't flash empty while the async boot finishes.
 */

import { t } from './i18n.js';

const DATA_KEY_ATTR = 'data-i18n';
const DATA_HTML_ATTR = 'data-i18n-html';
const DATA_ATTRS_ATTR = 'data-i18n-attr';
const DATA_PARAMS_ATTR = 'data-i18n-params';

function parseParams(el) {
  const raw = el.getAttribute(DATA_PARAMS_ATTR);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return undefined;
  }
}

function parseAttrSpec(spec) {
  // "placeholder=ns:key.one; title=ns:key.two"
  const entries = [];
  for (const piece of spec.split(';')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const attrName = trimmed.slice(0, eq).trim();
    const key = trimmed.slice(eq + 1).trim();
    if (attrName && key) entries.push([attrName, key]);
  }
  return entries;
}

function translateElement(el) {
  const params = parseParams(el);

  // Capture the original HTML fallback once so we can restore it if
  // t() can't resolve the key.  We stash it on the element the first
  // time we see it so subsequent language switches still have a
  // reliable fallback to roll back to.
  const textKey = el.getAttribute(DATA_KEY_ATTR);
  if (textKey) {
    if (el.dataset.i18nFallback === undefined) {
      el.dataset.i18nFallback = el.textContent || '';
    }
    const translated = t(textKey, params);
    // t() returns empty string when i18next couldn't resolve the
    // key (missing namespace, missing path, etc.).  In that case we
    // keep the original HTML fallback text instead of blanking the
    // element — critical for Windows builds where a JSON file has
    // been observed to silently fail to load, leaving callers
    // otherwise showing raw key paths.
    el.textContent = translated || el.dataset.i18nFallback;
  }

  const htmlKey = el.getAttribute(DATA_HTML_ATTR);
  if (htmlKey) {
    if (el.dataset.i18nHtmlFallback === undefined) {
      el.dataset.i18nHtmlFallback = el.innerHTML || '';
    }
    const translated = t(htmlKey, params);
    el.innerHTML = translated || el.dataset.i18nHtmlFallback;
  }

  const attrSpec = el.getAttribute(DATA_ATTRS_ATTR);
  if (attrSpec) {
    for (const [attrName, key] of parseAttrSpec(attrSpec)) {
      const translated = t(key, params);
      if (translated) {
        el.setAttribute(attrName, translated);
      }
      // If missing, we leave the attribute as whatever it was before
      // (often the English fallback baked into the HTML).
    }
  }
}

/**
 * Walk the subtree rooted at `root` (default: document.body) and
 * apply translations to every annotated element.  Idempotent — calling
 * it multiple times is cheap.
 *
 * On a typical WhisperFlow Studio window with ~50 annotated nodes this
 * runs in under 2ms.  For large dynamic containers (Queue panel), mark
 * the container with `data-i18n-root` and pass it explicitly so we
 * don't walk the entire document for minor updates.
 */
function applyTranslations(root = document.body) {
  if (!root) return;
  // Only one querySelector call — cheap versus walking ourselves.
  const selector = `[${DATA_KEY_ATTR}], [${DATA_HTML_ATTR}], [${DATA_ATTRS_ATTR}]`;
  // Check the root itself too (document.body usually has nothing, but
  // callers passing a specific element want their own attrs picked up).
  if (root.matches && root.matches(selector)) {
    translateElement(root);
  }
  const elements = root.querySelectorAll(selector);
  for (const el of elements) {
    translateElement(el);
  }
}

/**
 * Helper for one-off translations of a freshly-created element without
 * needing the caller to import `t` separately.
 */
function translate(el) {
  translateElement(el);
}

export { applyTranslations, translate };
