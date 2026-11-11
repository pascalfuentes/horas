/**
 * Interface do controle de tempo (timer, relatórios, projetos e tokens).
 *
 * Um arquivo só, sem build e sem dependências. Cada página do painel renderiza
 * um `<div id="horas-app" data-view="…">` e este script monta a tela dentro.
 * Todo texto vindo do banco entra no DOM por `textContent`, nunca por HTML.
 */
(function () {
  'use strict';

  const root = document.getElementById('horas-app');
  if (!root) return;

  /** Base da API deste workspace, ex.: /api/w/meu-slug/horas */
  const BASE = root.dataset.base || '';
  /** Papel de leitura esconde tudo que escreve (o servidor barra de qualquer forma). */
  const CAN_WRITE = root.dataset.write === '1';
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /* ------------------------------------------------------------------ */
  /* Utilitários                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Chama a API JSON do workspace.
   * @param {string} path Caminho depois da base, ex.: "/entries?from=2026-01-01".
   * @param {string} [method]
   * @param {object} [body]
   * @param {string} [base] Outra base, quando não é a API de horas.
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
      throw new Error('Sessão expirada.');
    }
    const data = await res.json().catch(function () { return null; });
    if (!res.ok) throw new Error((data && data.error) || 'Algo deu errado (' + res.status + ').');
    return data;
  }

  /**
   * Cria um elemento.
   * @param {string} tag
   * @param {Object<string, any>} [attrs] `class`, `text`, `on<evento>` e atributos comuns.
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
   * Segundos -> "1:23:45" (relógio).
   * @param {number} s
   * @returns {string}
   */
  function clock(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 3600) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }

  /**
   * Segundos -> "1h 23min" (leitura).
   * @param {number} s
   * @returns {string}
   */
  function human(s) {
    const m = Math.round(s / 60);
    if (m < 60) return m + 'min';
    return Math.floor(m / 60) + 'h ' + pad(m % 60) + 'min';
  }

  /**
   * Data local -> "YYYY-MM-DD".
   * @param {Date} d
   * @returns {string}
   */
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /**
   * Hoje deslocado em N dias, à meia-noite local.
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
   * "YYYY-MM-DD" -> "Hoje", "Ontem" ou "ter., 10 de nov.".
   * @param {string} key
   * @returns {string}
   */
  function dayLabel(key) {
    if (key === dayKey(day(0))) return 'Hoje';
    if (key === dayKey(day(-1))) return 'Ontem';
    const p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  /**
   * Mostra um aviso passageiro no rodapé.
   * @param {string} msg
   * @param {boolean} [isError]
   * @returns {void}
   */
  function toast(msg, isError) {
    const t = el('div', { class: 'hr-toast' + (isError ? ' hr-toast-erro' : ''), role: 'status', text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  /**
   * Envolve um handler assíncrono: erro vira aviso em vez de sumir no console.
   * @param {function(...any): Promise<any>} fn
   * @returns {function(...any): void}
   */
  function safe(fn) {
    return function () {
      fn.apply(null, arguments).catch(function (e) { toast(e.message, true); });
    };
  }

  /**
   * `<select>` de projetos.
   * @param {Array<object>} projects
   * @param {number|null} selected
   * @param {string} [emptyLabel]
   * @returns {HTMLSelectElement}
   */
  function projectSelect(projects, selected, emptyLabel) {
    const s = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': 'Projeto' }));
    s.appendChild(el('option', { value: '0', text: emptyLabel || 'Sem projeto' }));
    projects.forEach(function (p) {
      if (p.archived && p.id !== selected) return;
      s.appendChild(el('option', { value: String(p.id), text: p.client ? p.name + ' · ' + p.client : p.name, selected: p.id === selected }));
    });
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* Tela: Tempo                                                         */
  /* ------------------------------------------------------------------ */

  /** @returns {Promise<void>} */
  async function viewTempo() {
    /** @type {{projects: object[], running: object|null, entries: object[], status: object|null}} */
    const state = { projects: [], running: null, entries: [], status: null };
    let ticker = 0;

    const desc = /** @type {HTMLInputElement} */ (el('input', { type: 'text', placeholder: 'No que você está trabalhando?', maxlength: '500', 'aria-label': 'Descrição' }));
    const projSlot = el('div', { class: 'hr-proj' });
    const bill = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: 'hr-bill' }));
    const clockEl = el('div', { class: 'hr-clock', text: '0:00:00', 'aria-live': 'off' });
    const btn = el('button', { type: 'button', class: 'hr-go', text: 'Iniciar' });
    const totals = el('p', { class: 'muted hr-totals' });
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
      btn.textContent = r ? 'Parar' : 'Iniciar';
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

    /** Edição na barra, com timer rodando, grava direto na entrada. @returns {Promise<void>} */
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
      totals.textContent = st ? 'Hoje: ' + human(st.today_seconds) + '  ·  Esta semana: ' + human(st.week_seconds) : '';
      const done = state.entries.filter(function (e) { return !e.running; });
      if (!done.length) {
        list.replaceChildren(el('p', { class: 'empty', text: 'Nenhum lançamento nos últimos 30 dias. Inicie o timer acima ou peça para a sua IA lançar por você.' }));
        return;
      }
      /** @type {Object<string, object[]>} */
      const groups = {};
      done.forEach(function (e) { (groups[dayKey(new Date(e.start))] = groups[dayKey(new Date(e.start))] || []).push(e); });
      list.replaceChildren.apply(list, Object.keys(groups).sort().reverse().map(function (key) {
        const total = groups[key].reduce(function (a, e) { return a + e.duration_seconds; }, 0);
        return el('section', { class: 'card hr-day' }, [
          el('header', {}, [el('h2', { text: dayLabel(key) }), el('strong', { text: human(total) })]),
          el('ul', {}, groups[key].map(row)),
        ]);
      }));
    }

    /**
     * @param {object} e Entrada.
     * @returns {HTMLElement}
     */
    function row(e) {
      return el('li', { class: 'hr-row' }, [
        el('span', { class: 'hr-dot', style: 'background:' + (e.project_color || 'var(--border)') }),
        el('div', { class: 'hr-what' }, [
          el('span', { class: e.description ? '' : 'muted', text: e.description || '(sem descrição)' }),
          el('small', {}, [
            e.project || 'Sem projeto',
            e.billable ? ' · faturável' : '',
            e.tags.length ? ' · ' + e.tags.map(function (t) { return '#' + t; }).join(' ') : '',
          ]),
        ]),
        el('span', { class: 'hr-when muted', text: hhmm(e.start) + ' – ' + hhmm(e.end) }),
        el('strong', { class: 'hr-dur', text: clock(e.duration_seconds) }),
        CAN_WRITE && el('span', { class: 'row-actions' }, [
          el('button', { type: 'button', class: 'btn-ghost btn-sm', title: 'Continuar este lançamento', 'aria-label': 'Continuar', text: '▶', onclick: safe(async function () {
            await api('/timer/start', 'POST', { description: e.description, project_id: e.project_id || 0, tags: e.tags, billable: e.billable });
            await load();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }) }),
          el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Editar', onclick: function () { openDialog(e); } }),
        ]),
      ]);
    }

    /**
     * Diálogo de lançamento manual (sem `entry`) ou de edição.
     * @param {object} [entry]
     * @returns {void}
     */
    function openDialog(entry) {
      const start = entry ? new Date(entry.start) : new Date(Date.now() - 3600000);
      const end = entry ? new Date(entry.end) : new Date();
      const f = {
        desc: /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'hd-desc', maxlength: '500', value: entry ? entry.description : desc.value })),
        proj: projectSelect(state.projects, entry ? entry.project_id : Number(projEl().value) || null),
        tags: /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'hd-tags', placeholder: 'separadas por vírgula', value: entry ? entry.tags.join(', ') : '' })),
        date: /** @type {HTMLInputElement} */ (el('input', { type: 'date', id: 'hd-date', required: true, value: dayKey(start) })),
        from: /** @type {HTMLInputElement} */ (el('input', { type: 'time', id: 'hd-from', required: true, value: pad(start.getHours()) + ':' + pad(start.getMinutes()) })),
        to: /** @type {HTMLInputElement} */ (el('input', { type: 'time', id: 'hd-to', required: true, value: pad(end.getHours()) + ':' + pad(end.getMinutes()) })),
        bill: /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: 'hd-bill', checked: entry ? entry.billable : false })),
      };
      f.proj.id = 'hd-proj';
      const dlg = /** @type {HTMLDialogElement} */ (el('dialog', { class: 'hr-dialog' }));
      const close = function () { dlg.close(); dlg.remove(); };
      const field = function (label, input) { return el('div', { class: 'field' }, [el('label', { for: input.id, text: label }), input]); };

      const form = el('form', { class: 'stack', onsubmit: safe(async function (ev) {
        ev.preventDefault();
        const s = new Date(f.date.value + 'T' + f.from.value);
        const e = new Date(f.date.value + 'T' + f.to.value);
        if (e <= s) e.setDate(e.getDate() + 1); // terminou depois da meia-noite
        const body = {
          description: f.desc.value,
          project_id: Number(f.proj.value),
          tags: f.tags.value.split(','),
          billable: f.bill.checked,
          start: s.toISOString(),
          end: e.toISOString(),
        };
        if (entry) await api('/entries/' + entry.id, 'PATCH', body);
        else await api('/entries', 'POST', body);
        close();
        await load();
      }) }, [
        el('h2', { text: entry ? 'Editar lançamento' : 'Lançamento manual' }),
        field('Descrição', f.desc),
        field('Projeto', f.proj),
        el('div', { class: 'hr-grid3' }, [field('Dia', f.date), field('Início', f.from), field('Fim', f.to)]),
        field('Tags', f.tags),
        el('label', { class: 'hr-check' }, [f.bill, ' Faturável']),
        el('div', { class: 'hr-dialog-foot' }, [
          entry && el('button', { type: 'button', class: 'btn-danger btn-sm', text: 'Excluir', onclick: safe(async function () {
            if (!confirm('Excluir este lançamento? Não dá para desfazer.')) return;
            await api('/entries/' + entry.id, 'DELETE');
            close();
            await load();
          }) }),
          el('span', { class: 'spacer' }),
          el('button', { type: 'button', class: 'btn-ghost', text: 'Cancelar', onclick: close }),
          el('button', { type: 'submit', text: 'Salvar' }),
        ]),
      ]);
      dlg.appendChild(form);
      dlg.addEventListener('cancel', function () { dlg.remove(); });
      document.body.appendChild(dlg);
      dlg.showModal();
    }

    /** @returns {Promise<void>} */
    async function load() {
      const got = await Promise.all([
        api('/projects'),
        api('/status'),
        api('/entries?from=' + dayKey(day(-30)) + '&limit=1000'),
      ]);
      state.projects = got[0];
      state.status = got[1];
      state.running = got[1].running;
      state.entries = got[2];
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
        el('label', { class: 'hr-check', for: 'hr-bill', title: 'Marcar como faturável' }, [bill, ' Faturável']),
        clockEl,
        btn,
      ]) : el('p', { class: 'alert alert-info', text: 'Seu papel neste workspace é somente leitura.' }),
      el('div', { class: 'hr-sub' }, [
        totals,
        CAN_WRITE && el('button', { type: 'button', class: 'btn-ghost btn-sm', text: '+ Lançamento manual', onclick: function () { openDialog(); } }),
      ]),
      list
    );

    await load();
    // Outra aba, o celular ou a IA podem ter mexido no timer: ressincroniza ao voltar.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load().catch(function () {}); });
    setInterval(function () { if (!document.hidden && !document.querySelector('dialog[open]')) load().catch(function () {}); }, 60000);
  }

  /* ------------------------------------------------------------------ */
  /* Tela: Relatórios                                                    */
  /* ------------------------------------------------------------------ */

  /** @returns {Promise<void>} */
  async function viewRelatorios() {
    const today = day(0);
    const monday = day(-((today.getDay() + 6) % 7));
    /** @type {Object<string, {label: string, range: function(): Date[]}>} */
    const presets = {
      semana: { label: 'Esta semana', range: function () { return [monday, today]; } },
      semana_passada: { label: 'Semana passada', range: function () { return [new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7), new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 1)]; } },
      mes: { label: 'Este mês', range: function () { return [new Date(today.getFullYear(), today.getMonth(), 1), today]; } },
      mes_passado: { label: 'Mês passado', range: function () { return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)]; } },
      d30: { label: 'Últimos 30 dias', range: function () { return [day(-29), today]; } },
      ano: { label: 'Este ano', range: function () { return [new Date(today.getFullYear(), 0, 1), today]; } },
    };

    const preset = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': 'Período' }, Object.keys(presets).map(function (k) { return el('option', { value: k, text: presets[k].label }); }).concat([el('option', { value: 'custom', text: 'Personalizado' })])));
    const from = /** @type {HTMLInputElement} */ (el('input', { type: 'date', 'aria-label': 'De' }));
    const to = /** @type {HTMLInputElement} */ (el('input', { type: 'date', 'aria-label': 'Até' }));
    const projSlot = el('span', {});
    const out = el('div', {});
    const projects = await api('/projects?archived=1');
    projSlot.appendChild(projectSelect(projects, null, 'Todos os projetos'));
    const proj = /** @type {HTMLSelectElement} */ (projSlot.firstChild);
    proj.options[0].value = '';

    /** @returns {string} */
    function query() {
      return '?from=' + from.value + '&to=' + to.value + (proj.value ? '&project_id=' + proj.value : '');
    }

    /** @returns {void} */
    function applyPreset() {
      if (preset.value === 'custom') return;
      const r = presets[preset.value].range();
      from.value = dayKey(r[0]);
      to.value = dayKey(r[1]);
    }

    /**
     * Gráfico de barras por dia, preenchendo os dias sem lançamento.
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
      return el('div', { class: 'hr-chart' + (dense ? ' hr-chart-dense' : ''), role: 'img', 'aria-label': 'Horas por dia no período' }, days.map(function (k) {
        const s = map[k] || 0;
        const p = k.split('-').map(Number);
        const label = new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('pt-BR', dense ? { day: 'numeric' } : { weekday: 'short', day: 'numeric' });
        return el('div', { class: 'hr-col', title: dayLabel(k) + ': ' + human(s) }, [
          el('small', { text: s && !dense ? human(s) : '' }),
          el('div', { class: 'hr-colbar', style: 'height:' + Math.max(s ? 3 : 0, (s / max) * 100) + '%' }),
          el('small', { class: 'muted', text: label }),
        ]);
      }));
    }

    /**
     * @param {string} title
     * @param {string[]} head
     * @param {Array<Array<Node|string>>} rows
     * @returns {HTMLElement}
     */
    function table(title, head, rows) {
      return el('div', { class: 'card' }, [
        el('h2', { text: title }),
        rows.length ? el('div', { class: 'table-wrap' }, [el('table', {}, [
          el('thead', {}, [el('tr', {}, head.map(function (h) { return el('th', { text: h }); }))]),
          el('tbody', {}, rows.map(function (r) { return el('tr', {}, r.map(function (c) { return el('td', { class: 'wrap' }, [c]); })); })),
        ])]) : el('p', { class: 'empty', text: 'Nada neste período.' }),
      ]);
    }

    /** @returns {Promise<void>} */
    async function load() {
      if (!from.value || !to.value) return;
      const s = await api('/summary' + query());
      const stat = function (label, value) { return el('div', { class: 'card hr-stat' }, [el('small', { class: 'muted', text: label }), el('strong', { text: value })]); };
      out.replaceChildren(
        el('div', { class: 'hr-stats' }, [
          stat('Total', human(s.total_seconds)),
          stat('Faturável', human(s.billable_seconds)),
          stat('Lançamentos', String(s.entries)),
        ]),
        el('div', { class: 'card' }, [el('h2', { text: 'Por dia' }), chart(s.by_day)]),
        table('Por projeto', ['Projeto', 'Tempo', '%'], s.by_project.map(function (p) {
          const pct = s.total_seconds ? Math.round((p.seconds / s.total_seconds) * 100) : 0;
          return [
            el('span', {}, [el('span', { class: 'hr-dot', style: 'background:' + p.color }), ' ' + p.project]),
            human(p.seconds),
            el('span', { class: 'hr-pct' }, [el('span', { style: 'width:' + pct + '%;background:' + p.color }), el('small', { text: pct + '%' })]),
          ];
        })),
        table('Por descrição', ['Descrição', 'Projeto', 'Lançamentos', 'Tempo'], s.by_description.slice(0, 30).map(function (d) {
          return [d.description, d.project || '—', String(d.entries), human(d.seconds)];
        }))
      );
    }

    const reload = safe(load);
    preset.addEventListener('change', function () { applyPreset(); reload(); });
    [from, to].forEach(function (i) { i.addEventListener('change', function () { preset.value = 'custom'; reload(); }); });
    proj.addEventListener('change', reload);

    root.replaceChildren(
      el('div', { class: 'card hr-filters' }, [
        preset, from, to, projSlot,
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Exportar CSV', onclick: safe(async function () {
          const res = await fetch(BASE + '/export.csv' + query(), { headers: { 'x-timezone': TZ }, credentials: 'same-origin' });
          if (!res.ok) throw new Error('Não foi possível exportar.');
          const a = el('a', { href: URL.createObjectURL(await res.blob()), download: 'horas-' + from.value + '_' + to.value + '.csv' });
          a.click();
          URL.revokeObjectURL(a.getAttribute('href'));
        }) }),
      ]),
      out
    );
    applyPreset();
    await load();
  }

  /* ------------------------------------------------------------------ */
  /* Tela: Projetos                                                      */
  /* ------------------------------------------------------------------ */

  /** @returns {Promise<void>} */
  async function viewProjetos() {
    const body = el('tbody', {});
    const name = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'np-name', required: true, maxlength: '80' }));
    const client = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'np-client', maxlength: '80' }));

    /** @returns {Promise<void>} */
    async function load() {
      const projects = await api('/projects?archived=1');
      if (!projects.length) {
        body.replaceChildren(el('tr', {}, [el('td', { colspan: '5', class: 'empty', text: 'Nenhum projeto ainda.' })]));
        return;
      }
      body.replaceChildren.apply(body, projects.map(function (p) {
        const patch = function (data) { return safe(async function () { await api('/projects/' + p.id, 'PATCH', data()); await load(); }); };
        const color = /** @type {HTMLInputElement} */ (el('input', { type: 'color', value: p.color, disabled: !CAN_WRITE, 'aria-label': 'Cor de ' + p.name }));
        const nm = /** @type {HTMLInputElement} */ (el('input', { type: 'text', value: p.name, maxlength: '80', disabled: !CAN_WRITE, 'aria-label': 'Nome' }));
        const cl = /** @type {HTMLInputElement} */ (el('input', { type: 'text', value: p.client, maxlength: '80', placeholder: '—', disabled: !CAN_WRITE, 'aria-label': 'Cliente' }));
        color.addEventListener('change', patch(function () { return { color: color.value }; }));
        nm.addEventListener('change', patch(function () { return { name: nm.value }; }));
        cl.addEventListener('change', patch(function () { return { client: cl.value }; }));
        return el('tr', { class: p.archived ? 'hr-archived' : '' }, [
          el('td', {}, [color]),
          el('td', {}, [nm, p.archived ? el('span', { class: 'badge', text: 'Arquivado' }) : null]),
          el('td', {}, [cl]),
          el('td', { text: human(p.total_seconds) }),
          el('td', {}, [CAN_WRITE && el('span', { class: 'row-actions' }, [
            el('button', { type: 'button', class: 'btn-ghost btn-sm', text: p.archived ? 'Reativar' : 'Arquivar', onclick: patch(function () { return { archived: !p.archived }; }) }),
            el('button', { type: 'button', class: 'btn-danger btn-sm', text: 'Excluir', onclick: safe(async function () {
              if (!confirm('Excluir o projeto "' + p.name + '"? Os lançamentos continuam, sem projeto. Vale para todos os membros.')) return;
              await api('/projects/' + p.id, 'DELETE');
              await load();
            }) }),
          ])]),
        ]);
      }));
    }

    root.replaceChildren(
      CAN_WRITE && el('div', { class: 'card' }, [
        el('h2', { text: 'Novo projeto' }),
        el('form', { class: 'row', onsubmit: safe(async function (ev) {
          ev.preventDefault();
          await api('/projects', 'POST', { name: name.value, client: client.value });
          name.value = '';
          client.value = '';
          await load();
        }) }, [
          el('div', { class: 'field' }, [el('label', { for: 'np-name', text: 'Nome' }), name]),
          el('div', { class: 'field' }, [el('label', { for: 'np-client', text: 'Cliente (opcional)' }), client]),
          el('div', { class: 'field hr-field-btn' }, [el('button', { type: 'submit', text: 'Criar' })]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Projetos do workspace' }),
        el('span', { class: 'muted', text: 'Compartilhados entre os membros. O tempo mostrado é só o seu.' }),
        el('div', { class: 'table-wrap' }, [el('table', { class: 'hr-projects' }, [
          el('thead', {}, [el('tr', {}, ['Cor', 'Nome', 'Cliente', 'Seu tempo', ''].map(function (h) { return el('th', { text: h }); }))]),
          body,
        ])]),
      ])
    );
    await load();
  }

  /* ------------------------------------------------------------------ */
  /* Tela: Integrações (tokens de API/MCP)                               */
  /* ------------------------------------------------------------------ */

  /**
   * A lista de tokens vem renderizada do servidor; aqui só o criar/revogar.
   * @returns {void}
   */
  function viewIntegracoes() {
    const url = root.dataset.tokens || '';
    const form = /** @type {HTMLFormElement|null} */ (document.getElementById('novo-token'));
    const reveal = document.getElementById('token-novo');

    if (form) form.addEventListener('submit', safe(async function (ev) {
      ev.preventDefault();
      const nome = /** @type {HTMLInputElement} */ (form.elements.namedItem('nome'));
      const r = await api('', 'POST', { acao: 'criar', nome: nome.value, timezone: TZ }, url);
      // Mostra o token e preenche os exemplos com ele. Só existe nesta tela, agora.
      document.querySelectorAll('[data-token]').forEach(function (n) { n.textContent = n.textContent.replace(/SEU_TOKEN/g, r.token); });
      /** @type {HTMLElement} */ (reveal.querySelector('code')).textContent = r.token;
      reveal.hidden = false;
      form.hidden = true;
      reveal.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));

    document.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', safe(async function () {
        await navigator.clipboard.writeText(document.getElementById(b.getAttribute('data-copy')).textContent);
        toast('Copiado.');
      }));
    });

    document.querySelectorAll('[data-revogar]').forEach(function (b) {
      b.addEventListener('click', safe(async function () {
        if (!confirm('Revogar este token? Quem estiver usando perde o acesso na hora.')) return;
        await api('', 'POST', { acao: 'revogar', id: b.getAttribute('data-revogar') }, url);
        location.reload();
      }));
    });
  }

  /* ------------------------------------------------------------------ */

  /** @type {Object<string, function(): (Promise<void>|void)>} */
  const views = { tempo: viewTempo, relatorios: viewRelatorios, projetos: viewProjetos, integracoes: viewIntegracoes };
  const start = views[root.dataset.view || ''];
  if (start) {
    Promise.resolve().then(start).catch(function (e) {
      root.appendChild(el('p', { class: 'alert alert-error', text: 'Não foi possível carregar: ' + e.message }));
    });
  }
})();
