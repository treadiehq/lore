# Deploy and Host Lore with Railway

Lore provides governed shared memory for coding agents. This Railway template
runs the pinned Lore API and web dashboard images with a private PostgreSQL 18
database that includes pgvector.

> **Publication status: external action required.** Railway multi-service
> templates are created and published from the Railway dashboard or CLI. These
> repository assets do not publish a template, and no live template URL is
> claimed here.

`template-spec.json` is the checked-in source of truth for the dashboard-managed
template. Apply it exactly in Railway's template composer:

- `pgvector` uses `pgvector/pgvector:0.8.6-pg18`, private TCP port `5432`, and a
  persistent volume mounted at `/var/lib/postgresql`.
- `api` uses `ghcr.io/treadiehq/lore-api:0.1.4`, runs the compiled migration
  `node node_modules/@lore-co/database/dist/migrate.js` before deploy, exposes
  target port `3001`, and checks `/health/ready`.
- `web` uses `ghcr.io/treadiehq/lore-web:0.1.4`, exposes target port `3000`, and
  checks `/health`.
- Only `api` and `web` receive Railway-generated public domains. All
  service-to-service traffic uses Railway reference variables and private
  domains.
- The template generates separate 256-bit values for the database password,
  connector workspace token, and one-time local-owner bootstrap token.

## About Hosting Lore

The template provides the complete self-hosted Lore stack. pgvector stores
memories and vector indexes on persistent storage, the API performs migrations
and serves connectors, and the web service provides owner setup and the
dashboard. `AUTH_MODE=local_owner` avoids an external email provider while still
requiring a separate one-time secret to claim the first owner account.

After deployment, append `/setup` to the generated web domain and enter
`LORE_OWNER_BOOTSTRAP_TOKEN` from the API service variables. Do not expose the
pgvector service publicly.

## Common Use Cases

- Share durable context across coding agents.
- Review governed memories, activity, and delivery receipts.
- Run Lore without a hosted authentication or database dependency.
- Keep API-to-database and web-to-API traffic on Railway's private network.

## Deployment Dependencies

- Railway account with template publishing access.
- Public access to the pinned GitHub Container Registry images.
- A Railway volume attached to `pgvector` at the exact path in the spec.

## Config-as-Code Boundary

`/deploy/railway-api.json` and `/deploy/railway-web.json` are supported
source-repository deployment configs. They keep Railpack build filters,
compiled migration paths, start commands, and health paths aligned with the
canonical image builds.

Railway's config-as-code schema cannot select a Docker image source or a
Dockerfile target stage. Do not invent `image` or `target` keys in those files.
For the public multi-service template, select the pinned image sources directly
in the Railway template composer.

## Required External Publication

1. Create a Railway project from `template-spec.json`, including every service,
   variable, reference, public domain, health path, and volume.
2. Generate a template draft from that project and verify a clean deployment
   reaches both health paths.
3. Publish the draft in the Railway dashboard, or use the valid checked-in
   metadata with:

   ```sh
   railway templates publish <template-id> \
     --category "AI/ML" \
     --description "One-click self-hosting for Lore with pgvector, the Lore API, and the Lore web dashboard." \
     --readme-file deploy/railway/README.md \
     --json
   ```

4. Only after Railway returns the published template URL should that real URL be
   added to user-facing documentation in a separate change.
