/**
 * Time tracking UI (timer, reports, projects and tokens).
 *
 * A single file, no build and no dependencies. Each dashboard page renders
 * a `<div id="horas-app" data-view="…">` and this script builds the screen inside it.
 * All text coming from the database enters the DOM through `textContent`, never as HTML.
 */
(function () {
  'use strict';

  const root = document.getElementById('horas-app');
  if (!root) return;

  /** Base of this workspace's API, e.g. /api/w/my-slug/horas */
  const BASE = root.dataset.base || '';
  /** A read-only role hides everything that writes (the server blocks it anyway). */
  const CAN_WRITE = root.dataset.write === '1';
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /* ------------------------------------------------------------------ */
  /* Utilities                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Calls the workspace's JSON API.
   * @param {string} path Path after the base, e.g. "/entries?from=2026-01-01".
   * @param {string} [method]
   * @param {object} [body]
   * @param {string} [base] Another base, when it is not the horas API.
   * @returns {Promise<any>}
   */
  async function api(path, method, body, base) {
    const res = await fetch((base === undefined ? BASE : base) + path, {
      method: method || 'GET',
      headers: Object.assign({ 'x-timezone': TZ }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
      throw new Error('Session expired.');
    }
    const data = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((data && data.error) || 'Something went wrong (' + res.status + ').');
    return data;
  }

  /**
   * Creates an element.
   * @param {string} tag
   * @param {Object<string, any>} [attrs] `class`, `text`, `on<event>` and regular attributes.
   * @param {Array<Node|string|null|undefined|false>} [children]
   * @returns {HTMLElement}
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /** @param {number} n @returns {string} */
  function pad(n) { return String(n).padStart(2, '0'); }

  /**
   * Seconds -> "1:23:45" (clock).
   * @param {number} s
   * @returns {string}
   */
  function clock(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 3600) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }

  /**
   * Seconds -> "1h 23min" (for reading).
   * @param {number} s
   * @returns {string}
   */
  function human(s) {
    const m = Math.round(s / 60);
    if (m < 60) return m + 'min';
    return Math.floor(m / 60) + 'h ' + pad(m % 60) + 'min';
  }

  /**
   * Money amount in the workspace currency.
   * @param {number} n
   * @param {string} currency ISO 4217 code.
   * @returns {string}
   */
  function money(n, currency) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'BRL' }).format(n || 0);
    } catch (e) {
      return (n || 0).toFixed(2);
    }
  }

  /**
   * Reads a typed duration: "1:30", "1h30", "1h 30m", "45m", "1.5" or "1,5" (hours) or "90" (minutes).
   * @param {string} text
   * @returns {number|null} Seconds, or null if it could not be understood.
   */
  function parseDuration(text) {
    const t = String(text || '').trim().toLowerCase().replace(',', '.');
    if (!t) return null;
    let m = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
    m = t.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*(?:m|min)?)?$/);
    if (m && /h|m/.test(t) && (m[1] || m[2])) return Math.round(Number(m[1] || 0) * 3600) + Number(m[2] || 0) * 60;
    if (/^\d+\.\d+$/.test(t)) return Math.round(Number(t) * 3600);
    if (/^\d+$/.test(t)) return Number(t) * 60;
    return null;
  }

  /**
   * Seconds -> "1:30" (for the duration field).
   * @param {number} s
   * @returns {string}
   */
  function hm(s) {
    const m = Math.round(s / 60);
    return Math.floor(m / 60) + ':' + pad(m % 60);
  }

  /**
   * Local date -> "YYYY-MM-DD".
   * @param {Date} d
   * @returns {string}
   */
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /**
   * Today shifted by N days, at local midnight.
   * @param {number} [offset]
   * @returns {Date}
   */
  function day(offset) {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (offset || 0));
  }

  /**
   * ISO -> "09:30" local.
   * @param {string} iso
   * @returns {string}
   */
  function hhmm(iso) { const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  /**
   * "YYYY-MM-DD" -> "Today", "Yesterday" or "Tue, Nov 10".
   * @param {string} key
   * @returns {string}
   */
  function dayLabel(key) {
    if (key === dayKey(day(0))) return 'Today';
    if (key === dayKey(day(-1))) return 'Yesterday';
    const p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  /**
   * Shows a brief notice at the bottom of the page.
   * @param {string} msg
   * @param {boolean} [isError]
   * @returns {void}
   */
  function toast(msg, isError) {
    // One message at a time: a newer one replaces the one still on screen.
    Array.prototype.forEach.call(document.querySelectorAll('.hr-toast'), function (old) { old.remove(); });
    const t = el('div', { class: 'hr-toast' + (isError ? ' hr-toast-error' : ''), role: 'status', text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  /** What a button says while its action is waiting for the server. */
  const BUSY_LABELS = {
    'Start': 'Starting…', 'Stop': 'Stopping…', 'Save': 'Saving…', 'Delete': 'Deleting…', 'Duplicate': 'Duplicating…',
    'Create': 'Creating…', 'Archive': 'Archiving…', 'Restore': 'Restoring…', 'Revoke': 'Revoking…',
    'Generate token': 'Generating…', 'Export CSV': 'Exporting…', 'Load 30 more days': 'Loading…',
    'Download backup (JSON)': 'Preparing…', 'Download entries (CSV)': 'Preparing…', 'Copy': 'Copying…',
  };

  /**
   * The buttons to lock while a handler runs: the one that was clicked (or the
   * form's submit button), plus every other button in the same form or dialog,
   * so a second action cannot start in the middle of the first.
   * @param {Event|undefined} ev
   * @returns {{main: HTMLButtonElement, all: HTMLButtonElement[]}|null}
   */
  function busyTargets(ev) {
    if (!ev || !ev.type || !ev.currentTarget || !ev.currentTarget.querySelector) return null;
    const el0 = /** @type {HTMLElement} */ (ev.currentTarget);
    const main = ev.type === 'submit' ? el0.querySelector('button[type="submit"]') : (ev.type === 'click' && el0.tagName === 'BUTTON' ? el0 : null);
    if (!main) return null;
    const scope = main.closest('form') || main.closest('.row-actions') || main.parentElement;
    const all = scope ? Array.prototype.slice.call(scope.querySelectorAll('button')) : [main];
    return { main: /** @type {HTMLButtonElement} */ (main), all: all.indexOf(main) === -1 ? all.concat([main]) : all };
  }

  /**
   * Puts buttons in the waiting state and returns a function that undoes it.
   * The label is only restored if nothing else changed it meanwhile (the timer
   * button, for instance, is relabelled by the screen itself after a start).
   * @param {{main: HTMLButtonElement, all: HTMLButtonElement[]}} targets
   * @returns {function(): void}
   */
  function setBusy(targets) {
    const main = targets.main;
    const label = main.textContent;
    const plain = main.children.length === 0;
    const busy = main.getAttribute('data-busy') || BUSY_LABELS[label] || (/^Import /.test(label) ? 'Importing…' : 'Working…');
    const locked = targets.all.filter(function (b) { return !b.disabled; });
    locked.forEach(function (b) { b.disabled = true; });
    main.setAttribute('aria-busy', 'true');
    if (plain) main.textContent = busy;
    return function () {
      locked.forEach(function (b) { b.disabled = false; });
      main.removeAttribute('aria-busy');
      if (plain && main.textContent === busy) main.textContent = label;
    };
  }

  /**
   * Wraps an async handler. While it waits for the server, the button that
   * started it is disabled and says so; an error becomes a notice instead of
   * vanishing into the console.
   * @param {function(...any): (Promise<any>|any)} fn
   * @returns {function(...any): void}
   */
  function safe(fn) {
    return function () {
      const targets = busyTargets(arguments[0]);
      // A second click while the first is still waiting does nothing.
      if (targets && targets.main.getAttribute('aria-busy') === 'true') return;
      const release = targets ? setBusy(targets) : function () {};
      let pending;
      try {
        pending = Promise.resolve(fn.apply(null, arguments));
      } catch (e) {
        pending = Promise.reject(e);
      }
      pending.catch(function (e) { toast(e.message, true); }).then(release);
    };
  }

  /**
   * Shows a waiting message inside a container while something loads.
   * @param {HTMLElement} container
   * @param {string} message
   * @returns {void}
   */
  function waiting(container, message) {
    container.setAttribute('aria-busy', 'true');
    container.replaceChildren(el('p', { class: 'hr-waiting', role: 'status', text: message }));
  }

  /**
   * Project `<select>`.
   * @param {Array<object>} projects
   * @param {number|null} selected
   * @param {string} [emptyLabel]
   * @returns {HTMLSelectElement}
   */
  function projectSelect(projects, selected, emptyLabel) {
    const s = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': 'Project' }));
    s.appendChild(el('option', { value: '0', text: emptyLabel || 'No project' }));
    projects.forEach(function (p) {
      if (p.archived && p.id !== selected) return;
      s.appendChild(el('option', { value: String(p.id), text: p.client ? p.name + ' · ' + p.client : p.name, selected: p.id === selected }));
    });
    return s;
  }

  /**
   * Opens a small floating panel under an anchor. It closes on Escape, on a
   * click outside, or when `close()` is called; only one is open at a time.
   * @param {HTMLElement} anchor Element the panel hangs from (must be inside a positioned parent).
   * @param {function(function(): void): HTMLElement} build Receives `close` and returns the panel.
   * @returns {void}
   */
  function popover(anchor, build) {
    const open = document.querySelector('.hr-menu');
    if (open) open.dispatchEvent(new Event('hr-close'));
    /** @returns {void} */
    function close() {
      panel.remove();
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      anchor.setAttribute('aria-expanded', 'false');
    }
    /** @param {MouseEvent} ev @returns {void} */
    function outside(ev) { if (!panel.contains(/** @type {Node} */ (ev.target)) && !anchor.contains(/** @type {Node} */ (ev.target))) close(); }
    /** @param {KeyboardEvent} ev @returns {void} */
    function onKey(ev) { if (ev.key === 'Escape') { close(); anchor.focus(); } }
    const panel = build(close);
    panel.classList.add('hr-menu');
    panel.addEventListener('hr-close', close);
    anchor.setAttribute('aria-expanded', 'true');
    anchor.parentElement.appendChild(panel);
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
    const first = /** @type {HTMLElement|null} */ (panel.querySelector('input, button'));
    if (first) first.focus();
  }

  /**
   * "Nov 1 – Nov 13, 2026": a period written the short way.
   * @param {string} from Day key (YYYY-MM-DD).
   * @param {string} to Day key.
   * @returns {string}
   */
  function rangeLabel(from, to) {
    const a = from.split('-').map(Number);
    const b = to.split('-').map(Number);
    const first = new Date(a[0], a[1] - 1, a[2]);
    const last = new Date(b[0], b[1] - 1, b[2]);
    const end = last.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    if (from === to) return end;
    return first.toLocaleDateString('en-US', a[0] === b[0] ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }) + ' – ' + end;
  }

  /**
   * One control for a period: it shows the dates, and opens a calendar where
   * the first click is the start day and the second is the end day. Ready-made
   * periods ("This week", "Last month"…) sit beside the calendar.
   * @param {{presets: Object<string, {label: string, range: function(): Date[]}>, preset: string, onChange: function(): void}} opts
   *   `preset` is the period chosen at first.
   * @returns {{wrap: HTMLElement, from: function(): string, to: function(): string}} `from()`/`to()` give day keys.
   */
  function rangePicker(opts) {
    const first = opts.presets[opts.preset].range();
    let from = dayKey(first[0]);
    let to = dayKey(first[1]);
    let presetKey = opts.preset;
    const name = el('small', { class: 'hr-range-name' });
    const dates = el('span', { class: 'hr-range-dates' });
    const button = el('button', { type: 'button', class: 'hr-range', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, [name, dates]);
    const wrap = el('span', { class: 'hr-pick' }, [button]);

    /** @returns {void} */
    function paint() {
      name.textContent = opts.presets[presetKey] ? opts.presets[presetKey].label : 'Custom';
      dates.textContent = rangeLabel(from, to);
      button.setAttribute('aria-label', 'Period: ' + name.textContent + ', ' + dates.textContent);
    }

    button.addEventListener('click', function () {
      if (button.getAttribute('aria-expanded') === 'true') { wrap.querySelector('.hr-menu').dispatchEvent(new Event('hr-close')); return; }
      popover(button, function (close) {
        let a = from;
        let b = to;
        let picking = false;
        const last = to.split('-').map(Number);
        // Two months side by side, ending on the month of the last day.
        let view = new Date(last[0], last[1] - 2, 1);
        const months = el('div', { class: 'hr-cal-months' });
        const hint = el('small', { class: 'muted hr-cal-hint' });

        /**
         * Applies a period and closes.
         * @param {string} start @param {string} end @param {string} key Preset key, or "custom".
         * @returns {void}
         */
        function commit(start, end, key) {
          from = start;
          to = end;
          presetKey = key;
          paint();
          close();
          opts.onChange();
        }

        /**
         * Colours the days between the two ends. While the end is still being
         * chosen, `hover` is the day under the pointer.
         * @param {string} [hover]
         * @returns {void}
         */
        function mark(hover) {
          const end = picking ? (hover || a) : b;
          const lo = a < end ? a : end;
          const hi = a < end ? end : a;
          Array.prototype.forEach.call(months.querySelectorAll('button[data-day]'), function (d) {
            const k = d.dataset.day;
            d.classList.toggle('hr-cal-in', k > lo && k < hi);
            d.classList.toggle('hr-cal-end', k === lo || k === hi);
            d.setAttribute('aria-pressed', String(k === lo || k === hi));
          });
          hint.textContent = picking ? 'Now pick the last day.' : 'Pick the first day, then the last day.';
        }

        /**
         * @param {string} k Day that was clicked.
         * @returns {void}
         */
        function choose(k) {
          if (!picking) { a = b = k; picking = true; mark(); return; }
          if (k < a) commit(k, a, 'custom');
          else commit(a, k, 'custom');
        }

        /**
         * @param {Date} month First day of the month to draw.
         * @returns {HTMLElement}
         */
        function grid(month) {
          const todayKey = dayKey(day(0));
          const cells = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(function (w) { return el('small', { class: 'muted', text: w }); });
          for (let i = (month.getDay() + 6) % 7; i > 0; i--) cells.push(el('span', {}));
          const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
          for (let n = 1; n <= count; n++) {
            const k = dayKey(new Date(month.getFullYear(), month.getMonth(), n));
            cells.push(el('button', { type: 'button', class: 'hr-cal-day' + (k === todayKey ? ' hr-cal-today' : ''), 'data-day': k, text: String(n), 'aria-label': dayLabel(k), onclick: function () { choose(k); }, onmouseenter: function () { if (picking) mark(k); } }));
          }
          return el('div', { class: 'hr-cal-month' }, [
            el('strong', { text: month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) }),
            el('div', { class: 'hr-cal-grid' }, cells),
          ]);
        }

        /** @returns {void} */
        function draw() {
          months.replaceChildren(grid(view), grid(new Date(view.getFullYear(), view.getMonth() + 1, 1)));
          mark();
        }

        /**
         * @param {number} step Months to move, negative for the past.
         * @returns {function(): void}
         */
        function go(step) { return function () { view = new Date(view.getFullYear(), view.getMonth() + step, 1); draw(); }; }

        draw();
        return el('div', { class: 'hr-range-panel', role: 'dialog', 'aria-label': 'Choose a period' }, [
          el('div', { class: 'hr-range-presets' }, Object.keys(opts.presets).map(function (key) {
            return el('button', { type: 'button', class: 'hr-menu-item' + (key === presetKey ? ' hr-menu-on' : ''), text: opts.presets[key].label, onclick: function () {
              const r = opts.presets[key].range();
              commit(dayKey(r[0]), dayKey(r[1]), key);
            } });
          })),
          el('div', { class: 'hr-range-cal' }, [
            el('div', { class: 'hr-cal-nav' }, [
              el('button', { type: 'button', class: 'btn-ghost btn-sm', text: '‹', 'aria-label': 'Previous month', onclick: go(-1) }),
              hint,
              el('button', { type: 'button', class: 'btn-ghost btn-sm', text: '›', 'aria-label': 'Next month', onclick: go(1) }),
            ]),
            months,
          ]),
        ]);
      });
    });

    paint();
    return { wrap: wrap, from: function () { return from; }, to: function () { return to; } };
  }

  /**
   * Project chip that opens a menu to pick a project, clear it, or create a
   * new one by typing its name. Used in the timer bar and on every entry row.
   * @param {{projects: object[], value: number|null, onPick: function(number): (Promise<any>|void)}} opts
   *   `projects` is the shared list; a project created here is added to it.
   * @returns {HTMLElement} Wrapper whose `dataset.value` holds the chosen project id ("0" for none).
   */
  function projectPicker(opts) {
    const dot = el('span', { class: 'hr-dot' });
    const name = el('span', { class: 'hr-chip-name' });
    const chip = el('button', { type: 'button', class: 'hr-chip', 'aria-haspopup': 'true', 'aria-expanded': 'false', title: 'Change project' }, [dot, name]);
    const wrap = el('span', { class: 'hr-pick' }, [chip]);

    /**
     * Reflects a choice on the chip.
     * @param {number} id Project id, 0 for none.
     * @returns {void}
     */
    function paint(id) {
      const p = opts.projects.filter(function (x) { return x.id === id; })[0];
      wrap.dataset.value = String(p ? p.id : 0);
      dot.style.background = p ? p.color : 'var(--border-strong)';
      name.textContent = p ? p.name : 'No project';
      chip.classList.toggle('hr-chip-empty', !p);
    }

    /**
     * @param {number} id
     * @param {function(): void} close
     * @returns {Promise<void>}
     */
    async function pick(id, close) {
      close();
      if (String(id) === wrap.dataset.value) return;
      paint(id);
      await opts.onPick(id);
    }

    chip.addEventListener('click', function () {
      if (chip.getAttribute('aria-expanded') === 'true') return;
      popover(chip, function (close) {
        const query = /** @type {HTMLInputElement} */ (el('input', { type: 'text', placeholder: 'Find or create a project', maxlength: '80', 'aria-label': 'Find or create a project' }));
        const list = el('div', { class: 'hr-menu-list' });
        /** @returns {void} */
        function render() {
          const q = query.value.trim().toLowerCase();
          const active = opts.projects.filter(function (p) { return !p.archived && (!q || p.name.toLowerCase().indexOf(q) !== -1 || (p.client || '').toLowerCase().indexOf(q) !== -1); });
          const exact = opts.projects.some(function (p) { return p.name.toLowerCase() === q; });
          list.replaceChildren.apply(list, [
            !q ? el('button', { type: 'button', class: 'hr-menu-item', onclick: safe(function () { return pick(0, close); }) }, [el('span', { class: 'hr-dot', style: 'background:var(--border-strong)' }), 'No project']) : null,
          ].concat(active.slice(0, 50).map(function (p) {
            return el('button', { type: 'button', class: 'hr-menu-item', onclick: safe(function () { return pick(p.id, close); }) }, [
              el('span', { class: 'hr-dot', style: 'background:' + p.color }), el('span', { text: p.name }), p.client ? el('small', { text: p.client }) : null,
            ]);
          })).concat([
            q && !active.length ? el('p', { class: 'hr-menu-empty', text: 'No project matches.' }) : null,
            q && !exact && CAN_WRITE ? el('button', { type: 'button', class: 'hr-menu-item hr-menu-create', 'data-busy': 'Creating…', onclick: safe(async function () {
              const created = await api('/projects', 'POST', { name: query.value.trim() });
              opts.projects.push(created);
              await pick(created.id, close);
            }) }, ['+ Create project “' + query.value.trim() + '”']) : null,
          ]).filter(Boolean));
        }
        query.addEventListener('input', render);
        query.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          const firstOption = /** @type {HTMLElement|null} */ (list.querySelector('.hr-menu-item'));
          if (firstOption) firstOption.click();
        });
        render();
        return el('div', { class: 'hr-menu-project' }, [query, list]);
      });
    });

    paint(opts.value || 0);
    return wrap;
  }

  /**
   * Entry dialog: manual (no `entry`) or editing. Used by the timer and
   * by the detailed report.
   * @param {{entry?: object, projects: object[], tags?: string[], defaults?: {description?: string, project_id?: number|null}, onDone: function(): Promise<void>}} opts
   * @returns {void}
   */
  function entryDialog(opts) {
    const entry = opts.entry;
    const defaults = opts.defaults || {};
    const start = entry ? new Date(entry.start) : new Date(Date.now() - 3600000);
    const end = entry ? new Date(entry.end) : new Date();
    const t = function (d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
    const f = {
      desc: /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'hd-desc', maxlength: '500', value: entry ? entry.description : defaults.description || '' })),
      proj: projectSelect(opts.projects, entry ? entry.project_id : defaults.project_id || null),
      tags: /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'hd-tags', list: 'hd-taglist', placeholder: 'comma-separated', autocomplete: 'off', value: entry ? entry.tags.join(', ') : '' })),
      date: /** @type {HTMLInputElement} */ (el('input', { type: 'date', id: 'hd-date', required: true, value: dayKey(start) })),
      from: /** @type {HTMLInputElement} */ (el('input', { type: 'time', id: 'hd-from', required: true, value: t(start) })),
      to: /** @type {HTMLInputElement} */ (el('input', { type: 'time', id: 'hd-to', required: true, value: t(end) })),
      dur: /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'hd-dur', inputmode: 'text', placeholder: '1:30, 1h30 or 90', autocomplete: 'off' })),
      bill: /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: 'hd-bill', checked: entry ? entry.billable : false })),
    };
    f.proj.id = 'hd-proj';

    /** Start and end as dates; end before start = it ended after midnight. @returns {Date[]} */
    function range() {
      const s = new Date(f.date.value + 'T' + f.from.value);
      const e = new Date(f.date.value + 'T' + f.to.value);
      if (e <= s) e.setDate(e.getDate() + 1);
      return [s, e];
    }
    const syncDur = function () { const r = range(); if (!isNaN(r[1] - r[0])) f.dur.value = hm((r[1] - r[0]) / 1000); };
    syncDur();
    [f.from, f.to, f.date].forEach(function (i) { i.addEventListener('change', syncDur); });
    // Typing the duration moves the END, keeping the start — like in Clockify.
    f.dur.addEventListener('change', function () {
      const secs = parseDuration(f.dur.value);
      if (!secs || secs >= 86400) { toast('Invalid duration. Examples: 1:30, 1h30, 45m, 90.', true); syncDur(); return; }
      f.to.value = t(new Date(range()[0].getTime() + secs * 1000));
      syncDur();
    });

    /** @returns {object} */
    function payload() {
      const r = range();
      return {
        description: f.desc.value,
        project_id: Number(f.proj.value),
        tags: f.tags.value.split(','),
        billable: f.bill.checked,
        start: r[0].toISOString(),
        end: r[1].toISOString(),
      };
    }

    const dlg = /** @type {HTMLDialogElement} */ (el('dialog', { class: 'hr-dialog' }));
    const close = function () { dlg.close(); dlg.remove(); };
    const field = function (label, input) { return el('div', { class: 'field' }, [el('label', { for: input.id, text: label }), input]); };
    const finish = async function () { close(); await opts.onDone(); };

    dlg.appendChild(el('form', { class: 'stack', onsubmit: safe(async function (ev) {
      ev.preventDefault();
      if (entry) await api('/entries/' + entry.id, 'PATCH', payload());
      else await api('/entries', 'POST', payload());
      await finish();
    }) }, [
      el('h2', { text: entry ? 'Edit entry' : 'Manual entry' }),
      field('Description', f.desc),
      field('Project', f.proj),
      el('div', { class: 'hr-grid4' }, [field('Day', f.date), field('Start', f.from), field('End', f.to), field('Duration', f.dur)]),
      field('Tags', f.tags),
      el('datalist', { id: 'hd-taglist' }, (opts.tags || []).map(function (tag) { return el('option', { value: tag }); })),
      el('label', { class: 'hr-check' }, [f.bill, ' Billable']),
      el('div', { class: 'hr-dialog-foot' }, [
        entry && el('button', { type: 'button', class: 'btn-danger btn-sm', text: 'Delete', onclick: safe(async function () {
          if (!confirm('Delete this entry? This cannot be undone.')) return;
          await api('/entries/' + entry.id, 'DELETE');
          await finish();
        }) }),
        entry && el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Duplicate', title: 'Creates another entry with this data', onclick: safe(async function () {
          await api('/entries', 'POST', payload());
          await finish();
        }) }),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn-ghost', text: 'Cancel', onclick: close }),
        el('button', { type: 'submit', text: 'Save' }),
      ]),
    ]));
    dlg.addEventListener('cancel', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  /* ------------------------------------------------------------------ */
  /* Screen: Time                                                       */
  /* ------------------------------------------------------------------ */

  /** @returns {Promise<void>} */
  async function viewTime() {
    /** @type {{projects: object[], running: object|null, entries: object[], status: object|null}} */
    const state = { projects: [], running: null, entries: [], status: null, tags: [] };
    let ticker = 0;
    /** How many days back the list shows; "Load more" adds 30. */
    let windowDays = 30;

    const desc = /** @type {HTMLInputElement} */ (el('input', { type: 'text', placeholder: 'What are you working on?', maxlength: '500', 'aria-label': 'Description' }));
    const projSlot = el('div', { class: 'hr-proj' });
    const bill = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: 'hr-bill' }));
    const clockEl = el('button', { type: 'button', class: 'hr-clock', text: '0:00:00', title: 'Fix the start time', onclick: function () { editStart(); } });
    const more = el('button', { type: 'button', class: 'btn-sm hr-link', text: 'Load 30 more days', onclick: safe(async function () { windowDays += 30; await load(); }) });
    const btn = el('button', { type: 'button', class: 'hr-go', text: 'Start' });
    const totals = el('div', { class: 'hr-totals' });
    const list = el('div', { class: 'hr-days' });

    /** @returns {number} Project chosen in the timer bar, 0 for none. */
    function barProject() { return projSlot.firstChild ? Number(/** @type {HTMLElement} */ (projSlot.firstChild).dataset.value) : 0; }

    /** @returns {void} */
    function paintBar() {
      const r = state.running;
      projSlot.replaceChildren(projectPicker({ projects: state.projects, value: r ? r.project_id : barProject() || null, onPick: function (id) {
        // Before the timer starts, choosing a project brings its billable default along.
        if (!state.running) {
          const chosen = state.projects.filter(function (x) { return x.id === id; })[0];
          bill.checked = !!(chosen && chosen.billable);
          return undefined;
        }
        return patchRunning();
      } }));
      if (r) {
        if (document.activeElement !== desc) desc.value = r.description;
        bill.checked = r.billable;
      }
      clockEl.disabled = !r;
      btn.textContent = r ? 'Stop' : 'Start';
      btn.classList.toggle('hr-stop', !!r);
      clearInterval(ticker);
      const tick = function () {
        const s = r ? (Date.now() - Date.parse(r.start)) / 1000 : 0;
        clockEl.textContent = clock(s);
        document.title = r ? clock(s) + ' · ' + (r.description || 'Timer') : root.dataset.title || document.title;
      };
      tick();
      if (r) ticker = window.setInterval(tick, 1000);
    }

    /** Editing in the bar, while the timer is running, saves straight to the entry. @returns {Promise<void>} */
    async function patchRunning() {
      if (!state.running) return;
      state.running = await api('/entries/' + state.running.id, 'PATCH', {
        description: desc.value,
        project_id: barProject(),
        billable: bill.checked,
      });
    }

    /** @returns {void} */
    function paintList() {
      const st = state.status;
      totals.replaceChildren.apply(totals, st ? [
        el('span', { class: 'badge badge-sun', text: 'Today · ' + human(st.today_seconds) }),
        el('span', { class: 'badge badge-sky', text: 'This week · ' + human(st.week_seconds) }),
      ] : []);
      const done = state.entries.filter(function (e) { return !e.running; });
      if (!done.length) {
        list.replaceChildren(el('p', { class: 'empty', text: 'No entries in the last ' + windowDays + ' days. Start the timer above or ask your AI to log time for you.' }));
        return;
      }
      /** @type {Object<string, object[]>} */
      const groups = {};
      done.forEach(function (e) { (groups[dayKey(new Date(e.start))] = groups[dayKey(new Date(e.start))] || []).push(e); });
      list.replaceChildren.apply(list, Object.keys(groups).sort().reverse().map(function (key) {
        const total = groups[key].reduce(function (a, e) { return a + e.duration_seconds; }, 0);
        return el('section', { class: 'card hr-day' }, [
          el('header', {}, [el('h2', { text: dayLabel(key) }), el('span', { class: 'badge badge-sun', text: human(total) })]),
          el('ul', {}, groups[key].map(row)),
        ]);
      }));
    }

    /**
     * Saves a change made directly on a row, then refreshes the list. The row
     * dims while waiting, and the field being edited keeps the focus afterwards.
     * @param {HTMLElement} li The row.
     * @param {object} e Entry.
     * @param {object} body Fields to change.
     * @returns {Promise<void>}
     */
    async function saveRow(li, e, body) {
      const focused = /** @type {HTMLElement|null} */ (document.activeElement);
      const key = focused && focused.dataset ? focused.dataset.k : '';
      li.setAttribute('aria-busy', 'true');
      try {
        await api('/entries/' + e.id, 'PATCH', body);
        await load();
      } finally {
        li.removeAttribute('aria-busy');
      }
      const again = key ? /** @type {HTMLElement|null} */ (list.querySelector('[data-k="' + key + '"]')) : null;
      if (again) again.focus();
    }

    /**
     * One entry. For someone who can write, every field is edited in place,
     * as in Clockify: there is no separate edit screen.
     * @param {object} e Entry.
     * @returns {HTMLElement}
     */
    function row(e) {
      if (!CAN_WRITE) {
        return el('li', { class: 'hr-row' }, [
          el('span', { class: 'hr-dot', style: 'background:' + (e.project_color || 'var(--border)') }),
          el('div', { class: 'hr-what' }, [
            el('span', { class: e.description ? '' : 'muted', text: e.description || '(no description)' }),
            el('small', {}, [e.project || 'No project', e.billable ? ' · billable' : '', e.tags.length ? ' · ' + e.tags.map(function (t) { return '#' + t; }).join(' ') : '']),
          ]),
          el('span', { class: 'hr-when muted', text: hhmm(e.start) + ' – ' + hhmm(e.end) }),
          el('strong', { class: 'hr-dur', text: clock(e.duration_seconds) }),
        ]);
      }

      const li = el('li', { class: 'hr-row hr-row-edit' });
      const k = function (field) { return e.id + ':' + field; };
      const start = new Date(e.start);
      /**
       * Start and end as dates on a given day; an end before the start means it ran past midnight.
       * @param {string} dayStr YYYY-MM-DD
       * @param {string} from HH:MM
       * @param {string} to HH:MM
       * @returns {Date[]}
       */
      function span(dayStr, from, to) {
        const a = new Date(dayStr + 'T' + from);
        const b = new Date(dayStr + 'T' + to);
        if (b <= a) b.setDate(b.getDate() + 1);
        return [a, b];
      }

      const descIn = /** @type {HTMLInputElement} */ (el('input', { type: 'text', class: 'hr-inline hr-inline-desc', value: e.description, placeholder: 'Add description', maxlength: '500', 'aria-label': 'Description', 'data-k': k('desc') }));
      descIn.addEventListener('change', safe(function () { return saveRow(li, e, { description: descIn.value }); }));

      const tagsIn = /** @type {HTMLInputElement} */ (el('input', { type: 'text', class: 'hr-inline hr-inline-tags', value: e.tags.map(function (t) { return '#' + t; }).join(' '), placeholder: '+ tag', 'aria-label': 'Tags', 'data-k': k('tags') }));
      tagsIn.addEventListener('change', safe(function () { return saveRow(li, e, { tags: tagsIn.value.split(/[\s,]+/).map(function (t) { return t.replace(/^#/, ''); }).filter(Boolean) }); }));

      const fromIn = /** @type {HTMLInputElement} */ (el('input', { type: 'time', class: 'hr-inline hr-inline-time', value: hhmm(e.start), required: true, 'aria-label': 'Start time', 'data-k': k('from') }));
      const toIn = /** @type {HTMLInputElement} */ (el('input', { type: 'time', class: 'hr-inline hr-inline-time', value: hhmm(e.end), required: true, 'aria-label': 'End time', 'data-k': k('to') }));
      const saveTimes = safe(function () {
        if (!fromIn.value || !toIn.value) return Promise.resolve();
        const r = span(dayKey(start), fromIn.value, toIn.value);
        return saveRow(li, e, { start: r[0].toISOString(), end: r[1].toISOString() });
      });
      fromIn.addEventListener('change', saveTimes);
      toIn.addEventListener('change', saveTimes);

      const durIn = /** @type {HTMLInputElement} */ (el('input', { type: 'text', class: 'hr-inline hr-inline-dur', value: clock(e.duration_seconds), 'aria-label': 'Duration', title: 'Type 1:30, 1h30 or 90 to change the end time', 'data-k': k('dur') }));
      durIn.addEventListener('change', safe(function () {
        const secs = parseDuration(durIn.value);
        if (!secs || secs >= 86400 * 7) { durIn.value = clock(e.duration_seconds); throw new Error('Invalid duration. Examples: 1:30, 1h30, 45m, 90.'); }
        return saveRow(li, e, { end: new Date(start.getTime() + secs * 1000).toISOString() });
      }));

      const dateIn = /** @type {HTMLInputElement} */ (el('input', { type: 'date', class: 'hr-date-input', value: dayKey(start), tabindex: '-1', 'aria-hidden': 'true' }));
      dateIn.addEventListener('change', safe(function () {
        if (!dateIn.value) return Promise.resolve();
        const r = span(dateIn.value, hhmm(e.start), hhmm(e.end));
        return saveRow(li, e, { start: r[0].toISOString(), end: r[1].toISOString() });
      }));

      li.append(
        el('div', { class: 'hr-what' }, [
          descIn,
          el('div', { class: 'hr-meta' }, [
            projectPicker({ projects: state.projects, value: e.project_id, onPick: function (id) { return saveRow(li, e, { project_id: id }); } }),
            tagsIn,
          ]),
        ]),
        el('button', { type: 'button', class: 'hr-bill', 'aria-pressed': String(e.billable), title: e.billable ? 'Billable. Click to make it non-billable' : 'Not billable. Click to make it billable', 'aria-label': 'Billable', onclick: safe(function () { return saveRow(li, e, { billable: !e.billable }); }) }, [el('span', { text: '$' })]),
        el('span', { class: 'hr-date' }, [
          el('button', { type: 'button', class: 'hr-icon', title: 'Move to another day', 'aria-label': 'Change the day', onclick: function () {
            if (dateIn.showPicker) dateIn.showPicker(); else dateIn.focus();
          } }, [el('span', { class: 'hr-cal' })]),
          dateIn,
        ]),
        el('span', { class: 'hr-times' }, [fromIn, el('span', { class: 'muted', text: '–' }), toIn]),
        durIn,
        el('button', { type: 'button', class: 'hr-play', title: 'Continue this entry', 'aria-label': 'Continue', onclick: safe(async function () {
          await api('/timer/start', 'POST', { description: e.description, project_id: e.project_id || 0, tags: e.tags, billable: e.billable });
          await load();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }) }, [el('span', { class: 'hr-tri' })]),
        el('span', { class: 'hr-pick' }, [
          el('button', { type: 'button', class: 'hr-icon hr-more', title: 'More actions', 'aria-label': 'More actions', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: function (ev) {
            const anchor = /** @type {HTMLElement} */ (ev.currentTarget);
            if (anchor.getAttribute('aria-expanded') === 'true') return;
            popover(anchor, function (close) {
              return el('div', { class: 'hr-menu-actions' }, [
                el('button', { type: 'button', class: 'hr-menu-item', 'data-busy': 'Duplicating…', text: 'Duplicate', onclick: safe(async function () {
                  await api('/entries', 'POST', { description: e.description, project_id: e.project_id || 0, tags: e.tags, billable: e.billable, start: e.start, end: e.end });
                  close();
                  await load();
                }) }),
                el('button', { type: 'button', class: 'hr-menu-item hr-menu-danger', 'data-busy': 'Deleting…', text: 'Delete', onclick: safe(async function () {
                  if (!confirm('Delete this entry? This cannot be undone.')) return;
                  await api('/entries/' + e.id, 'DELETE');
                  close();
                  await load();
                }) }),
              ]);
            });
          } }, [el('span', { class: 'hr-kebab' })]),
        ])
      );
      return li;
    }

    /**
     * Opens the dialog for a manual entry (no `entry`) or for editing.
     * @param {object} [entry]
     * @returns {void}
     */
    function openDialog(entry) {
      entryDialog({
        entry: entry,
        projects: state.projects,
        tags: state.tags,
        defaults: { description: desc.value, project_id: barProject() || null },
        onDone: load,
      });
    }

    /**
     * Fixes the start time of the running timer (forgot to start it on time).
     * @returns {void}
     */
    function editStart() {
      const r = state.running;
      if (!r) return;
      const s = new Date(r.start);
      const date = /** @type {HTMLInputElement} */ (el('input', { type: 'date', id: 'hs-date', required: true, value: dayKey(s) }));
      const time = /** @type {HTMLInputElement} */ (el('input', { type: 'time', id: 'hs-time', required: true, value: pad(s.getHours()) + ':' + pad(s.getMinutes()) }));
      const dlg = /** @type {HTMLDialogElement} */ (el('dialog', { class: 'hr-dialog' }));
      const close = function () { dlg.close(); dlg.remove(); };
      dlg.appendChild(el('form', { class: 'stack', onsubmit: safe(async function (ev) {
        ev.preventDefault();
        await api('/entries/' + r.id, 'PATCH', { start: new Date(date.value + 'T' + time.value).toISOString() });
        close();
        await load();
      }) }, [
        el('h2', { text: 'When did you start?' }),
        el('div', { class: 'hr-grid2' }, [
          el('div', { class: 'field' }, [el('label', { for: 'hs-date', text: 'Day' }), date]),
          el('div', { class: 'field' }, [el('label', { for: 'hs-time', text: 'Start' }), time]),
        ]),
        el('div', { class: 'hr-dialog-foot' }, [
          el('span', { class: 'spacer' }),
          el('button', { type: 'button', class: 'btn-ghost', text: 'Cancel', onclick: close }),
          el('button', { type: 'submit', text: 'Save' }),
        ]),
      ]));
      dlg.addEventListener('cancel', function () { dlg.remove(); });
      document.body.appendChild(dlg);
      dlg.showModal();
    }

    /** @returns {Promise<void>} */
    async function load() {
      const got = await Promise.all([
        api('/projects'),
        api('/status'),
        api('/entries?from=' + dayKey(day(-windowDays)) + '&limit=2000'),
        api('/tags'),
      ]);
      state.projects = got[0];
      state.status = got[1];
      state.running = got[1].running;
      state.entries = got[2];
      state.tags = got[3].map(function (t) { return t.tag; });
      paintBar();
      paintList();
    }

    btn.addEventListener('click', safe(async function () {
      if (state.running) await api('/timer/stop', 'POST', {});
      else await api('/timer/start', 'POST', { description: desc.value, project_id: barProject(), billable: bill.checked });
      if (state.running) desc.value = '';
      await load();
    }));
    desc.addEventListener('change', safe(patchRunning));
    desc.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !state.running) btn.click(); });
    bill.addEventListener('change', safe(patchRunning));

    root.replaceChildren(
      CAN_WRITE ? el('div', { class: 'card hr-bar' }, [
        desc,
        projSlot,
        el('label', { class: 'hr-check', for: 'hr-bill', title: 'Mark as billable' }, [bill, ' Billable']),
        clockEl,
        btn,
      ]) : el('p', { class: 'alert alert-info', text: 'Your role in this workspace is read-only.' }),
      el('div', { class: 'hr-sub' }, [
        totals,
        CAN_WRITE && el('button', { type: 'button', class: 'btn-ghost btn-sm', text: '+ Manual entry', onclick: function () { openDialog(); } }),
      ]),
      list,
      el('div', { class: 'hr-more-wrap' }, [more])
    );

    await load();
    // Another tab, the phone or the AI may have changed the timer: resync on return.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load().catch(function () {}); });
    setInterval(function () { if (!document.hidden && !document.querySelector('dialog[open]')) load().catch(function () {}); }, 60000);
  }

  /* ------------------------------------------------------------------ */
  /* Screen: Reports                                                    */
  /* ------------------------------------------------------------------ */

  /** @returns {Promise<void>} */
  async function viewReports() {
    const today = day(0);
    const monday = day(-((today.getDay() + 6) % 7));
    /** @type {Object<string, {label: string, range: function(): Date[]}>} */
    const presets = {
      week: { label: 'This week', range: function () { return [monday, today]; } },
      last_week: { label: 'Last week', range: function () { return [new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7), new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 1)]; } },
      month: { label: 'This month', range: function () { return [new Date(today.getFullYear(), today.getMonth(), 1), today]; } },
      last_month: { label: 'Last month', range: function () { return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)]; } },
      d30: { label: 'Last 30 days', range: function () { return [day(-29), today]; } },
      year: { label: 'This year', range: function () { return [new Date(today.getFullYear(), 0, 1), today]; } },
    };
    /** Summary groupings: label, list in the JSON and how to name each row. */
    const groups = {
      project: { label: 'Project', key: 'by_project', name: function (g) { return g.client ? g.project + ' · ' + g.client : g.project; } },
      client: { label: 'Client', key: 'by_client', name: function (g) { return g.client; } },
      tag: { label: 'Tag', key: 'by_tag', name: function (g) { return g.tag; } },
      description: { label: 'Description', key: 'by_description', name: function (g) { return g.project ? g.description + ' · ' + g.project : g.description; } },
    };

    const got = await Promise.all([api('/projects?archived=1'), api('/tags')]);
    const projects = got[0];
    const tags = got[1].map(function (t) { return t.tag; });
    const clients = projects.map(function (p) { return p.client; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; }).sort();

    /**
     * Plain filter `<select>`; the first option (empty value) means "all".
     * @param {string} label
     * @param {string} all
     * @param {Array<string[]>} options [value, text] pairs.
     * @returns {HTMLSelectElement}
     */
    function filter(label, all, options) {
      return /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': label }, [el('option', { value: '', text: all })].concat(options.map(function (o) { return el('option', { value: o[0], text: o[1] }); }))));
    }

    const period = rangePicker({ presets: presets, preset: 'week', onChange: function () { reload(); } });
    const proj = filter('Project', 'All projects', [['0', 'No project']].concat(projects.map(function (p) { return [String(p.id), p.name]; })));
    const client = filter('Client', 'All clients', clients.map(function (c) { return [c, c]; }));
    const tag = filter('Tag', 'All tags', tags.map(function (t) { return [t, '#' + t]; }));
    const bill = filter('Billable', 'Billable and non-billable', [['1', 'Billable only'], ['0', 'Non-billable only']]);
    const groupBy = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': 'Group by' }, Object.keys(groups).map(function (k) { return el('option', { value: k, text: 'Group by ' + groups[k].label.toLowerCase() }); })));
    const out = el('div', {});
    let mode = 'summary';
    const tabs = el('div', { class: 'hr-tabs', role: 'tablist' });

    /** @returns {string} */
    function query() {
      const p = new URLSearchParams({ from: period.from(), to: period.to() });
      if (proj.value) p.set('project_id', proj.value);
      if (client.value) p.set('client', client.value);
      if (tag.value) p.set('tag', tag.value);
      if (bill.value) p.set('billable', bill.value);
      return '?' + p.toString();
    }

    /**
     * Bar chart per day, filling in the days without entries.
     * @param {Array<{day: string, seconds: number}>} byDay
     * @returns {HTMLElement}
     */
    function chart(byDay) {
      /** @type {Object<string, number>} */
      const map = {};
      byDay.forEach(function (d) { map[d.day] = d.seconds; });
      const days = [];
      const a = period.from().split('-').map(Number);
      const end = new Date(period.to() + 'T00:00');
      for (let d = new Date(a[0], a[1] - 1, a[2]); d <= end && days.length < 400; d.setDate(d.getDate() + 1)) days.push(dayKey(d));
      const max = Math.max.apply(null, days.map(function (k) { return map[k] || 0; }).concat([3600]));
      const dense = days.length > 14;
      const top = Math.max.apply(null, days.map(function (k) { return map[k] || 0; }));
      return el('div', { class: 'hr-chart' + (dense ? ' hr-chart-dense' : ''), role: 'img', 'aria-label': 'Hours per day in the period' }, days.map(function (k) {
        const s = map[k] || 0;
        const p = k.split('-').map(Number);
        const label = days.length > 62 ? '' : new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-US', dense ? { day: 'numeric' } : { weekday: 'short', day: 'numeric' });
        const kind = !s ? ' hr-col-zero' : (s === top && days.length > 1 ? ' hr-col-max' : '');
        return el('div', { class: 'hr-col' + kind, title: dayLabel(k) + ': ' + human(s) }, [
          el('small', { text: s && !dense ? human(s) : '' }),
          el('div', { class: 'hr-colbar', style: 'height:' + Math.max(s ? 3 : 0, (s / max) * 100) + '%' }),
          el('small', { class: 'muted', text: label }),
        ]);
      }));
    }

    /**
     * @param {string|Node} title
     * @param {string[]} head
     * @param {Array<Array<Node|string>>} rows
     * @param {string} [note]
     * @returns {HTMLElement}
     */
    function table(title, head, rows, note) {
      return el('div', { class: 'card' }, [
        typeof title === 'string' ? el('h2', { text: title }) : title,
        note ? el('span', { class: 'muted', text: note }) : null,
        rows.length ? el('div', { class: 'table-wrap' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, head.map(function (h) { return el('th', { text: h }); }))]),
          el('tbody', {}, rows.map(function (r) { return el('tr', {}, r.map(function (c) { return el('td', { class: 'wrap' }, [c]); })); })),
        ])]) : el('p', { class: 'empty', text: 'Nothing in this period with these filters.' }),
      ]);
    }

    /**
     * @param {object} s Response of /summary.
     * @returns {HTMLElement}
     */
    function stats(s) {
      const stat = function (label, value) { return el('div', { class: 'card hr-stat' }, [el('small', { class: 'muted', text: label }), el('strong', { text: value })]); };
      return el('div', { class: 'hr-stats' }, [
        stat('Total', human(s.total_seconds)),
        stat('Billable', human(s.billable_seconds)),
        stat('Amount', moneyList(s.billable_amounts, s.currency)),
        stat('Entries', String(s.entries)),
      ]);
    }

    /** @returns {Promise<void>} */
    async function loadSummary() {
      const s = await api('/summary' + query());
      const g = groups[groupBy.value];
      out.replaceChildren(
        stats(s),
        el('div', { class: 'card' }, [el('h2', { text: 'By day' }), chart(s.by_day)]),
        table(el('div', { class: 'hr-card-head' }, [el('h2', { text: 'By ' + g.label.toLowerCase() }), groupBy]), [g.label, 'Time', 'Amount', '%'], s[g.key].map(function (r) {
          const pct = s.total_seconds ? Math.round((r.seconds / s.total_seconds) * 100) : 0;
          const color = r.color || 'var(--accent)';
          return [
            el('span', {}, [r.color ? el('span', { class: 'hr-dot', style: 'background:' + r.color }) : null, (r.color ? ' ' : '') + g.name(r)]),
            el('span', { class: 'hr-num', text: human(r.seconds) }),
            el('span', { class: 'hr-num', text: r.amounts.length ? moneyList(r.amounts, s.currency) : '—' }),
            el('span', { class: 'hr-pct' }, [el('span', { style: 'width:' + pct + '%;background:' + color }), el('small', { text: pct + '%' })]),
          ];
        }), groupBy.value === 'tag' ? 'An entry with several tags counts in each of them.' : '')
      );
    }

    /** @returns {Promise<void>} */
    async function loadDetailed() {
      const got2 = await Promise.all([api('/summary' + query()), api('/entries' + query() + '&limit=1000')]);
      const s = got2[0];
      const entries = got2[1];
      out.replaceChildren(
        stats(s),
        table('Entries', ['Day', 'Description', 'Project', 'Time', 'Duration', 'Amount', ''], entries.map(function (e) {
          return [
            new Date(e.start).toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: '2-digit' }),
            el('span', {}, [e.description || '(no description)', e.tags.length ? el('small', { class: 'muted', text: ' ' + e.tags.map(function (t) { return '#' + t; }).join(' ') }) : null]),
            el('span', {}, [el('span', { class: 'hr-dot', style: 'background:' + (e.project_color || 'var(--border)') }), ' ' + (e.project || 'No project')]),
            e.running ? hhmm(e.start) + ' – now' : hhmm(e.start) + ' – ' + hhmm(e.end),
            el('span', { class: 'hr-num', text: clock(e.duration_seconds) }),
            el('span', { class: 'hr-num', text: e.billable ? money(e.amount, e.currency) : '—' }),
            CAN_WRITE && !e.running ? el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Edit', onclick: function () { entryDialog({ entry: e, projects: projects, tags: tags, onDone: load }); } }) : '',
          ];
        }), entries.length >= 1000 ? 'Showing the 1000 most recent in the period. The total above covers all of them.' : '')
      );
    }

    /** @returns {Promise<void>} */
    async function load() {
      tabs.replaceChildren.apply(tabs, [['summary', 'Summary'], ['detailed', 'Detailed']].map(function (t) {
        return el('button', { type: 'button', role: 'tab', class: 'btn-ghost btn-sm', 'aria-selected': String(mode === t[0]), text: t[1], onclick: function () { mode = t[0]; reload(); } });
      }));
      // First load shows a message; later ones dim the old numbers until the new ones arrive.
      if (!out.children.length) waiting(out, 'Loading your report…');
      out.setAttribute('aria-busy', 'true');
      try {
        if (mode === 'summary') await loadSummary();
        else await loadDetailed();
      } finally {
        out.removeAttribute('aria-busy');
      }
    }

    const reload = safe(load);
    [proj, client, tag, bill, groupBy].forEach(function (i) { i.addEventListener('change', reload); });

    root.replaceChildren(
      el('div', { class: 'card hr-filters' }, [
        period.wrap, proj,
        clients.length ? client : null,
        tags.length ? tag : null,
        bill,
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Export CSV', onclick: safe(async function () {
          const res = await fetch(BASE + '/export.csv' + query(), { headers: { 'x-timezone': TZ }, credentials: 'same-origin' });
          if (!res.ok) throw new Error('Could not export.');
          const a = el('a', { href: URL.createObjectURL(await res.blob()), download: 'clockfolio-' + period.from() + '_' + period.to() + '.csv' });
          a.click();
          URL.revokeObjectURL(a.getAttribute('href'));
        }) }),
      ]),
      tabs,
      out
    );
    await load();
  }

  /* ------------------------------------------------------------------ */
  /* Screen: Projects                                                   */
  /* ------------------------------------------------------------------ */

  /** Currencies offered in the pickers: [ISO 4217 code, label]. */
  const CURRENCIES = [['BRL', 'Real (R$)'], ['USD', 'US dollar (US$)'], ['EUR', 'Euro (€)'], ['GBP', 'Pound (£)'], ['CAD', 'Canadian dollar (CA$)'], ['AUD', 'Australian dollar (A$)'], ['CHF', 'Swiss franc (CHF)'], ['JPY', 'Yen (¥)'], ['MXN', 'Mexican peso (MX$)'], ['ARS', 'Argentine peso (ARS)']];

  /**
   * A total that may span several currencies: "R$ 100.00 + US$ 840.00".
   * Amounts in different currencies are never added together.
   * @param {Array<{currency: string, amount: number}>} amounts
   * @param {string} fallback Currency of the zero shown when there is nothing.
   * @returns {string}
   */
  function moneyList(amounts, fallback) {
    if (!amounts || !amounts.length) return money(0, fallback);
    return amounts.map(function (a) { return money(a.amount, a.currency); }).join(' + ');
  }

  /**
   * "12h 30min" style hours for a budget, from a decimal number of hours.
   * @param {number} hours
   * @returns {string}
   */
  function hoursLabel(hours) {
    return human(Math.round(hours * 3600));
  }

  /**
   * How much of a project's budget is used, as bars: one for money, one for hours.
   * @param {object} p Project, with budget_* and spent_* fields.
   * @param {string} currency Currency the project is billed in.
   * @param {boolean} [compact] Only the bar and the percentage, for the list.
   * @returns {HTMLElement|null} null when the project has no budget.
   */
  function budgetMeter(p, currency, compact) {
    const lines = [];
    if (p.budget_amount) lines.push({ used: p.spent_amount, max: p.budget_amount, text: function (n) { return money(n, currency); }, what: 'billed' });
    if (p.budget_hours) lines.push({ used: p.spent_hours, max: p.budget_hours, text: hoursLabel, what: 'tracked' });
    if (!lines.length) return null;
    return el('div', { class: 'hr-budget' + (compact ? ' hr-budget-compact' : '') }, lines.map(function (l) {
      const pct = Math.round((l.used / l.max) * 100);
      const state = pct > 100 ? 'over' : pct >= 80 ? 'near' : 'ok';
      const left = l.max - l.used;
      const summary = l.text(l.used) + ' of ' + l.text(l.max) + ' ' + l.what;
      return el('div', { class: 'hr-budget-line hr-budget-' + state, title: summary }, [
        compact ? null : el('div', { class: 'hr-budget-text' }, [
          el('span', { text: summary }),
          el('strong', { text: left >= 0 ? l.text(left) + ' left' : l.text(-left) + ' over budget' }),
        ]),
        el('div', { class: 'hr-budget-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(pct, 100)), 'aria-label': summary }, [el('span', { style: 'width:' + Math.min(pct, 100) + '%' })]),
        compact ? el('small', { text: pct + '%' }) : null,
      ]);
    }));
  }

  /**
   * Currency `<select>` for a project. The empty value means "the workspace currency".
   * @param {{id: string, value: (string|null), workspace: string, disabled?: boolean}} opts
   * @returns {HTMLSelectElement}
   */
  function currencySelect(opts) {
    const options = [el('option', { value: '', text: 'Workspace currency (' + opts.workspace + ')' })].concat(CURRENCIES.filter(function (c) { return c[0] !== opts.workspace; }).map(function (c) { return el('option', { value: c[0], text: c[1] }); }));
    if (opts.value && !CURRENCIES.some(function (c) { return c[0] === opts.value; })) options.push(el('option', { value: opts.value, text: opts.value }));
    const select = /** @type {HTMLSelectElement} */ (el('select', { id: opts.id, disabled: !!opts.disabled }, options));
    select.value = opts.value || '';
    return select;
  }

  /**
   * The symbol of a currency ("R$", "US$", "€"), as the user's locale writes it.
   * @param {string} currency ISO 4217 code.
   * @returns {string}
   */
  function currencySymbol(currency) {
    try {
      const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'BRL', currencyDisplay: 'narrowSymbol' }).formatToParts(0);
      for (let i = 0; i < parts.length; i++) if (parts[i].type === 'currency') return parts[i].value;
    } catch (e) { /* unknown code: fall through */ }
    return currency || '';
  }

  /**
   * Field for an amount of money: the currency sits in a fixed block on the
   * left, so it is always visible and never typed.
   * @param {{id: string, currency: string, value: number|null, placeholder?: string, disabled?: boolean}} opts
   * @returns {{wrap: HTMLElement, input: HTMLInputElement, read: function(): (number|null), setCurrency: function(string): void}}
   *   `read()` gives the amount, null when empty, and throws on something that is not a number.
   */
  function moneyField(opts) {
    const cur = el('span', { class: 'hr-money-cur', text: currencySymbol(opts.currency) });
    const input = /** @type {HTMLInputElement} */ (el('input', { type: 'text', inputmode: 'decimal', id: opts.id, class: 'hr-money-in', autocomplete: 'off', placeholder: opts.placeholder || '0.00', value: opts.value === null || opts.value === undefined ? '' : opts.value.toFixed(2), disabled: !!opts.disabled }));
    return {
      wrap: el('span', { class: 'hr-money' }, [cur, input]),
      input: input,
      read: function () {
        const raw = input.value.trim().replace(/\s/g, '');
        if (!raw) return null;
        // "1.234,56" and "1,234.56" both mean the same; the last separator is the decimal one.
        const lastComma = raw.lastIndexOf(',');
        const lastDot = raw.lastIndexOf('.');
        const normal = lastComma > lastDot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
        const n = Number(normal);
        if (!isFinite(n) || n < 0) throw new Error('Enter an amount like 150 or 150.50.');
        return Math.round(n * 100) / 100;
      },
      setCurrency: function (code) { cur.textContent = currencySymbol(code); },
    };
  }

  /** @returns {Promise<void>} */
  async function viewProjects() {
    const body = el('tbody', {});
    const here = location.pathname.replace(/\/$/, '');
    const name = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'np-name', required: true, maxlength: '80' }));
    const client = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'np-client', maxlength: '80', list: 'np-clients', autocomplete: 'off' }));
    const billable = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: 'np-bill' }));
    const rate = moneyField({ id: 'np-rate', currency: 'BRL', value: null, placeholder: 'default' });
    const clientList = el('datalist', { id: 'np-clients' });
    const currency = /** @type {HTMLSelectElement} */ (el('select', { id: 'st-currency' }, CURRENCIES.map(function (c) { return el('option', { value: c[0], text: c[1] }); })));
    const newCurrencySlot = el('span', { class: 'hr-slot' });
    /** @type {HTMLSelectElement|null} */
    let newCurrency = null;
    const defRate = moneyField({ id: 'st-rate', currency: 'BRL', value: null, placeholder: '0.00', disabled: !CAN_WRITE });
    let settings = { currency: 'BRL', default_rate: 0 };

    /** @returns {Promise<void>} */
    async function load() {
      const got = await Promise.all([api('/projects?archived=1'), api('/settings')]);
      const projects = got[0];
      settings = got[1];
      if (!currency.querySelector('option[value="' + settings.currency + '"]')) currency.appendChild(el('option', { value: settings.currency, text: settings.currency }));
      currency.value = settings.currency;
      defRate.setCurrency(settings.currency);
      // The project currency picker names the workspace currency, so it is rebuilt when that changes.
      const keep = newCurrency ? newCurrency.value : '';
      newCurrency = currencySelect({ id: 'np-currency', value: keep === settings.currency ? '' : keep, workspace: settings.currency });
      newCurrency.addEventListener('change', function () { rate.setCurrency(newCurrency.value || settings.currency); });
      newCurrencySlot.replaceChildren(newCurrency);
      rate.setCurrency(newCurrency.value || settings.currency);
      if (document.activeElement !== defRate.input) defRate.input.value = settings.default_rate ? settings.default_rate.toFixed(2) : '';
      clientList.replaceChildren.apply(clientList, projects.map(function (p) { return p.client; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; }).map(function (c) { return el('option', { value: c }); }));
      if (!projects.length) {
        body.replaceChildren(el('tr', {}, [el('td', { colspan: '8', class: 'empty', text: 'No projects yet.' })]));
        return;
      }
      body.replaceChildren.apply(body, projects.map(CAN_WRITE ? editableRow : readOnlyRow));
    }

    /**
     * Row for someone who can only read.
     * @param {object} p Project.
     * @returns {HTMLElement}
     */
    function readOnlyRow(p) {
      return el('tr', { class: p.archived ? 'hr-archived' : '' }, [
        el('td', { class: 'wrap' }, [el('a', { class: 'hr-proj-link', href: here + '/' + p.id }, [
          el('span', { class: 'hr-dot', style: 'background:' + p.color }), el('span', { text: p.name }),
          p.archived ? el('span', { class: 'badge', text: 'Archived' }) : null,
        ])]),
        el('td', { class: 'wrap', text: p.client || '—' }),
        el('td', {}, [p.billable ? el('span', { class: 'badge badge-sky', text: 'Billable' }) : el('span', { class: 'muted', text: '—' })]),
        el('td', { text: p.currency || settings.currency }),
        el('td', {}, [el('span', { class: p.hourly_rate === null ? 'hr-num muted' : 'hr-num', text: p.hourly_rate === null ? 'default' : money(p.hourly_rate, p.currency || settings.currency) })]),
        el('td', {}, [budgetMeter(p, p.currency || settings.currency, true) || el('span', { class: 'muted', text: '—' })]),
        el('td', {}, [el('span', { class: 'hr-num', text: human(p.total_seconds) })]),
        el('td', {}, [el('a', { class: 'btn btn-ghost btn-sm', href: here + '/' + p.id, text: 'View' })]),
      ]);
    }

    /**
     * Row where every field is changed in place and saved as soon as it changes.
     * The Edit button still opens the project page, which also archives and deletes.
     * @param {object} p Project.
     * @returns {HTMLElement}
     */
    function editableRow(p) {
      const dot = el('button', { type: 'button', class: 'hr-dot-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'Color of ' + p.name, title: 'Change color', style: 'background:' + p.color });
      const nameIn = /** @type {HTMLInputElement} */ (el('input', { type: 'text', class: 'hr-inline hr-inline-name', value: p.name, maxlength: '80', 'aria-label': 'Name' }));
      const clientIn = /** @type {HTMLInputElement} */ (el('input', { type: 'text', class: 'hr-inline', value: p.client, maxlength: '80', list: 'np-clients', placeholder: 'Add client', 'aria-label': 'Client of ' + p.name }));
      const billIn = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', checked: p.billable, 'aria-label': p.name + ' is billable by default' }));
      const curIn = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': 'Currency of ' + p.name }, [el('option', { value: '', text: settings.currency })].concat(CURRENCIES.filter(function (c) { return c[0] !== settings.currency; }).map(function (c) { return el('option', { value: c[0], text: c[0] }); }))));
      if (p.currency && !curIn.querySelector('option[value="' + p.currency + '"]')) curIn.appendChild(el('option', { value: p.currency, text: p.currency }));
      curIn.value = p.currency || '';
      const rateIn = moneyField({ id: 'pr-rate-' + p.id, currency: p.currency || settings.currency, value: p.hourly_rate, placeholder: p.currency ? '0.00' : 'default' });
      rateIn.input.setAttribute('aria-label', 'Hourly rate of ' + p.name);

      /**
       * Sends one change; on failure the list is reloaded so the row shows what is really saved.
       * @param {object} patch
       * @param {string} [done] Message for the toast.
       * @returns {Promise<void>}
       */
      async function save(patch, done) {
        try {
          const saved = await api('/projects/' + p.id, 'PATCH', patch);
          Object.assign(p, saved);
          toast(done || 'Saved.');
        } catch (err) {
          toast(err.message || 'Could not save.', true);
          await load();
        }
      }

      /**
       * Saves currency and rate together: a project in its own currency needs its own rate.
       * @returns {void}
       */
      function saveMoney() {
        let amount;
        try { amount = rateIn.read(); } catch (err) { toast(err.message, true); return; }
        rateIn.setCurrency(curIn.value || settings.currency);
        rateIn.input.placeholder = curIn.value ? '0.00' : 'default';
        if (curIn.value && amount === null) {
          toast('Type the hourly rate in ' + curIn.value + ' to finish.');
          rateIn.input.focus();
          return;
        }
        rateIn.input.value = amount === null ? '' : amount.toFixed(2);
        save({ currency: curIn.value, hourly_rate: amount });
      }

      dot.addEventListener('click', function () {
        popover(dot, function (close) {
          return el('div', { class: 'hr-swatches hr-swatch-menu' }, PROJECT_COLORS.map(function (c) {
            return el('button', { type: 'button', class: 'hr-swatch', 'aria-label': 'Color ' + c, 'aria-checked': String(c === p.color.toLowerCase()), style: 'background:' + c, onclick: function () {
              close();
              dot.style.background = c;
              save({ color: c });
            } });
          }));
        });
      });
      nameIn.addEventListener('change', function () {
        if (!nameIn.value.trim()) { nameIn.value = p.name; return; }
        save({ name: nameIn.value });
      });
      clientIn.addEventListener('change', function () { save({ client: clientIn.value }); });
      [nameIn, clientIn, rateIn.input].forEach(function (i) { i.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') i.blur(); }); });
      billIn.addEventListener('change', function () {
        // The default only reaches new entries; offer to bring the existing ones along.
        const differ = billIn.checked ? p.entries - p.billable_entries : p.billable_entries;
        const apply = differ > 0 && confirm('Also mark your ' + differ + ' existing ' + (differ === 1 ? 'entry' : 'entries') + ' on "' + p.name + '" as ' + (billIn.checked ? 'billable' : 'non-billable') + '?\n\nCancel changes only the entries you log from now on.');
        save({ billable: billIn.checked, apply_to_entries: apply }, apply ? 'Saved. ' + differ + (differ === 1 ? ' entry' : ' entries') + ' updated.' : 'Saved.');
      });
      curIn.addEventListener('change', saveMoney);
      rateIn.input.addEventListener('change', saveMoney);

      return el('tr', { class: p.archived ? 'hr-archived' : '' }, [
        el('td', {}, [el('span', { class: 'hr-proj-edit' }, [el('span', { class: 'hr-pick' }, [dot]), nameIn, p.archived ? el('span', { class: 'badge', text: 'Archived' }) : null])]),
        el('td', {}, [clientIn]),
        el('td', {}, [el('label', { class: 'hr-check' }, [billIn])]),
        el('td', {}, [curIn]),
        el('td', {}, [rateIn.wrap]),
        el('td', {}, [budgetMeter(p, p.currency || settings.currency, true) || el('a', { class: 'hr-budget-add', href: here + '/' + p.id + '#budget', text: 'Set budget' })]),
        el('td', {}, [el('span', { class: 'hr-num', text: human(p.total_seconds) })]),
        el('td', {}, [el('a', { class: 'btn btn-ghost btn-sm', href: here + '/' + p.id, text: 'Edit' })]),
      ]);
    }

    const saveSettings = safe(async function () {
      await api('/settings', 'PATCH', { currency: currency.value, default_rate: defRate.read() || 0 });
      toast('Billing updated.');
      await load();
    });
    currency.addEventListener('change', saveSettings);
    defRate.input.addEventListener('change', saveSettings);
    currency.disabled = !CAN_WRITE;

    // A viewer has no "New project" card; drop the missing part instead of printing "false".
    root.replaceChildren.apply(root, [
      clientList,
      CAN_WRITE && el('div', { class: 'card' }, [
        el('h2', { text: 'New project' }),
        el('form', { class: 'row', onsubmit: safe(async function (ev) {
          ev.preventDefault();
          await api('/projects', 'POST', { name: name.value, client: client.value, hourly_rate: rate.read(), billable: billable.checked, currency: newCurrency ? newCurrency.value : '' });
          name.value = client.value = rate.input.value = '';
          if (newCurrency) newCurrency.value = '';
          billable.checked = false;
          await load();
        }) }, [
          el('div', { class: 'field' }, [el('label', { for: 'np-name', text: 'Name' }), name]),
          el('div', { class: 'field' }, [el('label', { for: 'np-client', text: 'Client (optional)' }), client]),
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'np-currency', text: 'Currency' }), newCurrencySlot]),
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'np-rate', text: 'Hourly rate' }), rate.wrap]),
          el('label', { class: 'hr-check hr-check-row', for: 'np-bill' }, [billable, ' Billable by default']),
          el('div', { class: 'field hr-field-btn' }, [el('button', { type: 'submit', text: 'Create' })]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Workspace projects' }),
        el('span', { class: 'muted', text: 'Shared among members. The time shown is yours only. Change any field right here and it saves by itself; Edit opens the project page, which also archives and deletes.' }),
        el('div', { class: 'table-wrap' }, [el('table', { class: 'hr-projects' }, [
          el('thead', {}, [el('tr', {}, ['Project', 'Client', 'Billable', 'Currency', 'Hourly rate', 'Budget', 'Your time', ''].map(function (h) { return el('th', { text: h }); }))]),
          body,
        ])]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Billing' }),
        el('span', { class: 'muted', text: 'The amount of a billable entry is hours × the project hourly rate. Projects without their own rate use the default below. A project for a client abroad can have its own currency, set on the project. Changing a rate recalculates everything already logged.' }),
        el('div', { class: 'row' }, [
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'st-currency', text: 'Workspace currency' }), currency]),
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'st-rate', text: 'Default hourly rate' }), defRate.wrap]),
        ]),
      ])
    ].filter(Boolean));
    await load();
  }

  /* ------------------------------------------------------------------ */
  /* Screen: one project                                                 */
  /* ------------------------------------------------------------------ */

  /** Project colours offered as swatches; they are the design system's project tokens. */
  const PROJECT_COLORS = ['#5dcdf1', '#fd976d', '#fdd46b', '#4cc98c', '#9b8afb', '#f0705f'];

  /** @returns {Promise<void>} */
  async function viewProject() {
    const id = Number(root.dataset.project);
    const back = root.dataset.back || '';
    const got = await Promise.all([api('/projects?archived=1'), api('/settings')]);
    const settings = got[1];
    let p = got[0].filter(function (x) { return x.id === id; })[0];
    if (!p) {
      root.replaceChildren(el('p', { class: 'alert alert-error', text: 'This project does not exist, or was deleted.' }), el('a', { class: 'btn btn-ghost', href: back, text: 'All projects' }));
      return;
    }
    const heading = document.querySelector('.page-head h1');
    const off = !CAN_WRITE;

    const name = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'pj-name', required: true, maxlength: '80', value: p.name, disabled: off }));
    const client = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'pj-client', maxlength: '80', list: 'pj-clients', autocomplete: 'off', value: p.client, disabled: off }));
    const custom = /** @type {HTMLInputElement} */ (el('input', { type: 'color', class: 'hr-swatch-custom', value: p.color, disabled: off, 'aria-label': 'Custom color', title: 'Another color' }));
    const billable = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: 'pj-bill', checked: p.billable, disabled: off }));
    const rate = moneyField({ id: 'pj-rate', currency: p.currency || settings.currency, value: p.hourly_rate, placeholder: 'default', disabled: off });
    const projCurrency = currencySelect({ id: 'pj-currency', value: p.currency, workspace: settings.currency, disabled: off });
    projCurrency.addEventListener('change', function () {
      rate.setCurrency(projCurrency.value || settings.currency);
      budgetMoney.setCurrency(projCurrency.value || settings.currency);
      rate.input.placeholder = projCurrency.value ? '0.00' : 'default';
    });
    rate.input.placeholder = p.currency ? '0.00' : 'default';
    // "Billable by default" only reaches new entries; this offers to bring the existing ones along.
    const budgetMoney = moneyField({ id: 'pj-budget', currency: p.currency || settings.currency, value: p.budget_amount, placeholder: 'No limit', disabled: off });
    const budgetHours = /** @type {HTMLInputElement} */ (el('input', { type: 'text', inputmode: 'decimal', id: 'pj-budget-hours', class: 'hr-hours-in', placeholder: 'No limit', autocomplete: 'off', value: p.budget_hours ? String(p.budget_hours) : '', disabled: off }));
    const budgetSlot = el('div', { class: 'hr-budget-slot' });

    /**
     * Reads the hours budget: null when empty, and throws on something that is not a number.
     * @returns {number|null}
     */
    function readBudgetHours() {
      const raw = budgetHours.value.trim().replace(',', '.');
      if (!raw) return null;
      const n = Number(raw);
      if (!isFinite(n) || n < 0) throw new Error('Enter the hours as a number, like 40 or 12.5.');
      return n;
    }

    /** @returns {void} */
    function paintBudget() {
      const meter = budgetMeter(p, p.currency || settings.currency);
      budgetSlot.replaceChildren(meter || el('p', { class: 'muted', text: 'No budget yet. Set a limit below and this shows how much of it is used.' }));
    }
    const applyOld = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: 'pj-apply' }));
    const applyText = el('span', {});
    const applyRow = el('label', { class: 'hr-check hr-check-lg hr-apply', for: 'pj-apply' }, [applyOld, applyText]);
    const timeNote = el('span', { class: 'muted' });

    /**
     * Shows the offer only when some of this person's entries disagree with the checkbox.
     * @param {boolean} [suggest] True right after the user toggled the checkbox: the offer comes ticked.
     * @returns {void}
     */
    function paintApply(suggest) {
      const differ = billable.checked ? p.entries - p.billable_entries : p.billable_entries;
      applyRow.hidden = off || !differ;
      applyText.textContent = ' Also mark my ' + differ + ' existing ' + (differ === 1 ? 'entry' : 'entries') + ' on this project as ' + (billable.checked ? 'billable' : 'non-billable');
      applyOld.checked = !applyRow.hidden && !!suggest;
    }
    billable.addEventListener('change', function () { paintApply(true); });
    const swatches = el('div', { class: 'hr-swatches', role: 'radiogroup', 'aria-label': 'Color' });
    let color = p.color;

    /** @returns {void} */
    function paintColors() {
      swatches.replaceChildren.apply(swatches, PROJECT_COLORS.map(function (c) {
        return el('button', { type: 'button', class: 'hr-swatch', role: 'radio', 'aria-checked': String(c === color.toLowerCase()), 'aria-label': 'Color ' + c, disabled: off, style: 'background:' + c, onclick: function () { color = c; custom.value = c; paintColors(); } });
      }).concat([custom]));
      custom.classList.toggle('hr-swatch-on', PROJECT_COLORS.indexOf(color.toLowerCase()) === -1);
    }
    custom.addEventListener('input', function () { color = custom.value; paintColors(); });
    paintColors();

    const archiveBtn = el('button', { type: 'button', class: 'btn-ghost' });
    /** @returns {void} */
    function paintState() {
      archiveBtn.textContent = p.archived ? 'Restore project' : 'Archive project';
      if (heading) heading.textContent = p.name;
      timeNote.textContent = 'Your time on this project: ' + human(p.total_seconds) + ' in ' + p.entries + (p.entries === 1 ? ' entry' : ' entries') + ', ' + p.billable_entries + ' billable';
      paintApply();
      paintBudget();
      document.title = p.name + ' · Projects';
    }
    archiveBtn.addEventListener('click', safe(async function () {
      p = await api('/projects/' + id, 'PATCH', { archived: !p.archived });
      paintState();
      toast(p.archived ? 'Project archived.' : 'Project restored.');
    }));
    paintState();

    root.replaceChildren.apply(root, [
      el('datalist', { id: 'pj-clients' }, got[0].map(function (x) { return x.client; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; }).map(function (c) { return el('option', { value: c }); })),
      off ? el('p', { class: 'alert alert-info', text: 'Your role in this workspace is read-only.' }) : null,
      el('form', { onsubmit: safe(async function (ev) {
        ev.preventDefault();
        if (projCurrency.value && rate.read() === null) throw new Error('A project in its own currency needs its own hourly rate.');
        p = await api('/projects/' + id, 'PATCH', { name: name.value, client: client.value, color: color, billable: billable.checked, hourly_rate: rate.read(), currency: projCurrency.value, apply_to_entries: applyOld.checked, budget_amount: budgetMoney.read(), budget_hours: readBudgetHours() });
        const changed = p.entries_updated;
        paintState();
        toast(changed ? 'Project saved. ' + changed + (changed === 1 ? ' entry' : ' entries') + ' updated.' : 'Project saved.');
      }) }, [
        el('div', { class: 'card' }, [
          el('h2', { text: 'Details' }),
          el('div', { class: 'row' }, [
            el('div', { class: 'field' }, [el('label', { for: 'pj-name', text: 'Name' }), name]),
            el('div', { class: 'field' }, [el('label', { for: 'pj-client', text: 'Client' }), client]),
          ]),
          el('div', { class: 'field hr-field-top' }, [el('span', { class: 'hr-label', text: 'Color' }), swatches]),
        ]),
        el('div', { class: 'card' }, [
          el('h2', { text: 'Billing' }),
          el('label', { class: 'hr-check hr-check-lg', for: 'pj-bill' }, [billable, ' Billable by default']),
          el('p', { class: 'muted', text: 'New entries on this project start as billable. You can still switch the “$” on any single entry. Entries that already exist only change if you ask below.' }),
          applyRow,
          el('div', { class: 'row hr-field-top' }, [
            el('div', { class: 'field hr-field-md' }, [el('label', { for: 'pj-currency', text: 'Currency' }), projCurrency]),
            el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'pj-rate', text: 'Hourly rate' }), rate.wrap]),
          ]),
          el('p', { class: 'muted', text: 'Without a rate, the project uses the workspace default (' + money(settings.default_rate, settings.currency) + '). A project in another currency needs its own rate, and its amounts show in that currency in the reports. Changing the rate reprices every billable entry already logged on this project.' }),
        ]),
        el('div', { class: 'card', id: 'budget' }, [
          el('h2', { text: 'Budget' }),
          el('p', { class: 'muted', text: 'The most that may be spent on this project, as money, as hours, or both. It counts what every member of the workspace logged: billable entries for the money, all entries for the hours.' }),
          budgetSlot,
          el('div', { class: 'row hr-field-top' }, [
            el('div', { class: 'field hr-field-md' }, [el('label', { for: 'pj-budget', text: 'Money budget' }), budgetMoney.wrap]),
            el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'pj-budget-hours', text: 'Hours budget' }), el('span', { class: 'hr-money' }, [budgetHours, el('span', { class: 'hr-money-cur hr-money-unit', text: 'hours' })])]),
          ]),
          el('p', { class: 'muted', text: 'Leave a field empty for no limit. Going over the budget never blocks the timer; the bar turns yellow from 80% and red once it is passed.' }),
        ]),
        el('div', { class: 'hr-save' }, [
          off ? null : el('button', { type: 'submit', text: 'Save changes' }),
          timeNote,
        ]),
      ]),
      off ? null : el('div', { class: 'card' }, [
        el('h2', { text: 'Archive or delete' }),
        el('p', { class: 'muted', text: 'Archiving hides the project from the pickers and keeps its entries and reports. Deleting removes the project for every member; its entries stay, without a project.' }),
        el('div', { class: 'row' }, [
          archiveBtn,
          el('button', { type: 'button', class: 'btn-danger', text: 'Delete project', 'data-busy': 'Deleting…', onclick: safe(async function () {
            if (!confirm('Delete the project "' + p.name + '"? Its entries remain, without a project. This applies to every member.')) return;
            await api('/projects/' + id, 'DELETE');
            location.href = back;
          }) }),
        ]),
      ]),
    ].filter(Boolean));
  }

  /* ------------------------------------------------------------------ */
  /* Screen: Integrations (API/MCP tokens)                              */
  /* ------------------------------------------------------------------ */

  /**
   * The token list comes rendered from the server; here only create/revoke.
   * @returns {void}
   */
  function viewIntegrations() {
    const url = root.dataset.tokens || '';
    const form = /** @type {HTMLFormElement|null} */ (document.getElementById('new-token'));
    const reveal = document.getElementById('token-reveal');

    if (form) form.addEventListener('submit', safe(async function (ev) {
      ev.preventDefault();
      const nameInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('name'));
      const r = await api('', 'POST', { action: 'create', name: nameInput.value, timezone: TZ }, url);
      // Shows the token and fills the examples with it. It only exists on this screen, right now.
      document.querySelectorAll('[data-token]').forEach(function (n) { n.textContent = n.textContent.replace(/YOUR_TOKEN/g, r.token); });
      /** @type {HTMLElement} */ (reveal.querySelector('code')).textContent = r.token;
      reveal.hidden = false;
      form.hidden = true;
      reveal.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));

    document.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', safe(async function () {
        await navigator.clipboard.writeText(document.getElementById(b.getAttribute('data-copy')).textContent);
        toast('Copied.');
      }));
    });

    document.querySelectorAll('[data-revoke]').forEach(function (b) {
      b.addEventListener('click', safe(async function () {
        if (!confirm('Revoke this token? Anyone using it loses access immediately.')) return;
        await api('', 'POST', { action: 'revoke', id: b.getAttribute('data-revoke') }, url);
        location.reload();
      }));
    });
  }

  /* ------------------------------------------------------------------ */

  /** @type {Object<string, function(): (Promise<void>|void)>} */
  /* ------------------------------------------------------------------ */
  /* Screen: Import & export                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Downloads a file from the workspace API.
   * @param {string} path Path after the base, e.g. "/backup.json".
   * @param {string} filename Name suggested for the saved file.
   * @returns {Promise<void>}
   */
  async function download(path, filename) {
    const res = await fetch(BASE + path, { headers: { 'x-timezone': TZ }, credentials: 'same-origin' });
    if (!res.ok) throw new Error('Could not export.');
    const a = el('a', { href: URL.createObjectURL(await res.blob()), download: filename });
    a.click();
    URL.revokeObjectURL(a.getAttribute('href'));
  }

  /** @returns {void} */
  function viewData() {
    /** Human names for what the server recognized in the file. */
    const sources = { 'horas-backup': 'Clockfolio backup', 'horas-csv': 'Clockfolio CSV export', 'clockify-csv': 'Clockify detailed report', 'generic-csv': 'CSV file' };
    const file = /** @type {HTMLInputElement} */ (el('input', { type: 'file', id: 'imp-file', accept: '.csv,.json,text/csv,application/json' }));
    const order = /** @type {HTMLSelectElement} */ (el('select', { id: 'imp-order' }, [
      el('option', { value: 'auto', text: 'Detect automatically' }),
      el('option', { value: 'mdy', text: 'Month first (11/30/2026)' }),
      el('option', { value: 'dmy', text: 'Day first (30/11/2026)' }),
    ]));
    const out = el('div', { 'aria-live': 'polite' });
    /** @type {string} */
    let content = '';

    /**
     * Sends the file to the server.
     * @param {boolean} dryRun True to preview without writing.
     * @returns {Promise<object>}
     */
    async function send(dryRun) {
      const res = await fetch(BASE + '/import?date_format=' + order.value + (dryRun ? '&dry_run=1' : ''), {
        method: 'POST',
        headers: { 'x-timezone': TZ, 'content-type': 'text/plain' },
        body: content,
        credentials: 'same-origin',
      });
      const data = await res.json().catch(function () { return null; });
      if (!res.ok) throw new Error((data && data.error) || 'Could not read the file (' + res.status + ').');
      return data;
    }

    /**
     * Shows what the file contains, before or after importing.
     * @param {object} r Result from the server.
     * @returns {void}
     */
    function show(r) {
      const done = !r.dry_run;
      const count = done ? r.imported : r.to_import;
      const line = function (label, value) { return el('li', {}, [el('strong', { text: String(value) }), ' ' + label]); };
      // `replaceChildren` would print the word "null" for a missing part, so drop those first.
      out.replaceChildren.apply(out, [
        el('div', { class: 'alert ' + (done ? 'alert-success' : 'alert-info') }, [el('div', {}, [
          el('strong', { text: done ? 'Import finished.' : 'Preview: nothing has been imported yet.' }),
          el('p', { class: 'hr-imp-source', text: 'Recognized as: ' + (sources[r.source] || r.source) + ' · ' + r.rows + ' rows'
            + (r.date_order ? ' · dates read as ' + (r.date_order === 'mdy' ? 'month/day/year' : 'day/month/year') : '') }),
          !done && r.sample ? el('p', { class: 'hr-imp-source', text: 'Earliest entry: ' + new Date(r.sample.start).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })
            + ', ' + hhmm(r.sample.start) + ' – ' + hhmm(r.sample.end) + (r.sample.description ? ' (' + r.sample.description + ')' : '') + '. If that date is wrong, change the date order above.' }) : null,
          el('ul', { class: 'hr-imp-list' }, [
            line(done ? 'entries imported' : 'entries to import', count),
            r.duplicates ? line('already here, skipped', r.duplicates) : null,
            r.invalid ? line('rows with problems, skipped', r.invalid) : null,
            r.new_projects.length ? line((done ? 'projects created: ' : 'new projects: ') + r.new_projects.slice(0, 12).join(', ') + (r.new_projects.length > 12 ? '…' : ''), r.new_projects.length) : null,
            r.settings_restored ? el('li', { text: 'Currency and default rate restored from the backup.' }) : null,
          ]),
        ])]),
        r.errors.length ? el('div', { class: 'card' }, [
          el('h2', { text: 'Rows with problems' }),
          el('span', { class: 'muted', text: r.invalid > r.errors.length ? 'Showing the first ' + r.errors.length + ' of ' + r.invalid + '.' : 'These rows are skipped; the rest is imported.' }),
          el('ul', { class: 'hr-imp-list' }, r.errors.map(function (e) { return el('li', { text: 'Row ' + e.row + ': ' + e.message }); })),
        ]) : null,
        !done && count > 0 ? el('button', { type: 'button', text: 'Import ' + count + (count === 1 ? ' entry' : ' entries'), onclick: safe(async function () {
          show(await send(false));
          file.value = '';
          content = '';
        }) }) : null,
        !done && count === 0 ? el('p', { class: 'muted', text: 'There is nothing new to import from this file.' }) : null,
      ].filter(Boolean));
    }

    const preview = safe(async function () {
      const f = file.files && file.files[0];
      out.replaceChildren();
      if (!f) return;
      if (f.size > 3000000) throw new Error('File too large. The limit is 3 MB; split it by period.');
      waiting(out, 'Reading ' + f.name + ' and checking it against your entries…');
      file.disabled = order.disabled = true;
      try {
        content = await f.text();
        show(await send(true));
      } catch (e) {
        out.replaceChildren();
        throw e;
      } finally {
        out.removeAttribute('aria-busy');
        file.disabled = order.disabled = false;
      }
    });
    file.addEventListener('change', preview);
    order.addEventListener('change', preview);

    root.replaceChildren(
      el('div', { class: 'card' }, [
        el('h2', { text: 'Export' }),
        el('span', { class: 'muted', text: 'Your own entries in this workspace. The backup can be imported back here or into another account; the CSV opens in any spreadsheet.' }),
        el('div', { class: 'row' }, [
          el('button', { type: 'button', text: 'Download backup (JSON)', onclick: safe(function () { return download('/backup.json', 'clockfolio-backup-' + dayKey(new Date()) + '.json'); }) }),
          el('button', { type: 'button', class: 'btn-ghost', text: 'Download entries (CSV)', onclick: safe(function () { return download('/export.csv', 'clockfolio-' + dayKey(new Date()) + '.csv'); }) }),
        ]),
      ]),
      CAN_WRITE ? el('div', { class: 'card' }, [
        el('h2', { text: 'Import' }),
        el('span', { class: 'muted', text: 'Accepts a Clockfolio backup, a Clockfolio CSV export, or Clockify\'s Detailed report exported as CSV. You see a preview before anything is saved, and entries already here are skipped.' }),
        el('div', { class: 'row' }, [
          el('div', { class: 'field' }, [el('label', { for: 'imp-file', text: 'File (.csv or .json, up to 3 MB)' }), file]),
          el('div', { class: 'field hr-field-md' }, [el('label', { for: 'imp-order', text: 'Dates like 03/04/2026' }), order]),
        ]),
      ]) : el('p', { class: 'alert alert-info', text: 'Your role in this workspace is read-only, so you can export but not import.' }),
      out
    );
  }

  const views = { time: viewTime, reports: viewReports, projects: viewProjects, project: viewProject, integrations: viewIntegrations, data: viewData };
  const start = views[root.dataset.view || ''];
  if (start) {
    Promise.resolve().then(start).catch(function (e) {
      root.appendChild(el('p', { class: 'alert alert-error', text: 'Could not load: ' + e.message }));
    });
  }
})();
