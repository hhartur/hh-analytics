// Testes do SDK com um navegador simulado (sem dependências): `npm test` depois do build
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// ---------- navegador falso ----------
const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
};
const listeners = { window: {}, document: {} };
const on = (bag) => (type, fn) => (bag[type] ||= []).push(fn);
const fire = (bag, type) => (bag[type] || []).forEach((fn) => fn());

const loc = { href: '', pathname: '/', search: '', hostname: 'loja.test' };
const go = (path) => {
  const [pathname, search = ''] = path.split('?');
  Object.assign(loc, { pathname, search: search ? `?${search}` : '', href: `https://loja.test${path}` });
};
let calls = [];
let beacons = [];
let reply = () => ({ ok: true, status: 200 });
let ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36';

Object.assign(globalThis, {
  window: globalThis,
  localStorage: memStore(),
  sessionStorage: memStore(),
  location: loc,
  screen: { width: 1920, height: 1080 },
  document: { title: 'Loja', referrer: '', visibilityState: 'visible', addEventListener: on(listeners.document) },
  history: {
    pushState(_s, _t, url) { go(url); },
    replaceState(_s, _t, url) { if (url) go(url); }
  },
  addEventListener: on(listeners.window),
  fetch: async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    const r = reply();
    if (r instanceof Error) throw r;
    return r;
  }
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    get userAgent() { return ua; },
    language: 'pt-BR',
    sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; }
  }
});

const { Analytics } = await import('../dist/index.js');
const opts = { endpoint: 'https://analytics.test/api/', token: 'tok_ingest' };
const events = () => calls.flatMap((c) => c.body.events);

beforeEach(() => {
  localStorage.clear();
  calls = [];
  beacons = [];
  reply = () => ({ ok: true, status: 200 });
  ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36';
  go('/?utm_source=google&utm_campaign=natal');
  document.referrer = 'https://google.com/search';
});

test('init conta a visita e manda o lote para {endpoint}/collect com o token no corpo', async () => {
  const a = new Analytics();
  a.init(opts);
  await a.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://analytics.test/api/collect');
  assert.equal(calls[0].opts.headers['Content-Type'], 'text/plain');
  assert.equal(calls[0].body.token, 'tok_ingest');
  const [pv] = calls[0].body.events;
  assert.equal(pv.type, 'pageview');
  assert.equal(pv.path, '/?utm_source=google&utm_campaign=natal');
  assert.deepEqual(pv.utm, { source: 'google', campaign: 'natal' });
  assert.equal(pv.referrer, 'https://google.com/search');
  assert.equal(pv.screen, '1920x1080');
  assert.ok(pv.visitorId && pv.sessionId);
});

test('eventos próximos vão juntos; visitante e sessão se mantêm', async () => {
  const a = new Analytics();
  a.init(opts);
  a.track('cadastro', { plano: 'pro', valor: 19.9 });
  a.track('');
  await a.flush();
  const [pv, ev] = events();
  assert.equal(events().length, 2);
  assert.equal(ev.type, 'event');
  assert.equal(ev.name, 'cadastro');
  assert.deepEqual(ev.properties, { plano: 'pro', valor: 19.9 });
  assert.equal(pv.visitorId, ev.visitorId);
  assert.equal(pv.sessionId, ev.sessionId);
  // Cada evento tem id próprio: o servidor usa para ignorar reenvio do mesmo lote
  assert.match(pv.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(pv.id, ev.id);
});

test('SPA: pushState para outra página conta visita; replaceState no mesmo caminho não', async () => {
  const a = new Analytics();
  a.init(opts);
  history.replaceState({}, '', '/?utm_source=google&utm_campaign=natal');
  history.pushState({}, '', '/produtos?id=7');
  history.replaceState({ scroll: 300 }, '');
  await a.flush();
  assert.deepEqual(events().filter((e) => e.type === 'pageview').map((e) => e.path), ['/?utm_source=google&utm_campaign=natal', '/produtos?id=7']);
});

test('referrer do próprio site não conta como origem', async () => {
  document.referrer = 'https://loja.test/outra';
  const a = new Analytics();
  a.init(opts);
  await a.flush();
  assert.equal(events()[0].referrer, '');
});

test('sem rede: o lote volta para a fila (e fica salvo) e sai no próximo envio', async () => {
  const a = new Analytics();
  reply = () => new TypeError('Failed to fetch');
  a.init(opts);
  a.track('clique');
  await a.flush();
  assert.equal(JSON.parse(localStorage.getItem('hh:queue')).length, 2);
  reply = () => ({ ok: true, status: 200 });
  await a.flush();
  assert.equal(calls.at(-1).body.events.length, 2);
  assert.equal(JSON.parse(localStorage.getItem('hh:queue')).length, 0);
});

test('erro 5xx tenta de novo; 4xx (token errado) não fica preso na fila', async () => {
  const a = new Analytics();
  reply = () => ({ ok: false, status: 503 });
  a.init(opts);
  await a.flush();
  assert.equal(JSON.parse(localStorage.getItem('hh:queue')).length, 1);
  reply = () => ({ ok: false, status: 401 });
  await a.flush();
  assert.equal(JSON.parse(localStorage.getItem('hh:queue')).length, 0);
});

test('ao sair da página usa sendBeacon no endpoint (não na própria página)', async () => {
  const a = new Analytics();
  a.init(opts);
  a.track('saida');
  fire(listeners.window, 'pagehide');
  await new Promise((r) => setTimeout(r, 0));
  const last = beacons.at(-1);
  assert.equal(last.url, 'https://analytics.test/api/collect');
  assert.equal(last.blob.type, 'text/plain');
  const body = JSON.parse(await last.blob.text());
  assert.equal(body.token, 'tok_ingest');
  assert.ok(body.events.some((e) => e.name === 'saida'));
});

test('robôs e navegadores automatizados não contam', async () => {
  ua = 'Mozilla/5.0 (compatible; Googlebot/2.1)';
  const a = new Analytics();
  a.init(opts);
  a.track('x');
  await a.flush();
  assert.equal(calls.length + beacons.length, 0);
});

test('init sem endpoint ou token não liga nada', async () => {
  const a = new Analytics();
  const warn = console.warn;
  console.warn = () => {};
  a.init({ endpoint: '', token: '' });
  console.warn = warn;
  a.track('x');
  await a.flush();
  assert.equal(calls.length, 0);
});

test('fila offline tem teto de 200 eventos', async () => {
  const a = new Analytics();
  reply = () => new TypeError('offline');
  a.init(opts);
  for (let i = 0; i < 260; i++) a.track(`e${i}`);
  assert.equal(JSON.parse(localStorage.getItem('hh:queue')).length, 200);
});

test('no servidor (SSR) importar e chamar não quebra', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const m = await import('./dist/index.js'); m.analytics.init({ endpoint: 'x', token: 'y' }); m.analytics.track('a'); m.analytics.pageview(); await m.analytics.flush(); console.log('ok');"
  ], { encoding: 'utf8' });
  assert.equal(out.trim(), 'ok');
});

test('CommonJS também carrega', () => {
  const out = execFileSync(process.execPath, ['-e', "const m = require('./dist/index.cjs'); console.log(typeof m.analytics.init, typeof m.Analytics);"], { encoding: 'utf8' });
  assert.equal(out.trim(), 'function function');
});
