<script setup lang="ts">
import type { WorkspaceLearningMode } from "@lore-co/sdk";
import { ref, watch } from "vue";
import { errorMessage } from "~/utils/memory";

definePageMeta({ middleware: "auth" });
useHead({ title: "Settings" });

const client = useSharedMemoryClient();
const auth = useAuth();
const authSession = auth.session;
const toast = useToast();
const learningMode = ref<WorkspaceLearningMode>("trust_tiered");
const llmConflictAnalysisEnabled = ref(false);
const saving = ref(false);
const saveError = ref("");
const currentPassword = ref("");
const newPassword = ref("");
const passwordConfirmation = ref("");
const changingPassword = ref(false);
const passwordError = ref("");
const authConfig = await auth.getAuthConfig().catch(() => null);

const {
  data: policy,
  error,
  status,
  refresh,
} = await useAsyncData(
  "workspace-learning-policy",
  () => client.getWorkspaceLearningPolicy(),
);

watch(
  policy,
  (value) => {
    if (value === null || value === undefined) {
      return;
    }
    learningMode.value = value.learningMode;
    llmConflictAnalysisEnabled.value = value.llmConflictAnalysisEnabled;
  },
  { immediate: true },
);

async function savePolicy(): Promise<void> {
  saving.value = true;
  saveError.value = "";
  try {
    policy.value = await client.updateWorkspaceLearningPolicy({
      learningMode: learningMode.value,
      llmConflictAnalysisEnabled: llmConflictAnalysisEnabled.value,
    });
    toast.show("Workspace learning policy updated.");
  } catch (caught) {
    saveError.value = errorMessage(caught);
  } finally {
    saving.value = false;
  }
}

async function reloadPolicy(): Promise<void> {
  await refresh();
}

async function changePassword(): Promise<void> {
  passwordError.value = "";
  if (newPassword.value !== passwordConfirmation.value) {
    passwordError.value = "New passwords do not match.";
    return;
  }
  changingPassword.value = true;
  try {
    await auth.changePassword(currentPassword.value, newPassword.value);
    currentPassword.value = "";
    newPassword.value = "";
    passwordConfirmation.value = "";
    toast.show("Owner password updated.");
  } catch {
    passwordError.value = "The current password is incorrect.";
  } finally {
    changingPassword.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <header class="border-b border-lore-border pb-5">
      <p class="lore-page-eyebrow">Governance</p>
      <h1 class="lore-page-title mt-1.5">Settings</h1>
      <p class="lore-page-description mt-1.5">
        Choose which automatic captures require review before agents can use them.
      </p>
    </header>

    <div class="mt-6">
      <UiSkeleton v-if="status === 'pending'" :rows="5" />

      <UiStatePanel
        v-else-if="error"
        title="Settings couldn’t be loaded"
        :description="errorMessage(error)"
        tone="error"
      >
        <template #actions>
          <button type="button" class="lore-button-secondary" @click="reloadPolicy">
            Try again
          </button>
        </template>
      </UiStatePanel>

      <form
        v-else
        class="overflow-hidden rounded-[0.625rem] border border-lore-border bg-lore-surface"
        @submit.prevent="savePolicy"
      >
        <fieldset class="p-5">
          <legend class="sr-only">Automatic learning mode</legend>
          <h2 class="text-sm font-semibold text-lore-text">
            Automatic learning mode
          </h2>
          <p class="mt-1 text-xs leading-5 text-lore-text-muted">
            Manual entries remain active in either mode.
          </p>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <label class="rounded-lg border border-lore-border p-4">
              <span class="flex items-start gap-3">
                <input
                  v-model="learningMode"
                  type="radio"
                  value="trust_tiered"
                  class="mt-1"
                >
                <span>
                  <span class="block text-sm font-medium text-lore-text">Trust tiered</span>
                  <span class="mt-1 block text-xs leading-5 text-lore-text-secondary">
                    Explicit human corrections may activate immediately. Other
                    automatic captures become proposals.
                  </span>
                </span>
              </span>
            </label>
            <label class="rounded-lg border border-lore-border p-4">
              <span class="flex items-start gap-3">
                <input
                  v-model="learningMode"
                  type="radio"
                  value="proposal_only"
                  class="mt-1"
                >
                <span>
                  <span class="block text-sm font-medium text-lore-text">Proposal only</span>
                  <span class="mt-1 block text-xs leading-5 text-lore-text-secondary">
                    Every automatic capture waits for human review before it can
                    be retrieved or injected.
                  </span>
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <!-- Temporarily hidden until customers can configure an analysis provider.
        <section class="border-t border-lore-border p-5" aria-labelledby="conflict-analysis-heading">
          <div class="flex items-start justify-between gap-5">
            <div>
              <h2 id="conflict-analysis-heading" class="text-sm font-semibold text-lore-text">
                Optional LLM conflict analysis
              </h2>
              <p class="mt-1 max-w-2xl text-xs leading-5 text-lore-text-secondary">
                Add a model-generated explanation to deterministic, lexical, or
                semantic evidence. It fails open, never activates a proposal,
                and is never the sole blocker.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="llmConflictAnalysisEnabled"
              class="lore-focus relative mt-0.5 h-6 w-11 shrink-0 rounded-full border border-lore-border-strong transition"
              :class="llmConflictAnalysisEnabled ? 'bg-lore-accent' : 'bg-lore-raised'"
              @click="llmConflictAnalysisEnabled = !llmConflictAnalysisEnabled"
            >
              <span
                class="absolute top-0.5 size-4.5 rounded-full bg-white transition"
                :class="llmConflictAnalysisEnabled ? 'left-5.5' : 'left-0.5'"
                aria-hidden="true"
              />
              <span class="sr-only">Enable optional LLM conflict analysis</span>
            </button>
          </div>
        </section>
        -->

        <div class="border-t border-lore-border px-5 py-4">
          <UiInlineAlert
            v-if="saveError"
            class="mb-4"
            title="Settings weren’t saved"
            :message="saveError"
          />
          <div class="flex justify-end">
            <button type="submit" class="lore-button-primary" :disabled="saving">
              {{ saving ? "Saving…" : "Save settings" }}
            </button>
          </div>
        </div>
      </form>

      <form
        v-if="
          status !== 'pending' &&
          !error &&
          authConfig?.mode === 'local_owner' &&
          authSession?.role === 'owner'
        "
        class="mt-6 overflow-hidden rounded-[0.625rem] border border-lore-border bg-lore-surface"
        @submit.prevent="changePassword"
      >
        <section class="space-y-4 p-5" aria-labelledby="password-heading">
          <div>
            <h2 id="password-heading" class="text-sm font-semibold text-lore-text">
              Owner password
            </h2>
            <p class="mt-1 text-xs leading-5 text-lore-text-muted">
              Changing the password signs out other active owner sessions.
            </p>
          </div>
          <UiField label="Current password" for="current-password" required>
            <input
              id="current-password"
              v-model="currentPassword"
              type="password"
              autocomplete="current-password"
              required
              minlength="12"
              maxlength="1024"
              class="lore-input min-h-11"
            >
          </UiField>
          <UiField label="New password" for="new-password" required>
            <input
              id="new-password"
              v-model="newPassword"
              type="password"
              autocomplete="new-password"
              required
              minlength="12"
              maxlength="1024"
              class="lore-input min-h-11"
            >
          </UiField>
          <UiField
            label="Confirm new password"
            for="new-password-confirmation"
            required
          >
            <input
              id="new-password-confirmation"
              v-model="passwordConfirmation"
              type="password"
              autocomplete="new-password"
              required
              minlength="12"
              maxlength="1024"
              class="lore-input min-h-11"
            >
          </UiField>
          <UiInlineAlert
            v-if="passwordError"
            title="Password wasn’t changed"
            :message="passwordError"
          />
        </section>
        <div class="border-t border-lore-border px-5 py-4">
          <div class="flex justify-end">
            <button
              type="submit"
              class="lore-button-primary"
              :disabled="changingPassword"
            >
              {{ changingPassword ? "Updating…" : "Update password" }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>
