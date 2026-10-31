import { EventQueue } from './queue';
import type { CollectBody, CollectedEvent, InitOptions, Properties } from './types';
import { doNotTrack, getReferrer, getSessionId, getUtm, getVisitorId, isBot, isBrowser, uuid } from './utils';

const FLUSH_DELAY_MS = 1000; // junta eventos próximos num lote só
const RETRY_MS = 15_000;

export class Analytics {
  private config: Required<Omit<InitOptions, 'debug'>> & { debug: boolean } = {
    endpoint: '',
    token: '',
    trackPageviews: true,
    respectDoNotTrack: false,
    debug: false
  };
  private queue: EventQueue | null = null;
  private enabled = false;
  private lastPage = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;

  /** Liga o envio. Chamar de novo só troca a configuração. Fora do navegador (SSR) não faz nada. */
  init(options: InitOptions): void {
    if (!isBrowser()) return;
    if (!options?.endpoint || !options?.token) {
      console.warn('[hh-analytics] init precisa de endpoint e token');
      return;
    }
    const first = !this.queue;
    this.config = {
      endpoint: options.endpoint.replace(/\/+$/, ''),
      token: options.token,
      trackPageviews: options.trackPageviews !== false,
      respectDoNotTrack: Boolean(options.respectDoNotTrack),
      debug: Boolean(options.debug)
    };
    this.enabled = !isBot() && !(this.config.respectDoNotTrack && doNotTrack());
    if (!this.enabled || !first) return;

    this.queue = new EventQueue();
    this.listen();
    if (this.config.trackPageviews) this.pageview();
    if (this.queue.size) this.schedule();
  }

  /** Conta uma visita. Sem argumento, usa a página atual. */
  pageview(path?: string): void {
    if (!this.enabled) return;
    const current = path ?? location.pathname + location.search;
    this.lastPage = current;
    this.enqueue('pageview', undefined, undefined, current);
  }

  /** Evento personalizado, ex.: track('cadastro', { plano: 'pro' }) */
  track(name: string, properties?: Properties): void {
    if (!this.enabled || !name) return;
    this.enqueue('event', String(name).slice(0, 120), properties);
  }

  /** Envia o que estiver na fila agora. `beacon`: saindo da página (sendBeacon quando o endpoint é do próprio site). */
  async flush(beacon = false): Promise<void> {
    if (!this.queue || this.sending || !this.queue.size) return;
    const batch = this.queue.take();
    const body: CollectBody = { token: this.config.token, events: batch };
    // Não usa /collect: a EasyPrivacy (Brave, uBlock, AdBlock) bloqueia "/api/collect"
    const url = `${this.config.endpoint}/e`;
    const payload = JSON.stringify(body);
    if (this.config.debug) console.debug('[hh-analytics]', body);

    // text/plain não dispara preflight de CORS e é o que o sendBeacon consegue mandar.
    // sendBeacon para outro domínio cai na regra "*$ping,third-party" dos bloqueadores, que descartam sem avisar:
    // nesse caso vai por fetch keepalive, que também termina depois de a página fechar.
    if (beacon && typeof navigator.sendBeacon === 'function' && new URL(url, location.href).origin === location.origin) {
      if (navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }))) return;
    }
    this.sending = true;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: payload, keepalive: true });
      // 4xx é erro nosso (token, formato): reenviar não resolve. 5xx e rede voltam para a fila.
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok && this.config.debug) console.warn('[hh-analytics] recusado', res.status);
    } catch (err) {
      this.queue.putBack(batch);
      if (this.config.debug) console.warn('[hh-analytics] envio falhou, tento de novo depois', err);
      this.schedule(RETRY_MS);
    } finally {
      this.sending = false;
    }
    if (this.queue.size && !this.timer) this.schedule();
  }

  private enqueue(type: CollectedEvent['type'], name?: string, properties?: Properties, path?: string): void {
    if (!this.queue) return;
    const event: CollectedEvent = {
      id: uuid(),
      type,
      timestamp: Date.now(),
      visitorId: getVisitorId(),
      sessionId: getSessionId(),
      path: (path ?? location.pathname + location.search).slice(0, 500),
      title: document.title.slice(0, 300),
      url: location.href.slice(0, 1000),
      referrer: getReferrer().slice(0, 500),
      utm: getUtm(location.search),
      screen: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
      language: navigator.language || ''
    };
    if (name) event.name = name;
    if (properties && typeof properties === 'object') event.properties = properties;
    this.queue.push(event);
    this.schedule();
  }

  private schedule(delay = FLUSH_DELAY_MS): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, delay);
  }

  private listen(): void {
    // SPA: conta visita quando o caminho muda (replaceState para rolagem ou estado não conta)
    const onRoute = () => {
      if (!this.config.trackPageviews) return;
      const current = location.pathname + location.search;
      if (current !== this.lastPage) this.pageview(current);
    };
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        onRoute();
        return result;
      };
    }
    window.addEventListener('popstate', onRoute);
    // Saindo da página ou trocando de aba: manda o que falta
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush(true).catch(() => {});
    });
    window.addEventListener('pagehide', () => this.flush(true).catch(() => {}));
    window.addEventListener('online', () => this.flush().catch(() => {}));
  }
}

/** Instância pronta para usar: analytics.init({ endpoint, token }) */
export const analytics = new Analytics();
