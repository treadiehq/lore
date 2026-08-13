<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    tone?: "neutral" | "error";
    icon?: "empty" | "activity" | "learning" | "search" | "token" | "not-found";
  }>(),
  {
    description: "",
    tone: "neutral",
    icon: "empty",
  },
);

const panelClass = computed(() =>
  props.tone === "error"
    ? "border-lore-danger/30 bg-lore-danger-soft/45"
    : "border-lore-border bg-lore-surface",
);
const iconClass = computed(() =>
  props.tone === "error"
    ? "border-lore-danger/25 bg-lore-danger-soft text-lore-danger"
    : "border-lore-border-strong bg-lore-raised text-lore-text-secondary",
);
</script>

<template>
  <section
    class="relative overflow-hidden rounded-[0.625rem] border px-6 py-8 text-center sm:px-8 sm:py-10"
    :class="panelClass"
    :role="tone === 'error' ? 'alert' : undefined"
    :aria-live="tone === 'error' ? 'assertive' : 'polite'"
  >
    <div
      v-if="tone === 'error'"
      class="pointer-events-none absolute inset-x-0 top-0 h-px bg-lore-danger/50"
      aria-hidden="true"
    />

    <div
      class="mx-auto flex size-10 items-center justify-center rounded-lg border"
      :class="iconClass"
      aria-hidden="true"
    >
      <svg
        v-if="tone === 'error'"
        viewBox="0 0 24 24"
        fill="none"
        class="size-5"
      >
        <path
          d="M12 8v4.5m0 3.25v.05M10.25 3.95 3.1 16.35A2.1 2.1 0 0 0 4.92 19.5h14.16a2.1 2.1 0 0 0 1.82-3.15l-7.15-12.4a2.02 2.02 0 0 0-3.5 0Z"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <svg
        v-else-if="icon === 'activity'"
        viewBox="0 0 24 24"
        fill="none"
        class="size-5"
      >
        <path
          d="M3 12h3.1l2-5.25 3.8 10.5 2.15-5.25H21"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <svg
        v-else-if="icon === 'learning'"
        viewBox="0 0 24 24"
        fill="none"
        class="size-5"
      >
        <path
          d="M6.5 4.25h9.25A2.25 2.25 0 0 1 18 6.5v13.25l-6-3.25-6 3.25V4.75a.5.5 0 0 1 .5-.5Z"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path d="M9 8h6M9 11h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <svg
        v-else-if="icon === 'search'"
        viewBox="0 0 24 24"
        fill="none"
        class="size-5"
      >
        <circle cx="10.75" cy="10.75" r="5.75" stroke="currentColor" stroke-width="1.6" />
        <path d="m15 15 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <svg
        v-else-if="icon === 'token'"
        viewBox="0 0 24 24"
        fill="none"
        class="size-5"
      >
        <circle cx="8.5" cy="12" r="4.25" stroke="currentColor" stroke-width="1.6" />
        <path d="M12.75 12H21m-3 0v2.25M16 12v2.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <svg
        v-else-if="icon === 'not-found'"
        viewBox="0 0 24 24"
        fill="none"
        class="size-5"
      >
        <path d="M6 3.75h8l4 4v12.5H6V3.75Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
        <path d="M14 3.75v4h4M9 13h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" class="size-5">
        <path d="M4 7.25h16v11.5H4V7.25Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
        <path d="M4 14h4l1.5 2h5l1.5-2h4M7 7.25l1.25-3h7.5l1.25 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>

    <h2 class="mt-4 text-sm font-semibold text-lore-text">
      {{ title }}
    </h2>
    <p
      v-if="description"
      class="mx-auto mt-1.5 max-w-md text-sm leading-6 text-lore-text-secondary"
    >
      {{ description }}
    </p>
    <div
      v-if="$slots.actions"
      class="mt-5 flex flex-col justify-center gap-2 sm:flex-row"
    >
      <slot name="actions" />
    </div>
  </section>
</template>
