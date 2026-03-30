'use strict';

import { renderSettings } from './settings-panel.js';

let _profiles = [];
let _activeProfile = 'default';

async function initProfileSwitcher() {
  const container = document.getElementById('profile-switcher-container');
  container.innerHTML = '';

  try {
    _profiles = await window.electronAPI.listProfiles();
  } catch (e) {
    return;
  }

  if (_profiles.length <= 1) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  for (const profile of _profiles) {
    const btn = document.createElement('button');
    btn.className = 'profile-chip' + (profile.name === _activeProfile ? ' active' : '');
    btn.textContent = profile.name;
    btn.addEventListener('click', () => switchProfile(profile));
    container.appendChild(btn);
  }
}

async function switchProfile(profile) {
  if (profile.name === _activeProfile) return;

  await window.electronAPI.loadProfile(profile.configPath);
  _activeProfile = profile.name;

  document.querySelectorAll('.profile-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.textContent === _activeProfile);
  });

  // Reload settings panel
  await renderSettings();
}

export { initProfileSwitcher };
