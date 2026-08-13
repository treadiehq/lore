<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

useHead({
  titleTemplate: (title) => (title ? `${title} · Lore` : "Lore"),
  meta: [
    {
      name: "description",
      content: "Shared engineering knowledge for every connected agent.",
    },
  ],
});

const route = useRoute();
const auth = useAuth();
const session = auth.session;
const organizationName = auth.organizationName;
const mobileNavigationOpen = ref(false);
const accountMenuOpen = ref(false);
const accountMenu = ref<HTMLElement | null>(null);
const signingOut = ref(false);

const accountInitial = computed(
  () => session.value?.email.trim().charAt(0).toUpperCase() || "L",
);
const isAuthPage = computed(
  () =>
    route.path === "/login" ||
    route.path === "/signup" ||
    route.path === "/auth/verify",
);
const showApplicationShell = computed(
  () => !isAuthPage.value && session.value !== null,
);
const navigation = [
  { label: "Activity", to: "/activity", description: "Capture and application history" },
  { label: "Learnings", to: "/memories", description: "Team knowledge" },
  { label: "Connect", to: "/connect", description: "Agent access and tokens" },
] as const;

watch(
  () => route.path,
  () => {
    mobileNavigationOpen.value = false;
    accountMenuOpen.value = false;
  },
);

function isActivePath(path: string): boolean {
  return route.path === path || route.path.startsWith(`${path}/`);
}

function closeAccountMenu(event: PointerEvent): void {
  if (
    accountMenuOpen.value &&
    event.target instanceof Node &&
    !accountMenu.value?.contains(event.target)
  ) {
    accountMenuOpen.value = false;
  }
}

function closeAccountMenuWithKeyboard(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    accountMenuOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener("pointerdown", closeAccountMenu);
  document.addEventListener("keydown", closeAccountMenuWithKeyboard);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeAccountMenu);
  document.removeEventListener("keydown", closeAccountMenuWithKeyboard);
});

async function signOut(): Promise<void> {
  signingOut.value = true;
  try {
    await auth.signOut();
  } catch {
    // The BFF clears the browser cookie even when upstream revocation fails.
  } finally {
    signingOut.value = false;
    accountMenuOpen.value = false;
    await navigateTo("/login", { replace: true });
  }
}
</script>

<template>
  <div class="lore-app-shell">
    <NuxtRouteAnnouncer />
    <UiToastViewport />
    <a v-if="showApplicationShell" href="#main-content" class="lore-skip-link">
      Skip to content
    </a>

    <template v-if="showApplicationShell">
      <div class="relative min-h-dvh lg:h-dvh lg:overflow-hidden">
        <aside
          class="absolute inset-y-0 left-0 z-30 hidden w-64 flex-col lg:flex"
          aria-label="Workspace navigation"
        >
          <div class="flex h-18 items-center gap-2 px-5">
            <LoreMark size="sm" />
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold tracking-tight text-lore-text">
                {{ organizationName || "Lore" }}
              </p>
              <p class="text-[0.6875rem] text-lore-text-muted">Lore workspace</p>
            </div>
          </div>

          <nav class="flex-1 space-y-1 px-4 py-3" aria-label="Primary navigation">
            <p class="mb-2 px-3 text-xs font-medium text-lore-text-muted">
              Workspace
            </p>
            <NuxtLink
              v-for="item in navigation"
              :key="item.to"
              :to="item.to"
              class="lore-focus group flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm transition"
              :class="
                isActivePath(item.to)
                  ? 'bg-lore-hover text-lore-text'
                  : 'text-lore-text-secondary hover:bg-lore-hover/70 hover:text-lore-text'
              "
            >
              <svg
                v-if="item.to === '/activity'"
                viewBox="0 0 20 20"
                fill="none"
                class="size-4 shrink-0"
                aria-hidden="true"
              >
                <path
                  d="M3 10h2.3l1.5-4.1 3 8.2 1.7-4.1H17"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <svg
                v-else-if="item.to === '/memories'"
                viewBox="0 0 20 20"
                fill="none"
                class="size-4 shrink-0"
                aria-hidden="true"
              >
                <path
                  d="M5 3.5h8.25A1.75 1.75 0 0 1 15 5.25V16l-3-1.75L9 16l-3-1.75L3 16V5.5A2 2 0 0 1 5 3.5Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                />
              </svg>
              <svg
                v-else
                viewBox="0 0 20 20"
                fill="none"
                class="size-4 shrink-0"
                aria-hidden="true"
              >
                <path
                  d="M7.25 6.5V4.75m5.5 1.75V4.75M6 9h8m-6.75 0v2.25A2.75 2.75 0 0 0 10 14h0a2.75 2.75 0 0 0 2.75-2.75V9M10 14v2.25"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="truncate font-medium">{{ item.label }}</span>
            </NuxtLink>
          </nav>

          <div ref="accountMenu" class="relative p-4">
            <Transition
              enter-active-class="transition duration-150 ease-out"
              enter-from-class="translate-y-1 scale-95 opacity-0"
              enter-to-class="translate-y-0 scale-100 opacity-100"
              leave-active-class="transition duration-100 ease-in"
              leave-from-class="translate-y-0 scale-100 opacity-100"
              leave-to-class="translate-y-1 scale-95 opacity-0"
            >
              <div
                v-if="accountMenuOpen"
                id="account-menu"
                class="absolute inset-x-3 bottom-18 origin-bottom rounded-lg border border-lore-border bg-lore-raised p-1 shadow-[0_12px_32px_rgb(0_0_0/0.24)]"
                role="menu"
                aria-label="Account menu"
              >
                <div class="border-b border-lore-border px-3 py-2.5">
                  <p class="truncate text-xs font-medium text-lore-text">
                    {{ organizationName || "Workspace" }}
                  </p>
                  <p class="mt-0.5 truncate text-[0.6875rem] text-lore-text-muted">
                    {{ session?.email }}
                  </p>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  class="lore-button-ghost mt-1 w-full justify-start gap-2"
                  :disabled="signingOut"
                  @click="signOut"
                >
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    class="size-4"
                    aria-hidden="true"
                  >
                    <path
                      d="M7.5 3.5H4.75A1.75 1.75 0 0 0 3 5.25v9.5a1.75 1.75 0 0 0 1.75 1.75H7.5M12.5 6l4 4-4 4m4-4H7"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  {{ signingOut ? "Signing out…" : "Sign out" }}
                </button>
              </div>
            </Transition>
            <button
              type="button"
              class="lore-focus flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-lore-hover"
              :aria-expanded="accountMenuOpen"
              aria-haspopup="menu"
              aria-controls="account-menu"
              aria-label="Open account menu"
              @click="accountMenuOpen = !accountMenuOpen"
            >
              <span
                class="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-lore-border-strong bg-lore-raised text-xs font-semibold text-lore-text"
                aria-hidden="true"
              >
                {{ accountInitial }}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium text-lore-text">
                  {{ session?.email }}
                </span>
                <span class="block text-[0.6875rem] text-lore-text-muted">Account</span>
              </span>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                class="size-3.5 text-lore-text-muted transition-transform"
                :class="accountMenuOpen ? 'rotate-180' : ''"
                aria-hidden="true"
              >
                <path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        </aside>

        <header
          class="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-lore-border bg-lore-sidebar px-4 lg:hidden"
        >
          <NuxtLink to="/activity" class="lore-focus flex items-center gap-2 rounded-md">
            <LoreMark size="xs" />
            <span class="text-sm font-semibold text-lore-text">Lore</span>
          </NuxtLink>
          <button
            type="button"
            class="lore-button-ghost min-h-9 px-2.5"
            aria-label="Open navigation"
            @click="mobileNavigationOpen = true"
          >
            <svg viewBox="0 0 20 20" fill="none" class="size-5" aria-hidden="true">
              <path d="M3.5 5.5h13m-13 4.5h13m-13 4.5h13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div
          v-if="mobileNavigationOpen"
          class="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <button
            type="button"
            class="absolute inset-0 bg-black/70"
            aria-label="Close navigation"
            @click="mobileNavigationOpen = false"
          />
          <aside
            class="relative flex h-full w-[min(19rem,85vw)] flex-col border-r border-lore-border bg-lore-sidebar"
          >
            <div class="flex h-16 items-center justify-between border-b border-lore-border px-4">
              <div class="flex min-w-0 items-center gap-3">
                <LoreMark size="sm" />
                <div class="min-w-0">
                  <p class="text-sm font-semibold text-lore-text">Lore</p>
                  <p class="truncate text-xs text-lore-text-muted">
                    {{ organizationName || "Workspace" }}
                  </p>
                </div>
              </div>
              <button
                type="button"
                class="lore-button-ghost min-h-9 px-2.5"
                aria-label="Close navigation"
                @click="mobileNavigationOpen = false"
              >
                ×
              </button>
            </div>
            <nav class="flex-1 space-y-1 p-3">
              <NuxtLink
                v-for="item in navigation"
                :key="item.to"
                :to="item.to"
                class="lore-focus block rounded-md px-3 py-2.5 text-sm font-medium"
                :class="
                  isActivePath(item.to)
                    ? 'bg-lore-raised text-lore-text'
                    : 'text-lore-text-secondary'
                "
              >
                {{ item.label }}
              </NuxtLink>
            </nav>
            <div class="border-t border-lore-border p-3">
              <p class="truncate px-2 text-xs text-lore-text-muted">{{ session?.email }}</p>
              <button
                type="button"
                class="lore-button-ghost mt-2 w-full justify-start"
                :disabled="signingOut"
                @click="signOut"
              >
                {{ signingOut ? "Signing out…" : "Sign out" }}
              </button>
            </div>
          </aside>
        </div>

        <main
          id="main-content"
          tabindex="-1"
          class="min-h-dvh w-full bg-lore-surface px-4 py-7 outline-none sm:px-6 sm:py-8 lg:ml-64 lg:h-full lg:min-h-0 lg:w-[calc(100%-16rem)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-tl-[0.625rem] lg:px-8"
        >
          <NuxtPage />
        </main>
      </div>
    </template>

    <main v-else id="main-content" tabindex="-1" class="min-h-dvh outline-none">
      <NuxtPage />
    </main>
  </div>
</template>
