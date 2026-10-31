// Tudo aqui é seguro fora do navegador (SSR): sem window, as funções devolvem vazio.
export const isBrowser = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';

// Safari em modo privado e navegadores com cookies bloqueados lançam erro ao usar o storage
const read = (store: 'localStorage' | 'sessionStorage', key: string): string | null => {
  try {
    return window[store].getItem(key);
  } catch {
    return null;
  }
};
const write = (store: 'localStorage' | 'sessionStorage', key: string, value: string): void => {
  try {
    window[store].setItem(key, value);
  } catch {
    /* sem storage: os ids valem só para esta página */
  }
};
export const storage = { read, write };

export const uuid = (): string => {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const VID_KEY = 'hh:vid';
const SID_KEY = 'hh:sid';
export const SESSION_IDLE_MS = 30 * 60_000;

// Visitante anônimo: um id aleatório guardado no navegador (sem cookie, sem dado pessoal)
export const getVisitorId = (): string => {
  let id = read('localStorage', VID_KEY);
  if (!id) {
    id = uuid();
    write('localStorage', VID_KEY, id);
  }
  return id;
};

// Sessão: a mesma em todas as abas até 30 min sem atividade
export const getSessionId = (now = Date.now()): string => {
  let saved: { id: string; last: number } | null = null;
  try {
    saved = JSON.parse(read('localStorage', SID_KEY) || 'null');
  } catch {
    saved = null;
  }
  const id = saved && typeof saved.id === 'string' && now - saved.last < SESSION_IDLE_MS ? saved.id : uuid();
  write('localStorage', SID_KEY, JSON.stringify({ id, last: now }));
  return id;
};

export const getUtm = (search: string): Record<string, string> => {
  const utm: Record<string, string> = {};
  const params = new URLSearchParams(search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const value = params.get(key);
    if (value) utm[key.slice(4)] = value.slice(0, 200);
  }
  return utm;
};

// Só origem externa: navegação dentro do próprio site não é "origem de tráfego"
export const getReferrer = (): string => {
  const ref = document.referrer;
  if (!ref) return '';
  try {
    return new URL(ref).hostname === location.hostname ? '' : ref;
  } catch {
    return '';
  }
};

export const isBot = (): boolean =>
  Boolean((navigator as Navigator & { webdriver?: boolean }).webdriver) ||
  /bot|crawler|spider|crawl|slurp|headless|lighthouse|pingdom|uptime|monitor|preview/i.test(navigator.userAgent);

export const doNotTrack = (): boolean => {
  const n = navigator as Navigator & { msDoNotTrack?: string };
  const w = window as Window & { doNotTrack?: string };
  return [n.doNotTrack, n.msDoNotTrack, w.doNotTrack].some((v) => v === '1' || v === 'yes');
};
