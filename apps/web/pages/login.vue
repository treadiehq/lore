<script setup lang="ts">
import { computed, ref } from "vue";

definePageMeta({ middleware: "guest" });

useHead({
  title: "Sign in",
  meta: [
    { name: "robots", content: "noindex,nofollow" },
    { name: "referrer", content: "no-referrer" },
  ],
});

const auth = useAuth();
const email = ref("");
const password = ref("");
const pending = ref(false);
const sent = ref(false);
const errorMessage = ref("");
const {
  data: authConfig,
  error: configError,
  status: configStatus,
  refresh: refreshConfig,
} = await useAsyncData("auth-public-config", () =>
  auth.getAuthConfig({ force: true }),
);
const localOwner = computed(() => authConfig.value?.mode === "local_owner");
const bootstrapRequired = computed(
  () =>
    authConfig.value?.mode === "local_owner" &&
    authConfig.value.bootstrapRequired,
);

async function submit(): Promise<void> {
  errorMessage.value = "";
  pending.value = true;
  try {
    await auth.login(
      email.value.trim(),
      localOwner.value ? password.value : undefined,
    );
    if (localOwner.value) {
      await navigateTo("/activity", { replace: true });
    } else {
      sent.value = true;
    }
  } catch {
    errorMessage.value = localOwner.value
      ? "The email or password is incorrect."
      : "We couldn’t start sign in right now. Please wait a moment and try again.";
  } finally {
    pending.value = false;
  }
}

async function retryConfig(): Promise<void> {
  await refreshConfig();
}
</script>

<template>
  <AuthFrame
    v-if="configStatus === 'pending'"
    title="Preparing sign in"
    description="Checking the authentication options for this Lore deployment."
  >
    <UiSkeleton :rows="4" />
  </AuthFrame>

  <AuthFrame
    v-else-if="configError"
    title="Sign in is unavailable"
    description="Lore couldn’t load the authentication configuration."
  >
    <UiStatePanel
      title="Authentication couldn’t be loaded"
      description="Check the deployment configuration, then try again."
      tone="error"
    >
      <template #actions>
        <button type="button" class="lore-button-secondary" @click="retryConfig">
          Try again
        </button>
      </template>
    </UiStatePanel>
  </AuthFrame>

  <AuthFrame
    v-else-if="authConfig?.mode === 'disabled'"
    title="Dashboard authentication is disabled"
    description="This deployment is configured for headless access only."
  />

  <AuthFrame
    v-else-if="sent"
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
    :description="
      localOwner
        ? 'Sign in with the local owner account for this deployment.'
        : 'Enter your work email and we’ll send you a secure sign-in link.'
    "
  >
    <form
      class="rounded-[0.625rem] border border-lore-border bg-lore-surface p-5 sm:p-6"
      @submit.prevent="submit"
    >
      <UiField label="Email" for="login-email" required>
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

      <UiField
        v-if="localOwner"
        class="mt-4"
        label="Password"
        for="login-password"
        required
      >
        <input
          id="login-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          minlength="12"
          maxlength="1024"
          class="lore-input min-h-11"
        >
      </UiField>

      <UiInlineAlert
        v-if="errorMessage"
        class="mt-4"
        :title="localOwner ? 'Sign in failed' : 'Sign-in link wasn’t sent'"
        :message="errorMessage"
      />

      <button
        type="submit"
        :disabled="pending"
        class="lore-button-primary mt-5 min-h-11 w-full"
      >
        {{
          pending
            ? localOwner
              ? "Signing in…"
              : "Sending sign-in link…"
            : localOwner
              ? "Sign in"
              : "Continue with email"
        }}
      </button>
    </form>

    <p v-if="bootstrapRequired" class="mt-5 text-sm text-lore-text-secondary">
      Setting up this deployment?
      <NuxtLink to="/setup" class="lore-link ml-1">
        Claim the owner account
      </NuxtLink>
    </p>
    <p
      v-else-if="authConfig?.mode === 'magic_link'"
      class="mt-5 text-sm text-lore-text-secondary"
    >
      Need a workspace?
      <NuxtLink to="/signup" class="lore-link ml-1">
        Create one
      </NuxtLink>
    </p>
  </AuthFrame>
</template>
