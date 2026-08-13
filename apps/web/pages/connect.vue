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
  return `export LORE_BIN_DIR="\${LORE_BIN_DIR:-$HOME/.local/bin}"; curl -fsSL ${shellQuote(installUrl)} | bash && "$LORE_BIN_DIR/lore" connect --url ${shellQuote(apiUrl)} --token ${shellQuote(createdToken.value.token)} && "$LORE_BIN_DIR/lore" doctor`;
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
              ? "Create one setup command, run it in your terminal, then keep working in Codex or Claude normally."
              : "Create workspace tokens for Codex, Claude, Devin, CI, and other Lore connectors."
          }}
        </p>
      </div>
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
        The command installs Lore’s Codex and Claude hooks and verifies the
        connection. Run it directly in your terminal—not in an agent chat.
      </p>
    </section>

    <section
      v-if="createdToken"
      class="mt-5 rounded-[0.625rem] border border-lore-accent/40 bg-lore-accent-soft p-4"
      aria-labelledby="new-token-heading"
    >
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p class="text-xs font-semibold text-lore-accent">
            {{
              isOnboarding
                ? "Your setup command is ready"
                : "Copy this token now"
            }}
          </p>
          <h2 id="new-token-heading" class="mt-1.5 text-base font-semibold text-lore-text">
            {{ createdToken.workspaceToken.name }}
          </h2>
          <p class="mt-1 text-sm leading-6 text-lore-text-secondary">
            {{
              isOnboarding
                ? "Copy and run the command below. Its one-time token cannot be shown again."
                : "This secret is shown once. Lore stores only its hash and cannot recover it later."
            }}
          </p>
        </div>
        <button
          type="button"
          class="lore-button-ghost self-start"
          @click="createdToken = null"
        >
          Dismiss
        </button>
      </div>

      <div
        v-if="!isOnboarding"
        class="mt-4 flex flex-col gap-2 border-t border-lore-accent/20 pt-4 sm:flex-row sm:items-center"
      >
        <code class="min-w-0 flex-1 break-all text-xs leading-5 text-lore-text">
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

      <div class="mt-3 border-t border-lore-accent/20 pt-3">
        <p class="lore-section-label">
          Run once in your terminal
        </p>
        <div class="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
          <code class="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs leading-5 text-lore-text-secondary">
            {{ connectorCommand }}
          </code>
          <button
            type="button"
            class="lore-button-secondary shrink-0"
            @click="copyValue(connectorCommand, 'Connect command copied.')"
          >
            {{ isOnboarding ? "Copy setup command" : "Copy command" }}
          </button>
        </div>
        <div
          v-if="isOnboarding"
          class="mt-3 flex flex-col gap-3 border-t border-lore-accent/20 pt-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p class="text-xs leading-5 text-lore-text-secondary">
            Once Doctor reports a healthy connection, your agents can share
            relevant teachings and corrections.
          </p>
          <NuxtLink to="/activity" class="lore-button-primary shrink-0">
            Continue to Activity
          </NuxtLink>
        </div>
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
  </div>
</template>
