import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '../db';
import { HttpError, wrap } from '../http';
import { hashToken, requireAdmin } from '../middleware/auth';
import { loginLimiter } from '../middleware/rateLimit';

const router = Router();
const SESSION_DAYS = 30;
// Hash fixo para gastar o mesmo tempo quando o e-mail não existe (não revela quem tem conta)
const DUMMY_HASH = bcrypt.hashSync('hh-analytics-dummy', 12);

// Instalação privada: só o primeiro usuário se cadastra sozinho. ALLOW_REGISTER=true abre para mais gente.
const registrationOpen = async () => process.env.ALLOW_REGISTER === 'true' || (await prisma.user.count()) === 0;

const startSession = async (userId: string) => {
  const token = randomBytes(32).toString('hex');
  await prisma.adminSession.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) } });
  return token;
};
const publicUser = (u: { id: string; email: string; name: string | null }) => ({ id: u.id, email: u.email, name: u.name });

// O painel usa para saber se mostra "criar conta" (primeiro acesso) ou "entrar"
router.get('/status', wrap(async (_req, res) => {
  const users = await prisma.user.count();
  res.json({ setup: users === 0, registration: process.env.ALLOW_REGISTER === 'true' || users === 0 });
}));

router.post('/register', loginLimiter, wrap(async (req, res) => {
  const body = z
    .object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(8).max(200), name: z.string().trim().max(80).optional() })
    .parse(req.body);
  if (!(await registrationOpen())) throw new HttpError(403, 'Cadastro fechado nesta instalação. Peça acesso ao administrador.');
  if (await prisma.user.findUnique({ where: { email: body.email } })) throw new HttpError(409, 'Já existe uma conta com este e-mail');

  const passwordHash = await bcrypt.hash(body.password, 12);
  // Serializable: dois "primeiro cadastro" ao mesmo tempo não criam dois donos
  const user = await prisma.$transaction(
    async (tx) => {
      if (process.env.ALLOW_REGISTER !== 'true' && (await tx.user.count()) > 0) throw new HttpError(403, 'Cadastro fechado nesta instalação.');
      return tx.user.create({ data: { email: body.email, passwordHash, name: body.name || null } });
    },
    { isolationLevel: 'Serializable' }
  );
  res.status(201).json({ token: await startSession(user.id), user: publicUser(user) });
}));

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const { email, password } = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'E-mail ou senha incorretos');
  res.json({ token: await startSession(user.id), user: publicUser(user) });
}));

router.post('/logout', requireAdmin, wrap(async (req, res) => {
  const token = req.headers.authorization!.split(' ')[1];
  await prisma.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  res.json({ ok: true });
}));

// Troca de senha: exige a atual e derruba as outras sessões (a deste navegador continua)
router.post('/password', requireAdmin, loginLimiter, wrap(async (req, res) => {
  const { current, next } = z.object({ current: z.string().max(200), next: z.string().min(8).max(200) }).parse(req.body);
  const user = req.ctx!.user!;
  if (!(await bcrypt.compare(current, user.passwordHash))) throw new HttpError(400, 'Senha atual incorreta');
  const keep = hashToken(req.headers.authorization!.split(' ')[1]);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(next, 12) } }),
    prisma.adminSession.deleteMany({ where: { userId: user.id, tokenHash: { not: keep } } })
  ]);
  res.json({ ok: true });
}));

router.get('/me', requireAdmin, (req, res) => {
  res.json({ user: publicUser(req.ctx!.user!) });
});

export default router;
