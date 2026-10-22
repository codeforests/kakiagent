# syntax=docker/dockerfile:1.10
# One image per Node runtime role (ADR-001, ADR-003):
#   docker build --build-arg ROLE=api -t kaki/api .
# ROLE is one of api, realtime, agent-worker, ingest-worker, scheduler-worker.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG ROLE
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@kaki/${ROLE}
# The bundle keeps npm packages external; a hoisted production install lets
# dist/main.js resolve the dependencies of the bundled @kaki/* packages too.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @kaki/${ROLE} deploy --prod --legacy --config.node-linker=hoisted /out

FROM ${NODE_IMAGE} AS runtime
ARG ROLE
ENV NODE_ENV=production
# Take Debian security fixes newer than the base image, and drop the package
# managers bundled with Node: the runtime never installs anything, and their
# own dependencies carry CVEs the image scan would report.
RUN apt-get update --error-on=any \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
# ingest-worker crawls with Chromium (FEAT-012 D3): playwright-core's headless shell,
# the exact build its version drives, with the shared libraries it needs.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$ROLE" = "ingest-worker" ]; then \
      node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
      && rm -rf /var/lib/apt/lists/*; \
    fi
USER node
LABEL org.opencontainers.image.source="https://github.com/codeforests/kakiagent" \
      org.opencontainers.image.title="kakiagent-${ROLE}"
CMD ["node", "--enable-source-maps", "dist/main.js"]
