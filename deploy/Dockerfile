# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.tooling.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/extractor/package.json packages/extractor/package.json
COPY packages/retrieval/package.json packages/retrieval/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/devin-plugin/package.json packages/devin-plugin/package.json
COPY packages/opencode-plugin/package.json packages/opencode-plugin/package.json
COPY packages/adapters/generic/package.json packages/adapters/generic/package.json
COPY packages/adapters/codex/package.json packages/adapters/codex/package.json
COPY packages/adapters/claude/package.json packages/adapters/claude/package.json
COPY packages/adapters/devin/package.json packages/adapters/devin/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM dependencies AS api-build

COPY apps apps
COPY packages packages

RUN pnpm --filter "@lore-co/api..." --recursive run build \
  && pnpm --filter @lore-co/api deploy --prod --legacy /out/api

FROM dependencies AS web-build

COPY apps apps
COPY packages packages

RUN pnpm --filter "@lore-co/web..." --recursive run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production

RUN apk add --no-cache dumb-init

WORKDIR /app

ENTRYPOINT ["dumb-init", "--"]

FROM runtime AS api

ENV API_HOST=0.0.0.0
ENV API_PORT=3001

COPY --from=api-build --chown=node:node /out/api ./

RUN printf '%s\n' '#!/bin/sh' 'exec node /app/dist/auth/mint-password-reset.js "$@"' \
  > /usr/local/bin/lore-reset-password \
  && chmod 0555 /usr/local/bin/lore-reset-password

USER node

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3001/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]

FROM runtime AS web

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000

COPY --from=web-build --chown=node:node /app/apps/web/.output ./.output

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
