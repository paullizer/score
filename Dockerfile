FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY scripts/verify-installations.mjs ./scripts/
COPY scripts/security ./scripts/security
RUN node scripts/verify-installations.mjs && npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build
RUN node --input-type=module -e "import { accessSync } from 'node:fs'; for (const file of ['word-parser.mjs', 'telemetry.mjs']) accessSync('dist-server/' + file)"

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package.json package-lock.json .npmrc ./
COPY scripts/verify-installations.mjs ./scripts/
COPY scripts/security ./scripts/security
RUN node scripts/verify-installations.mjs && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
USER node
EXPOSE 8080
CMD ["node", "--import", "@azure/monitor-opentelemetry/loader", "--import", "./dist-server/telemetry.mjs", "dist-server/server.mjs"]
