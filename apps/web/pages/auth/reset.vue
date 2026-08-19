<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

definePageMeta({ middleware: "guest" });
useHead({
  title: "Reset password",
  meta: [
    { name: "robots", content: "noindex,nofollow" },
    { name: "referrer", content: "no-referrer" },
  ],
});

const auth = useAuth();
const token = ref("");
const password = ref("");
const passwordConfirmation = ref("");
const state = ref<"preparing" | "ready" | "pending" | "error">("preparing");
const errorMessage = ref("");
const title = computed(() =>
  state.value === "error" ? "This reset link can’t be used" : "Set a new password",
);

onMounted(() => {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  token.value = parameters.get("token")?.trim() ?? "";
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  state.value = /^[A-Za-z0-9_-]{43}$/u.test(token.value) ? "ready" : "error";
});

async function submit(): Promise<void> {
  errorMessage.value = "";
  if (password.value !== passwordConfirmation.value) {
    errorMessage.value = "Passwords do not match.";
    return;
  }
  state.value = "pending";
  try {
    await auth.resetPassword(token.value, password.value);
    token.value = "";
    password.value = "";
    passwordConfirmation.value = "";
    await navigateTo("/activity", { replace: true });
  } catch {
    state.value = "error";
    token.value = "";
  }
}
</script>

<template>
  <AuthFrame
    eyebrow="Owner recovery"
    :title="title"
    :description="
      state === 'error'
        ? 'The reset link is invalid, expired, or has already been used.'
        : 'Choose a new password for the local owner account.'
    "
  >
    <div
      v-if="state === 'preparing'"
      class="flex items-center gap-3 rounded-[0.625rem] border border-lore-border bg-lore-surface p-5"
      role="status"
    >
      <span
        class="size-5 animate-spin rounded-full border-2 border-lore-border-strong border-t-lore-accent"
        aria-hidden="true"
      />
      <p class="text-sm text-lore-text-secondary">Preparing password reset…</p>
    </div>

    <UiInlineAlert
      v-else-if="state === 'error'"
      title="Password reset failed"
      message="Ask the operator to mint a new one-use reset link."
    >
      <template #actions>
        <NuxtLink to="/login" class="lore-button-secondary">Back to sign in</NuxtLink>
      </template>
    </UiInlineAlert>

    <form
      v-else
      class="space-y-4 rounded-[0.625rem] border border-lore-border bg-lore-surface p-5 sm:p-6"
      @submit.prevent="submit"
    >
      <UiField
        label="New password"
        for="reset-password"
        hint="Use at least 12 characters."
        required
      >
        <input
          id="reset-password"
          v-model="password"
          type="password"
          autocomplete="new-password"
          required
          minlength="12"
          maxlength="1024"
          class="lore-input min-h-11"
        >
      </UiField>
      <UiField label="Confirm new password" for="reset-password-confirmation" required>
        <input
          id="reset-password-confirmation"
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
        v-if="errorMessage"
        title="Passwords don’t match"
        :message="errorMessage"
      />
      <button
        type="submit"
        class="lore-button-primary min-h-11 w-full"
        :disabled="state === 'pending'"
      >
        {{ state === "pending" ? "Updating password…" : "Update password" }}
      </button>
    </form>
  </AuthFrame>
</template>
