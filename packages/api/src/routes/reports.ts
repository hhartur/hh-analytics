import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError, wrap } from '../http';

// Montado em /api/reports/:projectId, atrás de requireProjectRead (membro do projeto ou token QUERY dele)
const router = Router({ mergeParams: true });

const RANGES: Record<string, number> = { '24h': 1, '1d': 1, '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// Período: ?range=7d (padrão) ou ?from=2026-10-01&to=2026-10-31; ?tz=America/Sao_Paulo define o "dia" dos gráficos
const period = (req: Request) => {
  const q = z
    .object({
      range: z.string().optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      tz: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(10)
    })
    .parse(req.query);
  const tz = q.tz && validTz(q.tz) ? q.tz : 'UTC';
  let from: Date;
  let to: Date;
  if (q.from && q.to) {
    from = new Date(`${q.from}T00:00:00Z`);
    to = new Date(`${q.to}T23:59:59.999Z`);
    if (!(from <= to) || to.getTime() - from.getTime() > 400 * 86_400_000) throw new HttpError(400, 'Período inválido (até 400 dias)');
  } else {
    const days = RANGES[q.range ?? '7d'];
    if (!days) throw new HttpError(400, 'range: use 24h, 7d, 30d, 90d ou 365d');
    to = new Date();
    from = new Date(to.getTime() - days * 86_400_000);
  }
  return { projectId: req.params.projectId, from, to, tz, limit: q.limit };
};

const num = (v: unknown) => Number(v ?? 0);

const totals = async (projectId: string, from: Date, to: Date) => {
  const [pv] = await prisma.$queryRaw<Array<{ pageviews: bigint; visitors: bigint }>>`
    SELECT count(*) AS pageviews, count(DISTINCT "visitorId") AS visitors
    FROM "Pageview" WHERE "projectId" = ${projectId} AND "createdAt" >= ${from} AND "createdAt" <= ${to}`;
  const [s] = await prisma.$queryRaw<Array<{ sessions: bigint; bounces: bigint; duration: number | null }>>`
    SELECT count(*) AS sessions,
           count(*) FILTER (WHERE "pageviews" <= 1) AS bounces,
           avg(EXTRACT(EPOCH FROM ("lastSeen" - "startedAt"))) AS duration
    FROM "Session" WHERE "projectId" = ${projectId} AND "startedAt" >= ${from} AND "startedAt" <= ${to}`;
  const events = await prisma.analyticsEvent.count({ where: { projectId, createdAt: { gte: from, lte: to } } });
  const sessions = num(s.sessions);
  return {
    pageviews: num(pv.pageviews),
    visitors: num(pv.visitors),
    sessions,
    events,
    bounceRate: sessions ? Math.round((num(s.bounces) / sessions) * 1000) / 10 : 0,
    avgSessionSeconds: Math.round(num(s.duration))
  };
};

// Números do período e do período anterior do mesmo tamanho (para a seta de subiu/desceu)
router.get('/summary', wrap(async (req, res) => {
  const { projectId, from, to } = period(req);
  const span = to.getTime() - from.getTime();
  const [current, previous] = await Promise.all([totals(projectId, from, to), totals(projectId, new Date(from.getTime() - span), from)]);
  res.json({ from, to, current, previous });
}));

// Visitas e visitantes por dia (ou por hora, no 24h), com os dias vazios preenchidos com zero
router.get('/timeseries', wrap(async (req, res) => {
  const { projectId, from, to, tz } = period(req);
  const hourly = to.getTime() - from.getTime() <= 2 * 86_400_000;
  const unit = Prisma.raw(hourly ? `'hour'` : `'day'`);
  const rows = await prisma.$queryRaw<Array<{ bucket: Date; pageviews: bigint; visitors: bigint }>>`
    SELECT date_trunc(${unit}, ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS bucket,
           count(*) AS pageviews, count(DISTINCT "visitorId") AS visitors
    FROM "Pageview" WHERE "projectId" = ${projectId} AND "createdAt" >= ${from} AND "createdAt" <= ${to}
    GROUP BY 1 ORDER BY 1`;
  // O banco devolve o "relógio de parede" do fuso; as chaves do eixo saem do mesmo fuso via Intl
  const byKey = new Map(rows.map((r) => [r.bucket.toISOString().slice(0, hourly ? 13 : 10), r]));
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const localKey = (d: Date) => {
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return hourly ? `${p.year}-${p.month}-${p.day}T${p.hour}` : `${p.year}-${p.month}-${p.day}`;
  };
  const keys: string[] = [];
  const step = hourly ? 3600_000 : 86_400_000;
  for (let t = from.getTime(); t <= to.getTime() + step; t += step) {
    const k = localKey(new Date(Math.min(t, to.getTime())));
    if (keys.at(-1) !== k) keys.push(k);
  }
  const points = keys.map((k) => ({ date: hourly ? `${k}:00` : k, pageviews: num(byKey.get(k)?.pageviews), visitors: num(byKey.get(k)?.visitors) }));
  res.json({ unit: hourly ? 'hour' : 'day', tz, points });
}));

// Quebra por uma coluna do Pageview: visitas e visitantes únicos por valor
const COLUMNS = { pages: 'path', browsers: 'browser', os: 'os', devices: 'device', countries: 'country' } as const;
for (const [route, column] of Object.entries(COLUMNS)) {
  router.get(`/${route}`, wrap(async (req, res) => {
    const { projectId, from, to, limit } = period(req);
    const col = Prisma.raw(`"${column}"`);
    const rows = await prisma.$queryRaw<Array<{ value: string | null; pageviews: bigint; visitors: bigint }>>`
      SELECT ${col} AS value, count(*) AS pageviews, count(DISTINCT "visitorId") AS visitors
      FROM "Pageview" WHERE "projectId" = ${projectId} AND "createdAt" >= ${from} AND "createdAt" <= ${to}
      GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`;
    res.json(rows.map((r) => ({ value: r.value, pageviews: num(r.pageviews), visitors: num(r.visitors) })));
  }));
}

// Origens de tráfego: de onde veio cada sessão ("" = acesso direto)
router.get('/referrers', wrap(async (req, res) => {
  const { projectId, from, to, limit } = period(req);
  const rows = await prisma.session.groupBy({
    by: ['referrer'],
    where: { projectId, startedAt: { gte: from, lte: to } },
    _count: { _all: true },
    orderBy: { _count: { referrer: 'desc' } },
    take: limit
  });
  res.json(rows.map((r) => ({ value: r.referrer || null, sessions: r._count._all })));
}));

router.get('/utm', wrap(async (req, res) => {
  const { projectId, from, to, limit } = period(req);
  const rows = await prisma.session.groupBy({
    by: ['utmSource'],
    where: { projectId, startedAt: { gte: from, lte: to }, utmSource: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { utmSource: 'desc' } },
    take: limit
  });
  res.json(rows.map((r) => ({ value: r.utmSource, sessions: r._count._all })));
}));

router.get('/events', wrap(async (req, res) => {
  const { projectId, from, to, limit } = period(req);
  const rows = await prisma.$queryRaw<Array<{ name: string; count: bigint; visitors: bigint }>>`
    SELECT "name", count(*) AS count, count(DISTINCT "visitorId") AS visitors
    FROM "AnalyticsEvent" WHERE "projectId" = ${projectId} AND "createdAt" >= ${from} AND "createdAt" <= ${to}
    GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`;
  res.json(rows.map((r) => ({ name: r.name, count: num(r.count), visitors: num(r.visitors) })));
}));

// Quem está no site agora: visitantes com atividade nos últimos 5 minutos
router.get('/realtime', wrap(async (req, res) => {
  const since = new Date(Date.now() - 5 * 60_000);
  const [row] = await prisma.$queryRaw<Array<{ visitors: bigint }>>`
    SELECT count(DISTINCT "visitorId") AS visitors FROM "Session" WHERE "projectId" = ${req.params.projectId} AND "lastSeen" >= ${since}`;
  res.json({ visitors: num(row.visitors), since });
}));

export default router;
