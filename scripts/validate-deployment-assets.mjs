import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

const root = resolve(import.meta.dirname, "..");
const packageMetadata = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const version = packageMetadata.version;
const migrationCommand =
  "node_modules/@lore-co/database/dist/migrate.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function text(path) {
  return readFile(resolve(root, path), "utf8");
}

function serviceMap(value, path) {
  assert(
    typeof value === "object" &&
      value !== null &&
      typeof value.services === "object" &&
      value.services !== null,
    `${path} must define Compose services`,
  );
  for (const name of ["postgres", "migrate", "api", "web"]) {
    assert(value.services[name] !== undefined, `${path} is missing ${name}`);
  }
  return value.services;
}

function assertCompose(path, source, options = {}) {
  const parsed = parseYaml(source);
  const services = serviceMap(parsed, path);
  assert(
    String(services.postgres.image).startsWith("pgvector/pgvector:"),
    `${path} must use pgvector PostgreSQL`,
  );
  assert(
    JSON.stringify(services.migrate.command).includes(migrationCommand),
    `${path} must run compiled migrations`,
  );
  assert(
    JSON.stringify(services.api.healthcheck).includes("/health/ready"),
    `${path} must check API readiness`,
  );
  assert(
    JSON.stringify(services.web.healthcheck).includes("/health"),
    `${path} must check web liveness`,
  );
  assert(!source.includes(":latest"), `${path} must not use latest images`);
  if (options.pinnedImages) {
    for (const service of ["migrate", "api"]) {
      assert(
        services[service].image ===
          `ghcr.io/treadiehq/lore-api:${version}`,
        `${path} ${service} image must match ${version}`,
      );
    }
    assert(
      services.web.image === `ghcr.io/treadiehq/lore-web:${version}`,
      `${path} web image must match ${version}`,
    );
  }
  if (options.noPublishedPorts) {
    for (const service of Object.values(services)) {
      assert(service.ports === undefined, `${path} must not publish host ports`);
    }
  }
  return services;
}

const rootCompose = await text("docker-compose.yml");
assertCompose("docker-compose.yml", rootCompose);
assert(
  rootCompose.includes(`LORE_IMAGE_TAG:-${version}`),
  "docker-compose.yml default image tag must match the package version",
);

const coolify = await text("deploy/coolify/docker-compose.yml");
const coolifyServices = assertCompose(
  "deploy/coolify/docker-compose.yml",
  coolify,
  { pinnedImages: true, noPublishedPorts: true },
);
assert(
  coolify.includes("SERVICE_HEX_32_OWNER"),
  "Coolify must generate a valid 256-bit owner bootstrap token",
);
assert(
  JSON.stringify(coolifyServices.web.environment).includes(
    "SERVICE_URL_API_3001",
  ),
  "Coolify web must publish the API connector URL",
);

const dokploy = await text("deploy/dokploy/docker-compose.yml");
const dokployServices = assertCompose(
  "deploy/dokploy/docker-compose.yml",
  dokploy,
  { pinnedImages: true, noPublishedPorts: true },
);
assert(
  dokployServices.web.environment.NUXT_AUTH_COOKIE_SECURE === "true",
  "Dokploy must use secure browser cookies",
);
const dokployTemplate = parseToml(
  await text("deploy/dokploy/template.toml"),
);
assert(
  Array.isArray(dokployTemplate.config?.domains) &&
    dokployTemplate.config.domains.length === 2,
  "Dokploy template must define API and web domains",
);
assert(
  dokployTemplate.config.env.includes(
    "WEB_ORIGIN=https://${web_domain}",
  ),
  "Dokploy web origin must use HTTPS",
);

const flyApi = parseToml(await text("deploy/fly/api.fly.toml"));
const flyWeb = parseToml(await text("deploy/fly/web.fly.toml"));
assert(
  flyApi.build?.image === `ghcr.io/treadiehq/lore-api:${version}`,
  "Fly API image version is stale",
);
assert(
  flyWeb.build?.image === `ghcr.io/treadiehq/lore-web:${version}`,
  "Fly web image version is stale",
);
assert(
  flyApi.deploy?.release_command?.includes(migrationCommand),
  "Fly API must run compiled migrations as its release command",
);
assert(
  flyApi.http_service?.checks?.some(
    (check) => check.path === "/health/ready",
  ),
  "Fly API must check readiness",
);
assert(
  flyWeb.env?.NUXT_LORE_API_URL?.includes(".internal:3001"),
  "Fly web must use private API networking",
);

for (const path of ["deploy/railway-api.json", "deploy/railway-web.json"]) {
  JSON.parse(await text(path));
}
const railway = JSON.parse(
  await text("deploy/railway/template-spec.json"),
);
assert(
  railway.canonicalVersion === version,
  "Railway template version is stale",
);
assert(
  railway.publication?.status === "external-publication-required" &&
    railway.publication.templateUrl === null,
  "Railway must not claim an unpublished template URL",
);
const railwayImages = railway.services
  .map((service) => service.source?.image)
  .filter((image) => image?.startsWith("ghcr.io/treadiehq/lore-"));
assert(
  railwayImages.includes(`ghcr.io/treadiehq/lore-api:${version}`) &&
    railwayImages.includes(`ghcr.io/treadiehq/lore-web:${version}`),
  "Railway images must match the package version",
);

const deploymentSources = [
  coolify,
  dokploy,
  await text("deploy/fly/api.fly.toml"),
  await text("deploy/fly/web.fly.toml"),
  JSON.stringify(railway),
];
for (const source of deploymentSources) {
  assert(
    !/(?:sk-|npm_|re_)[A-Za-z0-9_-]{16,}/u.test(source),
    "Deployment assets must not contain credential-like literals",
  );
}

const selfHostWorkflow = parseYaml(
  await text(".github/workflows/self-host-acceptance.yml"),
);
const stagingWorkflow = parseYaml(
  await text(".github/workflows/provider-staging.yml"),
);
assert(
  selfHostWorkflow.jobs?.containers !== undefined,
  "Self-host acceptance workflow must define the container gate",
);
assert(
  selfHostWorkflow.jobs.containers.env?.LORE_IMAGE_TAG === version,
  "Self-host acceptance image tag is stale",
);
assert(
  stagingWorkflow.jobs?.verify?.environment ===
    "staging-${{ inputs.provider }}",
  "Provider staging workflow must use protected provider environments",
);

process.stdout.write(
  `deployment assets valid for Lore ${version}: Railway, Coolify, Dokploy, Fly\n`,
);
