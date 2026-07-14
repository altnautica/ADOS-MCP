# Fleet-mode container. Coolify auto-deploys from this Dockerfile on push; the
# service is fronted by a Cloudflare tunnel. Convex and MQTT targets are injected
# as environment variables at runtime; no secret is baked into the image.
FROM node:22-alpine AS builder
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
COPY vendor/ vendor/
RUN pnpm build

FROM node:22-alpine
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NODE_ENV=production
ENV ADOS_MCP_HTTP_PORT=8091
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist/ dist/
COPY vendor/ vendor/
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${ADOS_MCP_HTTP_PORT}/healthz" >/dev/null 2>&1 || exit 1
USER node
CMD ["node", "dist/index.js", "--target", "fleet"]
