import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import type { Role, TokenType } from '@prisma/client';
import { prisma } from '../db';
import { HttpError, wrap } from '../http';
import { invalidateToken } from './ingest';

// Montado em /api/projects, atrás de requireAdmin
const router = Router();

const newToken = (type: TokenType) => `${type === 'INGEST' ? 'hhi' : 'hhq'}_${randomBytes(24).toString('base64url')}`;
const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'projeto';

// Domínio como o navegador manda no Origin: só o hostname, sem protocolo, porta ou caminho
const hostOf = (raw: string) => {
  const v = raw.trim().toLowerCase();
  try {
    return new URL(v.includes('://') ? v : `https://${v}`).hostname;
  } catch {
    return '';
  }
};

// Membro do projeto com um dos papéis pedidos; se não for, 404 (não revela que o projeto existe)
const access = async (userId: string, projectId: string, roles: Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']) => {
  const m = await prisma.projectUser.findUnique({ where: { userId_projectId: { userId, projectId } } });
  if (!m) throw new HttpError(404, 'Projeto não encontrado');
  if (!roles.includes(m.role)) throw new HttpError(403, 'Seu papel neste projeto não permite isso');
  return m;
};

const detail = async (projectId: string, role: Role) => {
  const p = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { domains: { orderBy: { createdAt: 'asc' } }, tokens: { where: { revokedAt: null }, orderBy: { createdAt: 'asc' } } }
  });
  // Token de consulta é segredo: só dono e admin veem
  const canManage = role === 'OWNER' || role === 'ADMIN';
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    role,
    createdAt: p.createdAt,
    domains: p.domains.map((d) => ({ id: d.id, name: d.name })),
    tokens: p.tokens.filter((t) => t.type === 'INGEST' || canManage).map((t) => ({ id: t.id, type: t.type, value: t.value, createdAt: t.createdAt }))
  };
};

router.get('/', wrap(async (req, res) => {
  const rows = await prisma.projectUser.findMany({ where: { userId: req.ctx!.user!.id }, include: { project: true }, orderBy: { createdAt: 'asc' } });
  res.json(rows.map((m) => ({ id: m.project.id, name: m.project.name, slug: m.project.slug, role: m.role, createdAt: m.project.createdAt })));
}));

router.post('/', wrap(async (req, res) => {
  const { name, slug } = z.object({ name: z.string().trim().min(1).max(80), slug: z.string().trim().max(40).optional() }).parse(req.body);
  const base = slugify(slug || name);
  let final = base;
  for (let n = 2; await prisma.project.findUnique({ where: { slug: final } }); n++) final = `${base}-${n}`;
  const user = req.ctx!.user!;
  const project = await prisma.project.create({
    data: {
      name,
      slug: final,
      ownerId: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
      tokens: { create: [{ type: 'INGEST', value: newToken('INGEST') }, { type: 'QUERY', value: newToken('QUERY') }] }
    }
  });
  res.status(201).json(await detail(project.id, 'OWNER'));
}));

router.get('/:id', wrap(async (req, res) => {
  const m = await access(req.ctx!.user!.id, req.params.id);
  res.json(await detail(req.params.id, m.role));
}));

router.patch('/:id', wrap(async (req, res) => {
  const m = await access(req.ctx!.user!.id, req.params.id, ['OWNER', 'ADMIN']);
  const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
  await prisma.project.update({ where: { id: req.params.id }, data: { name } });
  res.json(await detail(req.params.id, m.role));
}));

// Apaga o projeto e todos os dados dele (visitas, eventos, sessões, tokens)
router.delete('/:id', wrap(async (req, res) => {
  await access(req.ctx!.user!.id, req.params.id, ['OWNER']);
  const tokens = await prisma.token.findMany({ where: { projectId: req.params.id } });
  await prisma.project.delete({ where: { id: req.params.id } });
  tokens.forEach((t) => invalidateToken(t.value));
  res.json({ ok: true });
}));

// Troca um token: o antigo para de valer na hora (vazou, ou a pessoa saiu do time)
router.post('/:id/tokens', wrap(async (req, res) => {
  const m = await access(req.ctx!.user!.id, req.params.id, ['OWNER', 'ADMIN']);
  const { type } = z.object({ type: z.enum(['INGEST', 'QUERY']) }).parse(req.body);
  const old = await prisma.token.findMany({ where: { projectId: req.params.id, type, revokedAt: null } });
  await prisma.$transaction([
    prisma.token.updateMany({ where: { projectId: req.params.id, type, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.token.create({ data: { projectId: req.params.id, type, value: newToken(type) } })
  ]);
  old.forEach((t) => invalidateToken(t.value));
  res.json(await detail(req.params.id, m.role));
}));

router.post('/:id/domains', wrap(async (req, res) => {
  const m = await access(req.ctx!.user!.id, req.params.id, ['OWNER', 'ADMIN']);
  const { name } = z.object({ name: z.string().max(253) }).parse(req.body);
  const host = hostOf(name);
  if (!host || (!host.includes('.') && host !== 'localhost')) throw new HttpError(400, 'Domínio inválido. Ex.: meusite.com.br');
  await prisma.domain.upsert({ where: { projectId_name: { projectId: req.params.id, name: host } }, update: {}, create: { projectId: req.params.id, name: host } });
  await invalidateProject(req.params.id);
  res.status(201).json(await detail(req.params.id, m.role));
}));

router.delete('/:id/domains/:domainId', wrap(async (req, res) => {
  const m = await access(req.ctx!.user!.id, req.params.id, ['OWNER', 'ADMIN']);
  await prisma.domain.deleteMany({ where: { id: req.params.domainId, projectId: req.params.id } });
  await invalidateProject(req.params.id);
  res.json(await detail(req.params.id, m.role));
}));

// ---------- Membros ----------
// VIEWER só lê relatórios; MEMBER também vê a instalação; ADMIN gerencia tokens, domínios e membros (não admins);
// OWNER faz tudo, inclusive promover a admin e apagar o projeto. O dono não pode ser removido nem rebaixado.
const memberView = (m: { role: Role; createdAt: Date; user: { id: string; email: string; name: string | null } }) => ({
  userId: m.user.id,
  email: m.user.email,
  name: m.user.name,
  role: m.role,
  since: m.createdAt
});
const ASSIGNABLE = z.enum(['ADMIN', 'MEMBER', 'VIEWER']);
const listMembers = async (projectId: string) =>
  (await prisma.projectUser.findMany({ where: { projectId }, include: { user: true }, orderBy: { createdAt: 'asc' } })).map(memberView);

router.get('/:id/members', wrap(async (req, res) => {
  await access(req.ctx!.user!.id, req.params.id);
  res.json(await listMembers(req.params.id));
}));

// Adiciona por e-mail. Sem conta ainda: cria com senha provisória, devolvida só nesta resposta (a instalação não manda
// e-mail). Assim o dono monta a equipe mesmo com o cadastro público fechado.
router.post('/:id/members', wrap(async (req, res) => {
  const me = await access(req.ctx!.user!.id, req.params.id, ['OWNER', 'ADMIN']);
  const { email, role } = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: ASSIGNABLE.default('VIEWER') }).parse(req.body);
  if (role === 'ADMIN' && me.role !== 'OWNER') throw new HttpError(403, 'Só o dono pode adicionar admins');

  let user = await prisma.user.findUnique({ where: { email } });
  let tempPassword: string | null = null;
  if (!user) {
    tempPassword = randomBytes(9).toString('base64url');
    user = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(tempPassword, 12) } });
  }
  const exists = await prisma.projectUser.findUnique({ where: { userId_projectId: { userId: user.id, projectId: req.params.id } } });
  if (exists) throw new HttpError(409, 'Esta pessoa já é membro do projeto');
  await prisma.projectUser.create({ data: { userId: user.id, projectId: req.params.id, role } });
  res.status(201).json({ members: await listMembers(req.params.id), tempPassword });
}));

router.patch('/:id/members/:userId', wrap(async (req, res) => {
  await access(req.ctx!.user!.id, req.params.id, ['OWNER']);
  const { role } = z.object({ role: ASSIGNABLE }).parse(req.body);
  const target = await access(req.params.userId, req.params.id);
  if (target.role === 'OWNER') throw new HttpError(400, 'O dono não pode mudar de papel');
  await prisma.projectUser.update({ where: { id: target.id }, data: { role } });
  res.json(await listMembers(req.params.id));
}));

// Remove alguém (dono e admin) ou sai do projeto (qualquer membro, menos o dono)
router.delete('/:id/members/:userId', wrap(async (req, res) => {
  const meId = req.ctx!.user!.id;
  const me = await access(meId, req.params.id);
  const target = await access(req.params.userId, req.params.id);
  const self = req.params.userId === meId;
  if (target.role === 'OWNER') throw new HttpError(400, 'O dono não pode sair nem ser removido. Para encerrar, apague o projeto.');
  if (!self && me.role !== 'OWNER' && !(me.role === 'ADMIN' && target.role !== 'ADMIN')) throw new HttpError(403, 'Seu papel neste projeto não permite remover esta pessoa');
  await prisma.projectUser.delete({ where: { id: target.id } });
  res.json(self ? { left: true } : await listMembers(req.params.id));
}));

// A ingestão guarda token e domínios em cache: mudou um domínio, o cache do projeto cai
const invalidateProject = async (projectId: string) => {
  const tokens = await prisma.token.findMany({ where: { projectId } });
  tokens.forEach((t) => invalidateToken(t.value));
};

export default router;
