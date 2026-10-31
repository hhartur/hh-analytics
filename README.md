# hh-analytics

Analytics auto-hospedado, no estilo Plausible/Umami, **sem servidor central**: cada instalação tem a própria API, o próprio banco e o próprio painel. Os eventos vão só para o endpoint que o dono configura. Sem cookies e sem guardar IP.

- **SDK** (`@hh./analytics` no npm): pageviews automáticos (inclusive SPA), eventos personalizados, UTM, origem, fila offline e envio ao fechar a página. ~2 KB gzip.
- **API + painel** (Docker): ingestão, relatórios e um painel web servido pela própria API.

```
hh-analytics/
├── docker-compose.yml        # PostgreSQL + API/painel
├── .env.example
└── packages/
    ├── sdk/                  # pacote npm "@hh./analytics" (TypeScript, esbuild)
    │   ├── src/              # client, fila offline, utilitários, tipos, versão <script>
    │   └── test/             # testes num navegador simulado (node:test)
    └── api/                  # Express + Prisma + PostgreSQL
        ├── prisma/           # schema e migrações (aplicadas sozinhas ao subir)
        ├── public/           # painel (HTML + JS, sem build)
        ├── src/              # rotas: auth, projects, collect, reports
        └── test/             # testes de integração contra a API real
```

## Subir uma instalação

Precisa de Docker.

```bash
cp .env.example .env      # troque POSTGRES_PASSWORD
docker compose up -d --build
```

Abra http://localhost:4000. No primeiro acesso você cria a conta de dono; depois disso o cadastro fecha (`ALLOW_REGISTER=true` abre). Crie um projeto e copie o token de ingestão.

Em produção, coloque um proxy com HTTPS na frente (Caddy, Nginx) e defina `TRUST_PROXY=1`. A porta escuta só em `127.0.0.1` por padrão (`BIND_ADDRESS`): o Docker ignora o firewall da máquina, então expor direto deixaria a API aberta sem HTTPS.

O painel funciona também num subcaminho de outro site (ex.: `https://meusite.com/admin/analytics/`): basta o proxy repassar esse caminho sem o prefixo. Com Caddy:

```
redir /admin/analytics /admin/analytics/ 308
handle_path /admin/analytics/* {
	reverse_proxy 127.0.0.1:4000
}
```

O SDK usa então `endpoint: 'https://meusite.com/admin/analytics/api'`.

### Variáveis (`.env`)

| Variável | Padrão | Para quê |
|---|---|---|
| `POSTGRES_PASSWORD` | — | Senha do banco. Obrigatória. |
| `POSTGRES_DB`, `POSTGRES_USER` | `analytics` | Nome do banco e usuário. |
| `PORT` | `4000` | Porta da API e do painel. |
| `BIND_ADDRESS` | `127.0.0.1` | Interface da porta. `0.0.0.0` expõe para a rede (só sem proxy na frente). |
| `TRUST_PROXY` | vazio | Proxies na frente da API, para os limites por IP verem o IP real. |
| `ALLOW_REGISTER` | `false` | `true` deixa qualquer pessoa criar conta. |
| `RETENTION_DAYS` | `0` | Apaga visitas e eventos com mais de N dias (0 = guarda tudo). |
| `CORS_ORIGIN` | vazio | Outras origens que podem usar a API do painel (o painel já é servido pela API). |
| `DASHBOARD` | `on` | `off` desliga o painel e deixa só a API. |
| `DASHBOARD_DIR` | vazio | Pasta de um painel próprio, servido no lugar do padrão (veja abaixo). |

### Painel próprio

O painel que vem junto (preto e azul, HTML+JS sem build) é só o padrão. Para usar outro, gere o build estático dele (uma pasta com `index.html`), monte no container e aponte `DASHBOARD_DIR`:

```yaml
# docker-compose.override.yml
services:
  api:
    volumes:
      - ./meu-painel/dist:/painel:ro
    environment:
      DASHBOARD_DIR: /painel
```

A API serve os arquivos e devolve o `index.html` em qualquer rota (SPA). O painel próprio usa as mesmas rotas `/api` deste README, na mesma origem.

### Equipe

Dono e admins adicionam pessoas em **Instalação e ajustes > Membros**, pelo e-mail. Se a pessoa ainda não tem conta, ela é criada com uma senha provisória mostrada uma vez só (a instalação não manda e-mail); a pessoa troca em **Minha conta**. Assim dá para ter equipe com o cadastro público fechado.

| Papel | Pode |
|---|---|
| Leitor | Ver os relatórios |
| Membro | Também ver a instalação e o token de ingestão |
| Admin | Também gerenciar tokens, domínios e membros (exceto admins) |
| Dono | Tudo, inclusive promover a admin e apagar o projeto. Não sai nem é removido. |

## Instalar no site

```bash
npm install @hh./analytics
```

```ts
import { analytics } from '@hh./analytics';

analytics.init({ endpoint: 'https://analytics.seusite.com/api', token: 'TOKEN_DE_INGESTAO' });
analytics.track('cadastro', { plano: 'pro' });
```

Ou sem bundler:

```html
<script src="https://unpkg.com/@hh./analytics/dist/hh-analytics.min.js"
  data-endpoint="https://analytics.seusite.com/api" data-token="TOKEN_DE_INGESTAO" defer></script>
```

O painel mostra os dois trechos já preenchidos. Detalhes do SDK em [packages/sdk/README.md](packages/sdk/README.md).

## API

Todas as rotas ficam em `/api`. As do painel usam `Authorization: Bearer <token da sessão>`.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/health` | Saúde da API e do banco |
| GET | `/auth/status` | Se a instalação ainda não tem dono (`setup`) e se o cadastro está aberto |
| POST | `/auth/register` | `{ email, password, name? }`. Só o primeiro usuário, salvo `ALLOW_REGISTER=true` |
| POST | `/auth/login` | `{ email, password }`. Devolve o token da sessão (30 dias) |
| POST | `/auth/logout` | Encerra a sessão |
| GET | `/auth/me` | Usuário logado |
| POST | `/auth/password` | `{ current, next }`. Troca a senha e encerra as outras sessões |
| GET / POST | `/projects` | Lista / cria (`{ name }`). O projeto nasce com token de ingestão e de consulta |
| GET / PATCH / DELETE | `/projects/:id` | Detalhe (tokens e domínios) / renomeia / apaga com todos os dados |
| POST | `/projects/:id/tokens` | `{ type: "INGEST" \| "QUERY" }`. Troca o token; o antigo para na hora |
| POST / DELETE | `/projects/:id/domains[/:domainId]` | Domínios permitidos para enviar eventos |
| GET / POST | `/projects/:id/members` | Lista / adiciona `{ email, role }` (cria a conta com senha provisória se não existir) |
| PATCH / DELETE | `/projects/:id/members/:userId` | Muda o papel (dono) / remove ou sai do projeto |
| POST | `/collect` | Ingestão (usada pelo SDK). Token no corpo ou em `Authorization` |
| GET | `/reports/:projectId/{summary,timeseries,pages,referrers,utm,events,browsers,os,devices,countries,realtime}` | Relatórios. Aceitam `range` (24h, 7d, 30d, 90d, 365d) ou `from`/`to` (AAAA-MM-DD), `tz` e `limit` |

Relatórios aceitam a sessão de um membro do projeto ou o **token de consulta** do projeto (secreto, para integrações):

```bash
curl -H "Authorization: Bearer hhq_..." "https://analytics.seusite.com/api/reports/<projectId>/summary?range=30d"
```

## Segurança e privacidade

- **Visitante:** anônimo, identificado por um id aleatório no `localStorage`. Sem cookie, e o IP não é guardado. Navegador, sistema e aparelho saem do User-Agent. O país só aparece se o proxy mandar o cabeçalho (`cf-ipcountry`).
- **Token de ingestão:** é público, só envia eventos. Com domínios cadastrados, só esses sites conseguem enviar.
- **Token de consulta:** é secreto e lê só o próprio projeto.
- **Isolamento entre projetos:** quem não é membro recebe 404.
- **Sessões do painel:** guardadas como hash. Senhas com bcrypt.
- **Limites por IP:** valem no login, no cadastro, na ingestão e no resto da API.
- **Painel:** usa CSP restritiva, e dados vindos da ingestão nunca viram HTML.
- **Eventos repetidos:** cada evento tem um id, e um lote reenviado (rede caiu, página fechou) não conta duas vezes.

## Desenvolvimento

```bash
npm install
npm run build            # SDK + API
npm test                 # testes do SDK
npm run typecheck
```

Testes de integração precisam de uma API com banco vazio e cadastro aberto. Dá para subir uma instância descartável ao lado da principal:

```bash
POSTGRES_PASSWORD=teste PORT=4100 DB_PORT=5433 ALLOW_REGISTER=true docker compose -p hh-analytics-teste up -d --build
API_URL=http://localhost:4100 npm run test:api
docker compose -p hh-analytics-teste down -v
```

Mudou o schema (`packages/api/prisma/schema.prisma`)? Gere a migração com o banco local no ar e versione a pasta `prisma/migrations`:

```bash
cd packages/api && DATABASE_URL=postgresql://analytics:SENHA@localhost:5432/analytics npx prisma migrate dev --name descricao
```

## Publicar o SDK no npm

```bash
cd packages/sdk
npm login
npm publish          # roda typecheck, build e testes antes (prepublishOnly)
```

## Licença

MIT
