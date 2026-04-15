'use strict';

/**
 * Spotlight rendering utility — the drawing primitive behind the
 * onboarding tour.  Given a DOM element to highlight and a callout
 * HTMLElement, this module:
 *
 *   1. Measures the target via `getBoundingClientRect()`
 *   2. Positions an absolute-positioned `.onboarding-spotlight`
 *      element to match the target's rect (with a small padding)
 *   3. Places the callout in the "best" gap around the target —
 *      below if there's room, otherwise above, otherwise beside
 *   4. Keeps the callout inside the viewport with `clamp()`-style
 *      bounds checking
 *
 * The actual darken-the-rest-of-the-screen trick lives in CSS: the
 * spotlight element has a gigantic outward `box-shadow` that paints
 * every pixel outside its box dark.  No DOM cloning, no z-index
 * gymnastics on the target element itself.
 */

const CALLOUT_GAP = 18;
const CALLOUT_MARGIN = 12;

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.spotlightEl  — the `.onboarding-spotlight` div
 * @param {HTMLElement} opts.calloutEl    — the `.onboarding-callout` div
 * @param {HTMLElement|null} opts.targetEl — element to highlight (null = centred modal)
 * @param {number} [opts.padding=8]       — spotlight padding around target
 */
function placeSpotlight({ spotlightEl, calloutEl, targetEl, padding = 8 }) {
  if (!spotlightEl || !calloutEl) return;

  if (!targetEl) {
    // Centred mode — no spotlight, callout alone in the middle.
    spotlightEl.style.display = 'none';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const calloutWidth = calloutEl.offsetWidth || 300;
    const calloutHeight = calloutEl.offsetHeight || 180;
    calloutEl.style.top = `${Math.max(CALLOUT_MARGIN, (vh - calloutHeight) / 2)}px`;
    calloutEl.style.left = `${Math.max(CALLOUT_MARGIN, (vw - calloutWidth) / 2)}px`;
    return;
  }

  spotlightEl.style.display = 'block';

  const rect = targetEl.getBoundingClientRect();
  const top = Math.max(rect.top - padding, 4);
  const left = Math.max(rect.left - padding, 4);
  const width = rect.width + padding * 2;
  const height = rect.height + padding * 2;

  spotlightEl.style.top = `${top}px`;
  spotlightEl.style.left = `${left}px`;
  spotlightEl.style.width = `${width}px`;
  spotlightEl.style.height = `${height}px`;

  // Decide where to put the callout.  Preferred order:
  //   1. below the target (most natural reading flow)
  //   2. above the target
  //   3. to the right
  //   4. to the left
  //   5. fallback: anchored to bottom of viewport centre
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const calloutWidth = calloutEl.offsetWidth || 300;
  const calloutHeight = calloutEl.offsetHeight || 180;

  let calloutTop;
  let calloutLeft;

  if (rect.bottom + CALLOUT_GAP + calloutHeight <= vh - CALLOUT_MARGIN) {
    // Below
    calloutTop = rect.bottom + CALLOUT_GAP;
    calloutLeft = rect.left + rect.width / 2 - calloutWidth / 2;
  } else if (rect.top - CALLOUT_GAP - calloutHeight >= CALLOUT_MARGIN) {
    // Above
    calloutTop = rect.top - CALLOUT_GAP - calloutHeight;
    calloutLeft = rect.left + rect.width / 2 - calloutWidth / 2;
  } else if (rect.right + CALLOUT_GAP + calloutWidth <= vw - CALLOUT_MARGIN) {
    // Right
    calloutTop = rect.top + rect.height / 2 - calloutHeight / 2;
    calloutLeft = rect.right + CALLOUT_GAP;
  } else if (rect.left - CALLOUT_GAP - calloutWidth >= CALLOUT_MARGIN) {
    // Left
    calloutTop = rect.top + rect.height / 2 - calloutHeight / 2;
    calloutLeft = rect.left - CALLOUT_GAP - calloutWidth;
  } else {
    // Fallback — anchor to bottom centre of viewport.
    calloutTop = vh - calloutHeight - CALLOUT_MARGIN;
    calloutLeft = (vw - calloutWidth) / 2;
  }

  // Clamp to viewport.
  calloutTop = Math.max(CALLOUT_MARGIN, Math.min(calloutTop, vh - calloutHeight - CALLOUT_MARGIN));
  calloutLeft = Math.max(CALLOUT_MARGIN, Math.min(calloutLeft, vw - calloutWidth - CALLOUT_MARGIN));

  calloutEl.style.top = `${calloutTop}px`;
  calloutEl.style.left = `${calloutLeft}px`;
}

export { placeSpotlight };
