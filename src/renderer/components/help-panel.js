'use strict';

/**
 * Help panel — right-side slideout containing the full user guide.
 *
 * The panel's content is entirely static HTML wired with `data-i18n`
 * attributes, so this module only has four jobs:
 *
 *   1. Toggle the panel open/closed (transform slide animation).
 *   2. Expand/collapse each collapsible section.  Exactly one section
 *      can be open at a time apart from the pinned "Quick Start" that
 *      is always expanded.
 *   3. Wire the inline `data-help-goto-tab="models|settings"` buttons
 *      to switch to the named tab and close the panel in one click.
 *   4. Kick off the onboarding tour from the "Replay welcome tour"
 *      button — just a pass-through to onboarding-tour.js.
 *
 * Everything else (content, translations, theming) inherits from the
 * existing app infrastructure.
 */

import { startOnboardingTour } from './onboarding-tour.js';
import { bindLanguageToggle } from './language-toggle.js';

const panel = document.getElementById('help-panel');
const backdrop = document.getElementById('help-panel-backdrop');
const closeBtn = document.getElementById('btn-help-panel-close');
const helpBtn = document.getElementById('btn-help');
const replayTourBtn = document.getElementById('btn-help-replay-tour');

let initialized = false;
let isOpen = false;

function setOpen(next) {
  if (!panel) return;
  isOpen = Boolean(next);
  panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  if (isOpen) {
    document.body.classList.add('help-panel-open');
  } else {
    document.body.classList.remove('help-panel-open');
  }
}

function openHelpPanel(section = null) {
  setOpen(true);
  if (section) {
    requestAnimationFrame(() => scrollToSection(section));
  }
}

function closeHelpPanel() {
  setOpen(false);
}

function scrollToSection(sectionName) {
  const target = panel?.querySelector(`[data-help-section="${sectionName}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  expandSection(target);
}

function expandSection(sectionEl) {
  const header = sectionEl.querySelector('.help-section-header');
  const body = sectionEl.querySelector('.help-section-body');
  if (!header || !body) return;
  header.setAttribute('aria-expanded', 'true');
  body.hidden = false;
}

function collapseSection(sectionEl) {
  const header = sectionEl.querySelector('.help-section-header');
  const body = sectionEl.querySelector('.help-section-body');
  if (!header || !body) return;
  header.setAttribute('aria-expanded', 'false');
  body.hidden = true;
}

function bindSectionToggles() {
  const sections = panel.querySelectorAll('.help-section:not(.help-section--pinned)');
  for (const section of sections) {
    const header = section.querySelector('.help-section-header');
    if (!header) continue;
    header.addEventListener('click', () => {
      const expanded = header.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        collapseSection(section);
      } else {
        expandSection(section);
      }
    });
  }
}

function bindGotoTabButtons() {
  const buttons = panel.querySelectorAll('[data-help-goto-tab]');
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.helpGotoTab;
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${targetTab}"]`);
      if (tabBtn) tabBtn.click();
      closeHelpPanel();
    });
  }
}

function bindGlobalCloseTriggers() {
  // Backdrop click
  backdrop?.addEventListener('click', () => {
    closeHelpPanel();
  });

  // Close button
  closeBtn?.addEventListener('click', () => {
    closeHelpPanel();
  });

  // Escape key — but only when the help panel is the topmost focus.
  // If a modal is open on top of the panel we want Esc to close that
  // first, so we only react when our panel is "on top".
  document.addEventListener('keydown', (event) => {
    if (!isOpen) return;
    if (event.key !== 'Escape') return;
    // If a modal-overlay is visible, defer to it.
    const openModal = document.querySelector('.modal-overlay:not([hidden])');
    if (openModal) return;
    event.stopPropagation();
    closeHelpPanel();
  });
}

function bindReplayTourButton() {
  replayTourBtn?.addEventListener('click', async () => {
    closeHelpPanel();
    // Delay slightly so the slide-out animation finishes before the
    // spotlight takes over the screen — stacked transitions look
    // cleaner sequenced than simultaneous.
    await new Promise((resolve) => setTimeout(resolve, 260));
    startOnboardingTour({ markSeenOnFinish: true });
  });
}

function bindHelpButton() {
  helpBtn?.addEventListener('click', () => {
    if (helpBtn.disabled) return;
    if (isOpen) {
      closeHelpPanel();
    } else {
      openHelpPanel();
    }
  });
}

function initHelpPanel() {
  if (initialized || !panel) return;
  initialized = true;

  bindHelpButton();
  bindSectionToggles();
  bindGotoTabButtons();
  bindGlobalCloseTriggers();
  bindReplayTourButton();

  // Mirror the titlebar language toggle inside the help panel header
  // so it remains reachable while the panel covers the titlebar.
  // language-toggle.js tracks all bound buttons and keeps them in
  // sync, so this is the only wiring we need here.
  const langBtn = document.getElementById('btn-help-panel-lang');
  if (langBtn) bindLanguageToggle(langBtn);

  // Initial state — all collapsible sections start collapsed.  The
  // pinned section ("Quick Start") stays expanded because its body
  // is never marked hidden.
  const sections = panel.querySelectorAll('.help-section:not(.help-section--pinned)');
  for (const section of sections) {
    collapseSection(section);
  }
}

function isHelpPanelOpen() {
  return isOpen;
}

/**
 * External guard used by the onboarding tour: while a tour is running
 * the help button should be disabled to prevent the panel from
 * opening on top of the spotlight.  The tour component calls this
 * with `true` before starting and `false` after finishing.
 */
function setHelpButtonDisabled(disabled) {
  if (!helpBtn) return;
  helpBtn.disabled = Boolean(disabled);
}

export {
  initHelpPanel,
  openHelpPanel,
  closeHelpPanel,
  isHelpPanelOpen,
  setHelpButtonDisabled,
};
