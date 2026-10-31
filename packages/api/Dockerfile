# API + painel do hh-analytics. Build a partir da raiz do repositório (usa o package-lock.json do monorepo):
#   docker build -f packages/api/Dockerfile .
FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/sdk/package.json packages/sdk/
RUN npm ci -w @hh-analytics/api --include-workspace-root=false --no-audit --no-fund
COPY packages/api packages/api
RUN npm run build -w @hh-analytics/api

FROM node:20-alpine
# Prisma precisa do openssl no Alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/sdk/package.json packages/sdk/
RUN npm ci -w @hh-analytics/api --include-workspace-root=false --omit=dev --no-audit --no-fund && npm cache clean --force
COPY packages/api/prisma packages/api/prisma
RUN cd packages/api && npx prisma generate
COPY --from=build /app/packages/api/dist packages/api/dist
COPY packages/api/public packages/api/public
WORKDIR /app/packages/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
# Aplica as migrações pendentes (prisma/migrations, em ordem; nunca apaga dados por conta própria) e sobe a API
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/index.js"]
