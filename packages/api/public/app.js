'use strict';
// Painel do hh-analytics: sem framework e sem build. Dados que vêm da ingestão (caminhos, eventos, origens) são
// escritos só com textContent: qualquer visitante controla esses textos, então nada vira HTML.

const app = document.getElementById('app');
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
  const res = await fetch(`/api${path}`, {
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
    h('span', { class: 'logo' }, h('img', { src: 'favicon.svg', alt: '' }), 'hh-analytics'),
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
  mount(h('div', { class: 'auth' }, h('div', { class: 'skeleton', style: 'width:18rem;height:12rem' })));
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
    h('span', { class: 'logo' }, h('img', { src: 'favicon.svg', alt: '' }), h('span', { class: 'sr', text: 'hh-analytics' })),
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
  const body = h('div', {});
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
  const live = h('span', { class: 'live' }, h('i'), h('span', { class: 'num', id: 'live', text: '…' }));
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Período' },
    [['24h', '24 h'], ['7d', '7 dias'], ['30d', '30 dias'], ['90d', '90 dias']].map(([k, label]) =>
      h('button', { 'aria-pressed': String(state.range === k), text: label, onclick: () => {
        state.range = k;
        save('hh:range', k);
        seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === label)));
        loadOverview(body);
      } })));
  return h('div', { class: 'row' }, live, seg);
}

// ---------- Visão geral ----------
async function loadOverview(body) {
  const id = state.projectId;
  const q = `range=${state.range}&tz=${encodeURIComponent(tz)}`;
  body.replaceChildren(h('div', { class: 'cards' }, Array.from({ length: 6 }, () => h('div', { class: 'skeleton', style: 'height:86px' }))), h('div', { class: 'skeleton', style: 'height:260px' }));
  const get = (path) => api(`/reports/${id}/${path}${path.includes('?') ? '&' : '?'}${q}`);
  let r;
  try {
    const keys = ['summary', 'timeseries', 'pages', 'referrers', 'utm', 'events', 'browsers', 'os', 'devices', 'countries'];
    const values = await Promise.all(keys.map(get));
    r = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  } catch (err) {
    body.replaceChildren(h('p', { class: 'err', text: err.message }));
    return;
  }
  if (id !== state.projectId) return;

  const { current: c, previous: p } = r.summary;
  const card = (k, v, now, before, invert) => {
    let delta = null;
    if (before > 0 && now !== before) {
      const change = Math.round(((now - before) / before) * 100);
      const good = invert ? change < 0 : change > 0;
      delta = h('span', { class: `delta ${good ? 'up' : 'down'}`, text: `${change > 0 ? '▲' : '▼'} ${Math.abs(change)}%` });
    }
    return h('div', { class: 'card' }, h('div', { class: 'k', text: k }), h('div', { class: 'v num', text: v }), delta || h('span', { class: 'delta muted', text: 'vs. período anterior' }));
  };
  const empty = !c.pageviews && !c.events;
  body.replaceChildren(
    h('div', { class: 'cards' },
      card('Visitantes', n.format(c.visitors), c.visitors, p.visitors),
      card('Visitas (pageviews)', n.format(c.pageviews), c.pageviews, p.pageviews),
      card('Sessões', n.format(c.sessions), c.sessions, p.sessions),
      card('Taxa de rejeição', pct(c.bounceRate), c.bounceRate, p.bounceRate, true),
      card('Duração média', dur(c.avgSessionSeconds), c.avgSessionSeconds, p.avgSessionSeconds),
      card('Eventos', n.format(c.events), c.events, p.events)
    ),
    empty
      ? h('div', { class: 'panel empty' }, 'Nenhum dado neste período. Instale o SDK no seu site: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); state.tab = 'settings'; openProject(id); }, text: 'ver instalação' }), '.')
      : h('div', { class: 'panel' }, h('div', { class: 'row between' }, h('h3', { text: r.timeseries.unit === 'hour' ? 'Por hora' : 'Por dia' }),
          h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--accent)' }), 'Visitas'), h('span', {}, h('i', { style: 'background:var(--accent-2)' }), 'Visitantes'))),
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

function ranking(title, rows, label, value) {
  const max = Math.max(1, ...rows.map(value));
  return h('section', { class: 'panel' }, h('h3', { text: title }),
    rows.length
      ? h('ul', { class: 'list' }, rows.map((x) => h('li', { title: label(x) },
          h('i', { class: 'bg', style: `transform:scaleX(${(value(x) / max).toFixed(3)})` }),
          h('span', { text: label(x) }),
          h('b', { class: 'num', text: n.format(value(x)) }))))
      : h('p', { class: 'empty', text: 'Nada ainda.' }));
}

// Barras = visitas, linha = visitantes. Desenhado na largura real da tela (texto do eixo sem deformar).
function chart({ points, unit }) {
  const W = Math.max(300, Math.round((document.getElementById('main')?.clientWidth || 800) - 64)), H = 220, pad = { l: 36, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.pageviews));
  const step = (W - pad.l - pad.r) / Math.max(1, points.length);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Visitas e visitantes no período' });
  for (let i = 0; i <= 3; i++) {
    const v = Math.round((max / 3) * i);
    root.append(svg('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    const t = svg('text', { x: 4, y: y(v) + 4 });
    t.textContent = n.format(v);
    root.append(t);
  }
  const labelEvery = Math.ceil(points.length / Math.max(3, Math.floor(W / 90)));
  points.forEach((p, i) => {
    const x = pad.l + i * step;
    const bar = svg('rect', { class: 'bar', x: x + step * 0.15, width: Math.max(1, step * 0.7), y: y(p.pageviews), height: H - pad.b - y(p.pageviews), rx: 2 });
    const tip = svg('title', {});
    tip.textContent = `${p.date}: ${n.format(p.pageviews)} visitas, ${n.format(p.visitors)} visitantes`;
    bar.append(tip);
    root.append(bar);
    if (i % labelEvery === 0) {
      const t = svg('text', { x: x + step / 2, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = unit === 'hour' ? p.date.slice(11, 16) : `${p.date.slice(8, 10)}/${p.date.slice(5, 7)}`;
      root.append(t);
    }
  });
  root.append(svg('polyline', { class: 'line', points: points.map((p, i) => `${pad.l + i * step + step / 2},${y(p.visitors)}`).join(' ') }));
  return root;
}

// ---------- Instalação e ajustes ----------
function renderSettings(body) {
  const p = state.project;
  const ingest = p.tokens.find((t) => t.type === 'INGEST');
  const query = p.tokens.find((t) => t.type === 'QUERY');
  const manage = p.role === 'OWNER' || p.role === 'ADMIN';
  const endpoint = `${location.origin}/api`;
  const npmSnippet = `npm install @hhartur/analytics\n\nimport { analytics } from '@hhartur/analytics';\n\nanalytics.init({\n  endpoint: '${endpoint}',\n  token: '${ingest?.value || 'TOKEN'}'\n});\n\nanalytics.track('cadastro', { plano: 'pro' });`;
  const tagSnippet = `<script src="https://unpkg.com/@hhartur/analytics/dist/hh-analytics.min.js"\n  data-endpoint="${endpoint}"\n  data-token="${ingest?.value || 'TOKEN'}" defer></script>`;
  const codeBlock = (text) => h('div', {}, h('pre', { class: 'code mono', text }), h('button', { class: 'btn small', style: 'margin-top:.5rem', onclick: () => copy(text), text: 'Copiar' }));

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
      h('h3', { text: '1. Instale no seu site' }),
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
