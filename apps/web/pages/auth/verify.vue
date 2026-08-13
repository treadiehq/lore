<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

useHead({
  title: "Verify sign in",
  meta: [
    { name: "robots", content: "noindex,nofollow" },
    { name: "referrer", content: "no-referrer" },
  ],
});

const auth = useAuth();
const state = ref<"preparing" | "verifying" | "error">("preparing");
const title = computed(() =>
  state.value === "error" ? "This link can’t sign you in" : "Signing you in",
);
const description = computed(() =>
  state.value === "error"
    ? "The link is invalid, expired, or has already been used."
    : "We’re verifying your secure link. This should only take a moment.",
);

function verificationFromFragment(fragment: string): {
  token: string;
  showConnectorOnboarding: boolean;
} {
  const parameters = new URLSearchParams(fragment);
  const parameterToken = parameters.get("token");
  if (parameterToken !== null) {
    return {
      token: parameterToken.trim(),
      showConnectorOnboarding: parameters.get("onboarding") === "connect",
    };
  }
  if (fragment.includes("=")) {
    return { token: "", showConnectorOnboarding: false };
  }
  try {
    return {
      token: decodeURIComponent(fragment).trim(),
      showConnectorOnboarding: false,
    };
  } catch {
    return { token: "", showConnectorOnboarding: false };
  }
}

onMounted(async () => {
  const fragment = window.location.hash.slice(1);
  const verification = verificationFromFragment(fragment);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );

  if (verification.token === "") {
    state.value = "error";
    return;
  }

  state.value = "verifying";
  try {
    await auth.verify(verification.token);
    await navigateTo(
      verification.showConnectorOnboarding ? "/connect?welcome=1" : "/activity",
      { replace: true },
    );
  } catch {
    state.value = "error";
  }
});
</script>

<template>
  <AuthFrame
    eyebrow="Secure sign in"
    :title="title"
    :description="description"
  >
    <div
      v-if="state !== 'error'"
      class="flex items-center gap-3 rounded-[0.625rem] border border-lore-border bg-lore-surface p-5"
      role="status"
    >
      <span
        class="size-5 animate-spin rounded-full border-2 border-lore-border-strong border-t-lore-accent"
        aria-hidden="true"
      />
      <p class="text-sm text-lore-text-secondary">
        {{ state === "preparing" ? "Preparing verification…" : "Verifying link…" }}
      </p>
    </div>

    <UiInlineAlert
      v-else
      title="This sign-in link can’t be used"
      message="Request a fresh link and use only the most recent email. Previous and expired links are rejected for your security."
    >
      <template #actions>
        <NuxtLink to="/login" class="lore-button-secondary">
          Request a new link
        </NuxtLink>
      </template>
    </UiInlineAlert>
  </AuthFrame>
</template>
