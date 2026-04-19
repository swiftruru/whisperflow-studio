'use strict';

const { test, expect } = require('../fixtures/electron-app');

test.describe('navigation — tab switching', () => {
  const tabs = [
    { id: 'models',   pane: '#tab-models'   },
    { id: 'settings', pane: '#tab-settings' },
    { id: 'about',    pane: '#tab-about'    },
    { id: 'main',     pane: '#tab-main'     },
  ];

  test('clicking each tab activates its button and pane', async ({ app }) => {
    const { window } = app;

    for (const { id, pane } of tabs) {
      await window.locator(`.tab-btn[data-tab="${id}"]`).click();
      await expect(window.locator(`.tab-btn[data-tab="${id}"]`)).toHaveClass(/active/);
      await expect(window.locator(pane)).toHaveClass(/active/);
      await expect(window.locator(pane)).toBeVisible();
    }
  });
});
