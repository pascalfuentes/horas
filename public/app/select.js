/**
 * Custom dropdowns.
 *
 * Every single-choice `<select>` on the page — written by the server or added
 * later by a script — is replaced on screen by a button and a list drawn with
 * the design system. The native `<select>` stays in the document, hidden: it
 * still holds the value, still submits with its form and still fires `change`,
 * so the code that uses it does not need to know anything changed.
 */
(function () {
  'use strict';

  /** Native accessor of `select.value`, used to notice values set by scripts. */
  const NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  const SVG = 'http://www.w3.org/2000/svg';

  /**
   * What the script keeps for each upgraded select.
   * @typedef {{wrap: HTMLElement, button: HTMLButtonElement, paint: function(): void}} Upgraded
   */

  /** @type {WeakMap<HTMLSelectElement, Upgraded>} */
  const upgraded = new WeakMap();
  /** Closes the list that is open now, if any. @type {(function(): void)|null} */
  let closeOpen = null;
  let nextId = 0;

  /**
   * The little arrow on the right of the button.
   * @returns {SVGElement}
   */
  function chevron() {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'sel-chevron');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', 'M2.5 4.5 6 8l3.5-3.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  /**
   * The text that names the field: its `aria-label`, or its `<label>`.
   * @param {HTMLSelectElement} select
   * @returns {string}
   */
  function nameOf(select) {
    const own = select.getAttribute('aria-label');
    if (own) return own;
    const label = select.labels && select.labels[0];
    return label ? (label.textContent || '').trim() : '';
  }

  /**
   * Opens the list of a select under (or over) its button.
   * @param {HTMLSelectElement} select
   * @param {Upgraded} state
   * @returns {void}
   */
  function open(select, state) {
    if (closeOpen) closeOpen();
    const button = state.button;
    const options = Array.prototype.slice.call(select.options);
    if (!options.length) return;
    const menu = document.createElement('div');
    const id = 'sel-menu-' + (++nextId);
    menu.className = 'sel-menu';
    menu.id = id;
    menu.setAttribute('role', 'listbox');
    let active = Math.max(0, select.selectedIndex);
    let typed = '';
    let typedAt = 0;

    const items = options.map(function (option, i) {
      const item = document.createElement('div');
      item.className = 'sel-opt';
      item.id = id + '-' + i;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === select.selectedIndex));
      if (option.disabled) item.setAttribute('aria-disabled', 'true');
      item.textContent = option.textContent;
      item.addEventListener('mousemove', function () { move(i); });
      item.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      item.addEventListener('click', function () { pick(i); });
      menu.appendChild(item);
      return item;
    });

    /**
     * Highlights one option and keeps it in view.
     * @param {number} i
     * @returns {void}
     */
    function move(i) {
      active = Math.max(0, Math.min(items.length - 1, i));
      items.forEach(function (item, n) { item.classList.toggle('sel-opt-active', n === active); });
      button.setAttribute('aria-activedescendant', items[active].id);
      items[active].scrollIntoView({ block: 'nearest' });
    }

    /**
     * Chooses one option: the native select gets the value and fires `change`.
     * @param {number} i
     * @returns {void}
     */
    function pick(i) {
      if (options[i].disabled) return;
      close();
      if (select.selectedIndex === i) return;
      select.selectedIndex = i;
      state.paint();
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** @returns {void} */
    function place() {
      const box = button.getBoundingClientRect();
      const below = window.innerHeight - box.bottom - 12;
      const above = box.top - 12;
      const up = below < 160 && above > below;
      menu.style.minWidth = box.width + 'px';
      menu.style.maxHeight = Math.max(120, Math.min(300, up ? above : below)) + 'px';
      menu.style.left = Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      if (up) { menu.style.top = ''; menu.style.bottom = (window.innerHeight - box.top + 6) + 'px'; }
      else { menu.style.bottom = ''; menu.style.top = (box.bottom + 6) + 'px'; }
    }

    /** @returns {void} */
    function close() {
      menu.remove();
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-activedescendant');
      button.removeAttribute('aria-controls');
      document.removeEventListener('mousedown', outside, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      button.removeEventListener('keydown', onKey);
      button.removeEventListener('blur', close);
      closeOpen = null;
    }

    /** @param {MouseEvent} ev @returns {void} */
    function outside(ev) {
      const target = /** @type {Node} */ (ev.target);
      if (!menu.contains(target) && !button.contains(target)) close();
    }

    /** @param {Event} ev @returns {void} */
    function onScroll(ev) { if (!menu.contains(/** @type {Node} */ (ev.target))) close(); }

    /** @param {KeyboardEvent} ev @returns {void} */
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); move(active + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(active - 1); }
      else if (ev.key === 'Home') { ev.preventDefault(); move(0); }
      else if (ev.key === 'End') { ev.preventDefault(); move(items.length - 1); }
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(active); }
      else if (ev.key === 'Tab') close();
      else if (ev.key.length === 1) {
        // Typing jumps to the first option that starts with what was typed.
        const now = Date.now();
        typed = (now - typedAt > 700 ? '' : typed) + ev.key.toLowerCase();
        typedAt = now;
        for (let i = 0; i < options.length; i++) {
          if ((options[i].textContent || '').trim().toLowerCase().indexOf(typed) === 0) { move(i); break; }
        }
      }
    }

    // Inside a modal <dialog>, anything outside it is behind the modal and
    // cannot be seen or clicked, so the list opens inside the dialog itself.
    (select.closest('dialog') || document.body).appendChild(menu);
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', id);
    place();
    move(active);
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    button.addEventListener('keydown', onKey);
    button.addEventListener('blur', close);
    closeOpen = close;
  }

  /**
   * Replaces one select on screen. Safe to call again for the same select:
   * a select that a script moved somewhere else gets its button back.
   * @param {HTMLSelectElement} select
   * @returns {void}
   */
  function upgrade(select) {
    if (select.multiple || select.size > 1) return;
    const known = upgraded.get(select);
    if (known) {
      if (select.parentElement !== known.wrap && select.parentElement) {
        select.parentElement.insertBefore(known.wrap, select);
        known.wrap.appendChild(select);
        known.paint();
      }
      return;
    }

    const wrap = document.createElement('span');
    const label = document.createElement('span');
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    wrap.className = 'sel';
    label.className = 'sel-label';
    button.type = 'button';
    button.className = 'sel-btn';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(label);
    button.appendChild(chevron());

    /** @returns {void} */
    function paint() {
      const chosen = select.options[select.selectedIndex];
      const name = nameOf(select);
      label.textContent = chosen ? chosen.textContent : '';
      button.disabled = select.disabled;
      button.setAttribute('aria-label', name ? name + ': ' + label.textContent : label.textContent || '');
    }

    /** @type {Upgraded} */
    const state = { wrap: wrap, button: button, paint: paint };
    upgraded.set(select, state);

    // A value set by a script (`select.value = "x"`) fires no event, so the
    // setter itself repaints the button.
    Object.defineProperty(select, 'value', {
      configurable: true,
      get: function () { return NATIVE_VALUE.get.call(select); },
      set: function (v) { NATIVE_VALUE.set.call(select, v); paint(); },
    });

    button.addEventListener('click', function () {
      if (button.getAttribute('aria-expanded') === 'true') { if (closeOpen) closeOpen(); }
      else open(select, state);
    });
    button.addEventListener('keydown', function (ev) {
      if (button.getAttribute('aria-expanded') === 'true') return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); open(select, state); }
    });
    // A click on the field's <label> focuses the hidden select; pass it on.
    select.addEventListener('focus', function () { button.focus(); });
    select.addEventListener('change', paint);
    if (select.form) select.form.addEventListener('reset', function () { setTimeout(paint, 0); });
    new MutationObserver(paint).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'aria-label'] });

    if (select.parentElement) select.parentElement.insertBefore(wrap, select);
    wrap.appendChild(button);
    wrap.appendChild(select);
    select.classList.add('sel-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    paint();
  }

  /**
   * Upgrades every select inside a piece of the page.
   * @param {ParentNode} scope
   * @returns {void}
   */
  function scan(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll('select'), upgrade);
  }

  /** @returns {void} */
  function start() {
    scan(document);
    new MutationObserver(function (changes) {
      changes.forEach(function (change) {
        Array.prototype.forEach.call(change.addedNodes, function (node) {
          if (!(node instanceof Element)) return;
          if (node instanceof HTMLSelectElement) upgrade(node);
          else if (node.firstElementChild) scan(node);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
