<script setup lang="ts">
import { ref } from "vue";

definePageMeta({ middleware: "guest" });

useHead({
  title: "Create a workspace",
  meta: [
    { name: "robots", content: "noindex,nofollow" },
    { name: "referrer", content: "no-referrer" },
  ],
});

const auth = useAuth();
const authConfig = await auth.getAuthConfig({ force: true });
if (authConfig.mode !== "magic_link") {
  await navigateTo("/login", { replace: true });
}
const organizationName = ref("");
const email = ref("");
const pending = ref(false);
const sent = ref(false);
const errorMessage = ref("");

async function submit(): Promise<void> {
  errorMessage.value = "";
  pending.value = true;
  try {
    await auth.signup(organizationName.value.trim(), email.value.trim());
    sent.value = true;
  } catch {
    errorMessage.value =
      "We couldn’t create your workspace right now. Please wait a moment and try again.";
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <AuthFrame
    v-if="sent"
    eyebrow="Workspace created"
    title="Check your email"
    :description="`We sent a secure activation link to ${email}.`"
  >
    <AuthEmailConfirmation
      :email="email"
      :pending="pending"
      @resend="submit"
    />
  </AuthFrame>

  <AuthFrame
    v-else
    eyebrow="New workspace"
    title="Create your Lore workspace"
    description="Set up the workspace your team will use to review and maintain shared knowledge."
  >
    <form
      class="space-y-4 rounded-[0.625rem] border border-lore-border bg-lore-surface p-5 sm:p-6"
      @submit.prevent="submit"
    >
      <UiField
        label="Workspace name"
        for="signup-organization"
        hint="Usually your company or team name."
        required
      >
        <input
          id="signup-organization"
          v-model="organizationName"
          type="text"
          autocomplete="organization"
          required
          maxlength="200"
          placeholder="Acme Engineering"
          class="lore-input min-h-11"
        >
      </UiField>

      <UiField
        label="Work email"
        for="signup-email"
        hint="We’ll send a single-use activation link."
        required
      >
        <input
          id="signup-email"
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
        title="Workspace wasn’t created"
        :message="errorMessage"
      />

      <button
        type="submit"
        :disabled="pending"
        class="lore-button-primary min-h-11 w-full"
      >
        {{ pending ? "Creating workspace…" : "Create workspace" }}
      </button>
    </form>

    <p class="mt-5 text-sm text-lore-text-secondary">
      Already have a workspace?
      <NuxtLink to="/login" class="lore-link ml-1">
        Sign in
      </NuxtLink>
    </p>
    <p class="mt-8 text-xs leading-5 text-lore-text-muted">
      By continuing, you confirm that you’re authorized to create this workspace
      and connect your team’s development tools.
    </p>
  </AuthFrame>
</template>
