import { createHash } from 'crypto';
import type { Project, User } from '@prisma/client';
import { prisma } from '../db';
import { HttpError, wrap } from '../http';

export type Ctx = { user?: User; project?: Project; via: 'admin' | 'query' };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: Ctx;
    }
  }
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const bearer = (header?: string) => header?.match(/^Bearer\s+(\S+)$/i)?.[1];

const sessionUser = async (token: string) => {
  const session = await prisma.adminSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  return session && session.expiresAt > new Date() ? session.user : null;
};

// Rotas do painel: só sessão de usuário logado
export const requireAdmin = wrap(async (req, _res, next) => {
  const token = bearer(req.headers.authorization);
  const user = token ? await sessionUser(token) : null;
  if (!user) throw new HttpError(401, 'Faça login para continuar');
  req.ctx = { user, via: 'admin' };
  next();
});

// Relatórios de um projeto: sessão de quem é membro dele, ou token QUERY do próprio projeto.
// Projeto de outra pessoa responde 404 (não revela se existe).
export const requireProjectRead = wrap(async (req, _res, next) => {
  const token = bearer(req.headers.authorization);
  if (!token) throw new HttpError(401, 'Token necessário');
  const projectId = req.params.projectId;

  const user = await sessionUser(token);
  if (user) {
    const member = await prisma.projectUser.findUnique({ where: { userId_projectId: { userId: user.id, projectId } }, include: { project: true } });
    if (!member) throw new HttpError(404, 'Projeto não encontrado');
    req.ctx = { user, project: member.project, via: 'admin' };
    return next();
  }

  const tok = await prisma.token.findUnique({ where: { value: token }, include: { project: true } });
  if (!tok || tok.revokedAt || tok.type !== 'QUERY') throw new HttpError(401, 'Token inválido ou revogado');
  if (tok.projectId !== projectId) throw new HttpError(404, 'Projeto não encontrado');
  req.ctx = { project: tok.project, via: 'query' };
  next();
});
