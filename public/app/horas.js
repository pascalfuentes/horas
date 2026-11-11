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
    const t = el('div', { class: 'hr-toast' + (isError ? ' hr-toast-error' : ''), role: 'status', text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  /**
   * Wraps an async handler: an error becomes a notice instead of vanishing into the console.
   * @param {function(...any): Promise<any>} fn
   * @returns {function(...any): void}
   */
  function safe(fn) {
    return function () {
      fn.apply(null, arguments).catch(function (e) { toast(e.message, true); });
    };
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

    /** @returns {HTMLSelectElement} */
    function projEl() { return /** @type {HTMLSelectElement} */ (projSlot.firstChild); }

    /** @returns {void} */
    function paintBar() {
      const r = state.running;
      projSlot.replaceChildren(projectSelect(state.projects, r ? r.project_id : Number(projEl() ? projEl().value : 0) || null));
      projEl().addEventListener('change', safe(patchRunning));
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
        project_id: Number(projEl().value),
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
     * @param {object} e Entry.
     * @returns {HTMLElement}
     */
    function row(e) {
      return el('li', { class: 'hr-row' }, [
        el('span', { class: 'hr-dot', style: 'background:' + (e.project_color || 'var(--border)') }),
        el('div', { class: 'hr-what' }, [
          el('span', { class: e.description ? '' : 'muted', text: e.description || '(no description)' }),
          el('small', {}, [
            e.project || 'No project',
            e.billable ? ' · billable' : '',
            e.tags.length ? ' · ' + e.tags.map(function (t) { return '#' + t; }).join(' ') : '',
          ]),
        ]),
        el('span', { class: 'hr-when muted', text: hhmm(e.start) + ' – ' + hhmm(e.end) }),
        el('strong', { class: 'hr-dur', text: clock(e.duration_seconds) }),
        CAN_WRITE && el('span', { class: 'row-actions' }, [
          el('button', { type: 'button', class: 'hr-play', title: 'Continue this entry', 'aria-label': 'Continue', onclick: safe(async function () {
            await api('/timer/start', 'POST', { description: e.description, project_id: e.project_id || 0, tags: e.tags, billable: e.billable });
            await load();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }) }, [el('span', { class: 'hr-tri' })]),
          el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Edit', onclick: function () { openDialog(e); } }),
        ]),
      ]);
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
        defaults: { description: desc.value, project_id: Number(projEl().value) || null },
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
      else await api('/timer/start', 'POST', { description: desc.value, project_id: Number(projEl().value), billable: bill.checked });
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

    const preset = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': 'Period' }, Object.keys(presets).map(function (k) { return el('option', { value: k, text: presets[k].label }); }).concat([el('option', { value: 'custom', text: 'Custom' })])));
    const from = /** @type {HTMLInputElement} */ (el('input', { type: 'date', 'aria-label': 'From' }));
    const to = /** @type {HTMLInputElement} */ (el('input', { type: 'date', 'aria-label': 'To' }));
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
      const p = new URLSearchParams({ from: from.value, to: to.value });
      if (proj.value) p.set('project_id', proj.value);
      if (client.value) p.set('client', client.value);
      if (tag.value) p.set('tag', tag.value);
      if (bill.value) p.set('billable', bill.value);
      return '?' + p.toString();
    }

    /** @returns {void} */
    function applyPreset() {
      if (preset.value === 'custom') return;
      const r = presets[preset.value].range();
      from.value = dayKey(r[0]);
      to.value = dayKey(r[1]);
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
      const a = from.value.split('-').map(Number);
      const end = new Date(to.value + 'T00:00');
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
        stat('Amount', money(s.billable_amount, s.currency)),
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
            el('span', { class: 'hr-num', text: r.amount ? money(r.amount, s.currency) : '—' }),
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
            el('span', { class: 'hr-num', text: e.billable ? money(e.amount, s.currency) : '—' }),
            CAN_WRITE && !e.running ? el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Edit', onclick: function () { entryDialog({ entry: e, projects: projects, tags: tags, onDone: load }); } }) : '',
          ];
        }), entries.length >= 1000 ? 'Showing the 1000 most recent in the period. The total above covers all of them.' : '')
      );
    }

    /** @returns {Promise<void>} */
    async function load() {
      if (!from.value || !to.value) return;
      tabs.replaceChildren.apply(tabs, [['summary', 'Summary'], ['detailed', 'Detailed']].map(function (t) {
        return el('button', { type: 'button', role: 'tab', class: 'btn-ghost btn-sm', 'aria-selected': String(mode === t[0]), text: t[1], onclick: function () { mode = t[0]; reload(); } });
      }));
      if (mode === 'summary') await loadSummary();
      else await loadDetailed();
    }

    const reload = safe(load);
    preset.addEventListener('change', function () { applyPreset(); reload(); });
    [from, to].forEach(function (i) { i.addEventListener('change', function () { preset.value = 'custom'; reload(); }); });
    [proj, client, tag, bill, groupBy].forEach(function (i) { i.addEventListener('change', reload); });

    root.replaceChildren(
      el('div', { class: 'card hr-filters' }, [
        preset, from, to, proj,
        clients.length ? client : null,
        tags.length ? tag : null,
        bill,
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Export CSV', onclick: safe(async function () {
          const res = await fetch(BASE + '/export.csv' + query(), { headers: { 'x-timezone': TZ }, credentials: 'same-origin' });
          if (!res.ok) throw new Error('Could not export.');
          const a = el('a', { href: URL.createObjectURL(await res.blob()), download: 'horas-' + from.value + '_' + to.value + '.csv' });
          a.click();
          URL.revokeObjectURL(a.getAttribute('href'));
        }) }),
      ]),
      tabs,
      out
    );
    applyPreset();
    await load();
  }

  /* ------------------------------------------------------------------ */
  /* Screen: Projects                                                   */
  /* ------------------------------------------------------------------ */

  /** @returns {Promise<void>} */
  async function viewProjects() {
    const body = el('tbody', {});
    const name = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'np-name', required: true, maxlength: '80' }));
    const client = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'np-client', maxlength: '80', list: 'np-clients', autocomplete: 'off' }));
    const rate = /** @type {HTMLInputElement} */ (el('input', { type: 'number', id: 'np-rate', min: '0', step: '0.01', placeholder: 'default' }));
    const clientList = el('datalist', { id: 'np-clients' });
    const currency = /** @type {HTMLSelectElement} */ (el('select', { id: 'st-currency' }, [['BRL', 'Real (R$)'], ['USD', 'Dollar (US$)'], ['EUR', 'Euro (€)'], ['GBP', 'Pound (£)']].map(function (c) { return el('option', { value: c[0], text: c[1] }); })));
    const defRate = /** @type {HTMLInputElement} */ (el('input', { type: 'number', id: 'st-rate', min: '0', step: '0.01' }));
    let settings = { currency: 'BRL', default_rate: 0 };

    /** @returns {Promise<void>} */
    async function load() {
      const got = await Promise.all([api('/projects?archived=1'), api('/settings')]);
      const projects = got[0];
      settings = got[1];
      if (!currency.querySelector('option[value="' + settings.currency + '"]')) currency.appendChild(el('option', { value: settings.currency, text: settings.currency }));
      currency.value = settings.currency;
      if (document.activeElement !== defRate) defRate.value = settings.default_rate ? String(settings.default_rate) : '';
      clientList.replaceChildren.apply(clientList, projects.map(function (p) { return p.client; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; }).map(function (c) { return el('option', { value: c }); }));
      if (!projects.length) {
        body.replaceChildren(el('tr', {}, [el('td', { colspan: '6', class: 'empty', text: 'No projects yet.' })]));
        return;
      }
      body.replaceChildren.apply(body, projects.map(function (p) {
        const patch = function (data) { return safe(async function () { await api('/projects/' + p.id, 'PATCH', data()); await load(); }); };
        const color = /** @type {HTMLInputElement} */ (el('input', { type: 'color', value: p.color, disabled: !CAN_WRITE, 'aria-label': 'Color of ' + p.name }));
        const nm = /** @type {HTMLInputElement} */ (el('input', { type: 'text', value: p.name, maxlength: '80', disabled: !CAN_WRITE, 'aria-label': 'Name' }));
        const cl = /** @type {HTMLInputElement} */ (el('input', { type: 'text', value: p.client, maxlength: '80', placeholder: '—', list: 'np-clients', disabled: !CAN_WRITE, 'aria-label': 'Client' }));
        const rt = /** @type {HTMLInputElement} */ (el('input', { type: 'number', min: '0', step: '0.01', value: p.hourly_rate === null ? '' : String(p.hourly_rate), placeholder: settings.default_rate ? String(settings.default_rate) : 'default', disabled: !CAN_WRITE, 'aria-label': 'Hourly rate of ' + p.name, title: 'Empty = uses the workspace default rate' }));
        color.addEventListener('change', patch(function () { return { color: color.value }; }));
        nm.addEventListener('change', patch(function () { return { name: nm.value }; }));
        cl.addEventListener('change', patch(function () { return { client: cl.value }; }));
        rt.addEventListener('change', patch(function () { return { hourly_rate: rt.value === '' ? null : Number(rt.value) }; }));
        return el('tr', { class: p.archived ? 'hr-archived' : '' }, [
          el('td', {}, [color]),
          el('td', {}, [nm, p.archived ? el('span', { class: 'badge', text: 'Archived' }) : null]),
          el('td', {}, [cl]),
          el('td', {}, [rt]),
          el('td', { text: human(p.total_seconds) }),
          el('td', {}, [CAN_WRITE && el('span', { class: 'row-actions' }, [
            el('button', { type: 'button', class: 'btn-ghost btn-sm', text: p.archived ? 'Unarchive' : 'Archive', onclick: patch(function () { return { archived: !p.archived }; }) }),
            el('button', { type: 'button', class: 'btn-danger btn-sm', text: 'Delete', onclick: safe(async function () {
              if (!confirm('Delete the project "' + p.name + '"? Its entries remain, without a project. This applies to every member.')) return;
              await api('/projects/' + p.id, 'DELETE');
              await load();
            }) }),
          ])]),
        ]);
      }));
    }

    const saveSettings = safe(async function () {
      await api('/settings', 'PATCH', { currency: currency.value, default_rate: defRate.value === '' ? 0 : Number(defRate.value) });
      toast('Billing updated.');
      await load();
    });
    currency.addEventListener('change', saveSettings);
    defRate.addEventListener('change', saveSettings);
    currency.disabled = defRate.disabled = !CAN_WRITE;

    // A viewer has no "New project" card; drop the missing part instead of printing "false".
    root.replaceChildren.apply(root, [
      clientList,
      CAN_WRITE && el('div', { class: 'card' }, [
        el('h2', { text: 'New project' }),
        el('form', { class: 'row', onsubmit: safe(async function (ev) {
          ev.preventDefault();
          await api('/projects', 'POST', { name: name.value, client: client.value, hourly_rate: rate.value === '' ? null : Number(rate.value) });
          name.value = client.value = rate.value = '';
          await load();
        }) }, [
          el('div', { class: 'field' }, [el('label', { for: 'np-name', text: 'Name' }), name]),
          el('div', { class: 'field' }, [el('label', { for: 'np-client', text: 'Client (optional)' }), client]),
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'np-rate', text: 'Hourly rate' }), rate]),
          el('div', { class: 'field hr-field-btn' }, [el('button', { type: 'submit', text: 'Create' })]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Workspace projects' }),
        el('span', { class: 'muted', text: 'Shared among members. The time shown is yours only.' }),
        el('div', { class: 'table-wrap' }, [el('table', { class: 'hr-projects' }, [
          el('thead', {}, [el('tr', {}, ['Color', 'Name', 'Client', 'Hourly rate', 'Your time', ''].map(function (h) { return el('th', { text: h }); }))]),
          body,
        ])]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Billing' }),
        el('span', { class: 'muted', text: 'The amount of a billable entry is hours × the project hourly rate. Projects without their own rate use the default below. Changing a rate recalculates everything already logged.' }),
        el('div', { class: 'row' }, [
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'st-currency', text: 'Currency' }), currency]),
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'st-rate', text: 'Default hourly rate' }), defRate]),
        ]),
      ])
    ].filter(Boolean));
    await load();
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
    const sources = { 'horas-backup': 'Horas backup', 'horas-csv': 'Horas CSV export', 'clockify-csv': 'Clockify detailed report', 'generic-csv': 'CSV file' };
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
      content = await f.text();
      show(await send(true));
    });
    file.addEventListener('change', preview);
    order.addEventListener('change', preview);

    root.replaceChildren(
      el('div', { class: 'card' }, [
        el('h2', { text: 'Export' }),
        el('span', { class: 'muted', text: 'Your own entries in this workspace. The backup can be imported back here or into another account; the CSV opens in any spreadsheet.' }),
        el('div', { class: 'row' }, [
          el('button', { type: 'button', text: 'Download backup (JSON)', onclick: safe(function () { return download('/backup.json', 'horas-backup-' + dayKey(new Date()) + '.json'); }) }),
          el('button', { type: 'button', class: 'btn-ghost', text: 'Download entries (CSV)', onclick: safe(function () { return download('/export.csv', 'horas-' + dayKey(new Date()) + '.csv'); }) }),
        ]),
      ]),
      CAN_WRITE ? el('div', { class: 'card' }, [
        el('h2', { text: 'Import' }),
        el('span', { class: 'muted', text: 'Accepts a Horas backup, a Horas CSV export, or Clockify\'s Detailed report exported as CSV. You see a preview before anything is saved, and entries already here are skipped.' }),
        el('div', { class: 'row' }, [
          el('div', { class: 'field' }, [el('label', { for: 'imp-file', text: 'File (.csv or .json, up to 3 MB)' }), file]),
          el('div', { class: 'field hr-field-md' }, [el('label', { for: 'imp-order', text: 'Dates like 03/04/2026' }), order]),
        ]),
      ]) : el('p', { class: 'alert alert-info', text: 'Your role in this workspace is read-only, so you can export but not import.' }),
      out
    );
  }

  const views = { time: viewTime, reports: viewReports, projects: viewProjects, integrations: viewIntegrations, data: viewData };
  const start = views[root.dataset.view || ''];
  if (start) {
    Promise.resolve().then(start).catch(function (e) {
      root.appendChild(el('p', { class: 'alert alert-error', text: 'Could not load: ' + e.message }));
    });
  }
})();
