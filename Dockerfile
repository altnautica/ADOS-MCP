# syntax=docker/dockerfile:1
# ADOS MCP container image. An MCP client launches it over stdio
# (`docker run -i --rm IMAGE --target agent <host>`), or it runs as a
# Streamable HTTP service (`--transport http`). No secret is baked in.
#
# Targets: `runtime` (the default, last stage) is the published image; `dev`
# is the contributor toolchain that compose.yaml and the devcontainer use.

ARG NODE_IMAGE=node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack install -g pnpm@10.28.1 && chmod -R a+rX /usr/local/share/corepack
WORKDIR /app
COPY package.json pnpm-lock.yaml ./

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

# Built for the target platform, never $BUILDPLATFORM: a production dependency
# pulls per-architecture native binaries.
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod

FROM base AS dev
RUN mkdir -p /home/node/.ados/mcp /app/node_modules && chown -R node:node /home/node/.ados /app
ENV HOME=/home/node
USER node
CMD ["sh"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOME=/home/node
LABEL org.opencontainers.image.source="https://github.com/altnautica/ADOS-MCP" \
      org.opencontainers.image.description="Model Context Protocol server for the ADOS drone platform" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# src/version.ts reads ../package.json at runtime.
COPY package.json ./
COPY --from=prod-deps /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY vendor/ vendor/
RUN mkdir -p /home/node/.ados/mcp && chown -R node:node /home/node/.ados && chmod 700 /home/node/.ados/mcp
USER node
EXPOSE 8091
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
