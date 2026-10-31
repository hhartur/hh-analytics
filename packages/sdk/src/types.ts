export interface InitOptions {
  /** URL base da API da sua instalação, ex.: https://analytics.seusite.com/api */
  endpoint: string;
  /** Token de ingestão do projeto (público: só serve para enviar eventos) */
  token: string;
  /** Conta pageviews sozinho, inclusive em SPA (pushState/popstate). Padrão: true */
  trackPageviews?: boolean;
  /** Não envia nada se o navegador pedir "Do Not Track". Padrão: false */
  respectDoNotTrack?: boolean;
  /** Mostra no console o que seria enviado. Padrão: false */
  debug?: boolean;
}

export type Properties = Record<string, string | number | boolean | null>;

/** Um item do lote enviado para POST {endpoint}/collect */
export interface CollectedEvent {
  /** Id único do evento: se o mesmo lote chegar duas vezes (rede caiu no meio, página fechou), o servidor ignora a cópia */
  id: string;
  type: 'pageview' | 'event';
  name?: string;
  timestamp: number;
  visitorId: string;
  sessionId: string;
  path: string;
  title: string;
  url: string;
  referrer: string;
  utm: Record<string, string>;
  screen: string;
  language: string;
  properties?: Properties;
}

/** Corpo de POST {endpoint}/collect */
export interface CollectBody {
  token: string;
  events: CollectedEvent[];
}
