import express from 'express';
import cors from 'cors';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { prisma } from './db';
import { errorHandler } from './http';
import { requireAdmin, requireProjectRead } from './middleware/auth';
import { apiLimiter } from './middleware/rateLimit';
import authRouter from './routes/auth';
import ingestRouter from './routes/ingest';
import projectsRouter from './routes/projects';
import reportsRouter from './routes/reports';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida. Veja o .env.example.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
// Atrás de proxy (Caddy, Nginx, Cloudflare): número de proxies confiáveis, para o limite por IP ver o IP real
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

app.get(['/health', '/api/health'], async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: 'hh-analytics-api' });
  } catch {
    res.status(503).json({ ok: false, error: 'banco indisponível' });
  }
});

// Ingestão antes do JSON global: ela lê o corpo como texto (o SDK manda text/plain) e tem CORS aberto
// /api/e é o caminho do SDK >= 0.2 ("/api/collect" está na EasyPrivacy); /api/collect fica para SDKs antigos
app.use(['/api/e', '/api/collect'], ingestRouter);

// Resto da API: o painel é servido daqui mesmo (mesma origem). CORS_ORIGIN libera outros painéis/integrações.
const origins = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use('/api', cors({ origin: origins.length ? origins : false }), apiLimiter, express.json({ limit: '64kb' }));
app.use('/api/auth', authRouter);
app.use('/api/projects', requireAdmin, projectsRouter);
app.use('/api/reports/:projectId', requireProjectRead, reportsRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Painel. O padrão (public/, HTML+JS sem build) pode ser trocado: DASHBOARD_DIR aponta para a pasta de um painel
// próprio (SPA com index.html, usando esta mesma API); DASHBOARD=off deixa só a API.
const customDir = process.env.DASHBOARD_DIR ? path.resolve(process.env.DASHBOARD_DIR) : null;
const publicDir = customDir || path.join(__dirname, '..', 'public');
if (process.env.DASHBOARD !== 'off') {
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    // CSP restrita só no painel padrão: um painel próprio pode precisar de fontes ou scripts de fora
    if (!customDir) {
      res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    }
    next();
  });
  let sendIndex: express.RequestHandler = (_req, res) => res.sendFile(path.join(publicDir, 'index.html'));
  if (!customDir) {
    // CDN na frente (ex.: Cloudflare) guarda CSS/JS por horas: ?v= pelo conteúdo muda a cada deploy que altera os arquivos
    const v = createHash('sha256').update(readFileSync(path.join(publicDir, 'style.css'))).update(readFileSync(path.join(publicDir, 'app.js'))).digest('hex').slice(0, 10);
    const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8').replace(/(href="style\.css|src="app\.js)"/g, `$1?v=${v}"`);
    sendIndex = (_req, res) => res.set('Cache-Control', 'no-cache').type('html').send(html);
    app.get(['/', '/index.html'], sendIndex);
  }
  app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
  app.get('*', sendIndex);
} else {
  app.use((_req, res) => res.status(404).json({ error: 'Painel desligado nesta instalação (DASHBOARD=off)' }));
}

app.use(errorHandler);

// Retenção opcional: RETENTION_DAYS=365 apaga visitas e eventos mais antigos uma vez por dia
const retentionDays = Number(process.env.RETENTION_DAYS || 0);
const purge = async () => {
  if (!(retentionDays > 0)) return;
  const before = new Date(Date.now() - retentionDays * 86_400_000);
  const [pv, ev, se, vi] = await prisma.$transaction([
    prisma.pageview.deleteMany({ where: { createdAt: { lt: before } } }),
    prisma.analyticsEvent.deleteMany({ where: { createdAt: { lt: before } } }),
    prisma.session.deleteMany({ where: { lastSeen: { lt: before } } }),
    prisma.visitor.deleteMany({ where: { lastSeen: { lt: before } } })
  ]);
  console.log(`retenção: ${pv.count} visitas, ${ev.count} eventos, ${se.count} sessões e ${vi.count} visitantes com mais de ${retentionDays} dias apagados`);
};
setInterval(() => purge().catch((err) => console.error('retenção falhou:', err.message)), 86_400_000).unref();
purge().catch((err) => console.error('retenção falhou:', err.message));

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, '0.0.0.0', () => console.log(`hh-analytics: API e painel em http://localhost:${port}`));

const shutdown = () => {
  server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;
