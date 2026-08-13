FROM node:22-alpine AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

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
COPY packages/adapters/generic/package.json packages/adapters/generic/package.json
COPY packages/adapters/codex/package.json packages/adapters/codex/package.json
COPY packages/adapters/claude/package.json packages/adapters/claude/package.json
COPY packages/adapters/devin/package.json packages/adapters/devin/package.json

RUN pnpm install --frozen-lockfile

FROM dependencies AS api-build

COPY apps apps
COPY packages packages

RUN pnpm --filter "@lore-co/api..." --recursive run build

FROM dependencies AS web-build

COPY apps apps
COPY packages packages

RUN pnpm --filter "@lore-co/web..." --recursive run build

FROM node:22-alpine AS api

ENV NODE_ENV=production
WORKDIR /app

COPY --from=api-build /app/node_modules ./node_modules
COPY --from=api-build /app/package.json ./package.json
COPY --from=api-build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=api-build /app/apps/api ./apps/api
COPY --from=api-build /app/packages ./packages

EXPOSE 3001

CMD ["node", "apps/api/dist/main.js"]

FROM node:22-alpine AS web

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

COPY --from=web-build /app/apps/web/.output ./.output

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
