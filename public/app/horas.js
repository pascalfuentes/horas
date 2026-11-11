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
   * Valor em dinheiro na moeda do workspace.
   * @param {number} n
   * @param {string} currency Código ISO 4217.
   * @returns {string}
   */
  function money(n, currency) {
    try {
      return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency || 'BRL' }).format(n || 0);
    } catch (e) {
      return (n || 0).toFixed(2);
    }
  }

  /**
   * Lê uma duração digitada: "1:30", "1h30", "1h 30m", "45m", "1,5" (horas) ou "90" (minutos).
   * @param {string} text
   * @returns {number|null} Segundos, ou null se não deu para entender.
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
   * Segundos -> "1:30" (para campo de duração).
   * @param {number} s
   * @returns {string}
   */
  function hm(s) {
    const m = Math.round(s / 60);
    return Math.floor(m / 60) + ':' + pad(m % 60);
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

  /**
   * Diálogo de lançamento: manual (sem `entry`) ou edição. Usado no timer e
   * no relatório detalhado.
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
      tags: /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'hd-tags', list: 'hd-taglist', placeholder: 'separadas por vírgula', autocomplete: 'off', value: entry ? entry.tags.join(', ') : '' })),
      date: /** @type {HTMLInputElement} */ (el('input', { type: 'date', id: 'hd-date', required: true, value: dayKey(start) })),
      from: /** @type {HTMLInputElement} */ (el('input', { type: 'time', id: 'hd-from', required: true, value: t(start) })),
      to: /** @type {HTMLInputElement} */ (el('input', { type: 'time', id: 'hd-to', required: true, value: t(end) })),
      dur: /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'hd-dur', inputmode: 'text', placeholder: '1:30, 1h30 ou 90', autocomplete: 'off' })),
      bill: /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: 'hd-bill', checked: entry ? entry.billable : false })),
    };
    f.proj.id = 'hd-proj';

    /** Início e fim como datas; fim antes do início = terminou depois da meia-noite. @returns {Date[]} */
    function range() {
      const s = new Date(f.date.value + 'T' + f.from.value);
      const e = new Date(f.date.value + 'T' + f.to.value);
      if (e <= s) e.setDate(e.getDate() + 1);
      return [s, e];
    }
    const syncDur = function () { const r = range(); if (!isNaN(r[1] - r[0])) f.dur.value = hm((r[1] - r[0]) / 1000); };
    syncDur();
    [f.from, f.to, f.date].forEach(function (i) { i.addEventListener('change', syncDur); });
    // Digitar a duração move o FIM, mantendo o início — como no Clockify.
    f.dur.addEventListener('change', function () {
      const secs = parseDuration(f.dur.value);
      if (!secs || secs >= 86400) { toast('Duração inválida. Exemplos: 1:30, 1h30, 45m, 90.', true); syncDur(); return; }
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
      el('h2', { text: entry ? 'Editar lançamento' : 'Lançamento manual' }),
      field('Descrição', f.desc),
      field('Projeto', f.proj),
      el('div', { class: 'hr-grid4' }, [field('Dia', f.date), field('Início', f.from), field('Fim', f.to), field('Duração', f.dur)]),
      field('Tags', f.tags),
      el('datalist', { id: 'hd-taglist' }, (opts.tags || []).map(function (tag) { return el('option', { value: tag }); })),
      el('label', { class: 'hr-check' }, [f.bill, ' Faturável']),
      el('div', { class: 'hr-dialog-foot' }, [
        entry && el('button', { type: 'button', class: 'btn-danger btn-sm', text: 'Excluir', onclick: safe(async function () {
          if (!confirm('Excluir este lançamento? Não dá para desfazer.')) return;
          await api('/entries/' + entry.id, 'DELETE');
          await finish();
        }) }),
        entry && el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Duplicar', title: 'Cria outro lançamento com estes dados', onclick: safe(async function () {
          await api('/entries', 'POST', payload());
          await finish();
        }) }),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'btn-ghost', text: 'Cancelar', onclick: close }),
        el('button', { type: 'submit', text: 'Salvar' }),
      ]),
    ]));
    dlg.addEventListener('cancel', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  /* ------------------------------------------------------------------ */
  /* Tela: Tempo                                                         */
  /* ------------------------------------------------------------------ */

  /** @returns {Promise<void>} */
  async function viewTempo() {
    /** @type {{projects: object[], running: object|null, entries: object[], status: object|null}} */
    const state = { projects: [], running: null, entries: [], status: null, tags: [] };
    let ticker = 0;
    /** Quantos dias para trás a lista mostra; "Carregar mais" soma 30. */
    let windowDays = 30;

    const desc = /** @type {HTMLInputElement} */ (el('input', { type: 'text', placeholder: 'No que você está trabalhando?', maxlength: '500', 'aria-label': 'Descrição' }));
    const projSlot = el('div', { class: 'hr-proj' });
    const bill = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: 'hr-bill' }));
    const clockEl = el('button', { type: 'button', class: 'hr-clock', text: '0:00:00', title: 'Corrigir a hora de início', onclick: function () { editStart(); } });
    const more = el('button', { type: 'button', class: 'btn-sm hr-link', text: 'Carregar mais 30 dias', onclick: safe(async function () { windowDays += 30; await load(); }) });
    const btn = el('button', { type: 'button', class: 'hr-go', text: 'Iniciar' });
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
      totals.replaceChildren.apply(totals, st ? [
        el('span', { class: 'badge badge-sun', text: 'Hoje · ' + human(st.today_seconds) }),
        el('span', { class: 'badge badge-sky', text: 'Esta semana · ' + human(st.week_seconds) }),
      ] : []);
      const done = state.entries.filter(function (e) { return !e.running; });
      if (!done.length) {
        list.replaceChildren(el('p', { class: 'empty', text: 'Nenhum lançamento nos últimos ' + windowDays + ' dias. Inicie o timer acima ou peça para a sua IA lançar por você.' }));
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
          el('button', { type: 'button', class: 'hr-play', title: 'Continuar este lançamento', 'aria-label': 'Continuar', onclick: safe(async function () {
            await api('/timer/start', 'POST', { description: e.description, project_id: e.project_id || 0, tags: e.tags, billable: e.billable });
            await load();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }) }, [el('span', { class: 'hr-tri' })]),
          el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Editar', onclick: function () { openDialog(e); } }),
        ]),
      ]);
    }

    /**
     * Abre o diálogo de lançamento manual (sem `entry`) ou de edição.
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
     * Corrige a hora de início do timer rodando (esqueci de iniciar na hora).
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
        el('h2', { text: 'Quando você começou?' }),
        el('div', { class: 'hr-grid2' }, [
          el('div', { class: 'field' }, [el('label', { for: 'hs-date', text: 'Dia' }), date]),
          el('div', { class: 'field' }, [el('label', { for: 'hs-time', text: 'Início' }), time]),
        ]),
        el('div', { class: 'hr-dialog-foot' }, [
          el('span', { class: 'spacer' }),
          el('button', { type: 'button', class: 'btn-ghost', text: 'Cancelar', onclick: close }),
          el('button', { type: 'submit', text: 'Salvar' }),
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
        el('label', { class: 'hr-check', for: 'hr-bill', title: 'Marcar como faturável' }, [bill, ' Faturável']),
        clockEl,
        btn,
      ]) : el('p', { class: 'alert alert-info', text: 'Seu papel neste workspace é somente leitura.' }),
      el('div', { class: 'hr-sub' }, [
        totals,
        CAN_WRITE && el('button', { type: 'button', class: 'btn-ghost btn-sm', text: '+ Lançamento manual', onclick: function () { openDialog(); } }),
      ]),
      list,
      el('div', { class: 'hr-more-wrap' }, [more])
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
    /** Agrupamentos do resumo: rótulo, lista no JSON e como nomear cada linha. */
    const groups = {
      project: { label: 'Projeto', key: 'by_project', name: function (g) { return g.client ? g.project + ' · ' + g.client : g.project; } },
      client: { label: 'Cliente', key: 'by_client', name: function (g) { return g.client; } },
      tag: { label: 'Tag', key: 'by_tag', name: function (g) { return g.tag; } },
      description: { label: 'Descrição', key: 'by_description', name: function (g) { return g.project ? g.description + ' · ' + g.project : g.description; } },
    };

    const got = await Promise.all([api('/projects?archived=1'), api('/tags')]);
    const projects = got[0];
    const tags = got[1].map(function (t) { return t.tag; });
    const clients = projects.map(function (p) { return p.client; }).filter(function (c, i, a) { return c && a.indexOf(c) === i; }).sort();

    /**
     * `<select>` simples de filtro; a primeira opção (valor vazio) é "todos".
     * @param {string} label
     * @param {string} all
     * @param {Array<string[]>} options Pares [valor, texto].
     * @returns {HTMLSelectElement}
     */
    function filter(label, all, options) {
      return /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': label }, [el('option', { value: '', text: all })].concat(options.map(function (o) { return el('option', { value: o[0], text: o[1] }); }))));
    }

    const preset = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': 'Período' }, Object.keys(presets).map(function (k) { return el('option', { value: k, text: presets[k].label }); }).concat([el('option', { value: 'custom', text: 'Personalizado' })])));
    const from = /** @type {HTMLInputElement} */ (el('input', { type: 'date', 'aria-label': 'De' }));
    const to = /** @type {HTMLInputElement} */ (el('input', { type: 'date', 'aria-label': 'Até' }));
    const proj = filter('Projeto', 'Todos os projetos', [['0', 'Sem projeto']].concat(projects.map(function (p) { return [String(p.id), p.name]; })));
    const client = filter('Cliente', 'Todos os clientes', clients.map(function (c) { return [c, c]; }));
    const tag = filter('Tag', 'Todas as tags', tags.map(function (t) { return [t, '#' + t]; }));
    const bill = filter('Faturável', 'Faturável e não', [['1', 'Só faturável'], ['0', 'Só não faturável']]);
    const groupBy = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': 'Agrupar por' }, Object.keys(groups).map(function (k) { return el('option', { value: k, text: 'Agrupar por ' + groups[k].label.toLowerCase() }); })));
    const out = el('div', {});
    let mode = 'resumo';
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
      const top = Math.max.apply(null, days.map(function (k) { return map[k] || 0; }));
      return el('div', { class: 'hr-chart' + (dense ? ' hr-chart-dense' : ''), role: 'img', 'aria-label': 'Horas por dia no período' }, days.map(function (k) {
        const s = map[k] || 0;
        const p = k.split('-').map(Number);
        const label = days.length > 62 ? '' : new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('pt-BR', dense ? { day: 'numeric' } : { weekday: 'short', day: 'numeric' });
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
        ])]) : el('p', { class: 'empty', text: 'Nada neste período com estes filtros.' }),
      ]);
    }

    /**
     * @param {object} s Resposta de /summary.
     * @returns {HTMLElement}
     */
    function stats(s) {
      const stat = function (label, value) { return el('div', { class: 'card hr-stat' }, [el('small', { class: 'muted', text: label }), el('strong', { text: value })]); };
      return el('div', { class: 'hr-stats' }, [
        stat('Total', human(s.total_seconds)),
        stat('Faturável', human(s.billable_seconds)),
        stat('Valor', money(s.billable_amount, s.currency)),
        stat('Lançamentos', String(s.entries)),
      ]);
    }

    /** @returns {Promise<void>} */
    async function loadResumo() {
      const s = await api('/summary' + query());
      const g = groups[groupBy.value];
      out.replaceChildren(
        stats(s),
        el('div', { class: 'card' }, [el('h2', { text: 'Por dia' }), chart(s.by_day)]),
        table(el('div', { class: 'hr-card-head' }, [el('h2', { text: 'Por ' + g.label.toLowerCase() }), groupBy]), [g.label, 'Tempo', 'Valor', '%'], s[g.key].map(function (r) {
          const pct = s.total_seconds ? Math.round((r.seconds / s.total_seconds) * 100) : 0;
          const color = r.color || 'var(--accent)';
          return [
            el('span', {}, [r.color ? el('span', { class: 'hr-dot', style: 'background:' + r.color }) : null, (r.color ? ' ' : '') + g.name(r)]),
            el('span', { class: 'hr-num', text: human(r.seconds) }),
            el('span', { class: 'hr-num', text: r.amount ? money(r.amount, s.currency) : '—' }),
            el('span', { class: 'hr-pct' }, [el('span', { style: 'width:' + pct + '%;background:' + color }), el('small', { text: pct + '%' })]),
          ];
        }), groupBy.value === 'tag' ? 'Um lançamento com várias tags conta em cada uma.' : '')
      );
    }

    /** @returns {Promise<void>} */
    async function loadDetalhado() {
      const got2 = await Promise.all([api('/summary' + query()), api('/entries' + query() + '&limit=1000')]);
      const s = got2[0];
      const entries = got2[1];
      out.replaceChildren(
        stats(s),
        table('Lançamentos', ['Dia', 'Descrição', 'Projeto', 'Horário', 'Duração', 'Valor', ''], entries.map(function (e) {
          return [
            new Date(e.start).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }),
            el('span', {}, [e.description || '(sem descrição)', e.tags.length ? el('small', { class: 'muted', text: ' ' + e.tags.map(function (t) { return '#' + t; }).join(' ') }) : null]),
            el('span', {}, [el('span', { class: 'hr-dot', style: 'background:' + (e.project_color || 'var(--border)') }), ' ' + (e.project || 'Sem projeto')]),
            e.running ? hhmm(e.start) + ' – agora' : hhmm(e.start) + ' – ' + hhmm(e.end),
            el('span', { class: 'hr-num', text: clock(e.duration_seconds) }),
            el('span', { class: 'hr-num', text: e.billable ? money(e.amount, s.currency) : '—' }),
            CAN_WRITE && !e.running ? el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Editar', onclick: function () { entryDialog({ entry: e, projects: projects, tags: tags, onDone: load }); } }) : '',
          ];
        }), entries.length >= 1000 ? 'Mostrando os 1000 mais recentes do período. O total acima considera todos.' : '')
      );
    }

    /** @returns {Promise<void>} */
    async function load() {
      if (!from.value || !to.value) return;
      tabs.replaceChildren.apply(tabs, [['resumo', 'Resumo'], ['detalhado', 'Detalhado']].map(function (t) {
        return el('button', { type: 'button', role: 'tab', class: 'btn-ghost btn-sm', 'aria-selected': String(mode === t[0]), text: t[1], onclick: function () { mode = t[0]; reload(); } });
      }));
      if (mode === 'resumo') await loadResumo();
      else await loadDetalhado();
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
        el('button', { type: 'button', class: 'btn-ghost btn-sm', text: 'Exportar CSV', onclick: safe(async function () {
          const res = await fetch(BASE + '/export.csv' + query(), { headers: { 'x-timezone': TZ }, credentials: 'same-origin' });
          if (!res.ok) throw new Error('Não foi possível exportar.');
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
  /* Tela: Projetos                                                      */
  /* ------------------------------------------------------------------ */

  /** @returns {Promise<void>} */
  async function viewProjetos() {
    const body = el('tbody', {});
    const name = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'np-name', required: true, maxlength: '80' }));
    const client = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: 'np-client', maxlength: '80', list: 'np-clients', autocomplete: 'off' }));
    const rate = /** @type {HTMLInputElement} */ (el('input', { type: 'number', id: 'np-rate', min: '0', step: '0.01', placeholder: 'padrão' }));
    const clientList = el('datalist', { id: 'np-clients' });
    const currency = /** @type {HTMLSelectElement} */ (el('select', { id: 'st-currency' }, [['BRL', 'Real (R$)'], ['USD', 'Dólar (US$)'], ['EUR', 'Euro (€)'], ['GBP', 'Libra (£)']].map(function (c) { return el('option', { value: c[0], text: c[1] }); })));
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
        body.replaceChildren(el('tr', {}, [el('td', { colspan: '6', class: 'empty', text: 'Nenhum projeto ainda.' })]));
        return;
      }
      body.replaceChildren.apply(body, projects.map(function (p) {
        const patch = function (data) { return safe(async function () { await api('/projects/' + p.id, 'PATCH', data()); await load(); }); };
        const color = /** @type {HTMLInputElement} */ (el('input', { type: 'color', value: p.color, disabled: !CAN_WRITE, 'aria-label': 'Cor de ' + p.name }));
        const nm = /** @type {HTMLInputElement} */ (el('input', { type: 'text', value: p.name, maxlength: '80', disabled: !CAN_WRITE, 'aria-label': 'Nome' }));
        const cl = /** @type {HTMLInputElement} */ (el('input', { type: 'text', value: p.client, maxlength: '80', placeholder: '—', list: 'np-clients', disabled: !CAN_WRITE, 'aria-label': 'Cliente' }));
        const rt = /** @type {HTMLInputElement} */ (el('input', { type: 'number', min: '0', step: '0.01', value: p.hourly_rate === null ? '' : String(p.hourly_rate), placeholder: settings.default_rate ? String(settings.default_rate) : 'padrão', disabled: !CAN_WRITE, 'aria-label': 'Valor por hora de ' + p.name, title: 'Vazio = usa o valor padrão do workspace' }));
        color.addEventListener('change', patch(function () { return { color: color.value }; }));
        nm.addEventListener('change', patch(function () { return { name: nm.value }; }));
        cl.addEventListener('change', patch(function () { return { client: cl.value }; }));
        rt.addEventListener('change', patch(function () { return { hourly_rate: rt.value === '' ? null : Number(rt.value) }; }));
        return el('tr', { class: p.archived ? 'hr-archived' : '' }, [
          el('td', {}, [color]),
          el('td', {}, [nm, p.archived ? el('span', { class: 'badge', text: 'Arquivado' }) : null]),
          el('td', {}, [cl]),
          el('td', {}, [rt]),
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

    const saveSettings = safe(async function () {
      await api('/settings', 'PATCH', { currency: currency.value, default_rate: defRate.value === '' ? 0 : Number(defRate.value) });
      toast('Faturamento atualizado.');
      await load();
    });
    currency.addEventListener('change', saveSettings);
    defRate.addEventListener('change', saveSettings);
    currency.disabled = defRate.disabled = !CAN_WRITE;

    root.replaceChildren(
      clientList,
      CAN_WRITE && el('div', { class: 'card' }, [
        el('h2', { text: 'Novo projeto' }),
        el('form', { class: 'row', onsubmit: safe(async function (ev) {
          ev.preventDefault();
          await api('/projects', 'POST', { name: name.value, client: client.value, hourly_rate: rate.value === '' ? null : Number(rate.value) });
          name.value = client.value = rate.value = '';
          await load();
        }) }, [
          el('div', { class: 'field' }, [el('label', { for: 'np-name', text: 'Nome' }), name]),
          el('div', { class: 'field' }, [el('label', { for: 'np-client', text: 'Cliente (opcional)' }), client]),
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'np-rate', text: 'Valor/hora' }), rate]),
          el('div', { class: 'field hr-field-btn' }, [el('button', { type: 'submit', text: 'Criar' })]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Projetos do workspace' }),
        el('span', { class: 'muted', text: 'Compartilhados entre os membros. O tempo mostrado é só o seu.' }),
        el('div', { class: 'table-wrap' }, [el('table', { class: 'hr-projects' }, [
          el('thead', {}, [el('tr', {}, ['Cor', 'Nome', 'Cliente', 'Valor/hora', 'Seu tempo', ''].map(function (h) { return el('th', { text: h }); }))]),
          body,
        ])]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Faturamento' }),
        el('span', { class: 'muted', text: 'O valor de um lançamento faturável é horas × valor/hora do projeto. Projetos sem valor próprio usam o padrão abaixo. Mudar um valor recalcula tudo que já foi lançado.' }),
        el('div', { class: 'row' }, [
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'st-currency', text: 'Moeda' }), currency]),
          el('div', { class: 'field hr-field-sm' }, [el('label', { for: 'st-rate', text: 'Valor/hora padrão' }), defRate]),
        ]),
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
