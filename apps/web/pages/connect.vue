<script setup lang="ts">
import type {
  CreateWorkspaceTokenResponse,
  WorkspaceToken,
  WorkspaceTokenStatus,
} from "@lore-co/sdk";
import { computed, ref } from "vue";
import { errorMessage } from "~/utils/memory";

definePageMeta({ middleware: "auth" });
useHead({ title: "Connect" });

const client = useSharedMemoryClient();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();
const toast = useToast();
const isOnboarding = computed(() => route.query.welcome === "1");
const tokenName = ref(isOnboarding.value ? "My machine" : "");
const expiry = ref("90");
const creating = ref(false);
const createdToken = ref<CreateWorkspaceTokenResponse | null>(null);
const revokeTarget = ref<WorkspaceToken | null>(null);
const revoking = ref(false);
const setupHelpOpen = ref(false);

const {
  data: response,
  error,
  status,
  refresh,
} = await useAsyncData("workspace-tokens", () =>
  client.listWorkspaceTokens(),
);

const connectorCommand = computed(() => {
  if (createdToken.value === null) {
    return "";
  }
  const apiUrl = String(runtimeConfig.public.connectorApiUrl).replace(
    /\/+$/u,
    "",
  );
  const installUrl = String(runtimeConfig.public.loreInstallUrl);
  const dashboardUrl = import.meta.client ? window.location.origin : "";
  const dashboardOption =
    dashboardUrl === ""
      ? ""
      : ` --dashboard-url ${shellQuote(dashboardUrl)}`;
  return `export LORE_BIN_DIR="\${LORE_BIN_DIR:-$HOME/.local/bin}"; curl -fsSL ${shellQuote(installUrl)} | bash && "$LORE_BIN_DIR/lore" connect --url ${shellQuote(apiUrl)}${dashboardOption} --token ${shellQuote(createdToken.value.token)} && "$LORE_BIN_DIR/lore" doctor`;
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function statusLabel(value: WorkspaceTokenStatus): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function statusClass(value: WorkspaceTokenStatus): string {
  if (value === "active") {
    return "border-lore-success/30 bg-lore-success-soft text-lore-success";
  }
  if (value === "expired") {
    return "border-lore-warning/30 bg-lore-warning-soft text-lore-warning";
  }
  return "border-lore-border bg-lore-raised text-lore-text-muted";
}

async function createToken(): Promise<void> {
  const name = tokenName.value.trim();
  if (name === "") {
    toast.show("Give this token a name.", "error");
    return;
  }

  creating.value = true;
  try {
    const expiresInDays =
      expiry.value === "never" ? undefined : Number(expiry.value);
    createdToken.value = await client.createWorkspaceToken({
      name,
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
    });
    tokenName.value = "";
    await refresh();
    toast.show("Workspace token created.");
  } catch (caught) {
    toast.show(errorMessage(caught), "error");
  } finally {
    creating.value = false;
  }
}

async function copyValue(value: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.show(successMessage);
  } catch {
    toast.show("Copy failed. Select and copy the value manually.", "error");
  }
}

async function reloadTokens(): Promise<void> {
  await refresh();
}

async function revokeToken(): Promise<void> {
  if (revokeTarget.value === null) {
    return;
  }
  revoking.value = true;
  try {
    await client.revokeWorkspaceToken(revokeTarget.value.id);
    revokeTarget.value = null;
    await refresh();
    toast.show("Workspace token revoked.");
  } catch (caught) {
    toast.show(errorMessage(caught), "error");
  } finally {
    revoking.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl">
    <header
      class="flex flex-col gap-4 border-b border-lore-border pb-5 sm:flex-row sm:items-end sm:justify-between"
    >
      <div>
        <p class="lore-page-eyebrow">
          {{ isOnboarding ? "One-time setup" : "Agent access" }}
        </p>
        <h1 class="lore-page-title mt-1.5">
          {{ isOnboarding ? "Connect your agents" : "Connect" }}
        </h1>
        <p class="lore-page-description mt-1.5">
          {{
            isOnboarding
              ? "Create one setup command, run it in your terminal, then keep working in Claude, Codex, or OpenCode normally."
              : "Create workspace tokens for Claude, Codex, OpenCode, Devin, CI, and other Lore connectors."
          }}
        </p>
      </div>
      <button
        type="button"
        class="lore-button-secondary self-start"
        :aria-expanded="setupHelpOpen"
        aria-controls="setup-help-drawer"
        @click="setupHelpOpen = true"
      >
        <svg viewBox="0 0 20 20" fill="none" class="size-4" aria-hidden="true">
          <path
            d="M10 14.25v.05M7.7 7.35a2.4 2.4 0 1 1 3.3 2.22c-.64.3-1 .7-1 1.43v.25M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        Setup help
      </button>
    </header>

    <section
      v-if="isOnboarding && !createdToken"
      class="mt-5 rounded-[0.625rem] border border-lore-border bg-lore-sidebar p-4"
      aria-labelledby="onboarding-heading"
    >
      <h2 id="onboarding-heading" class="text-sm font-semibold text-lore-text">
        Connect once. Lore works quietly afterward.
      </h2>
      <p class="mt-1 text-sm leading-6 text-lore-text-secondary">
        The command installs Lore’s Claude/Codex hooks and OpenCode plugin, then
        verifies the connection. Run it directly in your terminal, not in an
        agent chat.
      </p>
    </section>

    <section
      v-if="createdToken"
      class="mt-5 overflow-hidden rounded-xl border border-lore-border-strong bg-lore-surface"
      aria-labelledby="new-token-heading"
      aria-live="polite"
    >
      <div class="p-5 sm:p-6">
        <div class="flex items-start gap-4">
          <span
            class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-lore-accent/25 bg-lore-accent-soft/50 text-lore-accent"
            aria-hidden="true"
          >
            <svg viewBox="0 0 20 20" fill="none" class="size-4">
              <path
                d="m5 10.25 3.1 3.1L15.5 6"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p
                  class="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-lore-accent"
                >
                  {{ isOnboarding ? "Setup command ready" : "Token created" }}
                </p>
                <h2
                  id="new-token-heading"
                  class="mt-1.5 text-lg font-semibold tracking-tight text-lore-text"
                >
                  {{
                    isOnboarding
                      ? `Connect ${createdToken.workspaceToken.name}`
                      : createdToken.workspaceToken.name
                  }}
                </h2>
              </div>

              <button
                type="button"
                class="lore-button-ghost min-h-8 shrink-0 px-2.5 py-1 text-xs"
                @click="createdToken = null"
              >
                <svg viewBox="0 0 20 20" fill="none" class="size-3.5" aria-hidden="true">
                  <path
                    d="m6 6 8 8m0-8-8 8"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
                Dismiss
              </button>
            </div>

            <p class="mt-1.5 max-w-2xl text-sm leading-6 text-lore-text-secondary">
              {{
                isOnboarding
                  ? "Run this command once on the machine you want to connect."
                  : "Use this token to authenticate a new Lore connector."
              }}
            </p>

            <div
              class="mt-3 inline-flex items-center gap-2 rounded-md border border-lore-warning/25 bg-lore-warning-soft/50 px-2.5 py-1.5 text-xs text-lore-warning"
            >
              <svg viewBox="0 0 20 20" fill="none" class="size-3.5 shrink-0" aria-hidden="true">
                <path
                  d="M6.75 8V6.5a3.25 3.25 0 0 1 6.5 0V8m-7.5 0h8.5c.7 0 1.25.56 1.25 1.25v5.5c0 .7-.56 1.25-1.25 1.25h-8.5c-.7 0-1.25-.56-1.25-1.25v-5.5C4.5 8.55 5.06 8 5.75 8Z"
                  stroke="currentColor"
                  stroke-width="1.35"
                  stroke-linecap="round"
                />
              </svg>
              <span>
                {{
                  isOnboarding
                    ? "Copy it now. The embedded token will not be shown again."
                    : "This secret will not be shown again."
                }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="!isOnboarding"
        class="flex flex-col gap-3 border-t border-lore-border bg-lore-sidebar px-5 py-4 sm:flex-row sm:items-center"
      >
        <code
          class="min-w-0 flex-1 wrap-break-word font-mono text-xs leading-5 text-lore-text-secondary"
        >
          {{ createdToken.token }}
        </code>
        <button
          type="button"
          class="lore-button-secondary shrink-0"
          @click="copyValue(createdToken.token, 'Token copied.')"
        >
          Copy token
        </button>
      </div>

      <div class="border-t border-lore-border bg-lore-sidebar p-4 sm:p-5">
        <div class="flex items-start gap-3">
          <span
            class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-lore-border-strong bg-lore-raised text-xs font-semibold text-lore-text-secondary"
            aria-hidden="true"
          >
            1
          </span>
          <div>
            <p class="text-sm font-medium text-lore-text">Terminal command</p>
            <p class="mt-0.5 text-xs leading-5 text-lore-text-muted">
              Run once on the machine you want Lore to connect.
            </p>
          </div>
        </div>

        <div
          class="mt-3 overflow-hidden rounded-lg border border-lore-border-strong bg-lore-bg"
        >
          <div
            class="flex items-center gap-2 border-b border-lore-border bg-lore-raised px-3 py-2"
          >
            <span class="size-2 rounded-full bg-lore-danger/70" aria-hidden="true" />
            <span class="size-2 rounded-full bg-lore-warning/70" aria-hidden="true" />
            <span class="size-2 rounded-full bg-lore-success/70" aria-hidden="true" />
            <span class="ml-1 text-[0.6875rem] font-medium text-lore-text-muted">
              Terminal
            </span>
            <button
              type="button"
              class="lore-focus ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-md border border-lore-border-strong bg-lore-surface px-2.5 py-1 text-xs font-semibold text-lore-text transition-colors hover:bg-lore-hover"
              @click="copyValue(connectorCommand, 'Connect command copied.')"
            >
              <svg viewBox="0 0 20 20" fill="none" class="size-3.5" aria-hidden="true">
                <path
                  d="M7.25 6.25V5c0-.7.56-1.25 1.25-1.25H15c.7 0 1.25.56 1.25 1.25v6.5c0 .7-.56 1.25-1.25 1.25h-1.25m-8.75-6.5h6.5c.7 0 1.25.56 1.25 1.25V14c0 .7-.56 1.25-1.25 1.25H5c-.7 0-1.25-.56-1.25-1.25V7.5c0-.7.56-1.25 1.25-1.25Z"
                  stroke="currentColor"
                  stroke-width="1.35"
                  stroke-linejoin="round"
                />
              </svg>
              {{ isOnboarding ? "Copy setup command" : "Copy command" }}
            </button>
          </div>
          <pre
            class="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word p-4 font-mono text-xs leading-6 text-lore-text-secondary"
          ><code>{{ connectorCommand }}</code></pre>
        </div>
      </div>

      <div
        v-if="isOnboarding"
        class="flex flex-col gap-4 border-t border-lore-border bg-lore-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex items-start gap-3">
          <span
            class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-lore-border-strong bg-lore-raised text-xs font-semibold text-lore-text-secondary"
            aria-hidden="true"
          >
            2
          </span>
          <div>
            <p class="text-sm font-medium text-lore-text">Verify the connection</p>
            <p class="mt-0.5 text-xs leading-5 text-lore-text-secondary">
              After Doctor reports healthy, open Activity to see Lore working.
            </p>
          </div>
        </div>
        <NuxtLink to="/activity" class="lore-button-primary shrink-0">
          Open Activity
          <svg viewBox="0 0 20 20" fill="none" class="size-3.5" aria-hidden="true">
            <path
              d="M4.5 10h11m-4-4 4 4-4 4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </NuxtLink>
      </div>
    </section>

    <div class="mt-5 grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <section
        class="rounded-[0.625rem] border border-lore-border bg-lore-surface p-4"
        aria-labelledby="create-token-heading"
      >
        <h2 id="create-token-heading" class="text-base font-semibold text-lore-text">
          {{ isOnboarding ? "Create your setup command" : "New workspace token" }}
        </h2>
        <p class="mt-1 text-sm leading-6 text-lore-text-secondary">
          {{
            isOnboarding
              ? "Name this machine so you can identify and revoke its access later."
              : "Use a separate named token for each machine or integration."
          }}
        </p>

        <form class="mt-4 space-y-4" @submit.prevent="createToken">
          <div>
            <label for="token-name" class="lore-field-label">Token name</label>
            <input
              id="token-name"
              v-model="tokenName"
              type="text"
              maxlength="100"
              required
              autocomplete="off"
              placeholder="Dante’s MacBook"
              class="lore-input mt-1.5"
            >
          </div>

          <div>
            <label for="token-expiry" class="lore-field-label">Expires</label>
            <select id="token-expiry" v-model="expiry" class="lore-select mt-1.5">
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
              <option value="never">Never</option>
            </select>
          </div>

          <button
            type="submit"
            class="lore-button-primary w-full"
            :disabled="creating"
          >
            {{
              creating
                ? "Creating…"
                : isOnboarding
                  ? "Create setup command"
                  : "Create token"
            }}
          </button>
        </form>
      </section>

      <section aria-labelledby="tokens-heading">
        <div class="mb-3 flex items-center justify-between gap-4">
          <div>
            <h2 id="tokens-heading" class="text-base font-semibold text-lore-text">
              Workspace tokens
            </h2>
            <p class="mt-1 text-xs text-lore-text-muted">
              Existing secrets are never displayed.
            </p>
          </div>
          <button
            type="button"
            class="lore-button-ghost min-h-8 px-2.5 py-1 text-xs"
            :disabled="status === 'pending'"
            @click="reloadTokens"
          >
            Refresh
          </button>
        </div>

        <UiSkeleton v-if="status === 'pending'" :rows="4" />

        <UiStatePanel
          v-else-if="error"
          title="Workspace tokens couldn’t be loaded"
          :description="errorMessage(error, 'workspace-tokens')"
          tone="error"
        >
          <template #actions>
            <button type="button" class="lore-button-secondary" @click="reloadTokens">
              Try again
            </button>
          </template>
        </UiStatePanel>

        <UiStatePanel
          v-else-if="response?.tokens.length === 0"
          title="No workspace tokens"
          description="Create a named token on the left to securely connect your first agent or integration."
          icon="token"
        />

        <div
          v-else
          class="overflow-hidden rounded-[0.625rem] border border-lore-border bg-lore-surface"
        >
          <article
            v-for="token in response?.tokens"
            :key="token.id"
            class="border-b border-lore-border p-4 last:border-b-0"
          >
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="truncate text-sm font-medium text-lore-text">
                    {{ token.name }}
                  </h3>
                  <span
                    class="rounded-md border px-2 py-0.5 text-[0.6875rem] font-medium"
                    :class="statusClass(token.status)"
                  >
                    {{ statusLabel(token.status) }}
                  </span>
                </div>
                <p class="mt-1 font-mono text-xs text-lore-text-muted">
                  {{ token.tokenPrefix }}••••••••
                </p>
              </div>
              <button
                v-if="token.status === 'active'"
                type="button"
                class="lore-button-danger min-h-8 self-start px-2.5 py-1 text-xs"
                @click="revokeTarget = token"
              >
                Revoke
              </button>
            </div>

            <dl class="mt-3 grid gap-3 border-t border-lore-border pt-3 text-xs sm:grid-cols-3">
              <div>
                <dt class="text-lore-text-muted">Created</dt>
                <dd class="mt-1 text-lore-text-secondary">
                  <UiDateTime :value="token.createdAt" />
                </dd>
              </div>
              <div>
                <dt class="text-lore-text-muted">Last used</dt>
                <dd class="mt-1 text-lore-text-secondary">
                  <UiDateTime
                    v-if="token.lastUsedAt"
                    :value="token.lastUsedAt"
                  />
                  <template v-else>Never</template>
                </dd>
              </div>
              <div>
                <dt class="text-lore-text-muted">Expires</dt>
                <dd class="mt-1 text-lore-text-secondary">
                  <UiDateTime
                    v-if="token.expiresAt"
                    :value="token.expiresAt"
                  />
                  <template v-else>Never</template>
                </dd>
              </div>
            </dl>
          </article>
        </div>
      </section>
    </div>

    <UiConfirmDialog
      :open="revokeTarget !== null"
      title="Revoke workspace token?"
      :description="`Agents using “${revokeTarget?.name ?? 'this token'}” will lose access immediately.`"
      confirm-label="Revoke token"
      pending-label="Revoking…"
      :pending="revoking"
      @confirm="revokeToken"
      @cancel="revokeTarget = null"
    />
    <SetupHelpDrawer
      :open="setupHelpOpen"
      :workspace-token="createdToken?.token ?? null"
      @close="setupHelpOpen = false"
    />
  </div>
</template>
