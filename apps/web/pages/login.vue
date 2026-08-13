<script setup lang="ts">
import { ref } from "vue";

useHead({
  title: "Sign in",
  meta: [
    { name: "robots", content: "noindex,nofollow" },
    { name: "referrer", content: "no-referrer" },
  ],
});

const auth = useAuth();
const email = ref("");
const pending = ref(false);
const sent = ref(false);
const errorMessage = ref("");

async function submit(): Promise<void> {
  errorMessage.value = "";
  pending.value = true;
  try {
    await auth.login(email.value.trim());
    sent.value = true;
  } catch {
    errorMessage.value =
      "We couldn’t start sign in right now. Please wait a moment and try again.";
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <AuthFrame
    v-if="sent"
    title="Check your email"
    :description="`We sent a secure sign-in link to ${email}.`"
  >
    <AuthEmailConfirmation
      :email="email"
      :pending="pending"
      @resend="submit"
    />
  </AuthFrame>

  <AuthFrame
    v-else
    title="Sign in to Lore"
    description="Enter your work email and we’ll send you a secure sign-in link."
  >
    <form
      class="rounded-[0.625rem] border border-lore-border bg-lore-surface p-5 sm:p-6"
      @submit.prevent="submit"
    >
      <UiField label="Work email" for="login-email" required>
        <input
          id="login-email"
          v-model="email"
          type="email"
          inputmode="email"
          autocomplete="email"
          required
          maxlength="320"
          placeholder="you@company.com"
          class="lore-input min-h-11"
        >
      </UiField>

      <UiInlineAlert
        v-if="errorMessage"
        class="mt-4"
        title="Sign-in link wasn’t sent"
        :message="errorMessage"
      />

      <button
        type="submit"
        :disabled="pending"
        class="lore-button-primary mt-5 min-h-11 w-full"
      >
        {{ pending ? "Sending sign-in link…" : "Continue with email" }}
      </button>
    </form>

    <p class="mt-5 text-sm text-lore-text-secondary">
      Need a workspace?
      <NuxtLink to="/signup" class="lore-link ml-1">
        Create one
      </NuxtLink>
    </p>
  </AuthFrame>
</template>
