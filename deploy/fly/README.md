# Fly.io deployment

These assets deploy Lore as two Fly apps:

- `api.fly.toml` runs the pinned canonical API image and executes compiled
  database migrations as a Fly release command.
- `web.fly.toml` runs the matching pinned dashboard image and reaches the API
  over Fly's private network.
- `deploy.sh` creates missing apps, stages secrets, deploys, and keeps one
  Machine for each app.

The templates deliberately omit `app` and `primary_region`. The helper supplies
both values without modifying tracked files. Both apps must belong to the same
Fly organization for `<api-app>.internal` private DNS to work.

## PostgreSQL and pgvector

The helper does not create a database. `DATABASE_URL` must point to a reachable
PostgreSQL database with the `vector` extension available. The migration release
command runs `CREATE EXTENSION IF NOT EXISTS vector`, so its database role must
either be allowed to create the extension or connect to a database where an
administrator has already enabled it.

For Fly Managed Postgres, provision a cluster that supports pgvector and enable
the `vector` extension through the current Fly dashboard or `fly mpg` workflow
before deploying Lore. Fly's managed-database command surface changes
independently of Lore, so use the command shown by the current Fly documentation
rather than copying a version-specific command from this runbook.

An external PostgreSQL provider is also supported when it provides pgvector,
accepts connections from the Fly apps, and supplies a TLS-protected PostgreSQL
URL.

Keep the database in or near the selected app region. Managed Postgres and other
database services are billed separately from the two application Machines.

## Deploy

Install and authenticate `flyctl`, provision the database, and export the three
required secrets:

```sh
export DATABASE_URL='postgresql://user:password@host:5432/lore?sslmode=require'
export LORE_WORKSPACE_TOKEN='lore_<43-base64url-characters>'
export LORE_OWNER_BOOTSTRAP_TOKEN='<43-base64url-characters>'
```

Preview the complete redacted plan without contacting Fly:

```sh
deploy/fly/deploy.sh \
  --api-app my-lore-api \
  --web-app my-lore-web \
  --fly-org personal \
  --region ord \
  --dry-run
```

Remove `--dry-run` to create and deploy the apps. Use
`deploy/fly/deploy.sh --help` for custom origins, workspace labels, and image
tag options.

The script passes secret values to `flyctl secrets set` over standard input.
They are never included in command arguments or printed. The owner bootstrap
token remains only in the caller's environment and Fly's secret store.

## Template conventions

The checked-in templates pin the API and web images to the same release as the
root Compose stack. `--image-tag` overrides both images together and accepts
only a pinned semantic version, never `latest`.

`web.fly.toml` uses `API_APP_NAME` as its explicit placeholder:

```text
http://API_APP_NAME.internal:3001
```

The helper replaces that runtime value with
`http://<api-app>.internal:3001` and separately configures the browser-facing
connector URL. For a manual `fly deploy`, override both
`NUXT_LORE_API_URL` and `NUXT_PUBLIC_LORE_CONNECTOR_API_URL`.

Fly normally creates redundant Machines for HTTP services. The helper deploys
with `--ha=false` and then scales each app to exactly one Machine. The templates
also keep that Machine running and configure API liveness/readiness plus web
health checks. Scale up explicitly when high availability is required.
