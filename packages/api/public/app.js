'use strict';
// Painel do hh-analytics: sem framework e sem build. Dados que vêm da ingestão (caminhos, eventos, origens) são
// escritos só com textContent: qualquer visitante controla esses textos, então nada vira HTML.

const app = document.getElementById('app');
// Caminho onde o painel está (ex.: "/" ou "/admin/analytics/" atrás de um proxy): a API fica em {BASE}api
const BASE = new URL('.', document.currentScript?.src || location.href).pathname;
const KEY = 'hh:admin';
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const state = {
  token: read(KEY),
  user: null,
  projects: [],
  projectId: read('hh:project'),
  project: null,
  range: read('hh:range') || '7d',
  tab: 'overview'
};
let liveTimer = null;

function read(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function save(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sem storage: vale só nesta aba */ }
}

// ---------- DOM ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const svg = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
};
const mount = (...nodes) => app.replaceChildren(...nodes);
const n = new Intl.NumberFormat('pt-BR');
const pct = (v) => `${n.format(v)}%`;
const dur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min` : `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, '0')}s`);

// ---------- Movimento ----------
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

// Número que conta até o valor quando chegam dados novos (troca de período); com movimento reduzido, aparece direto
function countTo(el, to, format) {
  if (reduced || !to) {
    el.textContent = format(to);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 650);
    el.textContent = format(k < 1 ? Math.round(to * easeOut(k)) : to);
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// A marca: três barras de gráfico. "loop" = carregando; "rise" = sobem uma vez (entrada)
function mark(mode) {
  const root = svg('svg', { class: `mark ${mode || ''}`, viewBox: '0 0 32 32', 'aria-hidden': 'true' });
  [[7, 17, 8], [14, 11, 14], [21, 6, 19]].forEach(([x, y, height], i) => root.append(svg('rect', { class: `b b${i + 1}`, x, y, width: 4, height, rx: 1.5 })));
  return root;
}

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado.');
  } catch {
    toast('Não deu para copiar: selecione e copie.');
  }
}

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token && !path.startsWith('/auth/login')) {
    logout(false);
    throw Object.assign(new Error('Sua sessão expirou. Entre de novo.'), { expired: true });
  }
  if (!res.ok) throw new Error(data.issues?.[0] ? `${data.error}: ${data.issues[0].path} ${data.issues[0].message}` : data.error || `Erro ${res.status}`);
  return data;
}

function logout(callApi = true) {
  if (callApi && state.token) api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.token = null;
  state.user = null;
  save(KEY, null);
  clearInterval(liveTimer);
  start();
}

// ---------- Entrada (primeiro acesso cria a conta do dono) ----------
function renderAuth(setup, registration) {
  const mode = setup ? 'register' : 'login';
  const error = h('p', { class: 'err', role: 'alert' });
  const email = h('input', { class: 'field', id: 'email', type: 'email', autocomplete: 'email', required: true });
  const pass = h('input', { class: 'field', id: 'pass', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 8 : null });
  const name = setup ? h('input', { class: 'field', id: 'name', autocomplete: 'name' }) : null;
  const btn = h('button', { class: 'btn primary', type: 'submit', text: setup ? 'Criar conta e entrar' : 'Entrar' });
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      btn.disabled = true;
      try {
        const data = await api(`/auth/${mode}`, { method: 'POST', body: { email: email.value, password: pass.value, ...(name ? { name: name.value } : {}) } });
        state.token = data.token;
        save(KEY, data.token);
        start();
      } catch (err) {
        error.textContent = err.message;
        btn.disabled = false;
      }
    }
  },
    name && h('div', {}, h('label', { class: 'lbl', for: 'name', text: 'Seu nome (opcional)' }), name),
    h('div', {}, h('label', { class: 'lbl', for: 'email', text: 'E-mail' }), email),
    h('div', {}, h('label', { class: 'lbl', for: 'pass', text: setup ? 'Senha (mínimo 8 caracteres)' : 'Senha' }), pass),
    error,
    btn
  );
  mount(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('span', { class: 'logo' }, mark('rise'), 'hh-analytics'),
    h('h1', { text: setup ? 'Bem-vindo' : 'Entrar' }),
    h('p', { class: 'muted', text: setup ? 'Primeiro acesso a esta instalação: crie a conta de dono. Depois disso o cadastro fecha.' : 'Entre para ver os números dos seus sites.' }),
    form,
    !setup && registration && h('p', { class: 'muted' }, 'Ainda não tem conta? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth(true, true); }, text: 'Criar conta' }))
  )));
  (name || email).focus();
}

// ---------- Painel ----------
async function start() {
  clearInterval(liveTimer);
  mount(h('div', { class: 'auth', role: 'status' }, mark('loop'), h('span', { class: 'sr', text: 'Carregando' })));
  try {
    if (!state.token) {
      const s = await api('/auth/status');
      return renderAuth(s.setup, s.registration);
    }
    state.user = (await api('/auth/me')).user;
    state.projects = await api('/projects');
    if (!state.projects.some((p) => p.id === state.projectId)) state.projectId = state.projects[0]?.id || null;
    save('hh:project', state.projectId);
    renderShell();
  } catch (err) {
    if (err.expired) return; // o logout já desenhou a tela de login
    mount(h('div', { class: 'auth' }, h('p', { class: 'err', text: `Não foi possível falar com a API: ${err.message}` })));
  }
}

function renderShell() {
  const select = h('select', { class: 'field', 'aria-label': 'Projeto', onchange: (e) => openProject(e.target.value) },
    state.projects.map((p) => h('option', { value: p.id, selected: p.id === state.projectId, text: p.name })));
  const top = h('header', { class: 'top' },
    h('span', { class: 'logo' }, mark(), h('span', { class: 'brand', text: 'hh-analytics' })),
    state.projects.length ? select : null,
    h('button', { class: 'btn small', onclick: newProject, text: '+ Projeto' }),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn small who', onclick: () => renderAccount(), text: state.user.name || state.user.email, title: 'Minha conta' }),
    h('button', { class: 'btn small', onclick: () => logout(), text: 'Sair' })
  );
  const main = h('main', { id: 'main' });
  mount(top, main);
  if (!state.projectId) return renderWelcome(main);
  openProject(state.projectId);
}

function renderWelcome(main) {
  main.replaceChildren(h('div', { class: 'panel', style: 'max-width:34rem;margin:3rem auto;text-align:center;padding:2rem' },
    h('h2', { text: 'Crie seu primeiro projeto' }),
    h('p', { class: 'muted', text: 'Um projeto para cada site ou app. Ele recebe um token para colocar no SDK.' }),
    h('button', { class: 'btn primary', onclick: newProject, text: 'Criar projeto' })
  ));
}

async function newProject() {
  const name = prompt('Nome do projeto (ex.: Meu site)');
  if (!name || !name.trim()) return;
  try {
    const p = await api('/projects', { method: 'POST', body: { name: name.trim() } });
    state.projects.push({ id: p.id, name: p.name, slug: p.slug, role: p.role });
    state.projectId = p.id;
    state.tab = 'settings';
    save('hh:project', p.id);
    renderShell();
    toast('Projeto criado. Copie o token de ingestão para o seu site.');
  } catch (err) {
    toast(err.message);
  }
}

async function openProject(id) {
  state.projectId = id;
  save('hh:project', id);
  const main = document.getElementById('main');
  try {
    state.project = await api(`/projects/${id}`);
  } catch (err) {
    main.replaceChildren(h('p', { class: 'err', text: err.message }));
    return;
  }
  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    [['overview', 'Visão geral'], ['settings', 'Instalação e ajustes']].map(([k, label]) =>
      h('button', { role: 'tab', 'aria-selected': String(state.tab === k), onclick: () => { state.tab = k; openProject(id); }, text: label })));
  const body = h('div', { class: 'view' });
  main.replaceChildren(
    h('div', { class: 'row between' }, h('h2', { text: state.project.name }), state.tab === 'overview' ? rangePicker(body) : null),
    tabs,
    body
  );
  clearInterval(liveTimer);
  if (state.tab === 'overview') loadOverview(body);
  else renderSettings(body);
}

function rangePicker(body) {
  const live = h('span', { class: 'live', title: 'Visitantes com atividade nos últimos 5 minutos' }, h('i'), h('span', { class: 'num', id: 'live', text: '…' }));
  // Indicador desliza até o período escolhido (mostra de onde para onde mudou)
  const ind = h('span', { class: 'seg-ind', 'aria-hidden': 'true' });
  const place = () => {
    const b = seg.querySelector('[aria-pressed="true"]');
    if (!b) return;
    ind.style.width = `${b.offsetWidth}px`;
    ind.style.transform = `translateX(${b.offsetLeft}px)`;
  };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Período' }, ind,
    [['24h', '24 h'], ['7d', '7 dias'], ['30d', '30 dias'], ['90d', '90 dias']].map(([k, label]) =>
      h('button', { 'aria-pressed': String(state.range === k), text: label, onclick: () => {
        if (state.range === k) return;
        state.range = k;
        save('hh:range', k);
        seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === label)));
        place();
        loadOverview(body);
      } })));
  requestAnimationFrame(() => {
    place();
    seg.classList.add('ready'); // só anima depois da primeira posição (não desliza do zero ao abrir)
  });
  document.fonts?.ready.then(place);
  return h('div', { class: 'row' }, live, seg);
}

// ---------- Visão geral ----------
async function loadOverview(body) {
  const id = state.projectId;
  const q = `range=${state.range}&tz=${encodeURIComponent(tz)}`;
  body.classList.add('loading');
  if (!body.firstChild) body.replaceChildren(h('div', { class: 'skeleton', style: 'height:92px;margin-top:1.25rem' }), h('div', { class: 'skeleton', style: 'height:300px;margin-top:.75rem' }));
  const get = (path) => api(`/reports/${id}/${path}${path.includes('?') ? '&' : '?'}${q}`);
  let r;
  try {
    const keys = ['summary', 'timeseries', 'pages', 'referrers', 'utm', 'events', 'browsers', 'os', 'devices', 'countries'];
    const values = await Promise.all(keys.map(get));
    r = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  } catch (err) {
    body.classList.remove('loading');
    body.replaceChildren(h('p', { class: 'err', text: err.message }));
    return;
  }
  if (id !== state.projectId) return;
  body.classList.remove('loading');

  // Faixa de números do período, comparando com o período anterior do mesmo tamanho
  const { current: c, previous: p } = r.summary;
  const kpi = (label, now, before, format, invert) => {
    const v = h('div', { class: 'v num' });
    countTo(v, now, format);
    let delta = h('span', { class: 'delta flat', title: 'Sem dados no período anterior para comparar', text: '—' });
    if (before > 0 && now !== before) {
      const change = Math.round(((now - before) / before) * 100);
      const good = invert ? change < 0 : change > 0;
      delta = h('span', { class: `delta ${good ? 'up' : 'down'}`, title: 'Em relação ao período anterior do mesmo tamanho', text: `${change > 0 ? '+' : '−'}${Math.abs(change)}%` });
    } else if (before > 0) delta = h('span', { class: 'delta flat', text: 'igual ao anterior' });
    return h('div', { class: 'kpi' }, h('div', { class: 'k', text: label }), v, delta);
  };
  const empty = !c.pageviews && !c.events;
  const unit = r.timeseries.unit === 'hour' ? 'Por hora' : 'Por dia';
  body.replaceChildren(
    h('section', { class: 'kpis', 'aria-label': 'Resumo do período' },
      kpi('Visitantes', c.visitors, p.visitors, (v) => n.format(v)),
      kpi('Visitas', c.pageviews, p.pageviews, (v) => n.format(v)),
      kpi('Sessões', c.sessions, p.sessions, (v) => n.format(v)),
      kpi('Rejeição', c.bounceRate, p.bounceRate, pct, true),
      kpi('Duração média', c.avgSessionSeconds, p.avgSessionSeconds, dur),
      kpi('Eventos', c.events, p.events, (v) => n.format(v))
    ),
    empty
      ? h('div', { class: 'panel empty-state' },
          mark(),
          h('h3', { text: 'Nenhuma visita neste período' }),
          h('p', { class: 'muted', text: 'Quando o SDK estiver no site, as visitas aparecem aqui em segundos.' }),
          h('button', { class: 'btn primary', onclick: () => { state.tab = 'settings'; openProject(id); }, text: 'Ver como instalar' }))
      : h('section', { class: 'panel chart-panel' },
          h('div', { class: 'row between' }, h('h3', { text: unit }),
            h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'sw bar' }), 'Visitas'), h('span', {}, h('i', { class: 'sw line' }), 'Visitantes'))),
          chart(r.timeseries)),
    h('div', { class: 'grid2' },
      ranking('Páginas', r.pages, (x) => x.value || '/', (x) => x.pageviews),
      ranking('Origens', r.referrers, (x) => x.value || 'Direto / sem origem', (x) => x.sessions),
      ranking('Eventos', r.events, (x) => x.name, (x) => x.count),
      ranking('Campanhas (utm_source)', r.utm, (x) => x.value, (x) => x.sessions),
      ranking('Navegadores', r.browsers, (x) => x.value || 'Desconhecido', (x) => x.visitors),
      ranking('Sistemas', r.os, (x) => x.value || 'Desconhecido', (x) => x.visitors),
      ranking('Aparelhos', r.devices, (x) => ({ desktop: 'Computador', mobile: 'Celular', tablet: 'Tablet' })[x.value] || 'Desconhecido', (x) => x.visitors),
      ranking('Países', r.countries, (x) => x.value || 'Desconhecido', (x) => x.visitors)
    )
  );
  live();
  clearInterval(liveTimer);
  liveTimer = setInterval(live, 30_000);
}

async function live() {
  const el = document.getElementById('live');
  if (!el) return clearInterval(liveTimer);
  try {
    const { visitors } = await api(`/reports/${state.projectId}/realtime`);
    el.textContent = `${n.format(visitors)} agora`;
  } catch {
    el.textContent = '—';
  }
}

// Ranking: as barras crescem da esquerda, em sequência curta (é uma lista aparecendo como lista)
function ranking(title, rows, label, value) {
  const max = Math.max(1, ...rows.map(value));
  const total = rows.reduce((a, x) => a + value(x), 0) || 1;
  return h('section', { class: 'panel' }, h('h3', { text: title }),
    rows.length
      ? h('ul', { class: 'list' }, rows.map((x, i) => h('li', { title: label(x) },
          h('i', { class: 'bg', style: `--w:${(value(x) / max).toFixed(3)};--i:${Math.min(i, 8)}` }),
          h('span', { class: 'name', text: label(x) }),
          h('span', { class: 'share num', text: `${Math.round((value(x) / total) * 100)}%` }),
          h('b', { class: 'num', text: n.format(value(x)) }))))
      : h('p', { class: 'empty', text: 'Nada neste período.' }));
}

const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
const pointLabel = (p, unit) => {
  const d = new Date(`${p.date.slice(0, 10)}T12:00:00`);
  return unit === 'hour' ? `${dayFmt.format(d)}, ${p.date.slice(11, 13)}h` : dayFmt.format(d);
};

// Barras = visitas, linha e área = visitantes. Desenhado na largura real (texto sem deformar).
// Ao carregar ou trocar o período, o gráfico é revelado da esquerda para a direita: os dados mudaram.
function chart({ points, unit }) {
  const W = Math.max(300, Math.round((document.getElementById('main')?.clientWidth || 800) - 64));
  const H = 260;
  const pad = { l: 40, r: 12, t: 14, b: 28 };
  const max = Math.max(1, ...points.map((p) => p.pageviews));
  const step = (W - pad.l - pad.r) / Math.max(1, points.length);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const cx = (i) => pad.l + i * step + step / 2;
  const base = H - pad.b;
  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Visitas e visitantes no período' });

  const defs = svg('defs', {});
  const grad = svg('linearGradient', { id: 'area-fill', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(svg('stop', { class: 'stop-top', offset: '0' }), svg('stop', { class: 'stop-bottom', offset: '1' }));
  defs.append(grad);
  root.append(defs);

  for (let i = 0; i <= 3; i++) {
    const v = Math.round((max / 3) * i);
    root.append(svg('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    const t = svg('text', { class: 'axis', x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' });
    t.textContent = n.format(v);
    root.append(t);
  }
  const plot = svg('g', { class: 'plot' });
  const labelEvery = Math.ceil(points.length / Math.max(3, Math.floor(W / 90)));
  points.forEach((p, i) => {
    const x = pad.l + i * step;
    plot.append(svg('rect', { class: 'bar', x: x + step * 0.18, width: Math.max(1, step * 0.64), y: y(p.pageviews), height: Math.max(0, base - y(p.pageviews)), rx: Math.min(3, step * 0.2) }));
    if (i % labelEvery === 0) {
      const t = svg('text', { class: 'axis', x: cx(i), y: H - 8, 'text-anchor': 'middle' });
      t.textContent = unit === 'hour' ? `${p.date.slice(11, 13)}h` : `${p.date.slice(8, 10)}/${p.date.slice(5, 7)}`;
      root.append(t);
    }
  });
  const line = points.map((p, i) => `${cx(i)},${y(p.visitors)}`);
  plot.append(svg('path', { class: 'area', d: `M${cx(0)},${base} L${line.join(' L')} L${cx(points.length - 1)},${base} Z` }));
  plot.append(svg('path', { class: 'line', d: `M${line.join(' L')}` }));
  root.append(plot);

  // Ponto em foco: guia vertical, marcador na linha e um rótulo com os números do dia (ou da hora)
  const guide = svg('line', { class: 'guide', y1: pad.t, y2: base });
  const dot = svg('circle', { class: 'dot', r: 4 });
  root.append(guide, dot);
  const tip = h('div', { class: 'tip', role: 'status', 'aria-live': 'off' });
  const wrap = h('div', { class: 'chart-wrap' }, root, tip);
  const show = (i) => {
    const p = points[i];
    const x = cx(i);
    guide.setAttribute('x1', x);
    guide.setAttribute('x2', x);
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y(p.visitors));
    tip.replaceChildren(h('b', { text: pointLabel(p, unit) }),
      h('span', {}, h('i', { class: 'sw bar' }), `${n.format(p.pageviews)} visitas`),
      h('span', {}, h('i', { class: 'sw line' }), `${n.format(p.visitors)} visitantes`));
    const scale = wrap.clientWidth / W;
    const left = Math.min(Math.max(x * scale, 70), wrap.clientWidth - 70);
    tip.style.transform = `translateX(calc(${left}px - 50%))`;
    wrap.classList.add('focus');
  };
  wrap.addEventListener('pointermove', (e) => {
    const r = wrap.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    show(Math.min(points.length - 1, Math.max(0, Math.floor((x - pad.l) / step))));
  });
  wrap.addEventListener('pointerleave', () => wrap.classList.remove('focus'));
  return wrap;
}

// ---------- Instalação e ajustes ----------
function renderSettings(body) {
  const p = state.project;
  const ingest = p.tokens.find((t) => t.type === 'INGEST');
  const query = p.tokens.find((t) => t.type === 'QUERY');
  const manage = p.role === 'OWNER' || p.role === 'ADMIN';
  const endpoint = `${location.origin}${BASE}api`;
  const npmSnippet = `npm install @hh./analytics\n\nimport { analytics } from '@hh./analytics';\n\nanalytics.init({\n  endpoint: '${endpoint}',\n  token: '${ingest?.value || 'TOKEN'}'\n});\n\nanalytics.track('cadastro', { plano: 'pro' });`;
  const tagSnippet = `<script src="https://unpkg.com/@hh./analytics/dist/hh-analytics.min.js"\n  data-endpoint="${endpoint}"\n  data-token="${ingest?.value || 'TOKEN'}" defer></script>`;
  const codeBlock = (text) => h('div', { class: 'code-box' }, h('pre', { class: 'code mono', text }), h('button', { class: 'btn small copy', onclick: () => copy(text), text: 'Copiar' }));

  const act = async (fn, ok) => {
    try {
      state.project = await fn();
      toast(ok);
      renderSettings(body);
    } catch (err) {
      toast(err.message);
    }
  };
  const tokenRow = (t, secret) => {
    const input = h('input', { class: 'field', readonly: true, value: t.value, type: secret ? 'password' : 'text', 'aria-label': secret ? 'Token de consulta' : 'Token de ingestão' });
    return h('div', { class: 'token' }, input,
      secret ? h('button', { class: 'btn small', onclick: (e) => { input.type = input.type === 'password' ? 'text' : 'password'; e.target.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar'; }, text: 'Mostrar' }) : null,
      h('button', { class: 'btn small', onclick: () => copy(t.value), text: 'Copiar' }),
      manage ? h('button', { class: 'btn small', onclick: () => confirm('O token atual para de funcionar na hora. Continuar?') && act(() => api(`/projects/${p.id}/tokens`, { method: 'POST', body: { type: t.type } }), 'Token trocado.'), text: 'Trocar' }) : null);
  };

  const domainInput = h('input', { class: 'field', placeholder: 'meusite.com.br', 'aria-label': 'Domínio' });
  const nameInput = h('input', { class: 'field', value: p.name, 'aria-label': 'Nome do projeto' });

  body.replaceChildren(h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('h3', { text: 'Instale no seu site' }),
      h('p', { class: 'muted', text: 'Com npm (React, Vue, Next, qualquer bundler):' }), codeBlock(npmSnippet),
      h('p', { class: 'muted', text: 'Ou sem bundler, com uma tag no <head>:' }), codeBlock(tagSnippet)),
    h('section', { class: 'panel' },
      h('h3', { text: 'Token de ingestão' }),
      h('p', { class: 'muted', text: 'Público: vai no código do site e só serve para enviar eventos.' }),
      ingest ? tokenRow(ingest, false) : h('p', { class: 'err', text: 'Sem token ativo.' })),
    manage && query ? h('section', { class: 'panel' },
      h('h3', { text: 'Token de consulta' }),
      h('p', { class: 'muted', text: 'Secreto: lê os relatórios deste projeto pela API (integrações, planilhas). Não coloque no site.' }),
      tokenRow(query, true),
      h('pre', { class: 'code mono', text: `curl -H "Authorization: Bearer ${'<token de consulta>'}" \\\n  "${endpoint}/reports/${p.id}/summary?range=30d"` })) : null,
    h('section', { class: 'panel' },
      h('h3', { text: 'Domínios permitidos' }),
      h('p', { class: 'muted', text: 'Com algum domínio cadastrado, só sites desses domínios (e subdomínios) conseguem enviar eventos com o token. Vazio: qualquer site com o token.' }),
      h('div', { class: 'chips' }, p.domains.length ? p.domains.map((d) => h('span', { class: 'chip' }, d.name,
        manage ? h('button', { 'aria-label': `Remover ${d.name}`, onclick: () => act(() => api(`/projects/${p.id}/domains/${d.id}`, { method: 'DELETE' }), 'Domínio removido.'), text: '×' }) : null)) : h('span', { class: 'muted', text: 'Nenhum: aceita de qualquer site.' })),
      manage ? h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (domainInput.value.trim()) act(() => api(`/projects/${p.id}/domains`, { method: 'POST', body: { name: domainInput.value } }), 'Domínio adicionado.'); } },
        h('div', { style: 'flex:1;min-width:12rem' }, domainInput), h('button', { class: 'btn', type: 'submit', text: 'Adicionar' })) : null),
    membersSection(p),
    manage ? h('section', { class: 'panel' },
      h('h3', { text: 'Nome do projeto' }),
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); act(async () => { const d = await api(`/projects/${p.id}`, { method: 'PATCH', body: { name: nameInput.value } }); state.projects.find((x) => x.id === p.id).name = d.name; return d; }, 'Nome salvo.'); } },
        h('div', { style: 'flex:1;min-width:12rem' }, nameInput), h('button', { class: 'btn', type: 'submit', text: 'Salvar' }))) : null,
    p.role === 'OWNER' ? h('section', { class: 'panel' },
      h('h3', { text: 'Apagar projeto' }),
      h('p', { class: 'muted', text: 'Apaga o projeto e todos os dados dele (visitas, eventos, sessões). Não tem volta.' }),
      h('button', { class: 'btn danger', onclick: async () => {
        if (prompt(`Para confirmar, digite o nome do projeto: ${p.name}`) !== p.name) return toast('Nome não confere. Nada foi apagado.');
        try {
          await api(`/projects/${p.id}`, { method: 'DELETE' });
          state.projects = state.projects.filter((x) => x.id !== p.id);
          state.projectId = state.projects[0]?.id || null;
          state.tab = 'overview';
          toast('Projeto apagado.');
          renderShell();
        } catch (err) {
          toast(err.message);
        }
      }, text: 'Apagar projeto' })) : null
  ));
}

// ---------- Membros ----------
const ROLE = { OWNER: 'Dono', ADMIN: 'Admin', MEMBER: 'Membro', VIEWER: 'Leitor' };
const ROLE_HINT = 'Leitor vê os relatórios. Membro também vê a instalação. Admin gerencia tokens, domínios e membros.';

function membersSection(p) {
  const box = h('section', { class: 'panel' }, h('h3', { text: 'Membros' }), h('div', { class: 'skeleton', style: 'height:3rem' }));
  const me = state.user.id;
  const isOwner = p.role === 'OWNER';
  const manage = isOwner || p.role === 'ADMIN';

  const draw = (members, notice) => {
    const email = h('input', { class: 'field', type: 'email', placeholder: 'pessoa@empresa.com', 'aria-label': 'E-mail do novo membro', autocomplete: 'off' });
    const role = h('select', { class: 'field', 'aria-label': 'Papel', style: 'width:auto' },
      ['VIEWER', 'MEMBER', ...(isOwner ? ['ADMIN'] : [])].map((r) => h('option', { value: r, text: ROLE[r] })));
    const run = async (fn, ok, added) => {
      try {
        const data = await fn();
        if (data.left) {
          state.projects = state.projects.filter((x) => x.id !== p.id);
          state.projectId = state.projects[0]?.id || null;
          toast('Você saiu do projeto.');
          return renderShell();
        }
        draw(data.members || data, data.tempPassword ? { email: added, password: data.tempPassword } : null);
        toast(ok);
      } catch (err) {
        toast(err.message);
      }
    };
    const row = (m) => {
      const self = m.userId === me;
      const canRemove = m.role !== 'OWNER' && (self || isOwner || (p.role === 'ADMIN' && m.role !== 'ADMIN'));
      return h('li', { class: 'member' },
        h('span', { class: 'who-name' }, h('b', { text: m.name || m.email }), m.name ? h('span', { class: 'muted', text: m.email }) : null),
        isOwner && m.role !== 'OWNER'
          ? h('select', { class: 'field', style: 'width:auto;height:2rem', 'aria-label': `Papel de ${m.email}`, onchange: (e) => run(() => api(`/projects/${p.id}/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } }), 'Papel alterado.') },
              ['VIEWER', 'MEMBER', 'ADMIN'].map((r) => h('option', { value: r, selected: r === m.role, text: ROLE[r] })))
          : h('span', { class: 'chip', text: ROLE[m.role] }),
        canRemove ? h('button', { class: 'btn small danger', text: self ? 'Sair' : 'Remover', onclick: () => {
          if (!confirm(self ? 'Sair deste projeto? Você perde o acesso aos números dele.' : `Remover ${m.email} do projeto?`)) return;
          run(() => api(`/projects/${p.id}/members/${m.userId}`, { method: 'DELETE' }), 'Membro removido.');
        } }) : null);
    };
    box.replaceChildren(...[
      h('h3', { text: 'Membros' }),
      h('ul', { class: 'members' }, members.map(row)),
      notice ? h('div', { class: 'notice', role: 'status' },
        h('p', {}, 'Conta criada para ', h('b', { text: notice.email }), '. Passe esta senha provisória para a pessoa (ela não aparece de novo) e peça para trocar em "Minha conta":'),
        h('div', { class: 'token' }, h('input', { class: 'field mono', readonly: true, value: notice.password, 'aria-label': 'Senha provisória' }), h('button', { class: 'btn small', onclick: () => copy(notice.password), text: 'Copiar' }))) : null,
      manage ? h('form', { class: 'row', style: 'margin-top:.75rem', onsubmit: (e) => {
        e.preventDefault();
        const value = email.value.trim();
        if (value) run(() => api(`/projects/${p.id}/members`, { method: 'POST', body: { email: value, role: role.value } }), 'Membro adicionado.', value);
      } }, h('div', { style: 'flex:1;min-width:12rem' }, email), role, h('button', { class: 'btn', type: 'submit', text: 'Adicionar' })) : null,
      h('p', { class: 'muted', style: 'margin:.75rem 0 0;font-size:.85rem', text: manage ? `${ROLE_HINT} Quem ainda não tem conta ganha uma com senha provisória.` : ROLE_HINT })
    ].filter(Boolean));
  };
  api(`/projects/${p.id}/members`).then((m) => draw(m), (err) => box.replaceChildren(h('h3', { text: 'Membros' }), h('p', { class: 'err', text: err.message })));
  return box;
}

// ---------- Minha conta ----------
function renderAccount() {
  const main = document.getElementById('main');
  clearInterval(liveTimer);
  const current = h('input', { class: 'field', id: 'cur', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'field', id: 'new', type: 'password', autocomplete: 'new-password', minlength: 8 });
  const error = h('p', { class: 'err', role: 'alert' });
  main.replaceChildren(
    h('div', { class: 'row between' }, h('h2', { text: 'Minha conta' }), state.projectId ? h('button', { class: 'btn small', onclick: () => openProject(state.projectId), text: 'Voltar' }) : null),
    h('section', { class: 'panel', style: 'max-width:30rem;margin-top:1rem' },
      h('p', { class: 'muted' }, 'Entrou como ', h('b', { text: state.user.email }), '.'),
      h('h3', { text: 'Trocar senha', style: 'margin-top:1rem' }),
      h('form', { class: 'stack', style: 'margin-top:0', onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          await api('/auth/password', { method: 'POST', body: { current: current.value, next: next.value } });
          current.value = next.value = '';
          toast('Senha trocada. As outras sessões foram encerradas.');
        } catch (err) {
          error.textContent = err.message;
        }
      } },
        h('div', {}, h('label', { class: 'lbl', for: 'cur', text: 'Senha atual' }), current),
        h('div', {}, h('label', { class: 'lbl', for: 'new', text: 'Nova senha (mínimo 8 caracteres)' }), next),
        error,
        h('div', {}, h('button', { class: 'btn primary', type: 'submit', text: 'Trocar senha' }))))
  );
}

start();
