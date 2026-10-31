// Versão <script>: expõe window.hhAnalytics e inicia sozinha se a tag tiver data-endpoint e data-token.
// <script src="hh-analytics.min.js" data-endpoint="https://analytics.seusite.com/api" data-token="..." defer></script>
import { analytics } from './client';

declare global {
  interface Window {
    hhAnalytics: typeof analytics;
  }
}

window.hhAnalytics = analytics;
const tag = document.currentScript as HTMLScriptElement | null;
if (tag?.dataset.endpoint && tag.dataset.token) {
  analytics.init({ endpoint: tag.dataset.endpoint, token: tag.dataset.token, debug: tag.dataset.debug === 'true' });
}
