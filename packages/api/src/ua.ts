// Leitura simples do User-Agent no servidor: navegador, sistema e tipo de aparelho (o SDK não manda isso).
export interface Agent {
  browser: string | null;
  os: string | null;
  device: 'desktop' | 'mobile' | 'tablet';
  bot: boolean;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/edg(e|a|ios)?\//i, 'Edge'],
  [/opr\/|opera/i, 'Opera'],
  [/samsungbrowser/i, 'Samsung Internet'],
  [/firefox|fxios/i, 'Firefox'],
  [/chrome|crios|chromium/i, 'Chrome'],
  [/safari/i, 'Safari']
];
const SYSTEMS: Array<[RegExp, string]> = [
  [/windows/i, 'Windows'],
  [/iphone|ipad|ipod/i, 'iOS'],
  [/android/i, 'Android'],
  [/mac os x|macintosh/i, 'macOS'],
  [/cros/i, 'ChromeOS'],
  [/linux/i, 'Linux']
];

export const parseAgent = (ua = ''): Agent => ({
  browser: BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null,
  os: SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null,
  device: /ipad|tablet|(android(?!.*mobile))/i.test(ua) ? 'tablet' : /mobi|iphone|ipod|android/i.test(ua) ? 'mobile' : 'desktop',
  bot: !ua || /bot|crawler|spider|crawl|slurp|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|axios|node-fetch/i.test(ua)
});
