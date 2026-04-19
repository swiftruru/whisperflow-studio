'use strict';

/**
 * Themed select — replaces native <select> with a button + listbox so
 * the open menu matches the cream/amber theme instead of dropping into
 * the OS-native dark dropdown (macOS in particular).
 *
 * Semantics are preserved by rendering a real <select> element inside
 * the wrapper.  The native select is visually hidden but remains in
 * the DOM so:
 *   - form-value collectors that iterate [data-section][data-key] and
 *     read `el.value` keep working with zero changes
 *   - dirty tracking that listens for 'change' / 'input' events on the
 *     same selector still fires (we dispatch both when the user picks
 *     a new option)
 *
 * Exposes a small imperative API on the returned root element so code
 * that needs to rebuild the option list at runtime (e.g. the model
 * select refreshing after the Python venv finishes bootstrapping) can
 * do so without re-constructing the whole wrapper.
 */

let _openInstance = null;

function closeOpenInstance() {
  if (_openInstance) _openInstance._close();
}

// Global listeners — install once.  Each open dropdown registers
// itself as `_openInstance`, so a single set of document listeners
// can route outside-click and keyboard events correctly.
if (typeof document !== 'undefined' && !document._themedSelectWired) {
  document._themedSelectWired = true;
  document.addEventListener('mousedown', (e) => {
    if (!_openInstance) return;
    if (!_openInstance.root.contains(e.target)) _openInstance._close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!_openInstance) return;
    _openInstance._handleKey(e);
  }, true);
  // Scrolling the page while a menu is open would leave the absolute
  // menu stranded at its old coordinates; close it.  But scrolling
  // *inside* the menu itself is expected (long option lists), so skip
  // closes originating from within the open menu's root.
  window.addEventListener('scroll', (e) => {
    if (!_openInstance) return;
    const target = e.target;
    if (target instanceof Node && _openInstance.root.contains(target)) return;
    _openInstance._close();
  }, true);
}

/**
 * @param {{
 *   options: Array<string | { value: string, label?: string }>,
 *   value?: string,
 *   id?: string,
 *   name?: string,
 *   ariaLabelledBy?: string,
 *   dataset?: Record<string, string>,   // e.g. { section, key } — applied to the hidden <select>
 *   onChange?: (value: string) => void,
 * }} config
 * @returns {HTMLElement} root element with imperative helpers attached
 */
function createThemedSelect(config = {}) {
  const {
    options = [],
    value = '',
    id,
    name,
    ariaLabelledBy,
    dataset = {},
    onChange,
  } = config;

  const root = document.createElement('div');
  root.className = 'themed-select';

  const native = document.createElement('select');
  native.className = 'themed-select-native';
  if (id) native.id = id;
  if (name) native.name = name;
  for (const [k, v] of Object.entries(dataset)) {
    native.dataset[k] = v;
  }

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'themed-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (ariaLabelledBy) trigger.setAttribute('aria-labelledby', ariaLabelledBy);

  const valueEl = document.createElement('span');
  valueEl.className = 'themed-select-value';

  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('class', 'themed-select-chevron');
  chevron.setAttribute('viewBox', '0 0 12 12');
  chevron.setAttribute('width', '12');
  chevron.setAttribute('height', '12');
  chevron.setAttribute('aria-hidden', 'true');
  const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  chevronPath.setAttribute('d', 'M3 4.5l3 3 3-3');
  chevronPath.setAttribute('fill', 'none');
  chevronPath.setAttribute('stroke', 'currentColor');
  chevronPath.setAttribute('stroke-width', '1.5');
  chevronPath.setAttribute('stroke-linecap', 'round');
  chevronPath.setAttribute('stroke-linejoin', 'round');
  chevron.appendChild(chevronPath);

  trigger.appendChild(valueEl);
  trigger.appendChild(chevron);

  const menu = document.createElement('ul');
  menu.className = 'themed-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  root.appendChild(native);
  root.appendChild(trigger);
  root.appendChild(menu);

  // ── Normalize options to { value, label } shape ─────────────
  function normalize(opts) {
    return opts.map((o) => (typeof o === 'string' ? { value: o, label: o } : {
      value: String(o.value),
      label: o.label != null ? String(o.label) : String(o.value),
    }));
  }

  let _options = [];
  let _value = '';

  function render() {
    // Rebuild native <select>.
    native.innerHTML = '';
    for (const opt of _options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === _value) o.selected = true;
      native.appendChild(o);
    }
    // If the current value isn't in the list (e.g. custom value saved
    // earlier), prepend it so the select can still represent it.
    if (_value !== '' && !_options.some((o) => o.value === _value)) {
      const o = document.createElement('option');
      o.value = _value;
      o.textContent = _value;
      o.selected = true;
      native.insertBefore(o, native.firstChild);
    }

    // Rebuild menu.
    menu.innerHTML = '';
    const allForMenu = _options.slice();
    if (_value !== '' && !_options.some((o) => o.value === _value)) {
      allForMenu.unshift({ value: _value, label: _value });
    }
    for (const opt of allForMenu) {
      const li = document.createElement('li');
      li.className = 'themed-select-option' + (opt.value === _value ? ' active' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('tabindex', '-1');
      li.setAttribute('aria-selected', opt.value === _value ? 'true' : 'false');
      li.dataset.value = opt.value;
      li.textContent = opt.label;
      li.addEventListener('click', (e) => {
        e.stopPropagation();
        select(opt.value);
        close();
        trigger.focus();
      });
      menu.appendChild(li);
    }

    // Update trigger label.
    const current = allForMenu.find((o) => o.value === _value);
    valueEl.textContent = current ? current.label : '';
  }

  function select(newValue) {
    if (newValue === _value) return;
    _value = newValue;
    native.value = newValue;
    // Fire both events so dirty tracking and any legacy listeners hear
    // about the change.  bubbles:true so delegated handlers on ancestor
    // containers also see the event.
    native.dispatchEvent(new Event('input', { bubbles: true }));
    native.dispatchEvent(new Event('change', { bubbles: true }));
    render();
    if (typeof onChange === 'function') {
      try { onChange(newValue); } catch (_) {}
    }
  }

  function open() {
    if (!menu.hidden) return;
    closeOpenInstance();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    _openInstance = instance;
    const activeLi = menu.querySelector('.themed-select-option.active')
      || menu.querySelector('.themed-select-option');
    activeLi?.focus();
  }

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (_openInstance === instance) _openInstance = null;
  }

  const instance = {
    root,
    _close: close,
    _handleKey(e) {
      if (menu.hidden) return;
      const opts = Array.from(menu.querySelectorAll('.themed-select-option'));
      const idx = opts.findIndex((el) => el === document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        trigger.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        (opts[Math.min(idx + 1, opts.length - 1)] || opts[0])?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (opts[Math.max(idx - 1, 0)] || opts[opts.length - 1])?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        opts[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        opts[opts.length - 1]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        // When focus is on an option, select it.
        const focused = opts[idx];
        if (focused) {
          e.preventDefault();
          select(focused.dataset.value);
          close();
          trigger.focus();
        }
      } else if (e.key === 'Tab') {
        close();
      }
    },
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open(); else close();
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      open();
    }
  });

  // ── Public imperative API ────────────────────────────────────
  root.setValue = (v) => {
    _value = String(v);
    native.value = _value;
    render();
  };
  root.getValue = () => _value;
  root.setOptions = (newOptions, { preserveValue = true } = {}) => {
    _options = normalize(newOptions);
    if (!preserveValue) _value = _options[0]?.value || '';
    render();
  };
  root.focus = () => trigger.focus();
  // Expose the hidden native for callers that need direct DOM access
  // (e.g. querySelector('[data-key="model"]') already returns it).
  root.nativeSelect = native;

  _options = normalize(options);
  _value = String(value);
  render();

  return root;
}

export { createThemedSelect };
