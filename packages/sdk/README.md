# @hhartur/analytics

SDK de analytics para a **sua própria instalação** do hh-analytics. Os eventos vão só para o endpoint que você configura: sem servidor central, sem cookies, sem dado pessoal.

- Pageviews automáticos, inclusive em SPA (React, Vue, Next, etc.)
- Eventos personalizados com propriedades
- Visitante e sessão anônimos (id aleatório no `localStorage`, sessão de 30 min)
- Origem de tráfego e UTM
- Fila offline: sem rede, os eventos esperam e são reenviados
- Envia o que falta ao fechar a página (`sendBeacon`)
- Ignora robôs e navegadores automatizados
- Seguro em SSR (no servidor não faz nada)
- ~2 KB gzip, sem dependências, tipos TypeScript inclusos

## Instalação

```bash
npm install @hhartur/analytics
```

## Uso

```ts
import { analytics } from '@hhartur/analytics';

analytics.init({
  endpoint: 'https://analytics.seusite.com/api', // a API da sua instalação
  token: 'TOKEN_DE_INGESTAO'                       // painel > projeto > token de ingestão
});

analytics.track('cadastro', { plano: 'pro' });
```

### Sem bundler (tag `<script>`)

```html
<script
  src="https://unpkg.com/@hhartur/analytics/dist/hh-analytics.min.js"
  data-endpoint="https://analytics.seusite.com/api"
  data-token="TOKEN_DE_INGESTAO"
  defer
></script>
<script>
  // depois de carregado: window.hhAnalytics.track('clique', { botao: 'comprar' })
</script>
```

## API

| Função | O que faz |
|---|---|
| `analytics.init(options)` | Liga o envio. Chamar de novo só troca a configuração. |
| `analytics.pageview(path?)` | Conta uma visita (sem argumento, a página atual). Use com `trackPageviews: false` para controlar na mão. |
| `analytics.track(name, properties?)` | Evento personalizado. Propriedades: texto, número, booleano ou `null`. |
| `analytics.flush()` | Envia agora o que estiver na fila. |
| `new Analytics()` | Outra instância, para mandar para dois projetos ao mesmo tempo. |

### Opções de `init`

| Opção | Padrão | Descrição |
|---|---|---|
| `endpoint` | — | URL base da API (ex.: `https://analytics.seusite.com/api`). Obrigatória. |
| `token` | — | Token de ingestão do projeto. Obrigatório. É público: só serve para enviar eventos. |
| `trackPageviews` | `true` | Conta pageviews sozinho, inclusive mudanças de rota em SPA. |
| `respectDoNotTrack` | `false` | Não envia nada se o navegador pedir "Do Not Track". |
| `debug` | `false` | Mostra no console os lotes enviados e as falhas. |

## O que é enviado

`POST {endpoint}/collect` com `Content-Type: text/plain` (não dispara preflight de CORS) e o corpo:

```json
{
  "token": "TOKEN_DE_INGESTAO",
  "events": [
    {
      "type": "pageview",
      "timestamp": 1793400000000,
      "visitorId": "uuid aleatório",
      "sessionId": "uuid aleatório",
      "path": "/produtos?id=7",
      "title": "Produto 7",
      "url": "https://seusite.com/produtos?id=7",
      "referrer": "https://google.com/",
      "utm": { "source": "google", "campaign": "natal" },
      "screen": "1920x1080",
      "language": "pt-BR"
    }
  ]
}
```

Navegador, sistema e tipo de aparelho são lidos no servidor a partir do `User-Agent`; o IP não é guardado.

## Servidor

A API, o banco e o painel ficam em [github.com/hhartur/hh-analytics](https://github.com/hhartur/hh-analytics) e sobem com `docker compose up -d`.

## Licença

MIT
