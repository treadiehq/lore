<script setup lang="ts">
import { ref } from "vue";

definePageMeta({ middleware: "guest" });
useHead({
  title: "Set up local owner",
  meta: [
    { name: "robots", content: "noindex,nofollow" },
    { name: "referrer", content: "no-referrer" },
  ],
});

const auth = useAuth();
const email = ref("");
const password = ref("");
const passwordConfirmation = ref("");
const bootstrapToken = ref("");
const pending = ref(false);
const errorMessage = ref("");
const config = await auth.getAuthConfig({ force: true });

if (config.mode !== "local_owner" || !config.bootstrapRequired) {
  await navigateTo("/login", { replace: true });
}

async function submit(): Promise<void> {
  errorMessage.value = "";
  if (password.value !== passwordConfirmation.value) {
    errorMessage.value = "Passwords do not match.";
    return;
  }
  pending.value = true;
  try {
    await auth.bootstrapOwner(
      email.value.trim(),
      password.value,
      bootstrapToken.value.trim(),
    );
    bootstrapToken.value = "";
    password.value = "";
    passwordConfirmation.value = "";
    await navigateTo("/activity", { replace: true });
  } catch {
    errorMessage.value =
      "Owner setup could not be completed. Check the bootstrap token and try again.";
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <AuthFrame
    eyebrow="One-time setup"
    title="Claim the local owner account"
    description="Create the first owner for this deployment’s configured workspace."
  >
    <form
      class="space-y-4 rounded-[0.625rem] border border-lore-border bg-lore-surface p-5 sm:p-6"
      @submit.prevent="submit"
    >
      <UiField
        label="Owner email"
        for="setup-email"
        hint="This becomes the durable local sign-in identity."
        required
      >
        <input
          id="setup-email"
          v-model="email"
          type="email"
          inputmode="email"
          autocomplete="email"
          required
          maxlength="320"
          class="lore-input min-h-11"
        >
      </UiField>

      <UiField
        label="Owner password"
        for="setup-password"
        hint="Use at least 12 characters."
        required
      >
        <input
          id="setup-password"
          v-model="password"
          type="password"
          autocomplete="new-password"
          required
          minlength="12"
          maxlength="1024"
          class="lore-input min-h-11"
        >
      </UiField>

      <UiField label="Confirm password" for="setup-password-confirmation" required>
        <input
          id="setup-password-confirmation"
          v-model="passwordConfirmation"
          type="password"
          autocomplete="new-password"
          required
          minlength="12"
          maxlength="1024"
          class="lore-input min-h-11"
        >
      </UiField>

      <UiField
        label="Bootstrap token"
        for="setup-bootstrap-token"
        hint="Read LORE_OWNER_BOOTSTRAP_TOKEN from the server environment. It is sent once and is never stored by the browser."
        required
      >
        <input
          id="setup-bootstrap-token"
          v-model="bootstrapToken"
          type="password"
          autocomplete="off"
          required
          minlength="43"
          maxlength="128"
          class="lore-input min-h-11 font-mono"
        >
      </UiField>

      <UiInlineAlert
        v-if="errorMessage"
        title="Owner setup failed"
        :message="errorMessage"
      />

      <button
        type="submit"
        class="lore-button-primary min-h-11 w-full"
        :disabled="pending"
      >
        {{ pending ? "Creating owner…" : "Create owner account" }}
      </button>
    </form>

    <p class="mt-5 text-sm text-lore-text-secondary">
      Already claimed?
      <NuxtLink to="/login" class="lore-link ml-1">Sign in</NuxtLink>
    </p>
  </AuthFrame>
</template>
