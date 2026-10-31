// Testes de integração contra uma API rodando com banco vazio e ALLOW_REGISTER=true:
//   API_URL=http://localhost:4100 npm run test:api
// (o README mostra como subir uma instância descartável para isso com docker compose)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.API_URL || 'http://localhost:4000').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MOBILE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

const call = async (path, { method = 'GET', token, body, headers = {}, text } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(text ? { 'Content-Type': 'text/plain' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: text ?? (body ? JSON.stringify(body) : undefined)
  });
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
};
const collect = (token, events, headers = {}) => call('/api/e', { method: 'POST', text: JSON.stringify({ token, events }), headers: { 'User-Agent': UA, ...headers } });

const run = `${Date.now()}`;
const ev = (over) => ({ type: 'pageview', timestamp: Date.now(), visitorId: `visitante-a-${run}`, sessionId: `sessao-a-${run}`, path: '/', title: 'Início', url: 'https://loja.test/', referrer: '', utm: {}, screen: '1920x1080', language: 'pt-BR', ...over });

const ctx = {};

test('saúde e banco no ar', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('cadastro, login e sessão', async () => {
  const a = await call('/api/auth/register', { method: 'POST', body: { email: `dona-${run}@loja.test`, password: 'senha-forte-123', name: 'Dona' } });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.ok(a.data.token);
  const dup = await call('/api/auth/register', { method: 'POST', body: { email: `dona-${run}@loja.test`, password: 'senha-forte-123' } });
  assert.equal(dup.status, 409);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'ruim', password: '1' } })).status, 400);

  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: `dona-${run}@loja.test`, password: 'errada' } })).status, 401);
  const login = await call('/api/auth/login', { method: 'POST', body: { email: `DONA-${run}@loja.test`, password: 'senha-forte-123' } });
  assert.equal(login.status, 200);
  ctx.owner = login.data.token;
  assert.equal((await call('/api/auth/me', { token: ctx.owner })).data.user.name, 'Dona');
  assert.equal((await call('/api/auth/me')).status, 401);
  assert.equal((await call('/api/auth/me', { token: 'inventado' })).status, 401);

  const outro = await call('/api/auth/register', { method: 'POST', body: { email: `outro-${run}@loja.test`, password: 'senha-forte-123' } });
  ctx.stranger = outro.data.token;
});

test('projeto nasce com token de ingestão e de consulta; slug único', async () => {
  const p = await call('/api/projects', { method: 'POST', token: ctx.owner, body: { name: 'Loja Ação' } });
  assert.equal(p.status, 201);
  assert.equal(p.data.slug, 'loja-acao');
  ctx.project = p.data;
  ctx.ingest = p.data.tokens.find((t) => t.type === 'INGEST').value;
  ctx.query = p.data.tokens.find((t) => t.type === 'QUERY').value;
  assert.match(ctx.ingest, /^hhi_/);
  const p2 = await call('/api/projects', { method: 'POST', token: ctx.owner, body: { name: 'Loja Ação' } });
  assert.equal(p2.data.slug, 'loja-acao-2');
  ctx.other = p2.data;
  assert.equal((await call('/api/projects', { token: ctx.owner })).data.length, 2);
});

test('ingestão: lote do SDK em text/plain com o token no corpo', async () => {
  const r = await collect(ctx.ingest, [
    ev({ referrer: 'https://www.google.com/search?q=loja', utm: { source: 'google', campaign: 'natal' }, path: '/?utm_source=google' }),
    ev({ path: '/produtos', title: 'Produtos', timestamp: Date.now() + 1000 }),
    ev({ type: 'event', name: 'cadastro', path: '/produtos', properties: { plano: 'pro', valor: 19.9 } })
  ]);
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.accepted, 3);
  assert.equal(r.headers.get('access-control-allow-origin'), null); // sem Origin, sem cabeçalho de CORS

  // Outro visitante, no celular, uma página só (rejeição), vindo de outro site
  const m = await collect(ctx.ingest, [ev({ visitorId: `visitante-b-${run}`, sessionId: `sessao-b-${run}`, path: '/produtos', referrer: 'https://twitter.com/x' })], { 'User-Agent': MOBILE, Origin: 'https://loja.test' });
  assert.equal(m.status, 202);
  assert.equal(m.headers.get('access-control-allow-origin'), 'https://loja.test');

  // Token pelo cabeçalho também vale (envio do servidor, em JSON)
  const j = await call('/api/collect', { method: 'POST', token: ctx.ingest, body: { events: [ev({ type: 'event', name: 'webhook' })] }, headers: { 'User-Agent': UA } });
  assert.equal(j.status, 202);
});

test('o mesmo lote reenviado (rede caiu, página fechou) não conta de novo', async () => {
  const once = [ev({ id: `dup-pv-${run}`, path: '/repetida', visitorId: `visitante-c-${run}`, sessionId: `sessao-c-${run}` }), ev({ id: `dup-ev-${run}`, type: 'event', name: 'repetido', visitorId: `visitante-c-${run}`, sessionId: `sessao-c-${run}` })];
  assert.equal((await collect(ctx.ingest, once)).data.accepted, 2);
  const again = await collect(ctx.ingest, once);
  assert.equal(again.status, 202);
  assert.equal(again.data.accepted, 0);
  ctx.extra = { pageviews: 1, events: 1, visitors: 1, sessions: 1 };
});

test('ingestão recusa o que não presta', async () => {
  assert.equal((await collect('hhi_inventado', [ev({})])).status, 401);
  assert.equal((await collect(ctx.query, [ev({})])).status, 401); // token de consulta não envia evento
  assert.equal((await collect(ctx.ingest, [])).status, 400);
  assert.equal((await collect(ctx.ingest, [ev({ visitorId: 'x' })])).status, 400);
  assert.equal((await call('/api/collect', { method: 'POST', text: '{nao é json' })).status, 400);
  const bot = await collect(ctx.ingest, [ev({ visitorId: `robo-${run}-xx` })], { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
  assert.equal(bot.data.accepted, 0);
  const pre = await fetch(`${BASE}/api/collect`, { method: 'OPTIONS', headers: { Origin: 'https://qualquer.test', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
});

test('relatórios batem com o que foi enviado', async () => {
  const id = ctx.project.id;
  const s = (await call(`/api/reports/${id}/summary?range=7d`, { token: ctx.owner })).data.current;
  // 3 visitas + 2 eventos do lote principal, mais a visita e o evento do teste de reenvio (contados uma vez só)
  assert.equal(s.pageviews, 3 + ctx.extra.pageviews);
  assert.equal(s.visitors, 2 + ctx.extra.visitors);
  assert.equal(s.sessions, 2 + ctx.extra.sessions);
  assert.equal(s.events, 2 + ctx.extra.events);
  assert.equal(s.bounceRate, 66.7);

  const ts = (await call(`/api/reports/${id}/timeseries?range=7d&tz=America/Sao_Paulo`, { token: ctx.owner })).data;
  assert.equal(ts.unit, 'day');
  assert.ok(ts.points.length >= 7 && ts.points.length <= 9, `pontos: ${ts.points.length}`);
  assert.equal(ts.points.reduce((a, p) => a + p.pageviews, 0), 4);
  const hours = (await call(`/api/reports/${id}/timeseries?range=24h`, { token: ctx.owner })).data;
  assert.equal(hours.unit, 'hour');
  assert.equal(hours.points.reduce((a, p) => a + p.pageviews, 0), 4);

  const pages = (await call(`/api/reports/${id}/pages`, { token: ctx.owner })).data;
  assert.deepEqual(pages[0], { value: '/produtos', pageviews: 2, visitors: 2 });
  const refs = (await call(`/api/reports/${id}/referrers`, { token: ctx.owner })).data.map((r) => r.value).sort();
  assert.deepEqual(refs, ['google.com', null, 'twitter.com']); // null = acesso direto (sessão do teste de reenvio)
  assert.deepEqual((await call(`/api/reports/${id}/utm`, { token: ctx.owner })).data, [{ value: 'google', sessions: 1 }]);
  const events = (await call(`/api/reports/${id}/events`, { token: ctx.owner })).data.map((e) => e.name).sort();
  assert.deepEqual(events, ['cadastro', 'repetido', 'webhook']);
  const devices = Object.fromEntries((await call(`/api/reports/${id}/devices`, { token: ctx.owner })).data.map((d) => [d.value, d.visitors]));
  assert.deepEqual(devices, { desktop: 2, mobile: 1 });
  const os = (await call(`/api/reports/${id}/os`, { token: ctx.owner })).data.map((d) => d.value).sort();
  assert.deepEqual(os, ['Android', 'Windows']);
  assert.ok((await call(`/api/reports/${id}/realtime`, { token: ctx.owner })).data.visitors >= 2);
  assert.equal((await call(`/api/reports/${id}/summary?range=1ano`, { token: ctx.owner })).status, 400);
});

test('isolamento: ninguém lê projeto alheio', async () => {
  const id = ctx.project.id;
  assert.equal((await call(`/api/reports/${id}/summary`, { token: ctx.stranger })).status, 404);
  assert.equal((await call(`/api/projects/${id}`, { token: ctx.stranger })).status, 404);
  assert.equal((await call(`/api/projects/${id}`, { method: 'DELETE', token: ctx.stranger })).status, 404);
  assert.equal((await call(`/api/reports/${id}/summary`)).status, 401);
  // Token de consulta lê o próprio projeto e só ele
  assert.equal((await call(`/api/reports/${id}/summary`, { token: ctx.query })).status, 200);
  assert.equal((await call(`/api/reports/${ctx.other.id}/summary`, { token: ctx.query })).status, 404);
  // Token de ingestão (público) não lê nada
  assert.equal((await call(`/api/reports/${id}/summary`, { token: ctx.ingest })).status, 401);
  assert.equal((await call('/api/projects', { token: ctx.query })).status, 401);
});

test('membros: convite com senha provisória e permissões por papel', async () => {
  const id = ctx.project.id;
  const email = `leitor-${run}@loja.test`;
  const add = await call(`/api/projects/${id}/members`, { method: 'POST', token: ctx.owner, body: { email, role: 'VIEWER' } });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  assert.ok(add.data.tempPassword && add.data.tempPassword.length >= 10);
  assert.deepEqual(add.data.members.map((m) => m.role), ['OWNER', 'VIEWER']);
  assert.equal((await call(`/api/projects/${id}/members`, { method: 'POST', token: ctx.owner, body: { email, role: 'VIEWER' } })).status, 409);

  // O convidado entra com a senha provisória e só lê
  const viewer = (await call('/api/auth/login', { method: 'POST', body: { email, password: add.data.tempPassword } })).data.token;
  assert.ok(viewer);
  const viewerId = add.data.members.find((m) => m.email === email).userId;
  assert.equal((await call(`/api/reports/${id}/summary`, { token: viewer })).status, 200);
  const seen = (await call(`/api/projects/${id}`, { token: viewer })).data;
  assert.deepEqual(seen.tokens.map((t) => t.type), ['INGEST']); // token de consulta é só de dono e admin
  assert.equal((await call(`/api/projects/${id}/tokens`, { method: 'POST', token: viewer, body: { type: 'QUERY' } })).status, 403);
  assert.equal((await call(`/api/projects/${id}/members`, { method: 'POST', token: viewer, body: { email: 'x@loja.test' } })).status, 403);
  assert.equal((await call(`/api/projects/${id}/members/${viewerId}`, { method: 'PATCH', token: viewer, body: { role: 'ADMIN' } })).status, 403);

  // Dono promove a admin; admin adiciona membro, mas não admin, e não remove o dono
  assert.equal((await call(`/api/projects/${id}/members/${viewerId}`, { method: 'PATCH', token: ctx.owner, body: { role: 'ADMIN' } })).status, 200);
  assert.equal((await call(`/api/projects/${id}/members`, { method: 'POST', token: viewer, body: { email: `outro-${run}@loja.test`, role: 'ADMIN' } })).status, 403);
  const added = await call(`/api/projects/${id}/members`, { method: 'POST', token: viewer, body: { email: `outro-${run}@loja.test`, role: 'MEMBER' } });
  assert.equal(added.status, 201);
  assert.equal(added.data.tempPassword, null); // conta já existia: nada de senha nova
  const ownerId = added.data.members.find((m) => m.role === 'OWNER').userId;
  assert.equal((await call(`/api/projects/${id}/members/${ownerId}`, { method: 'DELETE', token: viewer })).status, 400);
  assert.equal((await call(`/api/projects/${id}/members/${ownerId}`, { method: 'PATCH', token: ctx.owner, body: { role: 'VIEWER' } })).status, 400);

  // Troca de senha: a provisória para de valer e as outras sessões caem
  const other = (await call('/api/auth/login', { method: 'POST', body: { email, password: add.data.tempPassword } })).data.token;
  assert.equal((await call('/api/auth/password', { method: 'POST', token: viewer, body: { current: 'errada', next: 'nova-senha-123' } })).status, 400);
  assert.equal((await call('/api/auth/password', { method: 'POST', token: viewer, body: { current: add.data.tempPassword, next: 'nova-senha-123' } })).status, 200);
  assert.equal((await call('/api/auth/me', { token: other })).status, 401);
  assert.equal((await call('/api/auth/me', { token: viewer })).status, 200);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email, password: add.data.tempPassword } })).status, 401);

  // Sair do projeto e remoção
  const outroId = added.data.members.find((m) => m.email === `outro-${run}@loja.test`).userId;
  assert.equal((await call(`/api/projects/${id}/members/${viewerId}`, { method: 'DELETE', token: viewer })).data.left, true);
  assert.equal((await call(`/api/reports/${id}/summary`, { token: viewer })).status, 404);
  const left = await call(`/api/projects/${id}/members/${outroId}`, { method: 'DELETE', token: ctx.owner });
  assert.deepEqual(left.data.map((m) => m.role), ['OWNER']);
});

test('domínios permitidos travam a ingestão pelo Origin', async () => {
  const id = ctx.project.id;
  assert.equal((await call(`/api/projects/${id}/domains`, { method: 'POST', token: ctx.owner, body: { name: 'https://Loja.test/qualquer' } })).status, 201);
  assert.equal((await call(`/api/projects/${id}/domains`, { method: 'POST', token: ctx.owner, body: { name: 'semponto' } })).status, 400);
  assert.equal((await collect(ctx.ingest, [ev({})])).status, 403);
  assert.equal((await collect(ctx.ingest, [ev({})], { Origin: 'https://www.loja.test' })).status, 202);
  assert.equal((await collect(ctx.ingest, [ev({})], { Origin: 'https://lojatest.com' })).status, 403);
  const d = (await call(`/api/projects/${id}`, { token: ctx.owner })).data.domains;
  assert.deepEqual(d.map((x) => x.name), ['loja.test']);
  await call(`/api/projects/${id}/domains/${d[0].id}`, { method: 'DELETE', token: ctx.owner });
  assert.equal((await collect(ctx.ingest, [ev({})])).status, 202);
});

test('trocar token: o antigo para na hora', async () => {
  const id = ctx.project.id;
  const r = await call(`/api/projects/${id}/tokens`, { method: 'POST', token: ctx.owner, body: { type: 'INGEST' } });
  const fresh = r.data.tokens.find((t) => t.type === 'INGEST').value;
  assert.notEqual(fresh, ctx.ingest);
  assert.equal((await collect(ctx.ingest, [ev({})])).status, 401);
  assert.equal((await collect(fresh, [ev({})])).status, 202);
});

test('apagar projeto apaga os dados dele', async () => {
  const id = ctx.project.id;
  assert.equal((await call(`/api/projects/${id}`, { method: 'DELETE', token: ctx.owner })).status, 200);
  assert.equal((await call(`/api/reports/${id}/summary`, { token: ctx.owner })).status, 404);
  assert.equal((await call(`/api/projects/${ctx.other.id}`, { token: ctx.owner })).status, 200);
});

test('logout derruba a sessão', async () => {
  assert.equal((await call('/api/auth/logout', { method: 'POST', token: ctx.owner })).status, 200);
  assert.equal((await call('/api/auth/me', { token: ctx.owner })).status, 401);
});
