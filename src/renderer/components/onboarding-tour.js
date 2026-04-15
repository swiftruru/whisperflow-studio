'use strict';

/**
 * Onboarding tour — first-run guided walkthrough.
 *
 * The tour is a finite state machine over a fixed list of steps.
 * Each step:
 *   - resolves a DOM target via `data-onboard-target="stepN"`
 *     (set on existing elements in index.html — no duplication)
 *   - shows a callout bubble anchored to that target by the
 *     spotlight helper
 *   - optionally "previews" hidden elements (like the Batch Progress
 *     card which is normally hidden until Scan runs) by temporarily
 *     forcing `display: block` via the `.onboarding-preview` class
 *
 * Triggering
 * ----------
 *   - First-launch auto-trigger:  `maybeRunFirstLaunchTour()` reads
 *     `settings.json :: hasSeenOnboarding` and starts the tour if
 *     the flag is false AND preflight isn't blocking.  If preflight
 *     blocks, we subscribe to preflight updates and try again once
 *     the user fixes the environment — so the tour eventually runs
 *     even if the user fixes things one at a time.
 *   - Manual re-trigger:  help-panel.js's "Replay welcome tour"
 *     button calls `startOnboardingTour()` directly.
 *
 * Exit
 * ----
 *   - Skip button at any point, Esc key, or the final "Finish"
 *     button all persist `hasSeenOnboarding: true` and clean up.
 */

import { t, onLanguageChanged } from '../lib/i18n.js';
import { placeSpotlight } from '../lib/spotlight.js';
import { subscribePreflight } from './preflight-panel.js';
import { setHelpButtonDisabled } from './help-panel.js';

// ── Step list ────────────────────────────────────────────────────────────
// Each step matches a block of keys under `help:tour.<key>` and
// points at a real DOM element via the `data-onboard-target` attribute
// defined in index.html.  `reveal` is the set of normally-hidden
// elements that should be temporarily forced visible for this step.
const STEPS = [
  {
    key: 'welcome',
    target: null,
    variant: 'center',
  },
  {
    key: 'step1',
    target: '[data-onboard-target="step1"]',
  },
  {
    key: 'step2',
    target: '[data-onboard-target="step2"]',
  },
  {
    key: 'step3',
    target: '[data-onboard-target="step3"]',
  },
  {
    key: 'step4',
    target: '[data-onboard-target="step4"]',
  },
  {
    key: 'step5',
    target: '[data-onboard-target="step5"]',
    reveal: ['#progress-card'],
  },
];

const TOTAL_STEPS = STEPS.length - 1; // welcome doesn't count as "step 1/5"

let state = {
  running: false,
  index: 0,
  root: null,
  backdrop: null,
  spotlight: null,
  callout: null,
  revealed: [],
  unsubPreflight: null,
  unsubLang: null,
  onFinishCb: null,
};

// ── Public API ───────────────────────────────────────────────────────────

async function maybeRunFirstLaunchTour() {
  try {
    const settings = await window.electronAPI.readAppSettings();
    if (settings?.hasSeenOnboarding) return;

    // If preflight is blocked, subscribe and wait — the tour will
    // auto-start the moment preflight passes.  The subscribe callback
    // fires synchronously with the current state, so we predeclare
    // `unsub` (let, initially null) and the callback guards against
    // calling it before it's assigned.
    let unsub = null;
    let triggered = false;
    const listener = (preflightState) => {
      if (triggered) return;
      if (preflightState.pending) return;
      if (!preflightState.ok) return;
      // Conditions met — kick off the tour and unsubscribe.
      triggered = true;
      if (unsub) unsub();
      // Small delay so the user sees the green preflight state resolve
      // visually before the spotlight takes over the screen.
      setTimeout(() => {
        startOnboardingTour({ markSeenOnFinish: true });
      }, 400);
    };
    unsub = subscribePreflight(listener);
    // If the synchronous initial callback already fired and triggered
    // the tour, unsub was called with a no-op and we're done.
  } catch (err) {
    console.error('[onboarding] Failed to check first-launch state:', err);
  }
}

function startOnboardingTour({ markSeenOnFinish = true } = {}) {
  if (state.running) return;
  state.running = true;
  state.index = 0;
  state.onFinishCb = markSeenOnFinish ? persistSeenFlag : null;

  ensureDOM();
  setHelpButtonDisabled(true);
  state.root.setAttribute('aria-hidden', 'false');
  renderStep();

  // Re-render on language change so in-flight tours swap locale live.
  state.unsubLang = onLanguageChanged(() => renderStep());

  // Re-layout on resize so spotlight tracks its target.
  window.addEventListener('resize', handleResize);
  document.addEventListener('keydown', handleKeydown);
}

function finishTour({ skipped = false } = {}) {
  if (!state.running) return;
  state.running = false;
  unrevealAll();

  // CRITICAL: explicitly wipe the visual state of every onboarding
  // child, not just aria-hidden on the root.  Without this, setting
  // aria-hidden="true" turns off pointer-events but the callout still
  // has its `.visible` opacity:1, the spotlight still has its massive
  // box-shadow, and the backdrop still has its dark fill (fading over
  // 220ms) — so users see "nothing happened" when clicking Finish and
  // assume the button is broken.  Clearing the children here makes
  // the finish action feel instantaneous.
  if (state.callout) {
    state.callout.classList.remove('visible');
    state.callout.innerHTML = '';
    state.callout.removeAttribute('style');
  }
  if (state.spotlight) {
    state.spotlight.removeAttribute('style');
    state.spotlight.style.display = 'none';
  }

  if (state.root) state.root.setAttribute('aria-hidden', 'true');
  setHelpButtonDisabled(false);

  if (state.unsubLang) {
    state.unsubLang();
    state.unsubLang = null;
  }
  window.removeEventListener('resize', handleResize);
  document.removeEventListener('keydown', handleKeydown);

  if (state.onFinishCb) {
    try {
      state.onFinishCb();
    } catch (err) {
      console.error('[onboarding] Failed to persist seen flag:', err);
    }
  }
  state.onFinishCb = null;
}

// ── Internals ────────────────────────────────────────────────────────────

function ensureDOM() {
  if (state.root) return;
  const root = document.getElementById('onboarding-container');
  if (!root) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'onboarding-backdrop';

  const spotlight = document.createElement('div');
  spotlight.className = 'onboarding-spotlight';

  const callout = document.createElement('div');
  callout.className = 'onboarding-callout';

  root.appendChild(backdrop);
  root.appendChild(spotlight);
  root.appendChild(callout);

  state.root = root;
  state.backdrop = backdrop;
  state.spotlight = spotlight;
  state.callout = callout;
}

function renderStep() {
  const step = STEPS[state.index];
  if (!step) {
    finishTour();
    return;
  }

  unrevealAll();
  if (step.reveal) {
    for (const selector of step.reveal) {
      const el = document.querySelector(selector);
      if (el && el.hidden) {
        el.classList.add('onboarding-preview');
        state.revealed.push(el);
      }
    }
  }

  // Resolve target (after reveal so previously-hidden targets work)
  const targetEl = step.target ? document.querySelector(step.target) : null;

  // Build the callout contents from the i18n keys for this step.
  const progressText = step.key === 'welcome'
    ? ''
    : t('help:tour.nav.progress', { current: state.index, total: TOTAL_STEPS });
  const title = t(`help:tour.${step.key}.title`);
  const body = t(`help:tour.${step.key}.body`);

  state.callout.innerHTML = '';
  if (progressText) {
    const progress = document.createElement('div');
    progress.className = 'onboarding-callout-progress';
    progress.textContent = progressText;
    state.callout.appendChild(progress);
  }

  const h = document.createElement('h3');
  h.className = 'onboarding-callout-title';
  h.textContent = title;
  state.callout.appendChild(h);

  const p = document.createElement('p');
  p.className = 'onboarding-callout-body';
  p.innerHTML = body;
  state.callout.appendChild(p);

  const nav = document.createElement('div');
  nav.className = 'onboarding-callout-nav';

  const left = document.createElement('div');
  left.className = 'onboarding-callout-nav-left';
  const right = document.createElement('div');
  right.className = 'onboarding-callout-nav-right';

  // Skip — always present except on the final step
  if (state.index < STEPS.length - 1) {
    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'onboarding-btn onboarding-btn--ghost';
    skipBtn.textContent = t(step.key === 'welcome' ? 'help:tour.welcome.skip' : 'help:tour.nav.skip');
    skipBtn.addEventListener('click', () => finishTour({ skipped: true }));
    left.appendChild(skipBtn);
  }

  // Prev — not on welcome (step 0) or first real step... actually
  // allow going back from step1 to welcome, makes navigation feel real
  if (state.index > 0 && step.key !== 'welcome') {
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'onboarding-btn';
    prevBtn.textContent = t('help:tour.nav.prev');
    prevBtn.addEventListener('click', () => {
      state.index = Math.max(0, state.index - 1);
      renderStep();
    });
    right.appendChild(prevBtn);
  }

  // Next / Start / Finish
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'onboarding-btn onboarding-btn--primary';
  if (state.index === 0) {
    nextBtn.textContent = t('help:tour.welcome.start');
  } else if (state.index === STEPS.length - 1) {
    nextBtn.textContent = t('help:tour.nav.finish');
  } else {
    nextBtn.textContent = t('help:tour.nav.next');
  }
  nextBtn.addEventListener('click', () => {
    if (state.index >= STEPS.length - 1) {
      finishTour();
      return;
    }
    state.index += 1;
    renderStep();
  });
  right.appendChild(nextBtn);

  nav.appendChild(left);
  nav.appendChild(right);
  state.callout.appendChild(nav);

  // Layout AFTER the DOM is populated so offsetWidth/Height are correct.
  // rAF lets the browser finish layout of the new nodes first.
  requestAnimationFrame(() => {
    placeSpotlight({
      spotlightEl: state.spotlight,
      calloutEl: state.callout,
      targetEl,
    });
    requestAnimationFrame(() => {
      state.callout.classList.add('visible');
    });
  });
}

function handleResize() {
  if (!state.running) return;
  const step = STEPS[state.index];
  if (!step) return;
  const targetEl = step.target ? document.querySelector(step.target) : null;
  placeSpotlight({
    spotlightEl: state.spotlight,
    calloutEl: state.callout,
    targetEl,
  });
}

function handleKeydown(event) {
  if (!state.running) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    finishTour({ skipped: true });
  } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
    if (state.index < STEPS.length - 1) {
      state.index += 1;
      renderStep();
    } else {
      finishTour();
    }
  } else if (event.key === 'ArrowLeft') {
    if (state.index > 0) {
      state.index -= 1;
      renderStep();
    }
  }
}

function unrevealAll() {
  for (const el of state.revealed) {
    el.classList.remove('onboarding-preview');
  }
  state.revealed = [];
}

async function persistSeenFlag() {
  try {
    const settings = await window.electronAPI.readAppSettings();
    await window.electronAPI.writeAppSettings({
      ...settings,
      hasSeenOnboarding: true,
    });
  } catch (err) {
    console.error('[onboarding] Failed to persist hasSeenOnboarding:', err);
  }
}

export { maybeRunFirstLaunchTour, startOnboardingTour };
