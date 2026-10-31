import express, { Router } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError, wrap } from '../http';
import { collectLimiter } from '../middleware/rateLimit';
import { parseAgent } from '../ua';

// POST /api/collect: recebe o lote do SDK. Aberto para qualquer site (CORS), protegido pelo token de ingestão
// e, se o projeto tiver domínios cadastrados, pelo Origin do navegador.
const router = Router();

const MAX_SKEW_MS = 60_000; // relógio do visitante adiantado
const MAX_AGE_MS = 24 * 3600_000; // evento que ficou na fila offline por mais que isso chega com a hora do servidor

const value = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const event = z.object({
  id: z.string().min(8).max(64).optional(),
  type: z.enum(['pageview', 'event']),
  name: z.string().trim().max(120).optional(),
  timestamp: z.number().int().positive().optional(),
  visitorId: z.string().min(8).max(64),
  sessionId: z.string().min(8).max(64),
  path: z.string().max(500).default('/'),
  title: z.string().max(300).default(''),
  url: z.string().max(1000).default(''),
  referrer: z.string().max(500).default(''),
  utm: z.record(z.string().max(200)).default({}),
  screen: z.string().max(20).default(''),
  language: z.string().max(20).default(''),
  properties: z.record(value).refine((p) => Object.keys(p).length <= 30, 'no máximo 30 propriedades').optional()
});
const body = z.object({ token: z.string().max(100).optional(), events: z.array(event).min(1).max(50) });

// Token -> projeto e domínios, por 60 s (cada visita não precisa ir ao banco para isso)
type Cached = { projectId: string; domains: string[]; at: number } | null;
const cache = new Map<string, Cached>();
const CACHE_MS = 60_000;
export const invalidateToken = (token: string) => cache.delete(token);

const lookup = async (token: string): Promise<Cached> => {
  const hit = cache.get(token);
  if (hit !== undefined && (!hit || Date.now() - hit.at < CACHE_MS)) return hit;
  const t = await prisma.token.findUnique({ where: { value: token }, include: { project: { include: { domains: true } } } });
  const entry = t && !t.revokedAt && t.type === 'INGEST' ? { projectId: t.projectId, domains: t.project.domains.map((d) => d.name), at: Date.now() } : null;
  if (cache.size > 5000) cache.clear();
  cache.set(token, entry);
  return entry;
};

const originAllowed = (origin: string | undefined, domains: string[]) => {
  if (!domains.length) return true;
  if (!origin) return false;
  let host = '';
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
};

const country = (h: Record<string, unknown>) => {
  const v = h['cf-ipcountry'] ?? h['x-vercel-ip-country'] ?? h['x-country-code'];
  return typeof v === 'string' && /^[A-Z]{2}$/i.test(v) && v.toUpperCase() !== 'XX' ? v.toUpperCase() : null;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

router.use(cors({ origin: true, methods: ['POST'], maxAge: 86_400 }));
router.post(
  '/',
  collectLimiter,
  // O SDK manda text/plain (sem preflight, funciona no sendBeacon); integração de servidor pode mandar JSON
  express.text({ type: () => true, limit: '256kb' }),
  wrap(async (req, res) => {
    let raw: unknown;
    try {
      raw = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    } catch {
      throw new HttpError(400, 'JSON inválido');
    }
    const data = body.parse(raw);
    const token = data.token || req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) throw new HttpError(401, 'Token de ingestão necessário');
    const site = await lookup(token);
    if (!site) throw new HttpError(401, 'Token de ingestão inválido ou revogado');
    if (!originAllowed(req.headers.origin, site.domains)) throw new HttpError(403, 'Domínio não autorizado para este projeto');

    const agent = parseAgent(req.headers['user-agent']);
    if (agent.bot) return res.status(202).json({ ok: true, accepted: 0 });
    const geo = country(req.headers);
    const now = Date.now();

    // Entrega "pelo menos uma vez": o SDK reenvia o lote se não tiver certeza de que chegou. Ids já gravados saem daqui.
    const ids = data.events.map((e) => e.id).filter((id): id is string => Boolean(id));
    if (ids.length) {
      const [pv, ev] = await Promise.all([
        prisma.pageview.findMany({ where: { projectId: site.projectId, eventId: { in: ids } }, select: { eventId: true } }),
        prisma.analyticsEvent.findMany({ where: { projectId: site.projectId, eventId: { in: ids } }, select: { eventId: true } })
      ]);
      const seen = new Set([...pv, ...ev].map((r) => r.eventId));
      data.events = data.events.filter((e) => !e.id || !seen.has(e.id));
      if (!data.events.length) return res.status(202).json({ ok: true, accepted: 0, duplicates: ids.length });
    }
    const when = (ts?: number) => new Date(ts && ts <= now + MAX_SKEW_MS && ts >= now - MAX_AGE_MS ? Math.min(ts, now) : now);
    const projectId = site.projectId;

    // Visitantes do lote (normalmente um só)
    const visitors = new Map<string, string>();
    for (const vid of new Set(data.events.map((e) => e.visitorId))) {
      const first = data.events.find((e) => e.visitorId === vid)!;
      const v = await prisma.visitor.upsert({
        where: { projectId_visitorId: { projectId, visitorId: vid } },
        update: { lastSeen: new Date(now), browser: agent.browser, os: agent.os, device: agent.device, ...(geo ? { country: geo } : {}) },
        create: { projectId, visitorId: vid, browser: agent.browser, os: agent.os, device: agent.device, country: geo, language: first.language || null, screen: first.screen || null }
      });
      visitors.set(vid, v.id);
    }

    // Sessões: a primeira visita define a página de entrada e a origem; as seguintes só somam
    for (const sid of new Set(data.events.map((e) => e.sessionId))) {
      const items = data.events.filter((e) => e.sessionId === sid);
      const first = items.find((e) => e.type === 'pageview') ?? items[0];
      const times = items.map((e) => when(e.timestamp).getTime());
      const pageviews = items.filter((e) => e.type === 'pageview').length;
      await prisma.session.upsert({
        where: { projectId_sessionId: { projectId, sessionId: sid } },
        update: { lastSeen: new Date(Math.max(...times)), pageviews: { increment: pageviews } },
        create: {
          projectId,
          sessionId: sid,
          visitorId: visitors.get(first.visitorId)!,
          entryPath: first.path,
          referrer: hostOf(first.referrer),
          utmSource: first.utm.source || null,
          startedAt: new Date(Math.min(...times)),
          lastSeen: new Date(Math.max(...times)),
          pageviews
        }
      });
    }

    const pageviews = data.events.filter((e) => e.type === 'pageview');
    const events = data.events.filter((e) => e.type === 'event');
    await prisma.$transaction([
      prisma.pageview.createMany({
        skipDuplicates: true,
        data: pageviews.map((e) => ({
          projectId,
          visitorId: visitors.get(e.visitorId)!,
          sessionId: e.sessionId,
          eventId: e.id,
          path: e.path || '/',
          title: e.title,
          url: e.url,
          referrer: hostOf(e.referrer),
          utm: Object.keys(e.utm).length ? e.utm : undefined,
          browser: agent.browser,
          os: agent.os,
          device: agent.device,
          country: geo,
          createdAt: when(e.timestamp)
        }))
      }),
      prisma.analyticsEvent.createMany({
        skipDuplicates: true,
        data: events.map((e) => ({
          projectId,
          visitorId: visitors.get(e.visitorId)!,
          sessionId: e.sessionId,
          eventId: e.id,
          name: e.name || 'evento',
          path: e.path,
          properties: e.properties,
          createdAt: when(e.timestamp)
        }))
      })
    ]);

    res.status(202).json({ ok: true, accepted: data.events.length });
  })
);

export default router;
