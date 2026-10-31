import rateLimit from 'express-rate-limit';

// Limites por IP. Atrás de proxy, defina TRUST_PROXY para o IP real chegar aqui.
const limiter = (windowMs: number, limit: number, message: string) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: message } });

export const loginLimiter = limiter(15 * 60_000, 20, 'Muitas tentativas. Aguarde alguns minutos.');
export const collectLimiter = limiter(60_000, 1200, 'Eventos demais deste endereço. Aguarde um minuto.');
export const apiLimiter = limiter(60_000, 600, 'Requisições demais. Aguarde um minuto.');
