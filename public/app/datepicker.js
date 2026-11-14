/**
 * The calendar of the design system, for every place that picks a day.
 *
 * It works in two ways:
 *
 * - Every `<input type="date">` on the page — written by the server or added
 *   later by a script — is replaced on screen by a button that opens the
 *   calendar. The native input stays in the document, hidden: it still holds
 *   the value, still submits with its form and still fires `change`, so the
 *   code that uses it does not need to know anything changed.
 *   `data-picker="icon"` on the input shows only the calendar icon.
 *
 * - `window.ClockCalendar.month()` draws one month for a script that needs
 *   days to click on. The period picker of the reports is built with it.
 */
(function () {
  'use strict';

  /** Native accessor of `input.value`, used to notice values set by scripts. */
  const NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const SVG = 'http://www.w3.org/2000/svg';
  /** The week starts on Monday everywhere in the app. */
  const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  /**
   * What the script keeps for each upgraded input.
   * @typedef {{wrap: HTMLElement, button: HTMLButtonElement, paint: function(): void}} Upgraded
   */

  /** @type {WeakMap<HTMLInputElement, Upgraded>} */
  const upgraded = new WeakMap();
  /** Closes the calendar that is open now, if any. @type {(function(): void)|null} */
  let closeOpen = null;
  let nextId = 0;

  /**
   * @param {number} n
   * @returns {string}
   */
  function pad(n) { return String(n).padStart(2, '0'); }

  /**
   * A date as a day key.
   * @param {Date} d
   * @returns {string} YYYY-MM-DD, in the local time zone.
   */
  function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /**
   * A day key as a date.
   * @param {string} key YYYY-MM-DD
   * @returns {Date|null} Null when the text is not a real day.
   */
  function dateOf(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return keyOf(d) === key ? d : null;
  }

  /**
   * "Saturday, November 14, 2026": how a day is read out loud.
   * @param {string} key
   * @returns {string}
   */
  function longLabel(key) {
    const d = dateOf(key);
    return d ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
  }

  /**
   * "Sat, Nov 14, 2026": a day written the short way.
   * @param {string} key
   * @param {boolean} [compact] Leaves the year out when it is the current one
   *   ("Sat, Nov 14"), so the day fits a narrow field.
   * @returns {string}
   */
  function shortLabel(key, compact) {
    const d = dateOf(key);
    if (!d) return '';
    const sameYear = compact && d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString('en-US', sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  /**
   * "November 2026".
   * @param {Date} first Any day of the month.
   * @returns {string}
   */
  function monthName(first) { return first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }

  /**
   * Creates an element with a class and, optionally, a text.
   * @param {string} tag
   * @param {string} className
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * The calendar icon.
   * @returns {SVGElement}
   */
  function icon() {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'dp-ico');
    ['M3.75 3.25h8.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2Z', 'M1.75 6.75h12.5', 'M5.25 1.75v3M10.75 1.75v3'].forEach(function (d) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
    });
    return svg;
  }

  /**
   * A round button with an arrow, to move between months.
   * @param {string} arrow The character shown.
   * @param {string} label What the button does, for screen readers.
   * @param {function(): void} onClick
   * @returns {HTMLButtonElement}
   */
  function navButton(arrow, label, onClick) {
    const b = /** @type {HTMLButtonElement} */ (make('button', 'cal-nav', arrow));
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Draws one month: its name, the weekdays and one button per day. Each day
   * button carries its day key in `data-day`, so the caller can mark days
   * (class `cal-in` for a day inside a period, `cal-end` for its two ends).
   * @param {Date} first First day of the month to draw.
   * @param {{onPick: function(string): void, onHover?: function(string): void, selected?: string, min?: string, max?: string, title?: boolean}} opts
   *   `selected`, `min` and `max` are day keys; `title: false` leaves the month name out.
   * @returns {HTMLElement}
   */
  function month(first, opts) {
    const today = keyOf(new Date());
    const wrap = make('div', 'cal-month');
    const grid = make('div', 'cal-grid');
    if (opts.title !== false) wrap.appendChild(make('strong', 'cal-title', monthName(first)));
    WEEKDAYS.forEach(function (w) { grid.appendChild(make('small', '', w)); });
    for (let i = (first.getDay() + 6) % 7; i > 0; i--) grid.appendChild(make('span', ''));
    const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    for (let n = 1; n <= count; n++) {
      const key = keyOf(new Date(first.getFullYear(), first.getMonth(), n));
      const day = /** @type {HTMLButtonElement} */ (make('button', 'cal-day' + (key === today ? ' cal-today' : '') + (key === opts.selected ? ' cal-end' : ''), String(n)));
      day.type = 'button';
      day.dataset.day = key;
      day.setAttribute('aria-label', longLabel(key) + (key === today ? ', today' : ''));
      if (opts.selected !== undefined) day.setAttribute('aria-pressed', String(key === opts.selected));
      day.disabled = Boolean((opts.min && key < opts.min) || (opts.max && key > opts.max));
      day.addEventListener('click', function () { opts.onPick(key); });
      if (opts.onHover) day.addEventListener('mouseenter', function () { opts.onHover(key); });
      grid.appendChild(day);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  /**
   * The text that names the field: its `aria-label`, or its `<label>`.
   * @param {HTMLInputElement} input
   * @returns {string}
   */
  function nameOf(input) {
    const own = input.getAttribute('aria-label');
    if (own) return own;
    const label = input.labels && input.labels[0];
    return label ? (label.textContent || '').trim() : '';
  }

  /**
   * Opens the calendar of an input under (or over) its button.
   * @param {HTMLInputElement} input
   * @param {Upgraded} state
   * @returns {void}
   */
  function open(input, state) {
    if (closeOpen) closeOpen();
    const button = state.button;
    const min = dateOf(input.min) ? input.min : '';
    const max = dateOf(input.max) ? input.max : '';
    const chosen = dateOf(input.value) ? input.value : '';
    const today = keyOf(new Date());
    const id = 'cal-pop-' + (++nextId);
    const pop = make('div', 'cal-pop');
    const title = make('strong', 'cal-title');
    const body = make('div', '');
    /** The day the keyboard is on. */
    let focusKey = clamp(chosen || today);
    let view = monthOf(focusKey);

    /**
     * Keeps a day inside the allowed limits of the field.
     * @param {string} key
     * @returns {string}
     */
    function clamp(key) {
      if (min && key < min) return min;
      if (max && key > max) return max;
      return key;
    }

    /**
     * @param {string} key
     * @returns {Date} First day of the month of that day.
     */
    function monthOf(key) {
      const d = /** @type {Date} */ (dateOf(key));
      return new Date(d.getFullYear(), d.getMonth(), 1);
    }

    /**
     * Draws the month in view. Only the keyboard day can be reached with Tab.
     * @param {boolean} focus Whether to move the focus to the keyboard day.
     * @returns {void}
     */
    function draw(focus) {
      const drawn = month(view, { title: false, selected: chosen, min: min, max: max, onPick: pick });
      title.textContent = monthName(view);
      body.replaceChildren(drawn);
      Array.prototype.forEach.call(drawn.querySelectorAll('button[data-day]'), function (day) {
        day.tabIndex = day.dataset.day === focusKey ? 0 : -1;
      });
      if (focus) focusDay();
    }

    /**
     * Puts the focus on the keyboard day.
     * @returns {void}
     */
    function focusDay() {
      const day = /** @type {HTMLElement|null} */ (body.querySelector('button[data-day="' + focusKey + '"]'));
      if (day) day.focus();
    }

    /**
     * Moves the keyboard day, changing the month in view when needed.
     * @param {Date} target
     * @returns {void}
     */
    function show(target) {
      focusKey = clamp(keyOf(target));
      view = monthOf(focusKey);
      draw(true);
    }

    /**
     * Moves a number of months, keeping the day of the month when it exists.
     * @param {number} step Negative for the past.
     * @param {boolean} focus Whether the focus follows to the day.
     * @returns {void}
     */
    function go(step, focus) {
      const from = /** @type {Date} */ (dateOf(focusKey));
      const target = new Date(view.getFullYear(), view.getMonth() + step, 1);
      const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      focusKey = clamp(keyOf(new Date(target.getFullYear(), target.getMonth(), Math.min(from.getDate(), last))));
      view = monthOf(focusKey);
      draw(focus);
    }

    /**
     * Chooses a day: the native input gets the value and fires `change`.
     * @param {string} key
     * @returns {void}
     */
    function pick(key) {
      close();
      button.focus();
      if (input.value === key) return;
      NATIVE_VALUE.set.call(input, key);
      state.paint();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** @returns {void} */
    function place() {
      const box = button.getBoundingClientRect();
      const height = pop.offsetHeight;
      const below = window.innerHeight - box.bottom - 12;
      const above = box.top - 12;
      const up = below < height && above > below;
      pop.style.left = Math.max(8, Math.min(box.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = Math.max(8, up ? box.top - 6 - height : box.bottom + 6) + 'px';
    }

    /** @returns {void} */
    function close() {
      pop.remove();
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-controls');
      document.removeEventListener('mousedown', outside, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      closeOpen = null;
    }

    /** @param {MouseEvent} ev @returns {void} */
    function outside(ev) {
      const target = /** @type {Node} */ (ev.target);
      if (!pop.contains(target) && !button.contains(target)) close();
    }

    /** @param {Event} ev @returns {void} */
    function onScroll(ev) { if (!pop.contains(/** @type {Node} */ (ev.target))) close(); }

    /**
     * Keyboard inside the calendar: arrows walk the days, Page Up and Page
     * Down the months, and Tab stays inside until the calendar closes.
     * @param {KeyboardEvent} ev
     * @returns {void}
     */
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); button.focus(); return; }
      if (ev.key === 'Tab') {
        const stops = Array.prototype.filter.call(pop.querySelectorAll('button'), function (b) { return !b.disabled && b.tabIndex !== -1; });
        const at = stops.indexOf(document.activeElement);
        const next = stops[(at + (ev.shiftKey ? -1 : 1) + stops.length) % stops.length];
        ev.preventDefault();
        if (next) next.focus();
        return;
      }
      const active = /** @type {HTMLElement|null} */ (document.activeElement);
      if (!active || !active.dataset || !active.dataset.day) return;
      const d = /** @type {Date} */ (dateOf(active.dataset.day));
      const weekday = (d.getDay() + 6) % 7;
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
      if (Object.prototype.hasOwnProperty.call(moves, ev.key)) {
        ev.preventDefault();
        show(new Date(d.getFullYear(), d.getMonth(), d.getDate() + moves[ev.key]));
      } else if (ev.key === 'PageUp' || ev.key === 'PageDown') {
        ev.preventDefault();
        focusKey = active.dataset.day;
        go((ev.key === 'PageUp' ? -1 : 1) * (ev.shiftKey ? 12 : 1), true);
      }
    }

    const head = make('div', 'cal-head');
    head.appendChild(navButton('‹', 'Previous month', function () { go(-1, false); }));
    head.appendChild(title);
    head.appendChild(navButton('›', 'Next month', function () { go(1, false); }));
    title.setAttribute('aria-live', 'polite');

    const foot = make('div', 'cal-foot');
    const jump = /** @type {HTMLButtonElement} */ (make('button', 'btn-ghost btn-sm', 'Today'));
    jump.type = 'button';
    jump.disabled = clamp(today) !== today;
    jump.addEventListener('click', function () { pick(today); });
    foot.appendChild(make('small', 'muted', chosen ? shortLabel(chosen) : 'No day chosen'));
    foot.appendChild(jump);

    pop.id = id;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a day');
    pop.appendChild(head);
    pop.appendChild(body);
    pop.appendChild(foot);
    pop.addEventListener('keydown', onKey);

    // Inside a modal <dialog>, anything outside it is behind the modal and
    // cannot be clicked, so the calendar opens inside the dialog itself.
    (input.closest('dialog') || document.body).appendChild(pop);
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', id);
    draw(false);
    place();
    focusDay();
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    closeOpen = close;
  }

  /**
   * Replaces one date input on screen. Safe to call again for the same input:
   * an input that a script moved somewhere else gets its button back.
   * @param {HTMLInputElement} input
   * @returns {void}
   */
  function upgrade(input) {
    if (input.type !== 'date') return;
    const known = upgraded.get(input);
    if (known) {
      if (input.parentElement !== known.wrap && input.parentElement) {
        input.parentElement.insertBefore(known.wrap, input);
        known.wrap.appendChild(input);
        known.paint();
      }
      return;
    }

    const iconOnly = input.dataset.picker === 'icon';
    const wrap = make('span', 'dp' + (iconOnly ? ' dp-icon-only' : ''));
    const label = make('span', 'dp-label');
    const button = /** @type {HTMLButtonElement} */ (make('button', 'dp-btn'));
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(icon());
    if (!iconOnly) button.appendChild(label);

    /** @returns {void} */
    function paint() {
      const name = nameOf(input);
      const text = shortLabel(input.value) || 'Pick a day';
      label.textContent = shortLabel(input.value, true) || text;
      label.classList.toggle('dp-empty', !dateOf(input.value));
      button.disabled = input.disabled;
      button.setAttribute('aria-label', name ? name + ': ' + text : text);
      button.title = iconOnly ? (input.title || name || 'Pick a day') : longLabel(input.value);
    }

    /** @type {Upgraded} */
    const state = { wrap: wrap, button: button, paint: paint };
    upgraded.set(input, state);

    // A value set by a script (`input.value = "2026-11-14"`) fires no event,
    // so the setter itself repaints the button.
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: function () { return NATIVE_VALUE.get.call(input); },
      set: function (v) { NATIVE_VALUE.set.call(input, v); paint(); },
    });

    button.addEventListener('click', function () {
      if (button.getAttribute('aria-expanded') === 'true') { if (closeOpen) closeOpen(); }
      else open(input, state);
    });
    button.addEventListener('keydown', function (ev) {
      if (button.getAttribute('aria-expanded') === 'true') return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); open(input, state); }
    });
    // A click on the field's <label> focuses the hidden input; pass it on.
    input.addEventListener('focus', function () { button.focus(); });
    input.addEventListener('change', paint);
    if (input.form) input.form.addEventListener('reset', function () { setTimeout(paint, 0); });
    new MutationObserver(paint).observe(input, { attributes: true, attributeFilter: ['disabled', 'aria-label', 'title'] });

    if (input.parentElement) input.parentElement.insertBefore(wrap, input);
    wrap.appendChild(button);
    wrap.appendChild(input);
    input.classList.add('dp-native');
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    paint();
  }

  /**
   * Upgrades every date input inside a piece of the page.
   * @param {ParentNode} scope
   * @returns {void}
   */
  function scan(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll('input[type="date"]'), upgrade);
  }

  /** @returns {void} */
  function start() {
    scan(document);
    new MutationObserver(function (changes) {
      changes.forEach(function (change) {
        Array.prototype.forEach.call(change.addedNodes, function (node) {
          if (!(node instanceof Element)) return;
          if (node instanceof HTMLInputElement) upgrade(node);
          else if (node.firstElementChild) scan(node);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  window.ClockCalendar = { month: month, navButton: navButton, keyOf: keyOf };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
