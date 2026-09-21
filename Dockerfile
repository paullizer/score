FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV VITE_DEPLOYMENT_MODE=cloud
RUN npm run build
RUN node --input-type=module -e "import { accessSync } from 'node:fs'; for (const file of ['word-parser.mjs', 'telemetry.mjs']) accessSync('dist-server/' + file)"

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
USER node
EXPOSE 8080
CMD ["node", "--import", "@azure/monitor-opentelemetry/loader", "--import", "./dist-server/telemetry.mjs", "dist-server/server.mjs"]
